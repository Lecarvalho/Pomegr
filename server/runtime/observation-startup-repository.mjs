// Keeps repository-only startup work outside the live observation critical path.
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
    // A stopped startup can leave its private load in flight.
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

  // Resolves once the startup sidecar load settled.
  function checkpointRestoreReady(sessionId) {
    const ready = sidecarsReady || Promise.resolve();
    if (typeof sessionId !== "string" || typeof repositorySnapshotRecorder?.ensure !== "function") return ready;
    return ready.then(() => repositorySnapshotRecorder.ensure(sessionId)).then(() => {}, () => {});
  }

  // A live check may be recorded only while the committed catalog lists the session as live.
  function catalogListsLive(sessionId) {
    return catalog().some((entry) => entry?.id === sessionId && entry.isLive === true);
  }

  function record(sessionId, live) {
    if (!isActive() || !repositorySnapshotRecorder || !catalogListsLive(sessionId)) return;
    const ready = sidecarsReady;
    if (!ready) return;
    void ready.then(() => {
      // The sidecar load can outlast the catalog row; decide again just before writing.
      if (!isActive() || sidecarsReady !== ready || !catalogListsLive(sessionId)) return false;
      return repositorySnapshotRecorder.record(sessionId, live);
    }).then((changed) => {
      if (changed && isActive() && sidecarsReady === ready) onRecorded(sessionId);
    }).catch(() => {});
  }

  return Object.freeze({ start, stop, checkpointRestoreReady, record });
}
