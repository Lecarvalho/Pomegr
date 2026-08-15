import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_WINDOW_MS = 15 * 60_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const WINDOWS_FILETIME_EPOCH = 116_444_736_000_000_000n;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/;

const WINDOWS_SNAPSHOT_SCRIPT = String.raw`
$items = Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
  $processStart = ""
  try { $processStart = $_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() } catch {}
  [pscustomobject]@{
    pid = [double]$_.ProcessId
    parentPid = [double]$_.ParentProcessId
    processStartIdentity = $processStart
    cpuTimeMs = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000
    memoryBytes = [double]$_.WorkingSetSize
    readBytes = [double]$_.ReadTransferCount
    writeBytes = [double]$_.WriteTransferCount
  }
}
ConvertTo-Json -InputObject @($items) -Compress
`;

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function canonicalProcessStart(value) {
  const input = String(value ?? "").trim();
  if (/^\d{15,20}$/.test(input)) {
    try {
      const ticks = BigInt(input);
      if (ticks < WINDOWS_FILETIME_EPOCH) return null;
      const milliseconds = (ticks - WINDOWS_FILETIME_EPOCH) / 10_000n;
      const startedAtMs = Number(milliseconds);
      return Number.isSafeInteger(startedAtMs)
        ? { identity: `unix-ms:${startedAtMs}`, startedAtMs }
        : null;
    } catch {
      return null;
    }
  }

  const match = ISO_TIMESTAMP.exec(input);
  if (!match) return null;
  const milliseconds = (match[2] || "").padEnd(3, "0").slice(0, 3);
  const startedAtMs = Date.parse(`${match[1]}.${milliseconds}${match[3]}`);
  return Number.isFinite(startedAtMs)
    ? { identity: `unix-ms:${startedAtMs}`, startedAtMs }
    : null;
}

function safeTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function defaultReadSnapshot(options = {}) {
  const environment = options.env ?? process.env;
  const powershell = path.join(
    environment.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const execute = options.execFile || execFile;
  const timeout = Number.isFinite(options.collectionTimeoutMs) ? Math.max(1, options.collectionTimeoutMs) : 5_000;
  return new Promise((resolve, reject) => {
    execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: MAX_SNAPSHOT_BYTES,
    }, (error, stdout) => {
      if (error) reject(error);
      else {
        try {
          resolve(JSON.parse(String(stdout).trim() || "[]"));
        } catch (parseError) {
          reject(parseError);
        }
      }
    });
  });
}

function normalizeSnapshot(value) {
  const records = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const byPid = new Map();
  for (const value of records) {
    const pid = positiveInteger(value?.pid);
    const parentPid = nonNegativeNumber(value?.parentPid);
    const processStart = canonicalProcessStart(value?.processStartIdentity);
    const cpuTimeMs = nonNegativeNumber(value?.cpuTimeMs);
    const memoryBytes = nonNegativeNumber(value?.memoryBytes);
    const readBytes = nonNegativeNumber(value?.readBytes);
    const writeBytes = nonNegativeNumber(value?.writeBytes);
    if (!pid || !Number.isInteger(parentPid) || !processStart
      || cpuTimeMs === null || memoryBytes === null || readBytes === null || writeBytes === null) continue;
    byPid.set(pid, { pid, parentPid, ...processStart, cpuTimeMs, memoryBytes, readBytes, writeBytes });
  }
  return byPid;
}

function normalizedTargets(targets) {
  const normalized = new Map();
  for (const target of Array.isArray(targets) ? targets : []) {
    const sessionId = typeof target?.sessionId === "string" && target.sessionId.trim()
      ? target.sessionId.trim()
      : null;
    if (!sessionId) continue;
    if (target.status === "shared") {
      normalized.set(sessionId, { sessionId, status: "shared" });
      continue;
    }
    const pid = positiveInteger(target.pid);
    const processStart = canonicalProcessStart(target.processStartIdentity);
    normalized.set(sessionId, pid && processStart
      ? { sessionId, status: "available", pid, ...processStart }
      : { sessionId, status: "missing" });
  }
  return normalized;
}

function createState(ownerKey = null) {
  return {
    ownerKey,
    status: "collecting",
    reason: null,
    current: null,
    observedPeak: null,
    samples: [],
    previousProcesses: null,
    lastSampleAt: null,
  };
}

function publicState(state) {
  if (!state) return null;
  return {
    status: state.status,
    reason: state.reason,
    current: state.current ? { ...state.current } : null,
    observedPeak: state.observedPeak ? { ...state.observedPeak } : null,
    samples: state.samples.map((sample) => ({ ...sample })),
  };
}

function addSample(state, sample, nowMs, windowMs, maximumSamples) {
  state.samples.push(sample);
  const cutoff = nowMs - windowMs;
  while (state.samples.length && Date.parse(state.samples[0].timestamp) < cutoff) state.samples.shift();
  if (state.samples.length > maximumSamples) state.samples.splice(0, state.samples.length - maximumSamples);
}

