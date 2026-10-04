import { createOfficialProviderReleaseReaders } from "../providers/index.mjs";

const SIX_HOURS = 6 * 60 * 60_000;
/** One low-priority, single-flight job; failures retain last committed facts. */
export function createReleaseObservation({ readers = createOfficialProviderReleaseReaders(), accept, setTimer = setTimeout,
  clearTimer = clearTimeout, jitter = Math.random, initialDelayMs = 30_000 } = {}) {
  if (!Array.isArray(readers) || readers.length > 2 || typeof accept !== "function") throw new TypeError("Invalid release observation");
  let active = false;
  let timer = null;
  let pending = null;
  function schedule(delay) {
    if (!active) return;
    timer = setTimer(() => { timer = null; void refresh().finally(() => schedule(SIX_HOURS + Math.floor(Math.max(0, Math.min(1, jitter())) * 15 * 60_000))); }, delay);
    timer?.unref?.();
  }
  function refresh() {
    if (!active) return Promise.resolve([]);
    if (pending) return pending;
    pending = Promise.allSettled(readers.map((read) => read())).then((results) => {
      const observations = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
      if (active && observations.length) accept(observations);
      return observations;
    }).finally(() => { pending = null; });
    return pending;
  }
  return Object.freeze({
    start() { if (active) return; active = true; schedule(initialDelayMs); },
    refresh,
    async stop() { active = false; if (timer !== null) clearTimer(timer); timer = null;
      for (const read of readers) read.stop?.(); await pending?.catch(() => {}); },
  });
}
