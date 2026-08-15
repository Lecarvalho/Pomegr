import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const USER_ATTENTION_REASONS = ["input", "approval", "permission", "question"];
const ACTIVE_STATUSES = new Set(["active", "busy", "running"]);
const OWNER_CACHE_MS = 1_500;

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

function processIdentities(pids, options = {}) {
  try {
    if (typeof options.processIdentities === "function") return options.processIdentities(pids);
    if (pids.length === 0) return new Map();
    const platform = options.platform || process.platform;
    if (platform === "win32") {
      const environment = options.env ?? process.env;
      const powershell = path.join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `
$ids = @(${pids.join(",")})
$items = @()
foreach ($id in $ids) {
  $item = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($null -eq $item) { continue }
  try {
    $items += [pscustomobject]@{ pid = [int]$item.Id; procStart = $item.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() }
  } catch {}
}
$items | ConvertTo-Json -Compress
`;
      const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
      }).trim();
      const parsed = JSON.parse(output || "[]");
      return new Map((Array.isArray(parsed) ? parsed : [parsed]).flatMap((item) => {
        const pid = normalizedPid(item?.pid);
        const processStart = normalizedProcessStart(item?.procStart);
        return pid && processStart ? [[pid, processStart]] : [];
      }));
    }

    if (platform !== "linux") return null;

    const identities = new Map();
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const fields = close >= 0 ? stat.slice(close + 2).split(" ") : [];
        const processStart = normalizedProcessStart(fields[19]);
        if (processStart) identities.set(pid, processStart);
      } catch {
        // A missing process is represented by the absence of its PID.
      }
    }
    return identities;
  } catch {
    // Process inspection failures degrade to the provider registry instead of
    // incorrectly retiring every session on the machine.
    return null;
  }
}

export function createSessionRegistryOwnerValidator(options = {}) {
  const now = options.now || (() => Date.now());
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : OWNER_CACHE_MS;
  let cache = null;

  return (entries) => {
    const owned = entries.filter((entry) => entry.pid && entry.procStart);
    const pids = [...new Set(owned.map((entry) => entry.pid))].sort((left, right) => left - right);
    const key = owned.map((entry) => `${entry.sessionId}:${entry.pid}:${entry.procStart}`).sort().join("|");
    const checkedAt = now();
    let identities;
    if (cache && cache.key === key && checkedAt < cache.expiresAt) identities = cache.identities;
    else {
      identities = processIdentities(pids, options);
      cache = { key, expiresAt: checkedAt + cacheMs, identities };
    }
    if (identities === null) return new Map();

    return new Map(owned.map((entry) => [
      entry.sessionId,
      identities.get(entry.pid) === entry.procStart,
    ]));
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
      const entry = normalizeSessionRegistryEntry(JSON.parse(fs.readFileSync(file, "utf8")), stat.mtimeMs);
      if (!entry) continue;
      const current = registry.get(entry.sessionId);
      if (!current || entry.updatedAt >= current.updatedAt) registry.set(entry.sessionId, entry);
    } catch {
      // A partially-written or removed provider registry entry is ignored independently.
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
