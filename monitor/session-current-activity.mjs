/** Reconcile a cached heading with the independently refreshed catalog lifecycle. */
export function reconcileSessionCurrentActivity(entry, activity) {
  if (!activity || !entry.isLive || !["working", "needs_input"].includes(entry.activityStatus)
    || activity.state !== "current") return null;
  return {
    label: activity.label,
    observedAt: activity.observedAt,
    state: "current",
  };
}

/** Catalog-only projection; never mutate the retained primary-agent evidence. */
export function projectSessionCurrentActivity(entry, primaryAgent) {
  const activity = primaryAgent?.currentActivity;
  if (!activity) return null;
  const lifecycle = primaryAgent.liveness;
  const observed = lifecycle?.evidence === "observed" && lifecycle.freshness === "current";
  if (!observed || primaryAgent.status !== "active") return null;
  return reconcileSessionCurrentActivity(entry, {
    label: activity.label,
    observedAt: activity.observedAt,
    state: "current",
  });
}
