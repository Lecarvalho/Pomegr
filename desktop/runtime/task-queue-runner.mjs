import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { createTaskMerge } from "./task-merge.mjs";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STARTS = 16;
const MAX_CLEANUPS = 64;
// A worktree that could not go yet (a terminal still open in it, work not pushed) is asked about again, at this pace.
const CLEANUP_EVERY_TICKS = 4;
const CLEANED = new Set(["removed", "absent"]);
// Other failures pause as `start_failed`; a manual start in flight, a moved task, or a closed gate never pause (the next tick asks again).
const PAUSE_REASONS = new Set(["cli_missing", "plugin_missing", "unsupported_platform", "worktree_dirty"]);
const SETTLED = new Set(["started", "busy", "not_startable", "gate_held", "tree_dirty", "not_found", "cancelled"]);

function trustedMonitorOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "::1"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function startsFrom(answer) {
  const starts = [];
  if (!isPlainObject(answer) || answer.ok !== true || !Array.isArray(answer.starts)) return starts;
  for (const entry of answer.starts) {
    if (starts.length >= MAX_STARTS) break;
    if (!isPlainObject(entry)) continue;
    const { repositoryId, taskId } = entry;
    if (typeof repositoryId === "string" && REPOSITORY_ID.test(repositoryId) && typeof taskId === "string" && TASK_ID.test(taskId)) {
      starts.push({ repositoryId, taskId });
    }
  }
  return starts;
}

function cleanupsFrom(answer) {
  const cleanups = [];
  if (!isPlainObject(answer) || answer.ok !== true || !Array.isArray(answer.cleanups)) return cleanups;
  for (const entry of answer.cleanups) {
    if (cleanups.length >= MAX_CLEANUPS) break;
    if (!isPlainObject(entry)) continue;
    const { repositoryId, taskId, repositoryRoot } = entry;
    if (typeof repositoryId === "string" && REPOSITORY_ID.test(repositoryId) && typeof taskId === "string" && TASK_ID.test(taskId)
      && typeof repositoryRoot === "string") cleanups.push({ repositoryId, taskId, repositoryRoot });
  }
  return cleanups;
}

function stepsFrom(answer) {
  if (!isPlainObject(answer) || answer.ok !== true || !Array.isArray(answer.steps)) return [];
  return answer.steps.filter((step) => isPlainObject(step) && typeof step.repositoryId === "string" && REPOSITORY_ID.test(step.repositoryId)
    && typeof step.taskId === "string" && TASK_ID.test(step.taskId) && ["start", "review", "send_back", "merge"].includes(step.kind)
    && (step.kind === "merge" ? Number.isSafeInteger(step.pullRequest) && step.pullRequest > 0 && /^[a-f0-9]{40}$/u.test(step.headOid)
      && (step.mergeMethod === null || ["squash", "merge", "rebase"].includes(step.mergeMethod)) && !Object.hasOwn(step, "run")
      : step.kind === "send_back" ? !Object.hasOwn(step, "run")
      : !Object.hasOwn(step, "run") || (isPlainObject(step.run) && Object.keys(step.run).length === 3
        && ["claude", "codex"].includes(step.run.provider)
        && (step.run.model === null || (typeof step.run.model === "string" && MODEL.test(step.run.model)))
        && (step.run.effort === null || EFFORTS.has(step.run.effort))))).slice(0, MAX_STARTS);
}

function pauseReason(status) {
  if (typeof status === "string" && SETTLED.has(status)) return null;
  return typeof status === "string" && PAUSE_REASONS.has(status) ? status : "start_failed";
}

