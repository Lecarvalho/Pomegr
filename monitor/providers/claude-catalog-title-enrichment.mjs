import { fileIdentity } from "./claude-file-generation.mjs";
import { scanSessionTitleState, sessionTitleState } from "./claude-session-identity.mjs";

const MAX_ENTRIES = 64;
const MAX_CONCURRENT_SCANS = 1;

function sameSnapshot(left, right) {
  return Boolean(left && right
    && left.identity === right.identity
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs);
}

function snapshot(stat) {
  return stat?.isFile() ? { identity: fileIdentity(stat), size: stat.size, mtimeMs: stat.mtimeMs } : null;
}

function displayTitle(state) {
  return state?.customTitle || state?.aiTitle || "Untitled session";
}

function appendCompatible(previous, current) {
  return Boolean(previous && current && previous.identity === current.identity
    && current.size > previous.size && current.mtimeMs >= previous.mtimeMs);
}

/**
 * Catalog titles are an enrichment, rather than a prerequisite for a live
 * catalog. A bounded tail can publish immediately; one serialized complete
 * scan later replaces it only when the same source snapshot still exists.
 */
export function createClaudeCatalogTitleEnrichment({ statSafe, scanTitleState = scanSessionTitleState }) {
  if (typeof statSafe !== "function") throw new TypeError("Claude title enrichment requires statSafe");
  if (typeof scanTitleState !== "function") throw new TypeError("Claude title enrichment requires a title scanner");
  const cache = new Map();
  const fallbacks = new Map();
  const pending = new Map();
  const queue = [];
  const listeners = new Set();
  let active = 0;
  let enabled = false;
  let generation = 0;

  function touch(file, value) {
    cache.delete(file);
    cache.set(file, value);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }

  function touchFallback(file, value) {
    fallbacks.delete(file);
    fallbacks.set(file, value);
    while (fallbacks.size > MAX_ENTRIES) fallbacks.delete(fallbacks.keys().next().value);
  }

  function readCached(file, stat) {
    const value = cache.get(file);
    if (!sameSnapshot(value, snapshot(stat))) return null;
    touch(file, value);
    return value;
  }

  function notify(file) {
    for (const listener of listeners) {
      try { listener(file); } catch { /* Catalog wakeups are advisory. */ }
    }
  }

  function drain() {
    while (active < MAX_CONCURRENT_SCANS && queue.length) {
      const job = queue.shift();
      active += 1;
      void (async () => {
        try {
          const before = job.previous;
          const appendOnly = before?.complete === true && before.identity === job.expected.identity
            && job.expected.size > before.size && job.expected.mtimeMs >= before.mtimeMs;
          const state = await scanTitleState(job.file, job.stat, appendOnly ? before : {},
            appendOnly ? Math.max(0, before.size - 16 * 1024) : 0);
          if (!enabled || generation !== job.generation || !sameSnapshot(snapshot(statSafe(job.file)), job.expected)) return;
          const replacement = { ...job.expected, ...state, complete: true };
          const published = sameSnapshot(fallbacks.get(job.file), job.expected) ? fallbacks.get(job.file) : before;
          const changed = displayTitle(published) !== displayTitle(replacement)
            || (published?.createdAt || "") !== (replacement.createdAt || "");
          touch(job.file, replacement);
          fallbacks.delete(job.file);
          if (changed) notify(job.file);
        } catch {
          // The fast fallback remains usable. A later source observation may retry.
        } finally {
          if (pending.get(job.file)?.generation === job.generation) pending.delete(job.file);
          job.resolve();
          active -= 1;
          if (queue.length) setImmediate(drain);
        }
      })();
    }
  }

  function schedule(file, stat) {
    const expected = snapshot(stat);
    const prior = pending.get(file);
    if (!enabled || !expected || (prior && prior.generation === generation) || pending.size >= MAX_ENTRIES) return prior?.promise || Promise.resolve();
    let resolve;
    const done = new Promise((finish) => { resolve = finish; });
    pending.set(file, { promise: done, generation });
    queue.push({ file, stat, expected, previous: cache.get(file) || null, generation, resolve });
    // Never begin the complete scan inside catalog construction.
    setImmediate(drain);
    return done;
  }

  function fast(file, stat, tailRecords) {
    const cached = readCached(file, stat);
    if (cached?.complete) return { title: displayTitle(cached), createdAt: cached.createdAt || null };
    const fallback = fallbacks.get(file);
    if (sameSnapshot(fallback, snapshot(stat))) return { title: displayTitle(fallback), createdAt: fallback.createdAt || null };
    const previous = appendCompatible(fallback, snapshot(stat)) ? fallback : cache.get(file);
    const appendOnly = appendCompatible(previous, snapshot(stat));
    const state = sessionTitleState(tailRecords, appendOnly ? previous : {});
    const value = { ...snapshot(stat), ...state, complete: false };
    schedule(file, stat);
    touchFallback(file, value);
    return { title: displayTitle(value), createdAt: value.createdAt || null };
  }

  async function exact(file, stat, tailRecords) {
    const cached = readCached(file, stat);
    if (cached?.complete) return { title: displayTitle(cached), createdAt: cached.createdAt || null };
    const previous = cache.get(file);
    const appendOnly = previous?.complete === true && previous.identity === snapshot(stat)?.identity
      && stat.size > previous.size && stat.mtimeMs >= previous.mtimeMs;
    try {
      const state = await scanTitleState(file, stat, appendOnly ? previous : {},
        appendOnly ? Math.max(0, previous.size - 16 * 1024) : 0);
      if (sameSnapshot(snapshot(statSafe(file)), snapshot(stat))) {
        const value = { ...snapshot(stat), ...state, complete: true };
        touch(file, value);
        return { title: displayTitle(value), createdAt: value.createdAt || null };
      }
    } catch {
      // Direct compatibility reads retain their bounded tail fallback.
    }
    const state = sessionTitleState(tailRecords, appendOnly ? previous : {});
    return { title: displayTitle(state), createdAt: state.createdAt || null };
  }

  function ensure(file, stat) {
    const cached = readCached(file, stat);
    if (cached?.complete || !sameSnapshot(fallbacks.get(file), snapshot(stat))) return;
    schedule(file, stat);
  }

  function metadata(file, stat) {
    const current = snapshot(stat);
    const cached = cache.get(file);
    const fallback = fallbacks.get(file);
    const value = readCached(file, stat)
      || (sameSnapshot(fallback, current) || appendCompatible(fallback, current) ? fallback : null)
      || (appendCompatible(cached, current) ? cached : null);
    return value ? `${displayTitle(value)}\0${value.createdAt || ""}` : "";
  }

  return {
    fast,
    exact,
    ensure,
    metadata,
    activate() {
      enabled = true;
      generation += 1;
    },
    stop() {
      enabled = false;
      generation += 1;
      for (const job of queue.splice(0)) {
        if (pending.get(job.file)?.generation === job.generation) pending.delete(job.file);
        job.resolve();
      }
    },
    prune(visibleFiles) {
      for (const file of cache.keys()) if (!visibleFiles.has(file) && !statSafe(file)) cache.delete(file);
      for (const file of fallbacks.keys()) if (!visibleFiles.has(file) && !statSafe(file)) fallbacks.delete(file);
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Claude title listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
