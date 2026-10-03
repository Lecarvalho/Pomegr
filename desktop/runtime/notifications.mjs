import { encodeSessionRoute } from "../../shared/session-route.mjs";
import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { isUsageNotificationKind, normalizeUsageNotificationData, usageNotificationPayload, usageNotificationPolicy } from "../../shared/usage-notification.mjs";
import { isReleaseNotificationKind, normalizeReleaseNotificationData, releaseNotificationPayload, releaseNotificationPolicy } from "../../shared/release-notification.mjs";

export const NOTIFICATION_POLL_INTERVAL_MS = 2_000;
export const NOTIFICATION_MAX_CATCHUP_MS = 15 * 60_000;
export const NOTIFICATION_TOASTS_PER_MINUTE = 3;
export const NOTIFICATION_MAX_RESPONSE_BYTES = 1024 * 1024;
export const NOTIFICATION_FALLBACK_TARGET = "/sessions";
export const NATIVE_NOTIFICATION_CATEGORY_DEFAULTS = Object.freeze({
  attention: true, provider_service: false, system: false,
  usage: true, provider_news: false, model_news: false,
});

const ID = /^[a-f0-9]{32}$/u;
const SESSION_ID = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TERMINAL = /^[a-z][a-z_]{0,31}$/u;
const SAFE_TEXT = /^[^<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/u;
const ALLOWED_NOTIFICATION_TARGET = /^(?:\/|\/sessions(?:\/(?:claude|codex)-[A-Za-z0-9][A-Za-z0-9._-]{0,127})?|\/usage-limits)$/u;
const PROVIDER_LABEL = Object.freeze({ claude: "Claude Code", codex: "Codex" });

export function isAllowedNotificationTarget(value) {
  return typeof value === "string" && ALLOWED_NOTIFICATION_TARGET.test(value);
}

/** One bounded read of the existing committed same-origin cache. */
export async function loadCommittedNotificationSnapshot({ origin, authorizationToken, signal, fetchImpl = fetch } = {}) {
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch { return null; }
  if (parsedOrigin.protocol !== "http:" || parsedOrigin.hostname !== "127.0.0.1" || !parsedOrigin.port
    || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== "/"
    || parsedOrigin.search || parsedOrigin.hash || typeof authorizationToken !== "string"
    || !authorizationToken || authorizationToken.length > 128 || !signal) return null;
  const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
  const response = await fetchImpl(`${parsedOrigin.origin}/api/notifications`, {
    cache: "no-store", redirect: "error", headers: { [DESKTOP_AUTH_HEADER]: authorizationToken }, signal: combinedSignal,
  });
  if (response.status !== 200 || !response.body || Number(response.headers.get("content-length")) > NOTIFICATION_MAX_RESPONSE_BYTES) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > NOTIFICATION_MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body);
}

/** Resolve only fixed local destinations; records never supply a URL. */
export function notificationTarget(record) {
  if (record?.action === "open_session" && record.kind === "needs_input"
    && typeof record.data?.sessionId === "string" && SESSION_ID.test(record.data.sessionId)
    && record.data.sessionId.startsWith(`${record.provider}:`)) {
    try {
      const target = `/sessions/${encodeSessionRoute(record.data.sessionId)}`;
      if (isAllowedNotificationTarget(target)) return target;
    } catch { /* A malformed identity falls back to the session list. */ }
  }
  if (["open_providers", "open_usage_limits"].includes(record?.action)) return "/usage-limits";
  if (record?.action === "open_workspace") return "/";
  return NOTIFICATION_FALLBACK_TARGET;
}

function iso(value) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