/** Low-priority queue advance: asks the monitor, starts each answer in turn, and pauses the queue with a fixed reason on failure so a start is never retried in a loop. */
export function createTaskQueueRunner(options = {}) {
  const starter = options.starter;
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = typeof options.authorizationToken === "string" && options.authorizationToken
    ? options.authorizationToken : null;
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(MIN_INTERVAL_MS, options.intervalMs) : DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  let timer = null;
  let started = false;
  let disposed = false;
  let ticks = 0;
  let grantsReady = false;

  async function resetGrants() {
    if (disposed || typeof starter.startGranted !== "function" || typeof starter.startGrantedReview !== "function") return;
    try {
      const answer = await post("grant-end-all", { reason: "app_restart" });
      grantsReady = answer?.ok === true && Number.isSafeInteger(answer.ended) && answer.ended >= 0;
    } catch { /* no grant executes if startup cleanup could not be confirmed */ }
  }

  async function post(route, body) {
    const response = await fetchImpl(`${monitorOrigin}/internal/tasks/${route}`, {
      method: "POST",
      cache: "no-store",
      headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    return response.json();
  }

  const taskMerge = createTaskMerge({ post, execFile: options.execFile, timeoutMs: options.mergeTimeoutMs });

  async function pause(repositoryId, taskId, reason) {
    try { await post("queue-pause", { repositoryId, payload: { id: taskId, reason } }); } catch { /* best effort */ }
  }

  async function tick() {
    if (disposed) return;
    let answer;
    try { answer = await post("queue-next", {}); } catch { return; }
    // The tasks of one step arrive together. A queue paused by one of them starts nothing more in this tick.
    const paused = new Set();
    for (const { repositoryId, taskId } of startsFrom(answer)) {
      if (disposed) return;
      if (paused.has(repositoryId)) continue;
      let status;
      try { status = (await starter.startQueued(repositoryId, taskId))?.status; } catch { status = undefined; }
      // A start refused because the app is closing is no failure: leave the queue as it is.
      if (disposed) return;
      const reason = pauseReason(status);
      if (reason) {
        paused.add(repositoryId);
        await pause(repositoryId, taskId, reason);
      }
    }
  }

  async function grantTick() {
    if (disposed || !grantsReady) return;
    let answer;
    try { answer = await post("grant-next", {}); } catch { return; }
    const ended = new Set();
    for (const { repositoryId, taskId } of stepsFrom(answer).filter((step) => step.kind === "send_back")) {
      if (disposed) return;
      try { await post("grant-send-back", { repositoryId, taskId }); } catch { /* a send-back request is settled and never retried here */ }
    }
    for (const step of stepsFrom(answer)) {
      const { repositoryId, taskId, kind, run } = step;
      if (kind === "send_back") continue;
      if (disposed) return;
      if (ended.has(repositoryId)) continue;
      const isAuthorized = async () => {
        if (disposed) return false;
        try {
          const answer = await post("grant-check", { repositoryId });
          return answer?.ok === true && answer.active === true && !disposed;
        } catch { return false; }
      };
      if (kind === "merge") {
        try { await taskMerge.merge(step, isAuthorized); } catch { /* merge failures never end a grant */ }
        continue;
      }
      let status;
      try {
        status = (await (kind === "start" ? starter.startGranted(repositoryId, taskId, isAuthorized)
          : starter.startGrantedReview(repositoryId, taskId, isAuthorized, run)))?.status;
      } catch { status = undefined; }
      if (disposed) return;
      if (status === "started") {
        try { await post("grant-record", { repositoryId, taskId, kind }); } catch { /* best effort; a launch is never retried here */ }
      } else if (!SETTLED.has(status)) {
        ended.add(repositoryId);
        try { await post("grant-end", { repositoryId, reason: "start_failed" }); } catch { /* best effort */ }
      }
    }
  }

  // The worktrees of tasks marked done since the last pass. One the desktop could not remove stays listed.
  async function cleanup() {
    if (disposed || typeof starter.cleanWorktree !== "function") return;
    let answer;
    try { answer = await post("worktree-cleanups", {}); } catch { return; }
    for (const { repositoryId, taskId, repositoryRoot } of cleanupsFrom(answer)) {
      if (disposed) return;
      let outcome;
      try { outcome = await starter.cleanWorktree(repositoryId, taskId, repositoryRoot); } catch { outcome = undefined; }
      if (disposed || !CLEANED.has(outcome)) continue;
      try { await post("worktree-cleaned", { repositoryId, payload: { id: taskId } }); } catch { /* asked again on a later pass */ }
    }
  }

  function arm() {
    if (disposed) return;
    timer = setTimer(async () => {
      timer = null;
      if (ticks === 0) await resetGrants();
      try { await tick(); } catch { /* a failed tick never ends the chain */ }
      try { await grantTick(); } catch { /* a failed tick never ends the chain */ }
      ticks += 1;
      if (ticks % CLEANUP_EVERY_TICKS === 1) { try { await cleanup(); } catch { /* a failed pass never ends the chain */ } }
      arm();
    }, intervalMs);
    timer?.unref?.();
  }

  return Object.freeze({
    start() {
      if (disposed || started || !monitorOrigin || !authorizationToken || typeof starter?.startQueued !== "function") return;
      started = true;
      arm();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  });
}
