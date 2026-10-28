
const EMPTY_PAGE = Object.freeze({
  revision: 0, sessions: [], matchedCount: 0, counts: { all: 0, live: 0, needs: 0 }, pageSize: 25, nextCursor: null,
  coverage: { status: "discovering", knownCount: 0, exactTotal: null, observedAt: null, lastCompletedTotal: null, lastCompletedAt: null },
});

const FEATURE_ID = /^feat-[0-9a-f]{12}$/u;

export function validFeatureQuery(value) {
  return value === "" || FEATURE_ID.test(value);
}

// `assignedTasks` is present only on a session that is assigned to a task. A reviewer's `task` carries `role: "review"`.
function withTasks(sessions, references, assigned, reviews) {
  return sessions.map((session) => {
    const tasks = assigned?.get(session.id);
    return { ...session, task: references.get(session.id) ?? reviews?.get(session.id) ?? null, ...(tasks ? { assignedTasks: tasks } : {}) };
  });
}

// `query` is the validated catalog query.
export function serveSessionDirectoryWithTasks({ runtime, taskStore = null, allowed = false, query, feature = "", groupFeature = false, session = "" }) {
  if (session) query = { ...query, group: "", sessionIds: [session] };
  const directory = (input) => runtime.serveSessionDirectory?.(input) || { ...EMPTY_PAGE };
  const grouped = groupFeature && !feature;
  // Without the task store's answer a feature scope matches nothing; it never falls back to every session.
  const none = (taskReadiness) => {
    const page = directory({ ...query, group: "", sessionIds: [] });
    return { ...page, ...(grouped ? { groupBy: "feature", groups: [], groupCount: 0 } : {}), taskReadiness };
  };
  if (!allowed) return feature || groupFeature ? none("desktop_only") : { ...directory(query), taskReadiness: "desktop_only" };
  if (!taskStore) return feature || groupFeature ? none("unavailable") : { ...directory(query), taskReadiness: "unavailable" };

  let page;
  let featureLabel = null;
  if (feature) {
    const link = taskStore.featureSessions(feature);
    page = directory({ ...query, group: "", sessionIds: link ? link.sessionIds : [] });
    if (link) featureLabel = { id: link.id, name: link.name };
  } else if (grouped) {
    const sets = taskStore.featureSessionGroups();
    if (!sets) return none("unavailable");
    page = { ...directory({ ...query, group: "set", sets }), groupBy: "feature" };
  } else {
    page = directory(query);
  }

  const groups = Array.isArray(page.groups) ? page.groups : [];
  const sessionIds = [...page.sessions, ...groups.flatMap((group) => group.sessions)].map((session) => session.id);
  const references = taskStore.sessionTasks(sessionIds);
  if (!references) return { ...page, taskReadiness: "unavailable" };
  const assigned = typeof taskStore.sessionAssignedTasks === "function" ? taskStore.sessionAssignedTasks(sessionIds) : null;
  const reviews = typeof taskStore.sessionReviews === "function" ? taskStore.sessionReviews(sessionIds) : null;
  return {
    ...page,
    sessions: withTasks(page.sessions, references, assigned, reviews),
    ...(Array.isArray(page.groups) ? { groups: page.groups.map((group) => ({ ...group, sessions: withTasks(group.sessions, references, assigned, reviews) })) } : {}),
    ...(feature ? { feature: featureLabel } : {}),
    taskReadiness: "ready",
  };
}
