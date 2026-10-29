import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runExecFile } from "./exec-file-runner.mjs";

const USER_ATTENTION_REASONS = ["input", "approval", "permission", "question"];
const ACTIVE_STATUSES = new Set(["active", "busy", "running"]);
const OWNER_FRESH_MS = 1_500;
const OWNER_MAX_STALE_MS = 5_000;
const MAX_OWNER_VALIDATION_ENTRIES = 2_048;

export const OWNER_PROBE_COUNTERS = Object.freeze([
  "probeAnswers", "probeNoAnswers", "ownersCurrent", "ownersReplaced", "ownersAbsent", "ownersUnknown",
  "ownersExited", "sessionsClosed", "sessionsReinstated",
]);

// Counts of owner-probe outcomes only: no pid, start identity, session, or error.
export function createOwnerProbeCounters() {
  const counts = Object.fromEntries(OWNER_PROBE_COUNTERS.map((key) => [key, 0]));
  return Object.freeze({
    record(key, amount = 1) {
      if (Object.hasOwn(counts, key)) counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + amount);
    },
    snapshot: () => Object.freeze({ ...counts }),
  });
}

// Non-spawning liveness: true, false only for a definitely absent pid, null when unknown.
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "ESRCH" ? false : error?.code === "EPERM" ? true : null; }
}

function timestampMs(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function normalizedProcessStart(value) {
  const processStart = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9.:+-]{0,79}$/.test(processStart) ? processStart : null;
}

function normalizedStatus(value) {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ACTIVE_STATUSES.has(status) ? "active" : status;
}

