import { projectSessionActivityFallback, projectSessionCurrentActivity, reconcileSessionActivityFallback } from "../domain/session-current-activity.mjs";
import { projectSessionCacheTiming } from "../domain/session-cache-timing.mjs";

const PHASES = new Set(["planning", "implementing", "verifying", "blocked", "complete"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const SOURCES = new Set(["tool", "execution_task"]);
const ACTORS = new Set(["primary", "subagent", "multiple", "unknown"]);
const int = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const iso = (value) => typeof value === "string" && value.length <= 48 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const EMPTY = Object.freeze({ summaryReadiness: "loading", agentCount: null, activeAgentCount: null, latestContextTotal: null, progress: null, currentActivity: null });

function sanitizeProgress(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value) || !PHASES.has(value.phase) || !CONFIDENCE.has(value.confidence)
    || typeof value.percent !== "number" || !(value.percent >= 0 && value.percent <= 100)) return undefined;
  const hasMin = value.remainingMinutesMin !== undefined, hasMax = value.remainingMinutesMax !== undefined;
  if (hasMin !== hasMax || (hasMin && (!int(value.remainingMinutesMin, 10080) || !int(value.remainingMinutesMax, 10080)
    || value.remainingMinutesMin > value.remainingMinutesMax))) return undefined;
  const reportedAt = value.reportedAt == null ? null : iso(value.reportedAt);
  if (value.reportedAt != null && !reportedAt) return undefined;
  return { phase: value.phase, percent: value.percent, ...(hasMin ? { remainingMinutesMin: value.remainingMinutesMin, remainingMinutesMax: value.remainingMinutesMax } : {}),
    confidence: value.confidence, reportedAt };
}

function sanitizeObserved(value) {
  if (value === null || value === undefined) return null;
  const observedAt = iso(value.observedAt);
  if (typeof value.label !== "string" || !/^[A-Za-z][A-Za-z ]{0,47}$/u.test(value.label) || !observedAt
    || !SOURCES.has(value.source) || !ACTORS.has(value.actor)) return undefined;
  return { label: value.label, observedAt, source: value.source, actor: value.actor };
}

/** Validates a summary for persistence; returns only the allowlisted keys, or null when invalid. */
export function sanitizeRowSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !int(value.agentCount, 10_000)
    || !(value.latestContextTotal === null || int(value.latestContextTotal, 1e12))) return null;
  const progress = sanitizeProgress(value.progress), lastObserved = sanitizeObserved(value.lastObserved);
  return progress === undefined || lastObserved === undefined ? null
    : { agentCount: value.agentCount, latestContextTotal: value.latestContextTotal, progress, lastObserved };
}

export function projectRowSummary(snapshot) {
  const state = snapshot?.publicState;
  if (!Number.isFinite(state?.metrics?.agents)) return null;
  const fallback = projectSessionActivityFallback({ isLive: false }, state.agents, snapshot.evidence?.toolCalls);
  return sanitizeRowSummary({
    agentCount: state.metrics.agents,
    latestContextTotal: Number.isFinite(state.metrics.tokens?.allAgents) ? state.metrics.tokens.allAgents : null,
    progress: state.session?.progress ?? null,
    lastObserved: fallback?.state === "last_observed" ? fallback : null,
  });
}

export function rowSummaryFields(summaryJson, isLive) {
  let summary = null;
  try { summary = typeof summaryJson === "string" ? sanitizeRowSummary(JSON.parse(summaryJson)) : null; } catch { /* unreadable summary is absent */ }
  if (!summary) return EMPTY;
  return { summaryReadiness: "ready", agentCount: summary.agentCount, activeAgentCount: isLive ? null : 0, latestContextTotal: summary.latestContextTotal,
    progress: summary.progress, currentActivity: null,
    activityFallback: summary.lastObserved ? { ...summary.lastObserved, state: "last_observed" } : null };
}

function projectRowActivity(lifecycle, snapshot, restoredActivity) {
  const state = snapshot?.publicState;
  const primaryAgent = Array.isArray(state?.agents) ? state.agents.find((agent) => agent.id === "primary") : null;
  return {
    currentActivity: projectSessionCurrentActivity(lifecycle, primaryAgent),
    activityFallback: projectSessionActivityFallback(restoredActivity ? { ...lifecycle, isLive: false } : lifecycle, state?.agents, snapshot?.evidence?.toolCalls),
    cacheTiming: snapshot ? projectSessionCacheTiming(state?.agents, state?.metrics?.tokens?.requestSnapshots) : null,
  };
}
const rowLifecycle = (entry) => ({ isLive: entry.isLive, activityStatus: entry.activityStatus });
function frozenActivity(activity) {
  for (const value of Object.values(activity)) if (value) Object.freeze(value);
  return Object.freeze(activity);
}
// The store's snapshots are deep-frozen and replaced, never changed.
const frozenSnapshot = (snapshot) => Object.isFrozen(snapshot) && Object.isFrozen(snapshot.publicState)
  && (snapshot.evidence == null || Object.isFrozen(snapshot.evidence));

