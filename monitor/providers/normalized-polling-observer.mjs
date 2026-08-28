/**
 * Transitional adapter-local observer.  It intentionally knows nothing about
 * a provider's transcript format: an adapter supplies acquisition and
 * normalization closures, while this worker only schedules publication of
 * their already-normalized results.  Native incremental cursors and partial
 * record fragments remain adapter-private and can replace `read` without
 * changing the observer lifecycle.
 */
export { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";

export function createNormalizedPollingObserver(options) {
  const {
    list,
    read,
    ingest,
    intervalMs = 10_000,
    concurrency = 2,
    watchTargets = [],
  } = options || {};
  const acquire = ingest || read;
  if (typeof list !== "function" || typeof acquire !== "function") {
    throw new TypeError("Normalized polling observer requires list and ingest functions");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 100) {
    throw new TypeError("Normalized polling observer interval must be at least 100 ms");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new TypeError("Normalized polling observer concurrency must be between 1 and 16");
  }

  let publisher = null;
  let signal = null;
  let timer = null;
  let refreshPending = false;
  let refreshQueued = false;
  let stopped = false;
  const watchers = [];
  const hydrating = new Map();
  const qa = { reconciliationRuns: 0, watcherWakeups: 0, hydrationAttempts: 0, candidatesPublished: 0, acquisitionFailures: 0 };

  async function hydrate(localSessionId) {
    if (stopped || !publisher) return false;
    qa.hydrationAttempts += 1;
    const active = hydrating.get(localSessionId);
    if (active) return active;
    const task = (async () => {
      try {
        const candidate = await acquire(localSessionId, publisher);
        if (!stopped && !signal?.aborted && candidate) {
          publisher.publishSession(localSessionId, candidate);
          qa.candidatesPublished += 1;
        }
        return Boolean(candidate);
      } catch {
        // Acquisition errors are intentionally isolated.  A previous committed
        // value remains visible; adapter-native failure content never escapes.
        qa.acquisitionFailures += 1;
        return false;
      } finally {
        hydrating.delete(localSessionId);
      }
    })();
    hydrating.set(localSessionId, task);
    return task;
  }

  async function hydrateEntries(entries) {
    const queue = entries.map((entry) => entry.localId);
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (!stopped && !signal?.aborted) {
        const localSessionId = queue.shift();
        if (!localSessionId) return;
        await hydrate(localSessionId);
      }
    });
    await Promise.all(workers);
  }

  async function refresh() {
    if (refreshPending) {
      refreshQueued = true;
      return;
    }
    if (stopped || signal?.aborted || !publisher) return;
    refreshPending = true;
    qa.reconciliationRuns += 1;
    try {
      const entries = await list();
      if (!Array.isArray(entries) || stopped || signal?.aborted) return;
      publisher.publishCatalog(entries);
      await hydrateEntries(entries);
    } catch {
      // The registry records observer failures.  Do not erase an existing
      // catalog or publish an incomplete replacement here.
    } finally {
      refreshPending = false;
      if (refreshQueued && !stopped && !signal?.aborted) {
        refreshQueued = false;
        queueMicrotask(() => { void refresh(); });
      }
    }
  }

  function watchSource(target) {
    if (typeof target !== "string" || !target) return;
    const wake = () => { qa.watcherWakeups += 1; void refresh(); };
    try {
      watchers.push(fs.watch(target, { recursive: true }, wake));
    } catch {
      try { watchers.push(fs.watch(target, wake)); } catch { /* reconciliation remains authoritative */ }
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const watcher of watchers.splice(0)) {
      try { watcher.close(); } catch { /* best-effort observer shutdown */ }
    }
  }

  return Object.freeze({
    async start(nextPublisher, nextSignal) {
      if (publisher) throw new TypeError("Provider observer has already started");
      if (!nextPublisher || typeof nextPublisher.publishCatalog !== "function"
        || typeof nextPublisher.publishSession !== "function"
        || typeof nextPublisher.invalidateSession !== "function") {
        throw new TypeError("Provider observer requires a scoped normalized publisher");
      }
      if (!nextSignal || typeof nextSignal.addEventListener !== "function") {
        throw new TypeError("Provider observer requires an AbortSignal");
      }
      publisher = nextPublisher;
      signal = nextSignal;
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener("abort", stop, { once: true });
      timer = setInterval(() => { void refresh(); }, intervalMs);
      timer.unref?.();
      for (const target of watchTargets) watchSource(target);
      void refresh();
    },
    hydrate,
    listSessions: list,
    stop,
    diagnostics: () => Object.freeze({ ...qa, activeHydrations: hydrating.size }),
  });
}
import fs from "node:fs";
