import { createOfficialProviderReleaseReaders, createProviderModelReaders } from "../providers/index.mjs";

const SIX_HOURS = 6 * 60 * 60_000;
/** One low-priority, single-flight job; failures retain last committed facts. */
export function createReleaseObservation({ readers = createOfficialProviderReleaseReaders(), accept, setTimer = setTimeout,
  clearTimer = clearTimeout, jitter = Math.random, initialDelayMs = 30_000,
  modelReaders = null, modelOptions = {}, acceptModels = () => {}, now = Date.now } = {}) {
  if (!Array.isArray(readers) || readers.length > 2 || typeof accept !== "function") throw new TypeError("Invalid release observation");
  let active = false;
  let timer = null;
  let pending = null;
  const models = modelReaders || createProviderModelReaders(modelOptions);
  const sources = [...readers.map((read) => ({ read, interval: SIX_HOURS, models: false, due: 0 })),
    ...models.announcements.map((read) => ({ read, interval: SIX_HOURS, models: true, due: 0 })),
    ...models.catalogs.map((read) => ({ read, interval: 60 * 60_000, models: true, due: 0 }))];
  function schedule(delay) {
    if (!active) return;
    timer = setTimer(() => { timer = null; void refresh().finally(() => {
      const next = Math.min(...sources.map((source) => source.due));
      schedule(Math.max(60_000, Math.min(SIX_HOURS, next - now())) + Math.floor(Math.max(0, Math.min(1, jitter())) * 60_000));
    }); }, delay);
    timer?.unref?.();
  }
  function refresh() {
    if (!active) return Promise.resolve([]);
    if (pending) return pending;
    const due = sources.filter((source) => source.due <= now());
    for (const source of due) source.due = now() + source.interval;
    pending = Promise.allSettled(due.map((source) => {
      try { return Promise.resolve(source.read()); } catch (error) { return Promise.reject(error); }
    })).then((results) => {
      const observations = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
      const releases = observations.filter((row) => row.product);
      const models = observations.filter((row) => !row.product);
      if (active && releases.length) accept(releases);
      if (active && models.length) acceptModels(models);
      return observations;
    }).finally(() => { pending = null; });
    return pending;
  }
  return Object.freeze({
    start() { if (active) return; active = true; schedule(initialDelayMs); },
    refresh,
    async stop() { active = false; if (timer !== null) clearTimer(timer); timer = null;
      for (const source of sources) source.read.stop?.(); await pending?.catch(() => {}); },
  });
}