export function createRowActivityMemo() {
  let committed = new Map();
  let building = new Map();
  const counts = { walks: 0, reuses: 0 };
  return Object.freeze({
    activity(entry, snapshot, restoredActivity = false) {
      const lifecycle = rowLifecycle(entry);
      const previous = committed.get(entry.id);
      const reusable = previous && previous.snapshot.deref() === snapshot && previous.isLive === lifecycle.isLive
        && previous.activityStatus === lifecycle.activityStatus && previous.restoredActivity === restoredActivity;
      if (reusable) counts.reuses += 1;
      else counts.walks += 1;
      const activity = reusable ? previous.activity : frozenActivity(projectRowActivity(lifecycle, snapshot, restoredActivity));
      if (reusable) building.set(entry.id, previous);
      else if (frozenSnapshot(snapshot)) building.set(entry.id, { snapshot: new WeakRef(snapshot), ...lifecycle, restoredActivity, activity });
      return activity;
    },
    preview(entry, snapshot, restoredActivity = false) {
      const activity = this.activity(entry, snapshot, restoredActivity);
      const record = building.get(entry.id);
      if (record) committed.set(entry.id, record);
      building.delete(entry.id);
      return activity;
    },
    /** Ends one catalog commit: rows it did not build are forgotten. */
    settle() { committed = building; building = new Map(); },
    clear() { committed = new Map(); building = new Map(); },
    stats: () => Object.freeze({ ...counts, rows: committed.size }),
  });
}

/** One shell row: committed snapshot when resident, otherwise the persisted summary read through `persisted`. */
export function catalogShellRow(entry, { snapshot = null, persisted = null, restoredActivity = false, activity = null } = {}) {
  const state = snapshot?.publicState;
  const stored = !snapshot && persisted?.summaryReadiness === "ready" ? persisted : null;
  const derived = stored ? null : activity || projectRowActivity(rowLifecycle(entry), snapshot, restoredActivity);
  const publicEntry = { ...entry };
  delete publicEntry.detailReadiness;
  return {
    ...publicEntry,
    project: state?.session?.project ?? (entry.project === "Unknown project" ? stored?.project : null) ?? entry.project,
    summaryReadiness: snapshot || stored ? "ready" : entry.detailReadiness === "unavailable" ? "unavailable" : "loading",
    agentCount: Number.isFinite(state?.metrics?.agents) ? state.metrics.agents : stored?.agentCount ?? null,
    activeAgentCount: (snapshot || stored) && !entry.isLive ? 0
      : Number.isFinite(state?.metrics?.activeAgents) ? state.metrics.activeAgents : null,
    latestContextTotal: Number.isFinite(state?.metrics?.tokens?.allAgents) ? state.metrics.tokens.allAgents : stored?.latestContextTotal ?? null,
    progress: state?.session?.progress || stored?.progress || null,
    currentActivity: derived ? derived.currentActivity : null,
    activityFallback: stored ? reconcileSessionActivityFallback(entry, stored.activityFallback) : derived.activityFallback,
    cacheTiming: derived ? derived.cacheTiming : null,
    repositoryId: state?.session ? state.session.repositoryId ?? null : stored?.repositoryId ?? null,
    contextInventoryRef: state?.session ? state.session.contextInventoryRef ?? null : null,
  };
}

export function createRowSummaryWriter({ store, inventory, schedule, cancel, now, quietMs, maxMs, isStopped }) {
  const pending = new Map();
  const live = new Set();
  function write(id) {
    const snapshot = store.getByQualifiedId(id);
    const summary = snapshot ? projectRowSummary(snapshot) : null;
    if (!summary) return;
    try { inventory.upsertSummary(snapshot.providerId, snapshot.localSessionId, summary, snapshot.publicState?.session?.updatedAt || snapshot.observedAt); }
    catch { /* a summary write must not reject an accepted session */ }
  }
  function flush(id) {
    const entry = pending.get(id);
    if (!entry) return;
    if (entry.timer !== null) cancel(entry.timer);
    pending.delete(id);
    write(id);
  }
  return Object.freeze({
    record(id) {
      if (!live.has(id)) { flush(id); write(id); return; }
      const at = now();
      const entry = pending.get(id) || { firstAt: at, timer: null };
      if (entry.timer !== null) cancel(entry.timer);
      entry.timer = schedule(() => { entry.timer = null; if (!isStopped()) flush(id); }, Math.max(0, Math.min(quietMs, maxMs - (at - entry.firstAt))));
      entry.timer?.unref?.();
      pending.set(id, entry);
    },
    settle(liveIds) {
      live.clear();
      for (const id of liveIds) live.add(id);
      for (const id of [...pending.keys()]) if (!live.has(id)) flush(id);
    },
    stop() { for (const id of [...pending.keys()]) flush(id); },
  });
}