function gapSample(timestamp) {
  return {
    timestamp,
    cpuCores: null,
    cpuMachinePercent: null,
    memoryBytes: null,
    readBytesPerSecond: null,
    writeBytesPerSecond: null,
  };
}

function unavailable(state, reason, timestamp, options) {
  state.status = "unavailable";
  state.reason = reason;
  state.current = null;
  state.previousProcesses = null;
  state.lastSampleAt = null;
  if (options.reset) {
    state.observedPeak = null;
    state.samples = [];
  } else if (options.gap) {
    addSample(state, gapSample(timestamp), options.nowMs, options.windowMs, options.maximumSamples);
  }
}

function processTree(root, byPid) {
  const children = new Map();
  for (const process of byPid.values()) {
    const current = children.get(process.parentPid) || [];
    current.push(process);
    children.set(process.parentPid, current);
  }
  const tree = new Map();
  const pending = [root];
  while (pending.length) {
    const process = pending.pop();
    if (tree.has(process.pid)) continue;
    tree.set(process.pid, process);
    for (const child of children.get(process.pid) || []) {
      if (child.startedAtMs >= process.startedAtMs) pending.push(child);
    }
  }
  return tree;
}

function treesOverlap(left, right) {
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const pid of smaller.keys()) if (larger.has(pid)) return true;
  return false;
}

function sumTree(tree, field) {
  let total = 0;
  for (const process of tree.values()) total += process[field];
  return total;
}

function counterDelta(current, previous, field) {
  let delta = 0;
  let matches = 0;
  for (const process of current.values()) {
    const prior = previous.get(`${process.pid}:${process.identity}`);
    if (!prior) continue;
    matches += 1;
    const change = process[field] - prior[field];
    if (change < 0) return null;
    delta += change;
  }
  return matches > 0 ? delta : null;
}

function processBaselines(tree) {
  return new Map([...tree.values()].map((process) => [`${process.pid}:${process.identity}`, process]));
}

function sameOwnerTargets(targets) {
  const groups = new Map();
  for (const target of targets.values()) {
    if (target.status !== "available") continue;
    const ownerKey = `${target.pid}:${target.identity}`;
    const current = groups.get(ownerKey) || [];
    current.push(target.sessionId);
    groups.set(ownerKey, current);
  }
  return new Set([...groups.values()].filter((ids) => ids.length > 1).flat());
}

/**
 * Creates a request-driven, process-wide sampler. Its returned state contains
 * measurements only; process identifiers and collector configuration remain private.
 */
