/**
 * @template T
 * @param {{load: (options: {fresh: boolean}) => Promise<T>, cacheMs: number, now: () => number}} options
 */
export function createCodexCatalogCache({ load, cacheMs, now }) {
  /** @type {{expiresAt: number, value: T} | null} */
  let cache = null;
  /** @type {{generation: number, promise: Promise<T>} | null} */
  let pending = null;
  let generation = 0;

  /** @param {{fresh?: boolean}} [readOptions] */
  async function read(readOptions = {}) {
    const fresh = readOptions.fresh === true;
    if (fresh) {
      generation += 1;
      cache = null;
    }
    const requestedGeneration = generation;
    if (!fresh && cache && now() < cache.expiresAt) return cache.value;
    while (pending) {
      const active = pending;
      const value = await active.promise;
      if (!fresh && active.generation === requestedGeneration && requestedGeneration === generation) return value;
    }
    if (!fresh && cache && now() < cache.expiresAt) return cache.value;
    const loadGeneration = generation;
    const promise = load({ fresh }).then((value) => {
      if (loadGeneration === generation) cache = { expiresAt: now() + cacheMs, value };
      return value;
    });
    const active = { generation: loadGeneration, promise };
    pending = active;
    try {
      return await promise;
    } finally {
      if (pending === active) pending = null;
    }
  }

  // A selected-session read may use the last bounded snapshot as an exact
  // locator. It must not await an unrelated refresh just to find a known row.
  function peek() { return cache?.value || []; }

  return Object.freeze({ read, peek, pending: () => Boolean(pending) });
}
