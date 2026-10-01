import { encodeSessionRoute } from "../../shared/session-route.mjs";

export const NEEDS_INPUT_NOTIFICATION_COPY = "A coding-agent session needs input";
export const NEEDS_INPUT_NOTIFICATION_DETAIL = "This live session is waiting for input.";
export const NOTIFICATION_FALLBACK_TARGET = "/sessions";
export const NOTIFICATION_POLL_INTERVAL_MS = 2_000;
export const NOTIFICATION_QUIET_DURATION_MS = 60 * 60_000;

const SAFE_SESSION_ID = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SESSION_TITLE_LENGTH = 96;
// The only route shapes a notification click may open: the session list and one
// session's observation view, the same destination the in-app alert links to.
const ALLOWED_NOTIFICATION_TARGET = /^\/sessions(?:\/[a-z][a-z0-9]{0,31}-[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

export function isSafeNotificationSessionId(value) {
  return typeof value === "string" && SAFE_SESSION_ID.test(value);
}

export function boundedNotificationTitle(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SESSION_TITLE_LENGTH);
}

/**
 * Mirrors the in-app needs-input alert: the normalized session title already
 * served in the session catalog, then one fixed line. No other field is read.
 */
export function needsInputNotificationPayload(session) {
  const title = boundedNotificationTitle(session?.title);
  if (!title) {
    return Object.freeze({
      title: "Pomegr",
      body: NEEDS_INPUT_NOTIFICATION_COPY,
    });
  }
  return Object.freeze({ title, body: NEEDS_INPUT_NOTIFICATION_DETAIL });
}

export function isAllowedNotificationTarget(value) {
  return typeof value === "string" && ALLOWED_NOTIFICATION_TARGET.test(value);
}

/** Same-origin relative route for a needs-input alert, or the session list. */
export function needsInputNotificationTarget(sessionId) {
  try {
    if (isSafeNotificationSessionId(sessionId)) {
      const target = `/sessions/${encodeSessionRoute(sessionId)}`;
      if (isAllowedNotificationTarget(target)) return target;
    }
  } catch {
    // An ID the router cannot encode falls back to the session list.
  }
  return NOTIFICATION_FALLBACK_TARGET;
}

function quietAt(quietUntil, nowMs) {
  const value = typeof quietUntil === "string" ? Date.parse(quietUntil) : Number(quietUntil);
  return Number.isFinite(value) && value > nowMs;
}

export function createNeedsInputNotificationController(options) {
  let previous = new Set();
  const now = options.now || Date.now;

  return Object.freeze({
    observe(sessions, mode = {}) {
      if (!Array.isArray(sessions)) return 0;
      const current = new Set();
      let emitted = 0;
      const enabled = mode.enabled === true;
      const quiet = quietAt(mode.quietUntil, now());

      for (const session of sessions) {
        const id = session?.id;
        if (!isSafeNotificationSessionId(id)) continue;
        const needsInput = session?.isLive === true && session?.needsInput === true;
        if (!needsInput) continue;
        current.add(id);
        if (previous.has(id) || !enabled || quiet) continue;
        const payload = needsInputNotificationPayload(session);
        const target = needsInputNotificationTarget(id);
        try {
          options.notify(payload, () => options.openTarget(target));
          emitted += 1;
        } catch {
          // Native notification failures never affect monitoring or expose details.
        }
      }

      previous = current;
      return emitted;
    },
    clear() { previous = new Set(); },
    activeSessionIds() { return Object.freeze([...previous]); },
  });
}

export function createSessionNotificationPoller(options) {
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel || ((handle) => clearTimeout(handle));
  const intervalMs = options.intervalMs ?? NOTIFICATION_POLL_INTERVAL_MS;
  let running = false;
  let timer = null;
  let requestController = null;

  const refresh = async () => {
    if (!running) return false;
    requestController = new AbortController();
    try {
      const sessions = await options.loadSessions(requestController.signal);
      if (Array.isArray(sessions)) options.controller.observe(sessions, options.getMode());
      return Array.isArray(sessions);
    } catch {
      return false;
    } finally {
      requestController = null;
      if (running) timer = schedule(() => { void refresh(); }, intervalMs);
    }
  };

  return Object.freeze({
    start() {
      if (running) return;
      running = true;
      void refresh();
    },
    stop() {
      running = false;
      if (timer !== null) cancel(timer);
      timer = null;
      requestController?.abort();
      requestController = null;
      options.controller.clear();
    },
    refresh,
  });
}
