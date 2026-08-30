import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePomegrDataRoot } from "../../shared/pomegr-paths.mjs";
import { codexTimestamp, isSafeCodexSessionId } from "./codex-session-metadata.mjs";
import { CODEX_BRIDGE_LEASE_MS, CODEX_NEEDS_INPUT_MAX_MS } from "./codex-lifecycle-constants.mjs";
const SAFE_LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_PROCESS_START_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9.:+-]{0,79}$/;
const TERMINAL_BRIDGE_STATES = new Set(["ended", "finished", "stopped", "interrupted"]);
const BRIDGE_STATES = new Set(["unknown", "idle", "active", "needs_input", "ended", "finished", "stopped", "interrupted", "system_error"]);
const BRIDGE_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
]);

function timestampValue(value) {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY;
}

function safeId(value) {
  return typeof value === "string" && SAFE_LOCAL_ID.test(value) ? value : null;
}

function safeTurnId(value) {
  return typeof value === "string" && SAFE_TURN_ID.test(value) ? value : null;
}

function normalizedProcessStartIdentity(value) {
  const identity = String(value ?? "").trim();
  return SAFE_PROCESS_START_IDENTITY.test(identity) ? identity : null;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function readJson(file) {
  try {
    if (fs.statSync(file).size > 64 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function boundedFiles(directory, suffix, maximum) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file))
    .slice(0, maximum)
    .map((entry) => entry.file);
}

function snapshotFile(root, sessionId, actorId) {
  return path.join(root, "snapshots", `${hash(`${sessionId}\0${actorId}`)}.json`);
}

function leaseFile(root, ownerPid, ownerStartedAt) {
  return path.join(root, "leases", `${ownerPid}-${hash(ownerStartedAt)}.json`);
}

export function resolveCodexLivenessRoot(options = {}) {
  const environment = options.env ?? process.env;
  return path.resolve(options.root || environment.POMEGR_CODEX_LIVENESS_DIR || path.join(
    resolvePomegrDataRoot({ environment, homeDir: options.homeDir || os.homedir(), platform: options.platform }),
    "codex-liveness",
  ));
}

export function processStartIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof options.processStartIdentity === "function") {
    return normalizedProcessStartIdentity(options.processStartIdentity(pid));
  }
  try {
    if ((options.platform || process.platform) === "win32") {
      const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`;
      const value = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
      }).trim();
      return normalizedProcessStartIdentity(value);
    }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 2).split(" ") : [];
    return normalizedProcessStartIdentity(/^\d+$/.test(fields[19] || "") ? `proc-${fields[19]}` : null);
  } catch {
    return null;
  }
}

function processAncestors(startingPid, options = {}) {
  if (!Number.isInteger(startingPid) || startingPid <= 0) return [];
  try {
    if ((options.platform || process.platform) === "win32") {
      const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PomegrParentProcess {
  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref PROCESS_BASIC_INFORMATION info, int size, out int returned);
  public static int GetParentProcessId(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) return 0;
    try {
      PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
      int returned;
      return NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out returned) == 0
        ? info.InheritedFromUniqueProcessId.ToInt32()
        : 0;
    } finally { CloseHandle(handle); }
  }
}
'@ | Out-Null
$current = ${startingPid}
$items = @()
for ($index = 0; $index -lt 12 -and $current -gt 0; $index++) {
  $item = Get-Process -Id $current -ErrorAction SilentlyContinue
  if ($null -eq $item) { break }
  $started = $item.StartTime
  if ($null -eq $started) { break }
  $parent = [PomegrParentProcess]::GetParentProcessId($current)
  $items += [pscustomobject]@{ pid = [int]$item.Id; parentPid = [int]$parent; name = [string]$item.ProcessName; startedAt = $started.ToUniversalTime().ToFileTimeUtc().ToString() }
  $current = [int]$parent
}
$items | ConvertTo-Json -Compress
`;
      const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      }).trim();
      const parsed = JSON.parse(output || "[]");
      return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((item) => (
        Number.isInteger(item?.pid) && item.pid > 0 && normalizedProcessStartIdentity(item.startedAt)
          ? [{ pid: item.pid, parentPid: Number(item.parentPid) || 0, name: String(item.name || ""), startedAt: normalizedProcessStartIdentity(item.startedAt) }]
          : []
      ));
    }
    const ancestors = [];
    let current = startingPid;
    for (let index = 0; index < 12 && current > 0; index += 1) {
      const stat = fs.readFileSync(`/proc/${current}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = close >= 0 ? stat.slice(close + 2).split(" ") : [];
      const parentPid = Number(fields[1]);
      const startedAt = normalizedProcessStartIdentity(/^\d+$/.test(fields[19] || "") ? `proc-${fields[19]}` : null);
      const name = fs.readFileSync(`/proc/${current}/comm`, "utf8").trim();
      if (!startedAt) break;
      ancestors.push({ pid: current, parentPid: Number.isInteger(parentPid) ? parentPid : 0, name, startedAt });
      current = Number.isInteger(parentPid) ? parentPid : 0;
    }
    return ancestors;
  } catch {
    return [];
  }
}

export function codexOwnerIdentity(options = {}) {
  const environment = options.env ?? process.env;
  const configuredPid = Number(environment.POMEGR_CODEX_OWNER_PID);
  if (Number.isInteger(configuredPid) && configuredPid > 0) {
    const ownerStartedAt = processStartIdentity(configuredPid, options);
    return ownerStartedAt ? { ownerPid: configuredPid, ownerStartedAt } : null;
  }
  const startingPid = Number.isInteger(options.startingPid) && options.startingPid > 0 ? options.startingPid : process.ppid;
  const ancestors = processAncestors(startingPid, options);
  const owner = ancestors.find((item) => /^(?:codex|chatgpt)(?:\.exe)?$/i.test(item.name));
  if (owner) return { ownerPid: owner.pid, ownerStartedAt: owner.startedAt };
  return null;
}

function normalizedToolName(value) {
  if (typeof value !== "string") return "";
  return value.split(/[.:/]/).at(-1)?.trim().toLowerCase() || "";
}

function transitionForHook(input, previous) {
  const event = input.hook_event_name;
  const turnId = safeTurnId(input.turn_id);
  const sameTurn = !previous?.turnId || !turnId || previous.turnId === turnId;
  const toolName = normalizedToolName(input.tool_name);
  if (event === "SessionStart") {
    if (input.source === "compact" && turnId && previous?.turnId === turnId && previous?.version === 2) {
      return { state: previous.lifecycle, requestKind: previous.requestKind };
    }
    return { state: "unknown", requestKind: null };
  }
  // Hook dispatch is not an authoritative turn-completion notification. Stop
  // hooks can cause continuation; SessionEnd semantics also vary by runtime.
  if (["Stop", "SubagentStop", "SessionEnd"].includes(event)) return { state: "unknown", requestKind: null };
  if (event === "SubagentStart") return { state: "active", requestKind: null };
  if (event === "UserPromptSubmit") return { state: "active", requestKind: null };
  if (event === "PermissionRequest") return { state: "needs_input", requestKind: "approval" };
  if (event === "PreToolUse" && toolName === "request_user_input") {
    return { state: "needs_input", requestKind: "user_input" };
  }
  if (["PreToolUse", "PostToolUse"].includes(event)) {
    return sameTurn || previous?.lifecycle !== "needs_input"
      ? { state: "active", requestKind: null }
      : { state: previous.lifecycle, requestKind: previous.requestKind };
  }
  return null;
}

function currentLease(root, ownerPid, ownerStartedAt, nowMs) {
  const file = leaseFile(root, ownerPid, ownerStartedAt);
  const previous = readJson(file);
  if (previous?.version === 1
    && previous.ownerPid === ownerPid
    && previous.ownerStartedAt === ownerStartedAt
    && typeof previous.bridgeInstance === "string"
    && /^[a-f0-9]{32}$/.test(previous.bridgeInstance)
    && timestampValue(previous.expiresAt) > nowMs) {
    return { file, value: previous, reused: true };
  }
  return {
    file,
    value: {
      version: 1,
      provider: "codex",
      ownerPid,
      ownerStartedAt,
      bridgeInstance: crypto.randomBytes(16).toString("hex"),
      observedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + CODEX_BRIDGE_LEASE_MS).toISOString(),
    },
    reused: false,
  };
}

function launchOwnerWatcher({ root, ownerPid, ownerStartedAt, bridgeInstance }) {
  const watcher = fileURLToPath(new URL("../../scripts/codex-lifecycle-owner.mjs", import.meta.url));
  const child = spawn(process.execPath, [
    watcher,
    "--root", root,
    "--pid", String(ownerPid),
    "--started-at", ownerStartedAt,
    "--instance", bridgeInstance,
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export function captureCodexLifecycleHook(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const sessionId = safeId(input.session_id);
  const agentId = ["SubagentStart", "SubagentStop"].includes(event) ? safeId(input.agent_id) : null;
  if (!BRIDGE_EVENTS.has(event) || !sessionId || (["SubagentStart", "SubagentStop"].includes(event) && !agentId)) return null;
  const actorId = agentId || sessionId;
  const root = resolveCodexLivenessRoot(options);
  const file = snapshotFile(root, sessionId, actorId);
  const previous = readJson(file);
  const nowMs = options.now instanceof Date ? options.now.getTime() : Number.isFinite(options.now) ? options.now : Date.now();
  const configuredOwnerStartedAt = normalizedProcessStartIdentity(options.ownerStartedAt);
  const discoveredOwner = Number.isInteger(options.ownerPid) && options.ownerPid > 0 && configuredOwnerStartedAt
    ? { ownerPid: options.ownerPid, ownerStartedAt: configuredOwnerStartedAt }
    : codexOwnerIdentity(options);
  if (!discoveredOwner) return null;
  const { ownerPid, ownerStartedAt } = discoveredOwner;
  const lease = currentLease(root, ownerPid, ownerStartedAt, nowMs);
  const continuousPrevious = previous?.ownerPid === ownerPid && previous?.ownerStartedAt === ownerStartedAt
    && previous?.bridgeInstance === lease.value.bridgeInstance ? previous : null;
  const transition = transitionForHook(input, continuousPrevious);
  if (!transition) return null;
  lease.value.observedAt = new Date(nowMs).toISOString();
  lease.value.expiresAt = new Date(nowMs + CODEX_BRIDGE_LEASE_MS).toISOString();
  atomicWriteJson(lease.file, lease.value);
  const snapshot = {
    version: 2,
    provider: "codex",
    sessionId,
    turnId: safeTurnId(input.turn_id),
    agentId,
    lifecycle: transition.state,
    requestKind: transition.requestKind,
    event,
    startSource: event === "SessionStart" && ["startup", "resume", "clear", "compact"].includes(input.source) ? input.source : null,
    stopHookActive: ["Stop", "SubagentStop"].includes(event) ? input.stop_hook_active === true : false,
    observedAt: new Date(nowMs).toISOString(),
    sequence: Number.isSafeInteger(previous?.sequence) ? previous.sequence + 1 : 1,
    ownerPid,
    ownerStartedAt,
    bridgeInstance: lease.value.bridgeInstance,
  };
  atomicWriteJson(file, snapshot);
  if (!lease.reused && event !== "SessionEnd" && options.startWatcher !== false) {
    try { (options.launchWatcher || launchOwnerWatcher)({ root, ownerPid, ownerStartedAt, bridgeInstance: lease.value.bridgeInstance }); } catch {
      // A missing watcher simply bounds the bridge evidence to the initial lease.
    }
  }
  return snapshot;
}

export function renewCodexOwnerLease(options = {}) {
  const root = resolveCodexLivenessRoot(options);
  const ownerPid = Number(options.ownerPid);
  const ownerStartedAt = normalizedProcessStartIdentity(options.ownerStartedAt);
  const bridgeInstance = options.bridgeInstance;
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !ownerStartedAt || !/^[a-f0-9]{32}$/.test(bridgeInstance || "")) return false;
  if (processStartIdentity(ownerPid, options) !== ownerStartedAt) return false;
  const file = leaseFile(root, ownerPid, ownerStartedAt);
  const lease = readJson(file);
  if (lease?.ownerPid !== ownerPid || lease?.ownerStartedAt !== ownerStartedAt || lease?.bridgeInstance !== bridgeInstance) return false;
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  atomicWriteJson(file, {
    ...lease,
    observedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + CODEX_BRIDGE_LEASE_MS).toISOString(),
  });
  return true;
}

function validBridgeSnapshot(value) {
  return [1, 2].includes(value?.version)
    && (value.version === 1 || (BRIDGE_EVENTS.has(value.event)
      && [null, "startup", "resume", "clear", "compact"].includes(value.startSource)
      && typeof value.stopHookActive === "boolean"))
    && value.provider === "codex"
    && isSafeCodexSessionId(value.sessionId)
    && (value.agentId === null || safeId(value.agentId))
    && BRIDGE_STATES.has(value.lifecycle)
    && [null, "approval", "user_input", "multiple"].includes(value.requestKind)
    && codexTimestamp(value.observedAt)
    && Number.isSafeInteger(value.sequence)
    && Number.isInteger(value.ownerPid)
    && value.ownerPid > 0
    && normalizedProcessStartIdentity(value.ownerStartedAt)
    && /^[a-f0-9]{32}$/.test(value.bridgeInstance || "");
}

export function readBridgeRecords(root, maximumFiles) {
  const leases = new Map();
  for (const file of boundedFiles(path.join(root, "leases"), ".json", maximumFiles)) {
    const lease = readJson(file);
    if (lease?.version !== 1 || lease.provider !== "codex" || !Number.isInteger(lease.ownerPid)
      || !normalizedProcessStartIdentity(lease.ownerStartedAt) || !/^[a-f0-9]{32}$/.test(lease.bridgeInstance || "")
      || !codexTimestamp(lease.expiresAt)) continue;
    leases.set(`${lease.ownerPid}\0${lease.ownerStartedAt}\0${lease.bridgeInstance}`, lease);
  }
  return boundedFiles(path.join(root, "snapshots"), ".json", maximumFiles).flatMap((file) => {
    const snapshot = readJson(file);
    if (!validBridgeSnapshot(snapshot)) return [];
    const lease = leases.get(`${snapshot.ownerPid}\0${snapshot.ownerStartedAt}\0${snapshot.bridgeInstance}`) || null;
    return [{ snapshot, lease }];
  });
}

export function bridgeLiveness(record, nowMs, keepStale) {
  const { snapshot, lease } = record;
  const observedAt = codexTimestamp(snapshot.observedAt);
  const age = nowMs - timestampValue(observedAt);
  if (age < 0) return null;
  const leaseCurrent = Boolean(lease && timestampValue(lease.expiresAt) > nowMs);
  const stale = !leaseCurrent || age > CODEX_NEEDS_INPUT_MAX_MS;
  const legacy = snapshot.version !== 2;
  const ambiguous = snapshot.lifecycle === "unknown";
  const unavailable = legacy || stale || ambiguous;
  return {
    live: leaseCurrent || Boolean(keepStale),
    status: unavailable ? "unknown" : snapshot.lifecycle,
    needsInput: !unavailable && snapshot.lifecycle === "needs_input",
    source: "lifecycle_bridge",
    observedAt,
    evidence: unavailable ? "unavailable" : "observed",
    freshness: stale ? "stale" : "current",
    ...(unavailable ? { reason: legacy ? "legacy_snapshot" : stale ? "observation_gap" : "ambiguous_event" } : {}),
  };
}

export function currentBridgeResourceOwner(record, nowMs) {
  if (!record?.lease || (TERMINAL_BRIDGE_STATES.has(record.snapshot.lifecycle) && record.snapshot.lifecycle !== "ended")) return null;
  if (timestampValue(record.lease.expiresAt) <= nowMs) return null;
  return {
    pid: record.snapshot.ownerPid,
    processStartIdentity: record.snapshot.ownerStartedAt,
  };
}

export function uniqueResourceOwner(owners) {
  const unique = new Map(owners.map((owner) => [`${owner.pid}\0${owner.processStartIdentity}`, owner]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}
