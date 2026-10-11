import { readGitStateAsync } from "../repository/git-state.mjs";

const PROVIDERS = Object.freeze(["claude", "codex"]);
// A successful usage reading counts for this long after it was fetched. It must stay longer than one
// refresh interval (`USAGE_REFRESH_INTERVAL_MS`) plus one usage poll, or a healthy account reads unknown
// at the end of every refresh cycle.
export const TASK_GATE_USAGE_MAX_AGE_MS = 10 * 60 * 1000;
export const TASK_GATE_TREE_MAX_AGE_MS = 60 * 1000;
export const TASK_GATE_TREE_REFRESH_MS = 15 * 1000;
export const TASK_GATE_TREE_LIMIT = 16;

const percent = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);

// A window whose reset time has passed describes a period that ended: its percentage is not known.
function windowPercent(limits, window, now) {
  const readings = limits.filter((limit) => limit?.window === window).map((limit) => {
    const resetsAt = typeof limit.resetsAt === "string" ? Date.parse(limit.resetsAt) : Number.NaN;
    return Number.isFinite(resetsAt) && resetsAt <= now ? null : percent(limit.percent);
  });
  return readings.length === 0 || readings.includes(null) ? null : Math.max(...readings);
}

// A refresh that failed after the reading was taken: the reading is the last known value, not the current one.
function failedSince(usageLimits, fetchedAt) {
  if (usageLimits.failureKind === null || usageLimits.failureKind === undefined) return false;
  const attemptedAt = Date.parse(usageLimits.attemptedAt || "");
  return !Number.isFinite(attemptedAt) || attemptedAt > fetchedAt;
}

// One provider's usage as the gates read it, `{ fiveHourPercent, sevenDayPercent }`, or null.
// The gate judges the reading by its own age and failure record, never by the provider's `freshness`
// label: that label follows each reader's own display bound, which can be as short as one refresh interval.
export function gateUsageFact(usageLimits, now) {
  if (!usageLimits || usageLimits.available !== true || !Array.isArray(usageLimits.limits)) return null;
  const fetchedAt = Date.parse(usageLimits.fetchedAt || "");
  if (!Number.isFinite(fetchedAt) || fetchedAt > now || now - fetchedAt > TASK_GATE_USAGE_MAX_AGE_MS) return null;
  if (failedSince(usageLimits, fetchedAt)) return null;
  return { fiveHourPercent: windowPercent(usageLimits.limits, "5 hours", now), sevenDayPercent: windowPercent(usageLimits.limits, "7 days", now) };
}

export function gateProviderStatusFact(row) {
  if (!row || row.readiness !== "ready" || row.freshness !== "fresh" || row.status === "unknown") return null;
  return row.status === "operational" ? "operational" : ["degraded", "outage", "maintenance"].includes(row.status) ? "incident" : null;
}

// The working tree of repository roots, observed off the request path.
export function createTaskTreeObservation({ repositoryRoot, gitReader = readGitStateAsync, forbiddenRoots = () => [], now = Date.now } = {}) {
  const entries = new Map();
  let stopped = false;

  function refresh(repositoryId, entry) {
    let root = null;
    try { root = repositoryRoot?.(repositoryId) ?? null; } catch { root = null; }
    if (typeof root !== "string" || root === "") {
      entries.delete(repositoryId);
      return;
    }
    entry.inFlight = true;
    entry.attemptedAt = now();
    Promise.resolve().then(() => gitReader(root, { forbiddenRoots: forbiddenRoots() })).then((state) => {
      // A read whose `git status` failed lists no file without having read the tree: unknown, never clean.
      const known = state?.available === true && Array.isArray(state.files) && state._statusUnknown !== true;
      entry.clean = known ? state.files.length === 0 : null;
      entry.checkedAt = known ? now() : null;
    }).catch(() => {
      entry.clean = null;
      entry.checkedAt = null;
    }).finally(() => { entry.inFlight = false; });
  }

  return Object.freeze({
    read(repositoryId) {
      if (stopped || typeof repositoryId !== "string") return null;
      let entry = entries.get(repositoryId);
      if (entry) entries.delete(repositoryId);
      else entry = { clean: null, checkedAt: null, attemptedAt: null, inFlight: false };
      entries.set(repositoryId, entry);
      while (entries.size > TASK_GATE_TREE_LIMIT) entries.delete(entries.keys().next().value);
      const at = now();
      if (!entry.inFlight && (entry.attemptedAt === null || at - entry.attemptedAt >= TASK_GATE_TREE_REFRESH_MS)) refresh(repositoryId, entry);
      const current = entries.get(repositoryId);
      return current && current.checkedAt !== null && at - current.checkedAt <= TASK_GATE_TREE_MAX_AGE_MS ? current.clean : null;
    },
    stop() {
      stopped = true;
      entries.clear();
    },
  });
}

export function createTaskGateFacts({ usageLimits, providerStatus, tree, now = Date.now }) {
  return function resolveTaskGateFacts(repositoryId) {
    const at = now();
    const usageRows = usageLimits?.()?.providers;
    const statusRows = providerStatus?.()?.providers;
    const usage = {};
    const status = {};
    for (const provider of PROVIDERS) {
      usage[provider] = gateUsageFact(Array.isArray(usageRows) ? usageRows.find((row) => row?.provider === provider)?.usageLimits : null, at);
      status[provider] = gateProviderStatusFact(Array.isArray(statusRows) ? statusRows.find((row) => row?.provider === provider) : null);
    }
    return { usage, providerStatus: status, treeClean: tree?.read(repositoryId) ?? null };
  };
}
