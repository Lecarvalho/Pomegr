import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STARTS = 16;
// A start that fails for one of these reasons pauses the queue with the same fixed reason; every other
// failure pauses it as `start_failed`. The rest never pause: a manual start is in flight, the task moved, or a
// start gate closed between the monitor's answer and the start, and the next tick asks the monitor again.
const PAUSE_REASONS = new Set(["cli_missing", "plugin_missing", "unsupported_platform"]);
const SETTLED = new Set(["started", "busy", "not_startable", "gate_held", "not_found", "cancelled"]);

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

/** The valid next starts of an answer, at most MAX_STARTS; anything but a plain `ok` answer yields none. */
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

/** The pause reason for a start status, or null when the start needs none. */
function pauseReason(status) {
  if (typeof status === "string" && SETTLED.has(status)) return null;
  return typeof status === "string" && PAUSE_REASONS.has(status) ? status : "start_failed";
}

/**
 * Low-priority advance of the task queue. The monitor decides which tasks of a queue-enabled repository are next
 * (the queued tasks of one step start together); this runner only asks, starts each answer in turn through the starter (the same path as a
 * manual start, minus the confirmation the user gave by turning the queue on) and pauses the queue with a fixed
 * reason when a start fails, so a failure is never retried in a loop. One unref'd timer chain, so a tick never
 * overlaps the previous one and the runner never keeps the app alive. It holds only repository and task IDs
 * for the length of a tick and never touches a started session.
 */
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

  function arm() {
    if (disposed) return;
    timer = setTimer(async () => {
      timer = null;
      try { await tick(); } catch { /* a failed tick never ends the chain */ }
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
