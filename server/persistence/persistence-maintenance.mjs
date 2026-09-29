/** Incremental P maintenance owns one low-priority batch per turn, never GETs. */
export function createPersistenceMaintenance({
  steps = [], isBusy = () => false, intervalMs = 1_000, budget = 32,
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  if (!Array.isArray(steps) || steps.some((step) => typeof step !== "function")
    || !Number.isSafeInteger(budget) || budget < 1 || budget > 256) {
    throw new TypeError("Invalid persistence maintenance configuration");
  }
  let stopped = true;
  let timer = null;
  let running = null;
  let cursor = 0;
  const qa = { batches: 0, deferred: 0, failed: 0 };
  function arm() {
    if (stopped || timer !== null || steps.length === 0) return;
    timer = schedule(tick, Math.max(1, intervalMs));
    timer?.unref?.();
  }
  async function tick() {
    timer = null;
    if (stopped) return;
    if (isBusy()) { qa.deferred += 1; arm(); return; }
    const step = steps[cursor++ % steps.length];
    running = Promise.resolve().then(() => step({ budget, shouldYield: () => stopped || isBusy() }));
    try { await running; qa.batches += 1; } catch { qa.failed += 1; }
    finally { running = null; arm(); }
  }
  return Object.freeze({
    start() { if (!stopped) return; stopped = false; arm(); },
    async stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
      try { await running; } catch { /* tick records the sanitized failure */ }
    },
    stats: () => Object.freeze({ ...qa, active: Number(running !== null) }),
  });
}
