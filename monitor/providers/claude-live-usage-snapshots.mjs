import { statSafe } from "../session-discovery.mjs";
import { fileGeneration, priorFileSuffixStillMatches } from "./claude-file-generation.mjs";
import { mergeClaudeRequestFragments } from "./claude-activity-correlation.mjs";
import { parseClaudeContextRecords } from "./claude-context.mjs";

const MAX_LIVE_USAGE_SNAPSHOTS = 1_000;

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
 * longer continues what was parsed before. Historical and complete reads never use the cache.
 */
export function createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile }) {
  const cache = new Map();
  function read(file, records, actor, stat, historical, sessionId, compactionTimestamps, unlimited = false) {
    const parsed = parseClaudeContextRecords(records, {
      actorId: actor.id,
      sourceKey: actor.id,
      fallbackTimestamp: stat.mtime.toISOString(),
      completeHistory: unlimited || stat.size <= maximumBytesPerFile,
      expectedSessionId: sessionId,
      compactionTimestamps,
      includeToolUseIds: true,
      unlimited,
    });
    if (historical || unlimited) return parsed;
    const generation = fileGeneration(file, stat);
    if (!generation) {
      cache.delete(file);
      return parsed;
    }
    const cached = cache.get(file);
    if (!cached || cached.actorId !== actor.id) {
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
      cache.set(file, { actorId: actor.id, generation, snapshots: parsed });
      return parsed;
    }

    const snapshots = generation.size === previous.size && generation.mtimeMs === previous.mtimeMs
      ? cached.snapshots
      : mergeLiveUsageSnapshots(cached.snapshots, parsed);
    cache.set(file, { actorId: actor.id, generation, snapshots });
    return snapshots;
  }
  function pruneMissingFiles() {
    for (const file of cache.keys()) {
      if (!statSafe(file)) cache.delete(file);
    }
  }
  return { read, pruneMissingFiles };
}
