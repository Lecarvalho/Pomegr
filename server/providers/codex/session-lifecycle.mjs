const INACTIVE_STATUSES = new Set(["idle", "stopped", "finished"]);

function statusOf(thread) {
  return thread?.liveStatus || null;
}

function isWaiting(thread) {
  return statusOf(thread) === "needs_input";
}

// Aggregate related Codex actors without treating missing evidence as idle.
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

  const open = liveActors.some((thread) => thread.presenceConfirmed === true);
  const rootStatus = statusOf(root);
  const potentiallyLive = actors.filter((thread) => thread === root || thread.livenessLive === true);
  const allPotentiallyLiveInactive = potentiallyLive.every((thread) => INACTIVE_STATUSES.has(statusOf(thread)));
  if (allPotentiallyLiveInactive && INACTIVE_STATUSES.has(rootStatus)) {
    return { isLive, needsInput: false, activityStatus: rootStatus === "stopped" ? "stopped" : open ? "open" : "idle" };
  }
  return { isLive, needsInput: false, activityStatus: open ? "open" : "unknown" };
}
