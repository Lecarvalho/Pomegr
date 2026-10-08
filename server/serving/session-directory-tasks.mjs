// Serves one Sessions directory page with the task each listed session was started for. The join happens
// here, at serving time, from the task store: the session catalog and its checkpoints never hold a task
// reference. Task references are task-board content, so only a same-computer client that the proxy marked
// (`tasks=1`) gets them; any other client is answered `taskReadiness: "desktop_only"` and no reference.

const EMPTY_PAGE = Object.freeze({
  revision: 0, sessions: [], matchedCount: 0, counts: { all: 0, live: 0, needs: 0 }, pageSize: 25, nextCursor: null,
  coverage: { status: "discovering", knownCount: 0, exactTotal: null, observedAt: null, lastCompletedTotal: null, lastCompletedAt: null },
});

const FEATURE_ID = /^feat-[0-9a-f]{12}$/u;

/** A feature filter value the directory accepts: empty, or one feature ID. */
export function validFeatureQuery(value) {
  return value === "" || FEATURE_ID.test(value);
}

function withTasks(sessions, references) {
  return sessions.map((session) => ({ ...session, task: references.get(session.id) ?? null }));
}

/**
 * `query` is the validated catalog query. `feature` narrows to the sessions started for one feature's tasks and
 * `groupFeature` groups by feature; both read the task store and neither reaches the catalog as task data: the
 * catalog only sees a set of session IDs.
 */
export function serveSessionDirectoryWithTasks({ runtime, taskStore = null, allowed = false, query, feature = "", groupFeature = false }) {
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
  const references = taskStore.sessionTasks([...page.sessions, ...groups.flatMap((group) => group.sessions)].map((session) => session.id));
  if (!references) return { ...page, taskReadiness: "unavailable" };
  return {
    ...page,
    sessions: withTasks(page.sessions, references),
    ...(Array.isArray(page.groups) ? { groups: page.groups.map((group) => ({ ...group, sessions: withTasks(group.sessions, references) })) } : {}),
    ...(feature ? { feature: featureLabel } : {}),
    taskReadiness: "ready",
  };
}
