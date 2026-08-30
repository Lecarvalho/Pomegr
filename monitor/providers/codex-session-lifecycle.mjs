const INACTIVE_STATUSES = new Set(["idle", "stopped", "finished"]);

function statusOf(thread) {
  return thread?.liveStatus || null;
}

function isWaiting(thread) {
  return statusOf(thread) === "needs_input";
}

/**
 * Aggregate related Codex actors without treating missing evidence as idle.
 * Runtime liveness remains the existing any-actor liveness flag; activity is
 * conservative because a live child can keep an otherwise idle root working.
 */
export function aggregateCodexSessionLifecycle(rootThread, relatedThreads = []) {
  const related = Array.isArray(relatedThreads) ? relatedThreads : [];
  const root = rootThread || null;
  const actors = root && related.includes(root) ? related : [root, ...related].filter(Boolean);
  const liveActors = actors.filter((thread) => thread.livenessLive === true);
  const isLive = liveActors.length > 0;
  const needsInput = liveActors.some(isWaiting);
  if (needsInput) return { isLive, needsInput: true, activityStatus: "needs_input" };

  if (liveActors.some((thread) => statusOf(thread) === "active")) {
    return { isLive, needsInput: false, activityStatus: "working" };
  }

  const rootStatus = statusOf(root);
  const potentiallyLive = actors.filter((thread) => thread === root || thread.livenessLive === true);
  const allPotentiallyLiveInactive = potentiallyLive.every((thread) => INACTIVE_STATUSES.has(statusOf(thread)));
  const canBeIdle = isLive && rootStatus === "idle" && allPotentiallyLiveInactive;
  return { isLive, needsInput: false, activityStatus: canBeIdle ? "idle" : "unknown" };
}
