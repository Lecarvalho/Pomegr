import { gitObservedFilesFromSnapshot } from "./repository-snapshot.mjs";

const NO_SESSION_REPOSITORY_RECORD = Object.freeze({ gitObserved: null, commitTimes: null });
const sessionRepositoryRecords = new WeakMap();

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
