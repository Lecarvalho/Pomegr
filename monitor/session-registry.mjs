import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const USER_ATTENTION_REASONS = ["input", "approval", "permission", "question"];
const ACTIVE_STATUSES = new Set(["active", "busy", "running"]);
// A validated owner identity (pid + procStart) is trusted without a new process
// enumeration for OWNER_FRESH_MS, the same window the former whole-batch cache used.
// After that, where an asynchronous probe exists (Windows PowerShell), the last result
// is served while one background re-enumeration runs, but never once it is older than
// OWNER_MAX_STALE_MS; a synchronous probe then answers. A cheap, non-spawning liveness
// check ends a positive identity as soon as the pid is definitely gone.
const OWNER_FRESH_MS = 1_500;
const OWNER_MAX_STALE_MS = 5_000;
const MAX_OWNER_VALIDATION_ENTRIES = 2_048;

/** Non-spawning liveness: true, false only for a definitely absent pid, null when unknown. */
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
    if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
      $items += [pscustomobject]@{ pid = [int]$id; procStart = $null }
    }
    continue
  }
  try {
    $items += [pscustomobject]@{ pid = [int]$item.Id; procStart = $item.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() }
  } catch { $items += [pscustomobject]@{ pid = [int]$id; procStart = $null } }
}
$items | ConvertTo-Json -Compress
`;
  return [powershell, ["-NoProfile", "-NonInteractive", "-Command", script]];
}

function parseWindowsIdentities(output) {
  const parsed = JSON.parse(String(output || "").trim() || "[]");
  return new Map((Array.isArray(parsed) ? parsed : [parsed]).flatMap((item) => {
    const pid = normalizedPid(item?.pid);
    const processStart = normalizedProcessStart(item?.procStart);
    return pid ? [[pid, processStart]] : [];
  }));
}

/**
 * The asynchronous counterpart of `processIdentities`, or null where a synchronous
 * probe is already cheap (Linux /proc) or the caller injected a synchronous probe.
 */
function asyncProcessIdentities(options = {}) {
  if (typeof options.processIdentitiesAsync === "function") return options.processIdentitiesAsync;
  if (typeof options.processIdentities === "function" || (options.platform || process.platform) !== "win32") return null;
  return (pids) => new Promise((resolve) => {
    const [command, args] = windowsIdentityCommand(pids, options);
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: 3_000 }, (error, stdout) => {
      try { resolve(error ? null : parseWindowsIdentities(stdout)); } catch { resolve(null); }
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
      return parseWindowsIdentities(execFileSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 3_000 }));
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
        // Only absence proves exit. Permission and malformed-read failures are unknown.
        if (error?.code !== "ENOENT" && error?.code !== "ESRCH") identities.set(pid, null);
      }
    }
    return identities;
  } catch {
    // Process inspection failures degrade to the provider registry instead of
    // incorrectly retiring every session on the machine.
    return null;
  }
}

/**
 * Validates registry owners by pid and process-start identity. A result is reused
 * for `cacheMs` (default OWNER_FRESH_MS) while the registry reports the same pid
 * and procStart; a different procStart is always re-probed. A cheap liveness check
 * ends a positive result as soon as the pid is definitely gone. An older result is
 * served only while one asynchronous re-enumeration is pending and only until
 * OWNER_MAX_STALE_MS, so reads inside that bound never block the event loop on a
 * process spawn and never trust an identity much longer than the former cache did.
 * A first check, a changed identity, or a read after the bound still probes synchronously.
 */
export function createSessionRegistryOwnerValidator(options = {}) {
  const now = options.now || (() => Date.now());
  const freshMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : OWNER_FRESH_MS;
  const maxStaleMs = Math.max(freshMs, Number.isFinite(options.maxStaleMs) ? options.maxStaleMs : OWNER_MAX_STALE_MS);
  const processExists = typeof options.processExists === "function" ? options.processExists : () => null;
  const probeAsync = asyncProcessIdentities(options);
  /** @type {Map<string, {pid: number, procStart: string, isCurrent: boolean, validatedAt: number}>} */
  const cache = new Map();
  const refreshing = new Set();

  function remember(entry, isCurrent, validatedAt) {
    cache.delete(entry.sessionId);
    cache.set(entry.sessionId, { pid: entry.pid, procStart: entry.procStart, isCurrent, validatedAt });
    while (cache.size > MAX_OWNER_VALIDATION_ENTRIES) cache.delete(cache.keys().next().value);
  }

  function refresh(entries) {
    const pending = entries.filter((entry) => !refreshing.has(entry.sessionId));
    if (!pending.length) return;
    for (const entry of pending) refreshing.add(entry.sessionId);
    const pids = [...new Set(pending.map((entry) => entry.pid))].sort((left, right) => left - right);
    Promise.resolve().then(() => probeAsync(pids)).catch(() => null).then((identities) => {
      const checkedAt = now();
      for (const entry of pending) {
        refreshing.delete(entry.sessionId);
        const cached = cache.get(entry.sessionId);
        // A newer registry identity or an unavailable answer leaves the cache to the next read.
        if (!identities || !cached || cached.pid !== entry.pid || cached.procStart !== entry.procStart) continue;
        const identity = identities.get(entry.pid);
        if (identity === null) continue;
        remember(entry, identity === entry.procStart, checkedAt);
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
        remember(entry, false, now());
        result.set(entry.sessionId, false);
        continue;
      }
      const age = now() - cached.validatedAt;
      if (age < freshMs) { result.set(entry.sessionId, cached.isCurrent); continue; }
      if (probeAsync && age < maxStaleMs) {
        toRefresh.push(entry);
        result.set(entry.sessionId, cached.isCurrent);
        continue;
      }
      toProbe.push(entry);
    }
    if (toRefresh.length) refresh(toRefresh);
    if (toProbe.length) {
      const pids = [...new Set(toProbe.map((entry) => entry.pid))].sort((left, right) => left - right);
      const identities = processIdentities(pids, options);
      if (identities !== null) {
        const checkedAt = now();
        for (const entry of toProbe) {
          const identity = identities.get(entry.pid);
          if (identity === null) continue; // an individual inspection failure is unknown, never cached or resolved
          const isCurrent = identity === entry.procStart;
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
      // A partially-written or removed provider registry entry is ignored independently.
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
      // Owner inspection is an optional strengthening signal. Registry parsing
      // remains available if the operating-system check fails unexpectedly.
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