export function createResourceUsageSampler(options = {}) {
  const now = options.now || (() => Date.now());
  const platform = options.platform || process.platform;
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(1, options.intervalMs) : DEFAULT_INTERVAL_MS;
  const windowMs = Number.isFinite(options.windowMs) ? Math.max(intervalMs, options.windowMs) : DEFAULT_WINDOW_MS;
  const maximumSamples = Math.max(2, Math.ceil(windowMs / intervalMs) + 1);
  const collectionTimeoutMs = Number.isFinite(options.collectionTimeoutMs)
    ? Math.max(1, options.collectionTimeoutMs)
    : 5_000;
  const logicalProcessorCount = Number.isFinite(options.logicalProcessorCount)
    ? Math.max(1, options.logicalProcessorCount)
    : Math.max(1, os.availableParallelism());
  const readSnapshot = options.readSnapshot || (() => defaultReadSnapshot(options));
  const states = new Map();
  let activeSessionIds = new Set();
  let lastAttemptAt = null;
  let inFlight = null;

  function stateFor(target) {
    const ownerKey = target.status === "available" ? `${target.pid}:${target.identity}` : null;
    const existing = states.get(target.sessionId);
    if (!existing || existing.ownerKey !== ownerKey) {
      const state = createState(ownerKey);
      states.set(target.sessionId, state);
      return state;
    }
    return existing;
  }

  function results() {
    return new Map([...activeSessionIds].map((sessionId) => [sessionId, publicState(states.get(sessionId))]));
  }

  function boundedSnapshot() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ failed: true }), collectionTimeoutMs);
      Promise.resolve()
        .then(() => readSnapshot())
        .then((value) => finish({ failed: false, value }), () => finish({ failed: true }));
    });
  }

  return {
    async sample(inputTargets) {
      const targets = normalizedTargets(inputTargets);
      activeSessionIds = new Set(targets.keys());
      for (const sessionId of [...states.keys()]) if (!activeSessionIds.has(sessionId)) states.delete(sessionId);

      const nowMs = Number(now());
      const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
      const timestamp = safeTimestamp(safeNowMs);
      const fixedUnavailable = new Set();
      for (const target of targets.values()) {
        const state = stateFor(target);
        if (platform !== "win32") {
          unavailable(state, "unsupported_platform", timestamp, { reset: true });
          fixedUnavailable.add(target.sessionId);
        } else if (target.status === "shared") {
          unavailable(state, "shared_owner", timestamp, { reset: true });
          fixedUnavailable.add(target.sessionId);
        } else if (target.status !== "available") {
          unavailable(state, "missing_owner", timestamp, { reset: true });
          fixedUnavailable.add(target.sessionId);
        }
      }
      if (platform !== "win32") return results();

      const exactShared = sameOwnerTargets(targets);
      for (const sessionId of exactShared) {
        const state = states.get(sessionId);
        unavailable(state, "shared_owner", timestamp, { reset: true });
      }

      const available = [...targets.values()].filter((target) => (
        target.status === "available" && !fixedUnavailable.has(target.sessionId)
      ));
      if (available.length === 0) return results();
      if (inFlight) {
        await inFlight;
        return results();
      }
      if (lastAttemptAt !== null && safeNowMs - lastAttemptAt < intervalMs) return results();
      lastAttemptAt = safeNowMs;

      const pending = boundedSnapshot();
      inFlight = pending;
      const outcome = await pending;
      if (inFlight === pending) inFlight = null;
      if (outcome.failed) {
        for (const target of available) {
          unavailable(states.get(target.sessionId), "collection_failed", timestamp, {
            gap: true, nowMs: safeNowMs, windowMs, maximumSamples,
          });
        }
        return results();
      }
      const byPid = normalizeSnapshot(outcome.value);

      const trees = new Map();
      for (const target of available) {
        const state = states.get(target.sessionId);
        const owner = byPid.get(target.pid);
        if (!owner) {
          unavailable(state, "owner_not_found", timestamp, {
            gap: true, nowMs: safeNowMs, windowMs, maximumSamples,
          });
        } else if (owner.identity !== target.identity) {
          unavailable(state, "owner_identity_mismatch", timestamp, { reset: true });
        } else {
          trees.set(target.sessionId, processTree(owner, byPid));
        }
      }

      const overlapping = new Set();
      const treeEntries = [...trees.entries()];
      for (let left = 0; left < treeEntries.length; left += 1) {
        for (let right = left + 1; right < treeEntries.length; right += 1) {
          if (!treesOverlap(treeEntries[left][1], treeEntries[right][1])) continue;
          overlapping.add(treeEntries[left][0]);
          overlapping.add(treeEntries[right][0]);
        }
      }
      for (const sessionId of new Set([...exactShared, ...overlapping])) {
        unavailable(states.get(sessionId), "shared_owner", timestamp, { reset: true });
        trees.delete(sessionId);
      }

      for (const [sessionId, tree] of trees) {
        const state = states.get(sessionId);
        const memoryBytes = sumTree(tree, "memoryBytes");
        const elapsedMs = state.lastSampleAt === null ? null : safeNowMs - state.lastSampleAt;
        const cpuDelta = elapsedMs > 0 && state.previousProcesses
          ? counterDelta(tree, state.previousProcesses, "cpuTimeMs")
          : null;
        const readDelta = elapsedMs > 0 && state.previousProcesses
          ? counterDelta(tree, state.previousProcesses, "readBytes")
          : null;
        const writeDelta = elapsedMs > 0 && state.previousProcesses
          ? counterDelta(tree, state.previousProcesses, "writeBytes")
          : null;
        const cpuCores = cpuDelta === null ? null : Math.min(logicalProcessorCount, cpuDelta / elapsedMs);
        const cpuMachinePercent = cpuCores === null ? null : Math.min(100, cpuCores / logicalProcessorCount * 100);
        const seconds = elapsedMs === null ? null : elapsedMs / 1_000;
        const readBytesPerSecond = readDelta === null || !(seconds > 0) ? null : readDelta / seconds;
        const writeBytesPerSecond = writeDelta === null || !(seconds > 0) ? null : writeDelta / seconds;
        const current = {
          cpuCores,
          cpuMachinePercent,
          memoryBytes,
          readBytesPerSecond,
          writeBytesPerSecond,
        };
        state.status = cpuCores === null || readBytesPerSecond === null || writeBytesPerSecond === null
          ? "collecting"
          : "ready";
        state.reason = null;
        state.current = current;
        state.observedPeak = {
          memoryBytes: Math.max(state.observedPeak?.memoryBytes || 0, memoryBytes),
        };
        addSample(state, { timestamp, ...current }, safeNowMs, windowMs, maximumSamples);
        state.previousProcesses = processBaselines(tree);
        state.lastSampleAt = safeNowMs;
      }

      return results();
    },

    get(sessionId) {
      return activeSessionIds.has(sessionId) ? publicState(states.get(sessionId)) : null;
    },

    clear(sessionId) {
      if (typeof sessionId === "string") {
        states.delete(sessionId);
        activeSessionIds.delete(sessionId);
      } else {
        states.clear();
        activeSessionIds.clear();
        lastAttemptAt = null;
      }
    },
  };
}
