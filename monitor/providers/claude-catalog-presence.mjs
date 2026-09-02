import path from "node:path";
import { sessionActivityStatus } from "./claude-session-status.mjs";

const MAX_SESSIONS = 50;

// Native registrations can precede the first transcript. These are catalog
// identities only, never invented transcript evidence or checkpoint cursors.
export function createClaudeCatalogPresence() {
  let previous = new Map();
  return {
    liveSessionIds: () => [...previous.values()].filter((entry) => entry.isLive).map((entry) => entry.localId),
    merge(sessions, files, registry, { explicitSession = null } = {}) {
      const sourceIds = new Set(files.map(({ file }) => path.basename(file, ".jsonl")));
      const merged = new Map(sessions.map((entry) => [entry.localId, entry]));
      if (!explicitSession) for (const entry of registry.values()) {
        if (sourceIds.has(entry.sessionId) || !entry.resourceOwner) continue;
        const prior = previous.get(entry.sessionId);
        const startedAt = entry.ownerStartedAt;
        if (!prior && (!Number.isFinite(startedAt) || startedAt <= 0 || startedAt > 8.64e15)) continue;
        // A previously recorded source can be temporarily inaccessible. Preserve
        // its identity and hydration path; never downgrade it to metadata-only.
        const identity = prior || {
          localId: entry.sessionId,
          title: "Untitled session",
          project: "Unknown project",
          createdAt: new Date(startedAt).toISOString(),
          updatedAt: new Date(startedAt).toISOString(),
          detailReadiness: "unavailable",
        };
        merged.set(entry.sessionId, {
          ...identity,
          isLive: true,
          needsInput: Boolean(entry.needsInput),
          activityStatus: sessionActivityStatus(true, entry),
          resourceOwner: entry.resourceOwner,
        });
      }
      const result = [...merged.values()].sort((left, right) =>
        Date.parse(right.createdAt || right.updatedAt) - Date.parse(left.createdAt || left.updatedAt)
        || left.localId.localeCompare(right.localId)).slice(0, MAX_SESSIONS);
      previous = new Map(result.map((entry) => [entry.localId, entry]));
      return result;
    },
  };
}
