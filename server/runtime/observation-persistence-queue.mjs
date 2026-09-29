/**
 * A small in-process persistence owner for normalized observations.  Queue
 * byte accounting deliberately counts only bounded persistence fields using
 * string lengths and fixed object overhead; it never serializes public state
 * (which could both allocate a large temporary string and violate the
 * persistence boundary).  The estimate is an admission bound, not disk size.
 */
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 100;

function boundedInteger(value, fallback, minimum = 0) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number >= minimum ? number : fallback;
}

function persistenceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object"
    || typeof snapshot.providerId !== "string" || !snapshot.providerId
    || typeof snapshot.localSessionId !== "string" || !snapshot.localSessionId
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
    throw new TypeError("persistence snapshot is invalid");
  }
  return Object.freeze({
    providerId: snapshot.providerId,
    localSessionId: snapshot.localSessionId,
    revision: snapshot.revision,
    source: snapshot.source ?? null,
    evidence: snapshot.evidence,
    readiness: snapshot.readiness,
    observedAt: snapshot.observedAt,
  });
}

function estimateSnapshot(snapshot, limit) {
  const seen = new WeakSet();
  function valueBytes(value, depth = 0) {
    if (value === null || value === undefined) return 4;
    if (typeof value === "string") return value.length * 2 + 8;
    if (typeof value === "number" || typeof value === "boolean") return 16;
    if (typeof value !== "object" || depth >= 20 || seen.has(value)) return limit + 1;
    seen.add(value);
    let total = 24;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      total += key.length * 2 + 8 + valueBytes(value[key], depth + 1);
      if (total > limit) return limit + 1;
    }
    seen.delete(value);
    return total;
  }
  const total = 128 + valueBytes(snapshot.providerId) + valueBytes(snapshot.localSessionId)
    + valueBytes(snapshot.source) + valueBytes(snapshot.evidence) + valueBytes(snapshot.readiness)
    + valueBytes(snapshot.observedAt);
  return total > limit ? limit + 1 : total;
}