/** Rebuilds only fields native delivery needs; unknown future kinds are consumed silently. */
export function normalizeNativeNotificationSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.version !== 1
    || !Number.isSafeInteger(input.revision) || input.revision < 0
    || !Array.isArray(input.occurrences) || input.occurrences.length > 200
    || !input.readiness || typeof input.readiness !== "object") return null;
  const readiness = ["catalog", "providerStatus"].map((key) => input.readiness[key]);
  if (readiness.some((value) => !["loading", "ready", "partial", "stale", "unavailable"].includes(value))) return null;
  const rows = [];
  const seen = new Set();
  for (const row of input.occurrences) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !ID.test(row.id) || seen.has(row.id)
      || typeof row.kind !== "string" || !TERMINAL.test(row.kind)
      || typeof row.category !== "string" || !TERMINAL.test(row.category) || !iso(row.occurredAt)
      || !Number.isSafeInteger(row.priority) || row.priority < 0 || row.priority > 100
      || typeof row.deliveryEligible !== "boolean" || !["active", "resolved"].includes(row.lifecycle)
      || !["claude", "codex", ...(isReleaseNotificationKind(row.kind) ? [null] : [])].includes(row.provider)) return null;
    seen.add(row.id);
    const normalized = { id: row.id, kind: row.kind, category: row.category, priority: row.priority,
      occurredAt: row.occurredAt, deliveryEligible: row.deliveryEligible, lifecycle: row.lifecycle,
      provider: row.provider, action: ["open_session", "open_sessions", "open_providers", "open_workspace", "open_usage_limits"].includes(row.action) ? row.action : null,
      data: {} };
    if (isUsageNotificationKind(row.kind)) {
      const data = normalizeUsageNotificationData(row.kind, row.provider, row.data);
      const policy = usageNotificationPolicy(row.kind);
      if (!data || row.category !== policy.category || row.action !== "open_usage_limits" || row.priority !== policy.priority
        || row.lifecycle !== "resolved" || row.severity !== policy.severity || row.timeBasis !== "observed") return null;
      normalized.data = data;
    } else if (isReleaseNotificationKind(row.kind)) {
      const data = normalizeReleaseNotificationData(row.kind, row.provider, row.data);
      const policy = releaseNotificationPolicy(row.kind);
      if (!data || row.category !== policy.category || row.action !== policy.action || row.priority !== policy.priority
        || row.lifecycle !== "resolved" || row.severity !== policy.severity || row.timeBasis !== "observed") return null;
      normalized.data = data;
    } else if (row.kind === "needs_input") {
      if (typeof row.data?.sessionId !== "string" || !SESSION_ID.test(row.data.sessionId)
        || !row.data.sessionId.startsWith(`${row.provider}:`)
        || typeof row.data.sessionTitle !== "string" || row.data.sessionTitle.length > 96
        || !SAFE_TEXT.test(row.data.sessionTitle)) return null;
      normalized.data = { sessionId: row.data.sessionId, sessionTitle: row.data.sessionTitle };
    } else if (row.kind === "provider_incident") {
      if (!["degraded", "outage", "maintenance"].includes(row.data?.status)) return null;
      normalized.data = { status: row.data.status };
    } else if (row.kind === "provider_recovery") {
      if (row.data?.status !== "operational") return null;
      normalized.data = { status: "operational" };
    }
    rows.push(normalized);
  }
  return Object.freeze({ revision: input.revision, readiness: { catalog: readiness[0], providerStatus: readiness[1] }, occurrences: rows });
}

/** Static native copy; no provider-supplied description, URL, or command is read. */
export function nativeNotificationPayload(record) {
  if (isUsageNotificationKind(record.kind)) return usageNotificationPayload(record);
  if (isReleaseNotificationKind(record.kind)) return releaseNotificationPayload(record);
  if (record.kind === "needs_input" && record.lifecycle === "active") {
    const title = record.data.sessionTitle.replace(/\s+/gu, " ").trim().slice(0, 96);
    return Object.freeze(title
      ? { title, body: "Needs input. This live session is waiting for your action." }
      : { title: "Pomegr", body: "A coding-agent session needs input." });
  }
  if (record.kind === "provider_incident" && record.lifecycle === "active") return Object.freeze({
    title: `${PROVIDER_LABEL[record.provider]} reports service issues`,
    body: record.data.status === "outage" ? "The provider reports an outage. Requests may be delayed or fail."
      : record.data.status === "maintenance" ? "The provider reports maintenance. Requests may be delayed."
        : "The provider reports degraded service. Requests may be delayed or fail.",
  });
  if (record.kind === "provider_recovery") return Object.freeze({
    title: `${PROVIDER_LABEL[record.provider]} reports service restored`,
    body: "The provider's public status is operational again.",
  });
  return null;
}

function quietAt(value, now) {
  const until = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(until) && until > now;
}

function preferences(value) {
  const categories = {};
  for (const [key, fallback] of Object.entries(NATIVE_NOTIFICATION_CATEGORY_DEFAULTS)) {
    categories[key] = typeof value?.categories?.[key] === "boolean" ? value.categories[key] : fallback;
  }
  return { enabled: value?.enabled === true, quietUntil: value?.quietUntil ?? null, categories };
}

