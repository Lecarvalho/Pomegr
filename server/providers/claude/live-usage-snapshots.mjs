import { statSafe } from "../../normalize/session-discovery.mjs";
import { fileGeneration, generationKey as generationKeyString, priorFileSuffixStillMatches } from "./file-generation.mjs";
import { mergeClaudeRequestFragments } from "./activity-correlation.mjs";
import { parseClaudeContextRecords } from "./context.mjs";

const MAX_LIVE_USAGE_SNAPSHOTS = 1_000;
const DEFAULT_HISTORICAL_CACHE_MAX_ENTRIES = 512;

function mergeLiveUsageSnapshots(previous, current) {
  const byId = new Map(previous.map((snapshot) => [snapshot.dedupeId, snapshot]));
  for (const snapshot of current) byId.set(snapshot.dedupeId, mergeClaudeRequestFragments(byId.get(snapshot.dedupeId), snapshot));
  return [...byId.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId))
    .slice(-MAX_LIVE_USAGE_SNAPSHOTS);
}

/**
 * Bounded per-file usage snapshots for live transcripts. A live read parses only the file tail, so
 * snapshots already observed are retained and merged; the retained set is dropped whenever the file
 * identity, its recorded suffix, or append-only growth stops matching, because the tail then no
 * longer continues what was parsed before.
 *
 * Historical, non-unlimited reads use a separate bounded cache keyed by generation + actor + session
 * + the compaction-timestamp list + the completeHistory flag passed to the parser: an exact match
 * returns the previously parsed (shared-reference) array unchanged; anything else reparses and
 * replaces the entry. `unlimited` reads never use or populate either cache.
 *
 * `read`'s optional trailing `generation` lets a caller that already computed the file's generation
 * this readSession (see claude-read-generations.mjs) pass it in instead of having it recomputed here;
 * when omitted, it is computed the same way as before (`fileGeneration(file, stat)`).
 */
export function createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile, maxEntries = DEFAULT_HISTORICAL_CACHE_MAX_ENTRIES }) {
  const cache = new Map();
  const historicalCache = new Map();
  function read(file, records, actor, stat, historical, sessionId, compactionTimestamps, unlimited = false, precomputedGeneration) {
    const completeHistory = unlimited || stat.size <= maximumBytesPerFile;
    const parse = () => parseClaudeContextRecords(records, {
      actorId: actor.id,
      sourceKey: actor.id,
      fallbackTimestamp: stat.mtime.toISOString(),
      completeHistory,
      expectedSessionId: sessionId,
      compactionTimestamps,
      includeToolUseIds: true,
      unlimited,
    });
    if (unlimited) return parse();

    if (historical) {
      const generation = precomputedGeneration !== undefined ? precomputedGeneration : fileGeneration(file, stat);
      const generationKey = generationKeyString(generation);
      if (!generationKey) {
        historicalCache.delete(file);
        return parse();
      }
      const cacheKey = `${generationKey}\u0000${actor.id}\u0000${sessionId}\u0000${(compactionTimestamps || []).join(",")}\u0000${completeHistory}`;
      const cached = historicalCache.get(file);
      if (cached && cached.key === cacheKey) {
        historicalCache.delete(file);
        historicalCache.set(file, cached);
        return cached.snapshots;
      }
      const snapshots = parse();
      historicalCache.delete(file);
      historicalCache.set(file, { key: cacheKey, snapshots });
      while (historicalCache.size > maxEntries) historicalCache.delete(historicalCache.keys().next().value);
      return snapshots;
    }

    const generation = precomputedGeneration !== undefined ? precomputedGeneration : fileGeneration(file, stat);
    if (!generation) {
      cache.delete(file);
      return parse();
    }
    const cached = cache.get(file);
    if (!cached || cached.actorId !== actor.id) {
      const parsed = parse();
      cache.set(file, { actorId: actor.id, generation, snapshots: parsed });
      return parsed;
    }
    const previous = cached.generation;
    const monotonic = previous
      && previous.identity === generation.identity
      && generation.size >= previous.size
      && generation.mtimeMs >= previous.mtimeMs
      && (generation.size > previous.size || generation.mtimeMs === previous.mtimeMs);
    if (!monotonic || !priorFileSuffixStillMatches(file, previous)) {
      const parsed = parse();
      cache.set(file, { actorId: actor.id, generation, snapshots: parsed });
      return parsed;
    }

    // An unchanged generation serves the retained snapshots, so the tail is not parsed again.
    const snapshots = generation.size === previous.size && generation.mtimeMs === previous.mtimeMs
      ? cached.snapshots
      : mergeLiveUsageSnapshots(cached.snapshots, parse());
    cache.set(file, { actorId: actor.id, generation, snapshots });
    return snapshots;
  }
  function pruneMissingFiles(exists = (file) => Boolean(statSafe(file))) {
    for (const file of cache.keys()) {
      if (!exists(file)) cache.delete(file);
    }
    for (const file of historicalCache.keys()) {
      if (!exists(file)) historicalCache.delete(file);
    }
  }
  return { read, pruneMissingFiles };
}
