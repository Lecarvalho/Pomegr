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

// Fixed presentation vocabulary only: never copy a task description, tool name,
// actor label, command, argument, or result into the session directory.
const WORK_LABELS = Object.freeze({
  shell: ["Running shell task", "shell task"],
  search: ["Searching", "search"],
  read: ["Reading files", "file read"],
  write: ["Editing files", "file edit"],
  test: ["Running tests", "test run"],
  build: ["Building", "build"],
  git: ["Running Git operation", "Git operation"],
  git_push: ["Pushing changes", "Git push"],
  pull_request: ["Working on pull request", "pull request operation"],
  process: ["Running process task", "process task"],
  web: ["Accessing the web", "web activity"],
  image: ["Working with images", "image activity"],
  input: ["Requesting input", "input request"],
  transfer: ["Transferring files", "file transfer"],
  skill: ["Using a skill", "skill use"],
  report: ["Reporting status", "status report"],
  agent: ["Coordinating agents", "agent coordination"],
  integration: ["Using an integration", "integration activity"],
  wait: ["Waiting", "wait"],
});

function activityTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function currentExecutionAgent(agent) {
  if (!["active", "waiting", "needs_input"].includes(agent.status)) return false;
  // Adapters without a separate liveness object use normalized task/agent status.
  // An explicit uncertain or stale liveness observation always wins.
  return !agent.liveness || (agent.liveness.evidence === "observed" && agent.liveness.freshness === "current");
}

/** Suppress an older running summary as soon as catalog lifecycle changes. */
export function reconcileSessionActivityFallback(entry, activity, lastObserved = null) {
  const selected = activity?.state === "current"
    && (!entry.isLive || !["working", "needs_input"].includes(entry.activityStatus))
    ? lastObserved : activity;
  if (!selected || !["current", "last_observed"].includes(selected.state)) return null;
  return {
    label: selected.label,
    observedAt: selected.observedAt,
    state: selected.state,
    source: selected.source,
    actor: selected.actor,
  };
}

/** D projection from committed normalized evidence; no provider reads or parsing. */
export function projectSessionActivityFallback(entry, agents = [], toolCalls = []) {
  const visibleAgents = new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent]));
  const actorScope = (id) => !visibleAgents.has(id) ? "unknown" : id === "primary" ? "primary" : "subagent";
  let latest = null;
  let latestKey = "";
  const observe = (activity, key) => {
    if (!activity.observedAt) return;
    if (!latest || activity.observedAt > latest.observedAt
      || (activity.observedAt === latest.observedAt && key < latestKey)) {
      latest = activity;
      latestKey = key;
    }
  };
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!Object.hasOwn(WORK_LABELS, call.workKind)) continue;
    observe({
      label: WORK_LABELS[call.workKind][1] + (call.status === "failed" ? " failed" : ""),
      observedAt: activityTimestamp(call.timestamp),
      state: "last_observed",
      source: "tool",
      actor: actorScope(call.actor?.id),
    }, `tool:${call.actor?.id}:${call.id}`);
  }

  const running = new Map();
  for (const agent of visibleAgents.values()) {
    for (const task of Array.isArray(agent.executionTasks) ? agent.executionTasks : []) {
      if (task.kind !== "shell" || !task.id || !["running", "completed", "failed", "stopped"].includes(task.status)) continue;
      const labels = Object.hasOwn(WORK_LABELS, task.workKind) ? WORK_LABELS[task.workKind] : WORK_LABELS.shell;
      const startedAt = activityTimestamp(task.startedAt);
      const finishedAt = activityTimestamp(task.finishedAt);
      const actor = actorScope(agent.id);
      const key = `task:${agent.id}:${task.id}`;
      observe({
        label: labels[1] + (finishedAt && ["failed", "stopped"].includes(task.status) ? ` ${task.status}` : ""),
        observedAt: finishedAt || startedAt,
        state: "last_observed",
        source: "execution_task",
        actor,
      }, key);
      if (task.status === "running" && !task.finishedAt && task.exitCode == null && startedAt && currentExecutionAgent(agent)) {
        running.set(key, { label: labels[0], observedAt: startedAt, actor, agentId: agent.id });
      }
    }
  }
  if (running.size && entry.isLive && ["working", "needs_input"].includes(entry.activityStatus)) {
    const tasks = [...running.values()];
    const newest = tasks.reduce((left, right) => left.observedAt >= right.observedAt ? left : right);
    return {
      label: tasks.length === 1 ? newest.label : tasks.length > 10_000 ? "Multiple tasks running" : `${tasks.length} tasks running`,
      observedAt: newest.observedAt,
      state: "current",
      source: "execution_task",
      actor: new Set(tasks.map((task) => task.agentId)).size > 1 ? "multiple" : newest.actor,
    };
  }
  return latest;
}
