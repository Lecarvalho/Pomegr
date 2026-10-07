import { gitObservedFilesFromSnapshot } from "./repository-snapshot.mjs";

const NO_SESSION_REPOSITORY_RECORD = Object.freeze({ gitObserved: null, commitTimes: null });
// recorded snapshot -> its projection inputs; released with the snapshot.
const sessionRepositoryRecords = new WeakMap();

/**
 * The two session-domain projection inputs a recorded snapshot supplies: the Git-observed files
 * and the monitor-private in-window commit times. A recorder replaces a snapshot instead of
 * changing it, so the same snapshot answers with the same frozen record, and a consumer can
 * tell an unchanged input by identity.
 */
export function sessionRepositoryRecord(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return NO_SESSION_REPOSITORY_RECORD;
  let record = sessionRepositoryRecords.get(snapshot);
  if (!record) {
    const gitObserved = gitObservedFilesFromSnapshot(snapshot);
    record = Object.freeze({
      gitObserved: gitObserved ? Object.freeze({ ...gitObserved, files: Object.freeze(gitObserved.files) }) : null,
      commitTimes: snapshot.commitTimesInWindow ?? null,
    });
    sessionRepositoryRecords.set(snapshot, record);
  }
  return record;
}
