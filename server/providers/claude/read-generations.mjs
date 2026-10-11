import { statSafe } from "../../normalize/session-discovery.mjs";
import { FILE_SUFFIX_SAMPLE_BYTES, fileIdentity, generationKey, readFileSuffixRaw } from "./file-generation.mjs";
import { incrementalSourceDescriptor } from "../kernel/incremental-provider-observer.mjs";

// A generation key is `identity|size|mtimeMs|suffixDigest`; `null` means "no generation" (never cache).
export { generationKey };

function buildGeneration(stat, raw) {
  if (!stat || !Number.isInteger(stat.size) || stat.size < 1) return null;
  if (!raw || raw.read !== raw.bytes) return null;
  return { identity: fileIdentity(stat), size: stat.size, mtimeMs: stat.mtimeMs, suffixBytes: raw.bytes, suffixDigest: raw.digest };
}

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

  function generation(file) {
    if (generations.has(file)) return generations.get(file);
    const value = buildGeneration(stat(file), rawSuffix(file));
    generations.set(file, value);
    return value;
  }

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
