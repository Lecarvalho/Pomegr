import { createCommittedResponseCache } from "./committed-response-cache.mjs";
import { openMonitorStore } from "./monitor-store.mjs";
import { buildStorageReadiness, readStorageFacts, runRetention } from "./store-retention.mjs";

const DEFAULT_PRUNE_MIN_INTERVAL_MS = 5 * 60_000;

function readLastPrunedAt(store) {
  try {
    const row = store.database.prepare("SELECT value FROM meta WHERE key = 'last_pruned_at'").get();
    const parsed = row ? Number(row.value) : null;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistLastPrunedAt(store, prunedAtMs) {
  try {
    store.transaction(() => {
      store.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_pruned_at', ?)").run(String(prunedAtMs));
    });
  } catch { /* best-effort persistence; in-memory readiness still reflects the latest prune */ }
}

/**
 * Wraps a checkpoint store so a successful write() also notifies the store runtime.
 * Every other method (load, stats, and any future addition) stays bound to the original
 * instance so its private fields keep resolving correctly. A falsy input passes through.
 */
export function wrapCheckpointStoreForStore(checkpointStore, notifyWrite) {
  if (!checkpointStore) return checkpointStore;
  return new Proxy(checkpointStore, {
    get(target, property, receiver) {
      if (property === "write") {
        return async (...args) => {
          const result = await target.write(...args);
          try { notifyWrite(); } catch { /* store scheduling never blocks checkpoint writes */ }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The single seam later parts (file-change indexing, resource-history writers) extend
 * through `registerContributor`. Owns the store's open/rebuild lifecycle, the committed
 * storage-readiness response, and the checkpoint-triggered retention cadence.
 */
export function createMonitorStoreRuntime({
  directory,
  settings,
  now = Date.now,
  pruneMinIntervalMs = DEFAULT_PRUNE_MIN_INTERVAL_MS,
  openStore = openMonitorStore,
  retention = { runRetention, readStorageFacts, buildStorageReadiness },
} = {}) {
  if (!settings || typeof settings.thresholdBytes !== "number") {
    throw new TypeError("Monitor store runtime requires resolved retention settings");
  }
  const cache = createCommittedResponseCache({ includeRevision: true, now });
  const contributors = new Map();
  let openedStore = null;
  let openFailed = !directory;
  let lastPrunedAtMs = null;
  let completedCycles = 0;
  let facts = { databaseBytes: null, oldestRetainedDay: null, cleanupStatus: null };
  let cycleState = "idle"; // idle | scheduled | running
  let pendingAfterRunning = false;
  let cyclePromise = null;
  let startPromise = null;

  function readinessKind() {
    if (!openedStore) return openFailed ? "unavailable" : "loading";
    if (!openedStore.rebuilt) return "ready";
    if (contributors.size === 0) return completedCycles > 0 ? "ready" : "rebuilding";
    for (const contributor of contributors.values()) {
      let complete = false;
      try { complete = contributor.rebuildComplete() === true; } catch { complete = false; }
      if (!complete) return "rebuilding";
    }
    return "ready";
  }

  function commitReadiness(commitOptions = {}) {
    const readiness = readinessKind();
    const unavailable = readiness === "unavailable";
    return cache.commit(retention.buildStorageReadiness({
      readiness,
      settings,
      databaseBytes: unavailable ? null : facts.databaseBytes,
      oldestRetainedDay: unavailable ? null : facts.oldestRetainedDay,
      lastPrunedAt: lastPrunedAtMs === null ? null : new Date(lastPrunedAtMs).toISOString(),
      cleanupStatus: unavailable ? null : facts.cleanupStatus,
    }), commitOptions);
  }

  // "loading" (a directory is configured) or "unavailable" (persistence disabled). A fixed
  // observedAt keeps this construction-time commit from invoking the shared `now` clock
  // before any real lifecycle event (start, a cycle) runs.
  commitReadiness({ observedAt: 0 });

  async function runOneCycle() {
    if (!openedStore) return;
    const nowMs = now();
    for (const contributor of contributors.values()) {
      try { await contributor.onCheckpoint(openedStore, { now: nowMs }); }
      catch { /* a failing contributor degrades alone; other contributors and retention still run */ }
    }
    const dueForPrune = lastPrunedAtMs === null || (nowMs - lastPrunedAtMs) >= pruneMinIntervalMs;
    if (dueForPrune) {
      const result = await retention.runRetention(openedStore, settings, { now: nowMs });
      lastPrunedAtMs = result.prunedAt;
      persistLastPrunedAt(openedStore, lastPrunedAtMs);
      facts = { databaseBytes: result.databaseBytes, oldestRetainedDay: result.oldestRetainedDay, cleanupStatus: result.cleanupStatus };
    } else {
      const read = await retention.readStorageFacts(openedStore);
      const pending = Number.isFinite(read.databaseBytes) && read.databaseBytes >= settings.thresholdBytes;
      facts = { databaseBytes: read.databaseBytes, oldestRetainedDay: read.oldestRetainedDay, cleanupStatus: pending ? "cleanup_pending" : "normal" };
    }
  }

  async function runCycle() {
    cycleState = "running";
    do {
      pendingAfterRunning = false;
      try { await runOneCycle(); } catch { /* handled per-step above; a cycle never throws out */ }
      completedCycles += 1;
      commitReadiness();
    } while (pendingAfterRunning);
    cycleState = "idle";
  }

  function afterCheckpointWrite() {
    if (!openedStore) return;
    if (cycleState === "running") { pendingAfterRunning = true; return; }
    if (cycleState === "idle") {
      cycleState = "scheduled";
      // Assigned synchronously (not inside the setImmediate callback) so a stop() called
      // during the "scheduled" window still finds and awaits the pending cycle.
      cyclePromise = new Promise((resolve) => {
        setImmediate(() => { runCycle().finally(() => { cyclePromise = null; resolve(); }); });
      });
    }
    // cycleState === "scheduled": a cycle is already queued; this write coalesces into it.
  }

  async function start() {
    if (!directory) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        openedStore = await openStore({ directory });
        lastPrunedAtMs = readLastPrunedAt(openedStore);
        const initial = await retention.readStorageFacts(openedStore);
        facts = { databaseBytes: initial.databaseBytes, oldestRetainedDay: initial.oldestRetainedDay, cleanupStatus: null };
      } catch {
        openedStore = null;
        openFailed = true;
      }
      commitReadiness();
    })();
    return startPromise;
  }

  async function stop() {
    if (cyclePromise) { try { await cyclePromise; } catch { /* handled inside the cycle */ } }
    if (openedStore) { try { openedStore.close(); } catch { /* best-effort close */ } }
    openedStore = null;
    startPromise = null;
  }

  function registerContributor(contributor) {
    if (!contributor || typeof contributor.name !== "string" || typeof contributor.onCheckpoint !== "function"
      || typeof contributor.rebuildComplete !== "function") {
      throw new TypeError("Monitor store contributors require a name, onCheckpoint, and rebuildComplete");
    }
    contributors.set(contributor.name, contributor);
  }

  return Object.freeze({
    start,
    stop,
    afterCheckpointWrite,
    serveStorage: (revision) => cache.read(revision),
    registerContributor,
    store: () => openedStore,
  });
}