/** @returns {[string, string[]]} */
function windowsIdentityCommand(pids, options = {}) {
  const environment = options.env ?? process.env;
  const powershell = path.join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$ids = @(${pids.join(",")})
$items = @()
foreach ($id in $ids) {
  try { $item = Get-Process -Id $id -ErrorAction Stop }
  catch {
    $gone = $_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound
    $items += [pscustomobject]@{ pid = [int]$id; procStart = $null; gone = $gone }
    continue
  }
  try {
    $items += [pscustomobject]@{ pid = [int]$item.Id; procStart = $item.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); gone = $false }
  } catch { $items += [pscustomobject]@{ pid = [int]$id; procStart = $null; gone = $false } }
}
ConvertTo-Json -Compress -InputObject @($items)
`;
  return [powershell, ["-NoProfile", "-NonInteractive", "-Command", script]];
}

// The helper answers for every requested pid, and says so when a process is gone. A pid
// with no answer is never read as an exit: a helper that the timeout cut off as it
// finished returns success with empty output.
export function parseWindowsIdentities(output, pids) {
  const text = String(output || "").trim();
  if (text === "") return null;
  const parsed = JSON.parse(text);
  const answers = new Map((Array.isArray(parsed) ? parsed : [parsed]).flatMap((item) => {
    const pid = normalizedPid(item?.pid);
    return pid ? [[pid, item]] : [];
  }));
  if (pids.some((pid) => !answers.has(pid))) return null;
  return new Map(pids.flatMap((pid) => {
    const answer = answers.get(pid);
    return answer.gone === true ? [] : [[pid, normalizedProcessStart(answer.procStart)]];
  }));
}

function asyncProcessIdentities(options = {}) {
  if (typeof options.processIdentitiesAsync === "function") return options.processIdentitiesAsync;
  if (typeof options.processIdentities === "function" || (options.platform || process.platform) !== "win32") return null;
  return (pids) => new Promise((resolve) => {
    const [command, args] = windowsIdentityCommand(pids, options);
    runExecFile(command, args, { encoding: "utf8", windowsHide: true, timeout: 3_000 }, (error, stdout) => {
      try { resolve(error ? null : parseWindowsIdentities(stdout, pids)); } catch { resolve(null); }
    });
  });
}

function processIdentities(pids, options = {}) {
  try {
    if (typeof options.processIdentities === "function") return options.processIdentities(pids);
    if (pids.length === 0) return new Map();
    const platform = options.platform || process.platform;
    if (platform === "win32") {
      const [command, args] = windowsIdentityCommand(pids, options);
      return parseWindowsIdentities(execFileSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 3_000 }), pids);
    }

    if (platform !== "linux") return null;

    const identities = new Map();
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const fields = close >= 0 ? stat.slice(close + 2).split(" ") : [];
        const processStart = normalizedProcessStart(fields[19]);
        identities.set(pid, processStart);
      } catch (error) {
        // Only absence proves exit.
        if (error?.code !== "ENOENT" && error?.code !== "ESRCH") identities.set(pid, null);
      }
    }
    return identities;
  } catch {
    return null;
  }
}

// Validates registry owners by pid and process-start identity.
export function createSessionRegistryOwnerValidator(options = {}) {
  const now = options.now || (() => Date.now());
  const freshMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : OWNER_FRESH_MS;
  const maxStaleMs = Math.max(freshMs, Number.isFinite(options.maxStaleMs) ? options.maxStaleMs : OWNER_MAX_STALE_MS);
  const processExists = typeof options.processExists === "function" ? options.processExists : () => null;
  const probeAsync = asyncProcessIdentities(options);
  const count = (key) => { try { options.counters?.record?.(key); } catch { /* diagnostics cannot affect validation */ } };
  // Reads one owner's answer: true current, false replaced or absent, null unknown.
  function judge(entry, identities) {
    const identity = identities.get(entry.pid);
    if (identity === null) { count("ownersUnknown"); return null; }
    const isCurrent = identity === entry.procStart;
    count(isCurrent ? "ownersCurrent" : identity === undefined ? "ownersAbsent" : "ownersReplaced");
    return isCurrent;
  }
  /** @type {Map<string, {pid: number, procStart: string, isCurrent: boolean, validatedAt: number}>} */
  const cache = new Map();
  /** @type {Map<string, number>} When each pending refresh started. */
  const refreshing = new Map();

  function remember(entry, isCurrent, validatedAt) {
    cache.delete(entry.sessionId);
    cache.set(entry.sessionId, { pid: entry.pid, procStart: entry.procStart, isCurrent, validatedAt });
    while (cache.size > MAX_OWNER_VALIDATION_ENTRIES) cache.delete(cache.keys().next().value);
  }

  function refresh(entries) {
    const pending = entries.filter((entry) => !refreshing.has(entry.sessionId));
    if (!pending.length) return;
    const startedAt = now();
    for (const entry of pending) refreshing.set(entry.sessionId, startedAt);
    const pids = [...new Set(pending.map((entry) => entry.pid))].sort((left, right) => left - right);
    Promise.resolve().then(() => probeAsync(pids)).catch(() => null).then((identities) => {
      const checkedAt = now();
      count(identities ? "probeAnswers" : "probeNoAnswers");
      for (const entry of pending) {
        refreshing.delete(entry.sessionId);
        const cached = cache.get(entry.sessionId);
        if (!identities || !cached || cached.pid !== entry.pid || cached.procStart !== entry.procStart) continue;
        const isCurrent = judge(entry, identities);
        if (isCurrent === null) continue;
        remember(entry, isCurrent, checkedAt);
      }
    });
  }

  return (entries) => {
    const owned = entries.filter((entry) => entry.pid && entry.procStart);
    const result = new Map();
    const toProbe = [];
    const toRefresh = [];
    for (const entry of owned) {
      const cached = cache.get(entry.sessionId);
      if (!cached || cached.pid !== entry.pid || cached.procStart !== entry.procStart) { toProbe.push(entry); continue; }
      if (cached.isCurrent && processExists(entry.pid) === false) {
        count("ownersExited");
        remember(entry, false, now());
        result.set(entry.sessionId, false);
        continue;
      }
      const age = now() - cached.validatedAt;
      if (age < freshMs) { result.set(entry.sessionId, cached.isCurrent); continue; }
      // Past the stale bound, an owner whose process is still there keeps its last answer while one
      // asynchronous probe re-confirms it: a synchronous PowerShell probe holds the event loop for
      // 0.4 to 1.5 s. Only a refresh that has not answered within the stale bound of its start is
      // followed by a synchronous one.
      const refreshStartedAt = refreshing.get(entry.sessionId);
      const refreshAnswering = refreshStartedAt !== undefined && now() - refreshStartedAt < maxStaleMs;
      if (probeAsync && (age < maxStaleMs || refreshAnswering
        || (refreshStartedAt === undefined && processExists(entry.pid) === true))) {
        toRefresh.push(entry);
        result.set(entry.sessionId, cached.isCurrent);
        continue;
      }
      toProbe.push(entry);
    }
    if (toRefresh.length) refresh(toRefresh);
    if (toProbe.length) {
      const pids = [...new Set(toProbe.map((entry) => entry.pid))].sort((left, right) => left - right);
      const identities = processIdentities(pids, options) ?? null;
      count(identities ? "probeAnswers" : "probeNoAnswers");
      if (identities !== null) {
        const checkedAt = now();
        for (const entry of toProbe) {
          const isCurrent = judge(entry, identities);
          if (isCurrent === null) continue; // an individual inspection failure is unknown, never cached or resolved
          remember(entry, isCurrent, checkedAt);
          result.set(entry.sessionId, isCurrent);
        }
      }
    }
    return result;
  };
}

export function normalizeSessionRegistryEntry(value, fallbackUpdatedAt = 0) {
  if (!value || typeof value !== "object" || !/^[a-zA-Z0-9_-]+$/.test(value.sessionId || "")) return null;
  const status = normalizedStatus(value.status);
  const waitingFor = typeof value.waitingFor === "string" ? value.waitingFor.trim().toLowerCase() : "";
  const updatedAt = Math.max(
    timestampMs(value.updatedAt),
    timestampMs(value.statusUpdatedAt),
    fallbackUpdatedAt,
  );
  const needsInput = status === "waiting"
    && USER_ATTENTION_REASONS.some((reason) => waitingFor.includes(reason));

  return {
    sessionId: value.sessionId,
    status,
    needsInput,
    updatedAt,
    pid: normalizedPid(value.pid),
    procStart: normalizedProcessStart(value.procStart),
  };
}

export function readSessionRegistry(root, options = {}) {
  const registry = new Map();
  if (!root || !fs.existsSync(root)) return registry;

  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const entry = (options.normalizeEntry || normalizeSessionRegistryEntry)(JSON.parse(fs.readFileSync(file, "utf8")), stat.mtimeMs);
      if (!entry) continue;
      const current = registry.get(entry.sessionId);
      if (!current || entry.updatedAt >= current.updatedAt) registry.set(entry.sessionId, entry);
    } catch {
      options.onIncomplete?.();
    }
  }

  if (typeof options.validateOwners === "function") {
    try {
      const validation = options.validateOwners([...registry.values()]);
      for (const [sessionId, entry] of registry) {
        if (!entry.pid || !entry.procStart) continue;
        const ownerIsCurrent = validation.get(sessionId);
        if (ownerIsCurrent === false) registry.delete(sessionId);
        else if (ownerIsCurrent === true) entry.resourceOwner = {
          pid: entry.pid,
          processStartIdentity: entry.procStart,
        };
      }
    } catch {
    }
  }

  return registry;
}

export function preferredRegisteredSessionId(registry, orderedSessionIds) {
  return orderedSessionIds.find((sessionId) => registry.get(sessionId)?.needsInput)
    || orderedSessionIds.find((sessionId) => {
      const status = registry.get(sessionId)?.status;
      return status === "active" || status === "waiting";
    })
    || null;
}
