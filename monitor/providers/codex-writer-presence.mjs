import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isSafeCodexSessionId } from "./codex-session-metadata.mjs";
import { resolveCodexAppServerExecutable } from "./codex-app-server-client.mjs";

export const CODEX_WRITER_PRESENCE_CACHE_MS = 5_000;
export const CODEX_WRITER_PRESENCE_MAX_LOCKS = 500;
export const CODEX_WRITER_PRESENCE_BATCH_SIZE = 32;
export const CODEX_WRITER_PRESENCE_TIMEOUT_MS = 8_000;
export const CODEX_WRITER_PRESENCE_MAX_OUTPUT_BYTES = 256 * 1024;
export const CODEX_WRITER_PRESENCE_CONFIRMATION_MS = 30_000;

// This is a deliberately read-only Restart Manager query. RM reports the union of
// users for registered resources, not a file-to-process mapping. A single trusted
// union owner therefore proves every independently held file in that group; an
// ambiguous union is split sequentially until a unique group is found. This avoids
// serializing a full RM session per lock without relying on parallel RM sessions.
const OWNER_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
public static class PomegrWriterPresence {
  const uint ERROR_MORE_DATA = 234;
  const int MAX_GROUP_QUERIES = 63;
  const int MAX_PROCESS_INFOS = 512;
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Info {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string App;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string Service;
    public uint Type, Status, Session;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  public class Owner { public int index; public uint pid; public string processStartIdentity; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern uint RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern uint RmRegisterResources(uint session, uint files, string[] names, uint apps, IntPtr processes, uint services, IntPtr serviceNames);
  [DllImport("rstrtmgr.dll")] static extern uint RmGetList(uint session, out uint needed, ref uint count, [In, Out] Info[] infos, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern uint RmEndSession(uint session);
  static Owner Validate(UniqueProcess native, string[] executables) {
    try {
      using (Process process = Process.GetProcessById((int)native.Pid)) {
        long started = ((long)(uint)native.Start.dwHighDateTime << 32) | (uint)native.Start.dwLowDateTime;
        if (process.HasExited || process.StartTime.ToUniversalTime().ToFileTimeUtc() != started) return null;
        string executable = process.MainModule.FileName;
        bool trusted = false;
        foreach (string candidate in executables) if (String.Equals(executable, candidate, StringComparison.OrdinalIgnoreCase)) { trusted = true; break; }
        if (!trusted || process.HasExited || process.StartTime.ToUniversalTime().ToFileTimeUtc() != started) return null;
        return new Owner { pid = native.Pid, processStartIdentity = started.ToString(CultureInfo.InvariantCulture) };
      }
    } catch { return null; }
  }
  static string RawOwnerKey(UniqueProcess native) {
    long started = ((long)(uint)native.Start.dwHighDateTime << 32) | (uint)native.Start.dwLowDateTime;
    return native.Pid.ToString(CultureInfo.InvariantCulture) + "\\0" + started.ToString(CultureInfo.InvariantCulture);
  }
  static List<UniqueProcess> Group(string[] files) {
    uint session = 0;
    try {
      if (RmStartSession(out session, 0, new StringBuilder(33)) != 0) return null;
      if (RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero) != 0) return null;
      uint needed, count = 0, reasons = 0;
      uint status = RmGetList(session, out needed, ref count, null, ref reasons);
      if (status == 0 && needed == 0) return new List<UniqueProcess>();
      if (status != ERROR_MORE_DATA || needed == 0 || needed > (uint)MAX_PROCESS_INFOS) return null;
      Info[] infos = new Info[(int)needed]; count = needed;
      uint finalNeeded;
      if (RmGetList(session, out finalNeeded, ref count, infos, ref reasons) != 0
        || count > (uint)infos.Length || finalNeeded > (uint)infos.Length) return null;
      Dictionary<string, UniqueProcess> owners = new Dictionary<string, UniqueProcess>();
      for (int position = 0; position < (int)count; position++) {
        UniqueProcess owner = infos[position].Process;
        owners[RawOwnerKey(owner)] = owner;
      }
      return new List<UniqueProcess>(owners.Values);
    } catch { return null; }
    finally { if (session != 0) RmEndSession(session); }
  }
  static bool Resolve(string[] files, int[] indexes, string[] executables, List<Owner> result, ref int remaining) {
    if (remaining <= 0) return false;
    remaining--;
    List<UniqueProcess> owners = Group(files);
    if (owners == null) return false;
    if (owners.Count == 0) return true;
    if (owners.Count == 1) {
      Owner owner = Validate(owners[0], executables);
      if (owner != null) {
        for (int position = 0; position < indexes.Length; position++) {
          result.Add(new Owner { index = indexes[position], pid = owner.pid, processStartIdentity = owner.processStartIdentity });
        }
      }
      return true;
    }
    if (files.Length <= 1) return true;
    int middle = files.Length / 2;
    int rightLength = files.Length - middle;
    string[] leftFiles = new string[middle]; string[] rightFiles = new string[rightLength];
    int[] leftIndexes = new int[middle]; int[] rightIndexes = new int[rightLength];
    Array.Copy(files, 0, leftFiles, 0, middle); Array.Copy(files, middle, rightFiles, 0, rightLength);
    Array.Copy(indexes, 0, leftIndexes, 0, middle); Array.Copy(indexes, middle, rightIndexes, 0, rightLength);
    return Resolve(leftFiles, leftIndexes, executables, result, ref remaining)
      && Resolve(rightFiles, rightIndexes, executables, result, ref remaining);
  }
  public static List<Owner> Query(string[] files, string[] executables) {
    List<Owner> result = new List<Owner>();
    if (files == null || executables == null) return result;
    int[] indexes = new int[files.Length]; for (int index = 0; index < indexes.Length; index++) indexes[index] = index;
    int remaining = MAX_GROUP_QUERIES;
    return Resolve(files, indexes, executables, result, ref remaining) ? result : new List<Owner>();
  }
}
'@ | Out-Null
  $owners = [PomegrWriterPresence]::Query([string[]]$request.files, [string[]]$request.executables)
  [Console]::Out.Write((ConvertTo-Json -InputObject ([object[]]$owners) -Compress))
} catch { [Console]::Out.Write('[]') }
`;

function sleepTurn() { return new Promise((resolve) => setImmediate(resolve)); }
function safeNow(now) { const value = now(); return Number.isFinite(value) && value >= 0 ? value : null; }
function validOwner(value) {
  return value && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0x7fffffff
    && typeof value.processStartIdentity === "string" && /^\d{1,19}$/.test(value.processStartIdentity);
}
function lockIdentity(stat) {
  if (!stat?.isFile?.() || typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint" || typeof stat.birthtimeNs !== "bigint") return null;
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

/** Read exactly one byte without writing.  Any uncertainty is intentionally unavailable. */
export function readCodexWriterLock(file, options = {}) {
  const fsImpl = options.fs || fs;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(file, "r");
    const identity = lockIdentity(fsImpl.fstatSync(descriptor, { bigint: true }));
    if (!identity) return { state: "unavailable" };
    try {
      fsImpl.readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
      return { state: "unlocked", identity };
    } catch (error) {
      return error?.code === "EBUSY" ? { state: "held", identity } : { state: "unavailable", identity };
    }
  } catch (error) {
    return error?.code === "ENOENT" ? { state: "missing" } : { state: "unavailable" };
  } finally {
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch { /* no state is retained */ }
  }
}

function fileCandidate(candidate, fsImpl) {
  try { return path.isAbsolute(candidate) && fsImpl.statSync(candidate).isFile(); } catch { return false; }
}
function desktopCandidates(options) {
  const environment = options.env || process.env;
  const local = environment.LOCALAPPDATA;
  if (!local) return [];
  const bin = path.join(local, "OpenAI", "Codex", "bin");
  let entries;
  try { entries = options.fs.readdirSync(bin, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry?.isDirectory?.() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name))
    .map((entry) => path.join(bin, entry.name, "codex.exe")).sort().slice(0, 32)
    .filter((candidate) => fileCandidate(candidate, options.fs));
}
function vscodeCandidates(options) {
  const environment = options.env || process.env;
  const profile = environment.USERPROFILE;
  if (!profile) return [];
  const extensions = path.join(profile, ".vscode", "extensions");
  let entries;
  try { entries = options.fs.readdirSync(extensions, { withFileTypes: true }); } catch { return []; }
  const tails = [["bin", "windows-x64", "codex.exe"], ["bin", "win32-x64", "codex.exe"], ["bin", "codex.exe"]];
  return entries.filter((entry) => entry?.isDirectory?.() && /^openai\.chatgpt-[A-Za-z0-9._-]{1,128}$/i.test(entry.name))
    .map((entry) => tails.map((tail) => path.join(extensions, entry.name, ...tail))).flat().sort().slice(0, 32)
    .filter((candidate) => fileCandidate(candidate, options.fs));
}

/**
 * Returns only trusted, local executable paths.  These paths are comparison
 * targets for Restart Manager; this module never launches a discovered Codex exe.
 */
export function resolveCodexWriterExecutables(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return [];
  const fsImpl = options.fs || fs;
  const appServer = resolveCodexAppServerExecutable({ ...options, fs: fsImpl, platform });
  const candidates = [appServer, ...desktopCandidates({ ...options, fs: fsImpl }), ...vscodeCandidates({ ...options, fs: fsImpl })]
    .filter((candidate) => typeof candidate === "string" && fileCandidate(candidate, fsImpl));
  return [...new Set(candidates.map((candidate) => path.resolve(candidate).toLowerCase()))];
}

function powershellPath(environment) {
  return path.join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** One bounded, hidden, asynchronous process for a complete held-lock batch. */
export async function queryCodexWriterOwners(files, executables, options = {}) {
  if ((options.platform || process.platform) !== "win32" || !Array.isArray(files) || !Array.isArray(executables)
    || !files.length || files.length > CODEX_WRITER_PRESENCE_MAX_LOCKS || !executables.length || executables.length > 64
    || files.some((file) => typeof file !== "string" || !path.isAbsolute(file) || file.length > 1024)
    || executables.some((file) => typeof file !== "string" || !path.isAbsolute(file) || file.length > 1024)) return [];
  const spawnFn = options.spawnFn || spawn;
  const timeoutMs = Math.min(CODEX_WRITER_PRESENCE_TIMEOUT_MS, Math.max(1, options.timeoutMs || CODEX_WRITER_PRESENCE_TIMEOUT_MS));
  const outputLimit = Math.min(CODEX_WRITER_PRESENCE_MAX_OUTPUT_BYTES, Math.max(1, options.maximumOutputBytes || CODEX_WRITER_PRESENCE_MAX_OUTPUT_BYTES));
  return new Promise((resolve) => {
    let child; let settled = false; let output = ""; let outputBytes = 0;
    const stop = () => { try { child?.kill(); } catch { /* best effort */ } };
    // Do not resolve a failed helper early: the collector serializes queries by
    // awaiting this promise, so waiting for `close` prevents an overlap with a
    // still-terminating PowerShell process.  The hard deadline is the fallback.
    const onAbort = () => { stop(); };
    const finish = (owners = []) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener?.("abort", onAbort); resolve(owners);
    };
    const timer = setTimeout(() => { stop(); finish(); }, timeoutMs);
    if (options.signal?.aborted) { finish(); return; }
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      child = spawnFn(powershellPath(options.env || process.env), ["-NoProfile", "-NonInteractive", "-Command", OWNER_QUERY_SCRIPT], {
        windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"],
      });
      child.stdout?.on("data", (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > outputLimit) { stop(); return; }
        output += String(chunk);
      });
      child.once?.("error", stop);
      child.stdin?.once?.("error", stop);
      child.once?.("close", (code) => {
        if (code !== 0 || settled) return finish();
        try {
          const parsed = JSON.parse(output || "[]");
          const values = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : []);
          finish(values.length <= files.length ? values.filter(validOwner) : []);
        } catch { finish(); }
      });
      child.stdin?.end(JSON.stringify({ files, executables }));
    } catch { if (child) stop(); else finish(); }
  });
}

export function createCodexWriterPresence(options = {}) {
  const platform = options.platform || process.platform;
  const now = options.now || (() => Date.now());
  const fsImpl = options.fs || fs;
  const root = typeof options.writerLocksRoot === "string" ? path.resolve(options.writerLocksRoot) : null;
  const readLock = options.readLock || ((file) => readCodexWriterLock(file, { fs: fsImpl }));
  const resolveExecutables = options.resolveExecutables || (() => resolveCodexWriterExecutables({ ...options, fs: fsImpl, platform }));
  const query = options.queryOwners || ((files, executables, signal) => queryCodexWriterOwners(files, executables, { ...options, platform, signal }));
  const yieldFn = options.yieldFn || sleepTurn;
  const cacheMs = Math.min(CODEX_WRITER_PRESENCE_CACHE_MS, Math.max(0, options.cacheMs ?? CODEX_WRITER_PRESENCE_CACHE_MS));
  const confirmationMs = Math.min(CODEX_WRITER_PRESENCE_CONFIRMATION_MS, Math.max(cacheMs, options.confirmationMs ?? CODEX_WRITER_PRESENCE_CONFIRMATION_MS));
  let currentById = new Map(); let refreshAt = null; let refreshCompletedAt = null; let refreshSignature = null; let refreshing = null;
  let requested = null; let activeController = null; let generation = 0; let closed = false;
  const listeners = new Set();

  function sameOwners(left, right) {
    if (left.size !== right.size) return false;
    for (const [id, owner] of left) {
      const next = right.get(id);
      if (!next || owner.pid !== next.pid || owner.processStartIdentity !== next.processStartIdentity) return false;
    }
    return true;
  }
  function currentOwner(value, checkedAt) {
    return value && checkedAt !== null && checkedAt >= value.observedAt
      && checkedAt - value.observedAt <= confirmationMs ? value : null;
  }
  function sameEffectiveOwners(left, right, checkedAt) {
    const ids = new Set([...left.keys(), ...right.keys()]);
    for (const id of ids) {
      const previous = currentOwner(left.get(id), checkedAt);
      const next = currentOwner(right.get(id), checkedAt);
      if (Boolean(previous) !== Boolean(next)
        || (previous && (previous.pid !== next.pid || previous.processStartIdentity !== next.processStartIdentity))) return false;
    }
    return true;
  }
  function notify() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* a private wakeup cannot disrupt collection */ }
    }
  }
  function replaceCurrent(next, checkedAt = safeNow(now)) {
    const changed = !sameOwners(currentById, next) || !sameEffectiveOwners(currentById, next, checkedAt);
    currentById = next;
    if (changed) notify();
  }
  function clear() { replaceCurrent(new Map()); }
  function candidates(threads) {
    const seen = new Set(); const result = [];
    for (const thread of Array.isArray(threads) ? threads : []) {
      const id = thread?.localId;
      if (thread?.archived === true || thread?.isArchived === true || !isSafeCodexSessionId(id) || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result.sort().slice(0, CODEX_WRITER_PRESENCE_MAX_LOCKS);
  }
  function requestFor(threads) {
    const ids = candidates(threads);
    return { ids, signature: ids.join("\0") };
  }
  function prune(ids) {
    const allowed = new Set(ids);
    replaceCurrent(new Map([...currentById].filter(([id]) => allowed.has(id))));
  }
  async function perform(request, checkedAt, token) {
    const held = [];
    let failed = false;
    try {
      for (let index = 0; index < request.ids.length; index += 1) {
        const file = path.join(root, `${request.ids[index]}.lock`);
        const before = readLock(file);
        if (before?.state === "held" && typeof before.identity === "string" && before.identity.length <= 256) held.push({ id: request.ids[index], file, identity: before.identity });
        if ((index + 1) % CODEX_WRITER_PRESENCE_BATCH_SIZE === 0) await yieldFn();
        if (closed || token !== generation) return;
      }
    } catch { failed = true; }
    let owners = [];
    if (!failed && held.length) {
      let executables = [];
      try { executables = await resolveExecutables(); } catch { failed = true; }
      executables = Array.isArray(executables) ? [...new Set(executables.filter((value) => typeof value === "string" && path.isAbsolute(value)).slice(0, 64))] : [];
      if (!failed && executables.length) {
        try { owners = await query(held.map((item) => item.file), executables, activeController?.signal); } catch { failed = true; }
      }
      if (!executables.length) failed = true;
    }
    if (closed || token !== generation) return;
    // A newer requested set is authoritative.  Do not let a completed older
    // query republish owners for sessions already pruned from the new request.
    if (requested && requested.signature !== request.signature) return;
    const byIndex = new Map(); let ambiguous = false;
    for (const owner of Array.isArray(owners) ? owners : []) {
      if (!Number.isInteger(owner?.index) || owner.index < 0 || owner.index >= held.length || !validOwner(owner)) { failed = true; continue; }
      if (byIndex.has(owner.index)) { ambiguous = true; break; }
      byIndex.set(owner.index, owner);
    }
    const next = new Map([...currentById].filter(([id]) => request.ids.includes(id)));
    if (failed || ambiguous) {
      // Completion without complete, unambiguous evidence removes presence,
      // but never rewrites any recorded lifecycle state.
      next.clear();
    } else {
      // A completed scan has direct lock evidence for every requested ID, so
      // a missing or unlocked lock also removes an older confirmation.
      for (const id of request.ids) next.delete(id);
      try {
        for (let index = 0; index < held.length; index += 1) {
          const item = held[index]; const owner = byIndex.get(index); const after = readLock(item.file);
          if (owner && after?.state === "held" && after.identity === item.identity) next.set(item.id, { pid: owner.pid, processStartIdentity: owner.processStartIdentity, observedAt: checkedAt });
        }
      } catch { next.clear(); failed = true; }
    }
    if (closed || token !== generation) return;
    // `checkedAt` is the observation time.  Do not renew it merely because a
    // slow native helper finally completed, but apply the acquisition cooldown
    // from completion so a long query cannot immediately run itself again.
    const completedAt = safeNow(now);
    refreshCompletedAt = completedAt !== null && completedAt >= checkedAt ? completedAt : checkedAt;
    replaceCurrent(next, refreshCompletedAt); refreshAt = checkedAt;
    refreshSignature = request.signature;
  }
  async function drain() {
    while (!closed && requested) {
      const request = requested; requested = null;
      const checkedAt = safeNow(now);
      if (checkedAt === null || (refreshAt !== null && checkedAt < refreshAt)) {
        clear(); refreshAt = checkedAt; refreshCompletedAt = checkedAt; refreshSignature = null; continue;
      }
      if (refreshCompletedAt !== null && refreshSignature === request.signature && checkedAt >= refreshCompletedAt
        && checkedAt - refreshCompletedAt <= cacheMs) continue;
      const token = generation; activeController = new AbortController();
      await perform(request, checkedAt, token);
      activeController = null;
    }
  }
  async function refresh(threads) {
    const checkedAt = safeNow(now);
    if (closed || platform !== "win32" || !root || checkedAt === null || (refreshAt !== null && checkedAt < refreshAt)) {
      clear(); refreshAt = checkedAt; refreshCompletedAt = checkedAt; refreshSignature = null; return;
    }
    const request = requestFor(threads); prune(request.ids); requested = request;
    if (refreshing) return refreshing;
    refreshing = drain().finally(() => { refreshing = null; activeController = null; });
    return refreshing;
  }
  return {
    refresh,
    current(localId) {
      const checkedAt = safeNow(now); const value = currentOwner(currentById.get(localId), checkedAt);
      if (!value) return null;
      return { pid: value.pid, processStartIdentity: value.processStartIdentity };
    },
    subscribe(listener) {
      if (typeof listener !== "function" || closed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    invalidate() {
      // Let the native helper finish.  Killing it for every watcher event can
      // starve a busy lock directory forever; the generation still suppresses
      // its stale result, while `requested` retains the latest follow-up.
      generation += 1; clear(); refreshAt = null; refreshCompletedAt = null; refreshSignature = null;
    },
    close() {
      closed = true; generation += 1; requested = null; activeController?.abort(); listeners.clear(); clear();
      refreshAt = null; refreshCompletedAt = null; refreshSignature = null;
    },
  };
}
