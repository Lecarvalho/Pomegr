const MAX_RETRIES = 32;
const MAX_RETRY_BYTES = 16 * 1024 * 1024;

function merge(previous, next) {
  if (!previous) return next;
  if (next.epoch < previous.epoch || next.epoch === previous.epoch && next.sequence <= previous.sequence) return previous;
  if (next.epoch !== previous.epoch) return next;
  const result = { ...next };
  for (const field of ["activity", "requests"]) {
    if (!Array.isArray(previous[field]) && !Array.isArray(next[field])) continue;
    const rows = new Map((previous[field] || []).map((row) => [row.id, row]));
    for (const row of next[field] || []) rows.set(row.id, row);
    result[field] = [...rows.values()];
  }
  return result;
}

/** Bounded failure backlog; later suffixes cannot pass an uncommitted predecessor. */
export function createHistoryContributionPublisher({ store, isActive, trace, scopeForSession,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  const retries = new Map();
  let retryBytes = 0;
  let generation = 0;
  function remove(key, pending) {
    if (retries.get(key) !== pending) return;
    retries.delete(key); retryBytes -= pending.bytes;
  }
  function retry(domain, sessionId, contribution, attempt = 1) {
    if (!isActive() || attempt > 3) return;
    const key = `${domain}:${sessionId}`;
    const existing = retries.get(key);
    contribution = merge(existing?.contribution, contribution);
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(contribution)); } catch { return; }
    if (retryBytes - (existing?.bytes || 0) + bytes > MAX_RETRY_BYTES
      || (!existing && retries.size >= MAX_RETRIES)) return;
    if (existing) {
      if (existing.contribution === contribution) return;
      retryBytes += bytes - existing.bytes;
      existing.bytes = bytes; existing.contribution = contribution; existing.version += 1;
      return;
    }
    const pending = { contribution, bytes, timer: null, version: 1 };
    retries.set(key, pending); retryBytes += bytes;
    const owner = generation;
    pending.timer = schedule(() => {
      if (retries.get(key) !== pending || !isActive() || generation !== owner) { remove(key, pending); return; }
      const version = pending.version;
      perform(domain, sessionId, pending.contribution).then(() => {
        if (retries.get(key) !== pending) return;
        remove(key, pending);
        if (isActive() && version !== pending.version) retry(domain, sessionId, pending.contribution, attempt);
      }, () => {
        if (retries.get(key) !== pending) return;
        remove(key, pending);
        retry(domain, sessionId, pending.contribution, attempt + 1);
      });
    }, attempt * 100);
  }
  function perform(domain, sessionId, contribution) {
    const scope = scopeForSession?.(sessionId) || null;
    const flow = trace?.createFlow?.({ scope }) || null;
    const span = trace?.begin?.({ stage: "history_contribution", domain, flow, scope }) || null;
    const method = domain === "requests" ? "publishRequestContribution" : "publishActivityContribution";
    return Promise.resolve().then(() => store[method](sessionId, contribution)).then((record) => {
      trace?.end?.(span, { outcome: record ? "accepted" : "unchanged" });
      trace?.finishFlow?.(flow, { outcome: record ? "completed" : "rejected" });
      return record;
    }, (error) => {
      trace?.end?.(span, { outcome: "failed" });
      trace?.finishFlow?.(flow, { outcome: "failed" });
      throw error;
    });
  }
  return Object.freeze({
    publish(domain, sessionId, contribution) {
      if (!isActive()) return Promise.resolve(null);
      if (retries.has(`${domain}:${sessionId}`)) {
        retry(domain, sessionId, contribution);
        return Promise.resolve(null);
      }
      const owner = generation;
      return perform(domain, sessionId, contribution).catch(() => {
        if (generation === owner) retry(domain, sessionId, contribution);
        return null;
      });
    },
    busy: () => retries.size > 0,
    stop() {
      generation += 1;
      for (const pending of retries.values()) cancel(pending.timer);
      retries.clear(); retryBytes = 0;
    },
  });
}