export function createObservationPersistenceQueue({
  write,
  maxPending = DEFAULT_MAX_PENDING,
  maxBytes = DEFAULT_MAX_BYTES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  onEvent = null,
  schedule = (task, delay) => setTimeout(task, delay),
  cancel = clearTimeout,
  now = Date.now,
} = {}) {
  if (typeof write !== "function") throw new TypeError("persistence write hook is required");
  maxPending = boundedInteger(maxPending, DEFAULT_MAX_PENDING, 1);
  maxBytes = boundedInteger(maxBytes, DEFAULT_MAX_BYTES, 1);
  maxAttempts = boundedInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, 1);
  retryDelayMs = boundedInteger(retryDelayMs, DEFAULT_RETRY_DELAY_MS, 0);
  const entries = new Map();
  const ready = new Set();
  let queuedBytes = 0;
  let running = false;
  let activeEntry = null;
  let draining = false;
  let stopped = false;
  let closing = false;
  let pumpPromise = null;
  let drainPromise = null;
  const counters = { admitted: 0, replaced: 0, rejected: 0, written: 0, failed: 0, exhausted: 0, retries: 0 };

  function emit(kind, { count = 1, waitedMs = 0 } = {}) {
    // The event object has a closed vocabulary and numeric facts only; queue
    // identities and snapshots remain monitor-private.
    try { onEvent?.(Object.freeze({ kind, count: Math.max(0, Math.floor(Number(count) || 0)), waitedMs: Math.max(0, Math.floor(Number(waitedMs) || 0)) })); } catch { /* diagnostics cannot block persistence */ }
  }
  function keyFor(snapshot) { return `${snapshot.providerId}\u0000${snapshot.localSessionId}`; }
  function remove(entry) {
    if (!entries.delete(entry.key)) return;
    queuedBytes -= entry.bytes;
    ready.delete(entry);
    if (entry.timer !== null) cancel(entry.timer);
    entry.timer = null;
  }
  function makeReady(entry) {
    if (stopped || !entries.has(entry.key) || entry.ready) return;
    entry.ready = true;
    ready.add(entry);
    requestPump();
  }
  function scheduleEntry(entry, dueAt) {
    if (entry.timer !== null) cancel(entry.timer);
    entry.timer = null;
    // One ready position per key, including while a write holds the pump.
    entry.ready = false;
    entry.dueAt = dueAt;
    const delay = Math.max(0, dueAt - now());
    if (delay === 0) makeReady(entry);
    else {
      ready.delete(entry);
      entry.timer = schedule(() => { entry.timer = null; makeReady(entry); }, delay);
    }
  }
  function requestPump() {
    // Even a zero-delay admission crosses an async turn.  Provider commit
    // publication must never spend its own synchronous turn in filesystem IO.
    if (!pumpPromise && !stopped) {
      pumpPromise = Promise.resolve().then(pump).finally(() => {
        pumpPromise = null;
        if (!stopped && ready.size) requestPump();
      });
    }
    return pumpPromise;
  }
  async function pump() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && ready.size) {
        const entry = ready.values().next().value;
        ready.delete(entry);
        if (!entries.has(entry.key) || !entry.ready) continue;
        entry.ready = false;
        const writingSnapshot = entry.snapshot;
        try {
          activeEntry = { bytes: entry.bytes };
          emit("started", { waitedMs: now() - entry.firstDirtyAt });
          await write(writingSnapshot);
          if (entry.snapshot === writingSnapshot) remove(entry);
          counters.written += 1;
          emit("completed");
        } catch {
          if (entry.snapshot !== writingSnapshot) continue;
          entry.attempt += 1;
          counters.failed += 1;
          if (entry.attempt >= maxAttempts) {
            remove(entry);
            counters.exhausted += 1;
            emit("exhausted");
            continue;
          }
          counters.retries += 1;
          emit("retry");
          // Retrying at the tail keeps an unrelated cold session from being
          // trapped behind a persistently failing hot session.
          scheduleEntry(entry, draining ? now() : now() + retryDelayMs);
        } finally { activeEntry = null; }
      }
    } finally {
      running = false;
    }
  }
  function enqueue(snapshot, { delayMs = 0, maxDelayMs = delayMs } = {}) {
    if (stopped || closing) return Object.freeze({ accepted: false, reason: "stopped" });
    let normalized;
    try { normalized = persistenceSnapshot(snapshot); }
    catch { return Object.freeze({ accepted: false, reason: "invalid" }); }
    const key = keyFor(normalized);
    const bytes = estimateSnapshot(normalized, maxBytes);
    if (bytes > maxBytes) {
      counters.rejected += 1; emit("rejected");
      return Object.freeze({ accepted: false, reason: "bytes" });
    }
    const existing = entries.get(key);
    if (!existing && (entries.size >= maxPending || queuedBytes + bytes > maxBytes)) {
      counters.rejected += 1; emit("rejected");
      return Object.freeze({ accepted: false, reason: entries.size >= maxPending ? "entries" : "bytes" });
    }
    if (existing) {
      // A durable revision newer than this replacement is never displaced.
      if (normalized.revision < existing.snapshot.revision) return Object.freeze({ accepted: true, replaced: false, stale: true });
      if (queuedBytes - existing.bytes + bytes > maxBytes) {
        counters.rejected += 1; emit("rejected");
        return Object.freeze({ accepted: false, reason: "bytes" });
      }
      queuedBytes += bytes - existing.bytes;
      existing.snapshot = normalized;
      existing.bytes = bytes;
      const delay = boundedInteger(delayMs, 0, 0);
      const maximum = Math.max(delay, boundedInteger(maxDelayMs, delay, 0));
      scheduleEntry(existing, draining ? now() : Math.min(now() + delay, existing.firstDirtyAt + maximum));
      counters.replaced += 1; emit("coalesced");
      return Object.freeze({ accepted: true, replaced: true, revision: normalized.revision });
    }
    const firstDirtyAt = now();
    const delay = boundedInteger(delayMs, 0, 0);
    const maximum = Math.max(delay, boundedInteger(maxDelayMs, delay, 0));
    const entry = { key, snapshot: normalized, bytes, attempt: 0, ready: false, timer: null,
      firstDirtyAt, dueAt: firstDirtyAt + Math.min(delay, maximum) };
    entries.set(key, entry);
    queuedBytes += bytes;
    counters.admitted += 1; emit("queued");
    scheduleEntry(entry, entry.dueAt);
    return Object.freeze({ accepted: true, replaced: false, revision: normalized.revision });
  }
  async function drain() {
    if (stopped) return Object.freeze({ pending: entries.size, stopped: true });
    draining = true;
    for (const entry of entries.values()) {
      if (!entry.ready) {
        if (entry.timer !== null) cancel(entry.timer);
        entry.timer = null;
        makeReady(entry);
      }
    }
    if (!drainPromise) {
      drainPromise = (async () => {
        while (!stopped && (pumpPromise || ready.size)) {
          if (pumpPromise) await pumpPromise;
          else requestPump();
        }
        return Object.freeze({ pending: entries.size, stopped });
      })().finally(() => { drainPromise = null; draining = false; });
    }
    return drainPromise;
  }
  async function stop() {
    closing = true;
    await drain();
    stopped = true;
    for (const entry of entries.values()) if (entry.timer !== null) cancel(entry.timer);
    entries.clear(); ready.clear(); queuedBytes = 0;
    return Object.freeze({ stopped: true });
  }
  return Object.freeze({
    enqueue,
    drain,
    stop,
    stats: () => Object.freeze({ pending: entries.size, ready: ready.size, active: activeEntry ? 1 : 0, bytes: Math.max(0, queuedBytes), activeBytes: activeEntry?.bytes || 0, maxPending, maxBytes,
      coalesced: counters.replaced, rejected: counters.rejected, retries: counters.retries, exhausted: counters.exhausted,
      admitted: counters.admitted, written: counters.written, failed: counters.failed }),
  });
}

export function checkpointFailureStage(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (message === "checkpoint exceeds byte budget") return "checkpoint_size";
  if (message === "checkpoint privacy validation failed") return "checkpoint_privacy";
  if (message === "checkpoint collection is invalid") return "checkpoint_collection";
  if (message === "checkpoint candidate was rejected") return "checkpoint_candidate";
  if (message.startsWith("checkpoint ")) return "checkpoint_validation";
  return "checkpoint_storage";
}

