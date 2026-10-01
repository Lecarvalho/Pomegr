/**
 * Keeps repository-only startup work outside the live observation critical path.
 * The private sidecar promise also establishes the ordering boundary for live
 * repository snapshots: a new write cannot race an older restored baseline.
 */
export function createObservationStartupRepository({
  repositoryInventory,
  repositorySnapshotRecorder,
  isActive,
  catalog,
  onRecorded,
} = {}) {
  if (!repositoryInventory || typeof isActive !== "function" || typeof catalog !== "function"
    || typeof onRecorded !== "function") {
    throw new TypeError("Repository startup requires inventory and lifecycle hooks");
  }
  let startupToken = null;
  let sidecarsReady = null;
  let loadTail = Promise.resolve();

  function start() {
    const token = {};
    startupToken = token;
    // A stopped startup can leave its private load in flight. Serialize the
    // next lifecycle behind it so an older load cannot mutate the shared
    // recorder after newer live writes begin.
    const load = loadTail.then(() => Promise.resolve().then(() => repositorySnapshotRecorder?.load())).catch(() => {});
    loadTail = load;
    sidecarsReady = load;
    void (async () => {
      try {
        await repositoryInventory.ready;
        if (!isActive() || startupToken !== token) return;
        await repositoryInventory.reconcile(catalog());
        if (!isActive() || startupToken !== token) return;
        repositoryInventory.startPluginObservation?.();
      } catch { /* repository setup degrades independently */ }
      finally {
        if (startupToken === token) startupToken = null;
      }
    })();
  }

  function stop() {
    startupToken = null;
    sidecarsReady = null;
  }

  /**
   * Resolves once the startup sidecar load settled. With a session ID it also reads that
   * session's own sidecar when the load did not cover it (no checkpoint on disk at startup),
   * so its projection sees the recorded snapshot rather than the no-snapshot fallback.
   */
  function checkpointRestoreReady(sessionId) {
    const ready = sidecarsReady || Promise.resolve();
    if (typeof sessionId !== "string" || typeof repositorySnapshotRecorder?.ensure !== "function") return ready;
    return ready.then(() => repositorySnapshotRecorder.ensure(sessionId)).then(() => {}, () => {});
  }

  function record(sessionId, live) {
    if (!isActive() || !repositorySnapshotRecorder) return;
    const ready = sidecarsReady;
    if (!ready) return;
    void ready.then(() => {
      if (!isActive() || sidecarsReady !== ready) return false;
      return repositorySnapshotRecorder.record(sessionId, live);
    }).then((changed) => {
      if (changed && isActive() && sidecarsReady === ready) onRecorded(sessionId);
    }).catch(() => {});
  }

  return Object.freeze({ start, stop, checkpointRestoreReady, record });
}
