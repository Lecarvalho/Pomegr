import { readGitStateAsync } from "../repository/git-state.mjs";

// The committed facts the task start gates judge: each provider's account usage, each provider's public status,
// and the working tree of a repository root. Every fact is read from memory. Whatever is missing, stale, or
// partial is null, which the gates treat as unknown and hold on (server/tasks/task-gates.mjs).

const PROVIDERS = Object.freeze(["claude", "codex"]);
/** Usage with no provider freshness of its own is fresh for this long after it was fetched. */
export const TASK_GATE_USAGE_MAX_AGE_MS = 10 * 60 * 1000;
/** A working-tree observation is served for this long, and refreshed on demand once it is this old. */
export const TASK_GATE_TREE_MAX_AGE_MS = 60 * 1000;
export const TASK_GATE_TREE_REFRESH_MS = 15 * 1000;
/** Repositories whose working tree is held at once; the least recently asked for is dropped. */
export const TASK_GATE_TREE_LIMIT = 16;

const percent = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);

// The highest reading among the windows of one length: a provider may report the same window for several buckets,
// and the fullest one is the one that runs out first.
function windowPercent(limits, window) {
  const readings = limits.filter((limit) => limit?.window === window).map((limit) => percent(limit.percent));
  return readings.length === 0 || readings.includes(null) ? null : Math.max(...readings);
}

/**
 * One provider's usage as the gates read it, `{ fiveHourPercent, sevenDayPercent }`, or null. `usageLimits` is the
 * provider's committed normalized usage. It counts only when it is available and fresh: the provider's own
 * freshness when it reports one, otherwise a fetch time no older than `TASK_GATE_USAGE_MAX_AGE_MS`.
 */
export function gateUsageFact(usageLimits, now) {
  if (!usageLimits || usageLimits.available !== true || !Array.isArray(usageLimits.limits)) return null;
  const fetchedAt = Date.parse(usageLimits.fetchedAt || "");
  if (!Number.isFinite(fetchedAt) || fetchedAt > now) return null;
  const fresh = usageLimits.freshness === undefined ? now - fetchedAt <= TASK_GATE_USAGE_MAX_AGE_MS : usageLimits.freshness === "fresh";
  if (!fresh) return null;
  return { fiveHourPercent: windowPercent(usageLimits.limits, "5 hours"), sevenDayPercent: windowPercent(usageLimits.limits, "7 days") };
}

/** One provider's public status as the gates read it: `operational`, `incident`, or null for anything not fresh and known. */
export function gateProviderStatusFact(row) {
  if (!row || row.readiness !== "ready" || row.freshness !== "fresh" || row.status === "unknown") return null;
  return row.status === "operational" ? "operational" : ["degraded", "outage", "maintenance"].includes(row.status) ? "incident" : null;
}

/**
 * The working tree of repository roots, observed off the request path. `read(repositoryId)` answers the last
 * committed observation (true for clean, false for uncommitted changes) or null when there is none or it is older
 * than `TASK_GATE_TREE_MAX_AGE_MS`, and queues one asynchronous Git inspection when the observation is missing or
 * due. It never waits for Git. Asking is the only demand signal: a repository nobody asks about is not inspected,
 * so there is no timer to stop. Roots stay private to this module's caller; only the boolean leaves.
 */
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
      // Re-inserting keeps the map in least-recently-asked order.
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

/**
 * `resolveTaskGateFacts(repositoryId)` for the task routes: `{ usage, providerStatus, treeClean }` from the committed
 * usage response, the committed public provider status, and the working-tree observation. No provider read and no
 * synchronous Git call happen here.
 */
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