/** One Electron-owned consumer. Claims every new ID before selecting any native toast. */
export function createNativeNotificationController({ store, notify, openTarget, getPreferences,
  present = nativeNotificationPayload, now = Date.now } = {}) {
  if (!store || typeof notify !== "function" || typeof openTarget !== "function" || typeof getPreferences !== "function") throw new TypeError("Invalid notification controller");
  let started = false;
  let degraded = false;
  let tail = Promise.resolve();
  let toastTimes = [];
  const newsDeliveredAt = new Map();

  async function start() {
    if (started) return "ready";
    started = true;
    return store.load();
  }

  async function process(input) {
    const snapshot = normalizeNativeNotificationSnapshot(input);
    if (!started || !snapshot || !store.writable()) return 0;
    if (!snapshot.occurrences.length && snapshot.readiness.catalog === "loading" && snapshot.readiness.providerStatus === "loading") return 0;
    const unseen = snapshot.occurrences.filter((row) => !store.has(row.id));
    if (!store.initialized()) {
      degraded = !await store.claim(snapshot.occurrences.map((row) => row.id));
      return 0;
    }
    if (!unseen.length) return 0;
    if (!await store.claim(unseen.map((row) => row.id))) { degraded = true; return 0; }
    if (degraded) { degraded = false; return 0; }
    const clock = now();
    const mode = preferences(getPreferences());
    if (!mode.enabled || quietAt(mode.quietUntil, clock)) return 0;
    toastTimes = toastTimes.filter((at) => clock - at < 60_000 && clock >= at);
    const candidates = unseen.filter((row) => row.deliveryEligible && mode.categories[row.category] === true
      && clock >= Date.parse(row.occurredAt) - 60_000 && clock - Date.parse(row.occurredAt) <= NOTIFICATION_MAX_CATCHUP_MS)
      .sort((left, right) => right.priority - left.priority || right.occurredAt.localeCompare(left.occurredAt));
    const coalesced = new Set();
    let emitted = 0;
    for (const row of candidates) {
      if (toastTimes.length >= NOTIFICATION_TOASTS_PER_MINUTE) break;
      const group = ["provider_news", "model_news"].includes(row.category) ? row.category : null;
      if (group && (coalesced.has(group) || clock - (newsDeliveredAt.get(group) ?? Number.NEGATIVE_INFINITY) < 60_000)) continue;
      const payload = present(row);
      if (!payload || typeof payload.title !== "string" || !payload.title || payload.title.length > 96
        || typeof payload.body !== "string" || !payload.body || payload.body.length > 200
        || !SAFE_TEXT.test(payload.title) || !SAFE_TEXT.test(payload.body)) continue;
      const target = notificationTarget(row);
      try {
        if (notify(payload, () => openTarget(target)) === true) {
          toastTimes.push(clock);
          if (group) { coalesced.add(group); newsDeliveredAt.set(group, clock); }
          emitted += 1;
        }
      } catch { /* The durable claim remains; OS failure never affects monitor state. */ }
    }
    return emitted;
  }

  function observe(snapshot) {
    const operation = tail.then(() => process(snapshot)).catch(() => 0);
    tail = operation.then(() => {});
    return operation;
  }
  return Object.freeze({ start, observe });
}

/** Polls only the already-committed same-origin response. No tab owns this loop. */
export function createNotificationPoller({ controller, loadSnapshot, intervalMs = NOTIFICATION_POLL_INTERVAL_MS,
  schedule = (callback, delay) => setTimeout(callback, delay), cancel = clearTimeout } = {}) {
  let running = false;
  let timer = null;
  let request = null;
  let inFlight = null;
  function refresh() {
    if (!running) return Promise.resolve(false);
    if (inFlight) return inFlight;
    if (timer !== null) { cancel(timer); timer = null; }
    inFlight = (async () => {
      request = new AbortController();
      try {
        const snapshot = await loadSnapshot(request.signal);
        if (!running || !snapshot) return false;
        await controller.observe(snapshot);
        return true;
      } catch { return false; }
      finally {
        request = null;
        if (running) timer = schedule(() => { timer = null; void refresh(); }, intervalMs);
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  return Object.freeze({
    async start() {
      if (running) return;
      running = true;
      try { await controller.start(); } catch { /* Invalid store disables delivery. */ }
      if (running) void refresh();
    },
    stop() {
      running = false;
      if (timer !== null) cancel(timer);
      timer = null;
      request?.abort();
      request = null;
    },
    refresh,
  });
}
