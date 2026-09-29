import { statSafe } from "../session-discovery.mjs";
import { FILE_SUFFIX_SAMPLE_BYTES, fileIdentity, generationKey, readFileSuffixRaw } from "./claude-file-generation.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";

// A generation key is `identity|size|mtimeMs|suffixDigest`; `null` means "no generation" (never cache).
export { generationKey };

function buildGeneration(stat, raw) {
  if (!stat || !Number.isInteger(stat.size) || stat.size < 1) return null;
  if (!raw || raw.read !== raw.bytes) return null;
  return { identity: fileIdentity(stat), size: stat.size, mtimeMs: stat.mtimeMs, suffixBytes: raw.bytes, suffixDigest: raw.digest };
}

/**
 * Per-readSession cache of file stats and their 256-byte tail-suffix reads, shared by every
 * reader (tail cache, activity events, agent lifecycle) that would otherwise independently stat
 * and open the same transcript files to decide whether their own parse is still valid. Each file
 * is stat'd and suffix-read at most once per instance; a failed stat or suffix read is memoized as
 * `null` too, so a missing/unreadable file is never retried within the same readSession call.
 * Discard the instance once readSession returns: nothing here is safe to reuse across calls.
 */
export function createReadGenerations() {
  const stats = new Map();
  const rawSuffixes = new Map();
  const generations = new Map();
  const descriptors = new Map();

  function stat(file) {
    if (stats.has(file)) return stats.get(file);
    const value = statSafe(file) || null;
    stats.set(file, value);
    return value;
  }

  function rawSuffix(file) {
    if (rawSuffixes.has(file)) return rawSuffixes.get(file);
    const current = stat(file);
    const value = current ? readFileSuffixRaw(file, current.size, FILE_SUFFIX_SAMPLE_BYTES) : null;
    rawSuffixes.set(file, value);
    return value;
  }

  /** Identity + size + sampled tail-suffix digest, or null. Matches `fileGeneration(file, stat)`. */
  function generation(file) {
    if (generations.has(file)) return generations.get(file);
    const value = buildGeneration(stat(file), rawSuffix(file));
    generations.set(file, value);
    return value;
  }

  /** Exactly what `incrementalSourceDescriptor(file, historical)` returns today, built from the
   * shared stat and suffix instead of statting/opening the file again. */
  function descriptor(file, historical = false) {
    const key = `${file}\0${historical ? 1 : 0}`;
    if (descriptors.has(key)) return descriptors.get(key);
    const current = stat(file);
    const suffix = current ? rawSuffix(file) : null;
    const value = current && suffix
      ? incrementalSourceDescriptor(file, historical, { stat: current, suffix })
      : null;
    descriptors.set(key, value);
    return value;
  }

  return Object.freeze({ stat, generation, descriptor });
}
