"use client";

/** One tab-scoped event stream. Consumers filter bounded revision publications locally. */
export type LiveEventDomain = "sessions" | "repositories" | "history" | "session-summary" | "agents" | "agent" | "signals" | "repository" | "resources" | "details";
export type LiveRevisionEvent = Readonly<{ type: "revision"; domain: LiveEventDomain; sessionId?: string; revision: number; total?: number; epoch: number }>;
export type LiveConnectionEvent = Readonly<{ type: "connection"; state: "connected" | "reconnecting"; epoch: number }>;
export type LiveEvent = LiveRevisionEvent | LiveConnectionEvent;

const EVENT_STREAM = "/api/events";
const EVENT_NAMES: ReadonlyArray<[string, LiveEventDomain]> = [
  ["catalog", "sessions"], ["repositories", "repositories"], ["history", "history"],
  ["session-summary", "session-summary"], ["agents", "agents"], ["agent", "agent"],
  ["signals", "signals"], ["repository", "repository"], ["resources", "resources"], ["details", "details"],
];
const SESSION_DOMAINS = new Set<LiveEventDomain>(["history", "session-summary", "agents", "agent", "signals", "repository", "resources", "details"]);
const SESSION_ID = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// One tab has a small, bounded number of active/recent session domains. Retain
// their latest revision for the connection epoch instead of every publication.
const MAX_REVISION_KEYS = 256;
type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let epoch = 0;
let state: LiveConnectionEvent["state"] = "reconnecting";
let latestRevisions = new Map<string, number>();

function emit(event: LiveEvent) { for (const listener of listeners) { try { listener(event); } catch { /* consumers are isolated */ } } }
function notify(listener: Listener, event: LiveEvent) { try { listener(event); } catch { /* consumers are isolated */ } }
function connection(next: LiveConnectionEvent["state"]) {
  if (state === next) return;
  state = next;
  emit(Object.freeze({ type: "connection" as const, state, epoch }));
}
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function rememberRevision(key: string, revision: number) {
  const previous = latestRevisions.get(key);
  if (previous !== undefined && revision <= previous) return false;
  // Refresh insertion order for active keys, then evict the least-recently
  // published key. This keeps the map bounded without retaining a session's
  // complete revision history.
  if (previous !== undefined) latestRevisions.delete(key);
  latestRevisions.set(key, revision);
  if (latestRevisions.size > MAX_REVISION_KEYS) {
    const oldest = latestRevisions.keys().next().value;
    if (oldest !== undefined) latestRevisions.delete(oldest);
  }
  return true;
}
function consume(domain: LiveEventDomain, message: MessageEvent<string>, owner: EventSource) {
  if (source !== owner) return;
  try {
    const value: unknown = JSON.parse(message.data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as { domain?: unknown; sessionId?: unknown; revision?: unknown; total?: unknown };
    if (input.domain !== domain || !validRevision(input.revision)) return;
    const sessionId = typeof input.sessionId === "string" && SESSION_ID.test(input.sessionId) ? input.sessionId : undefined;
    if (SESSION_DOMAINS.has(domain) && !sessionId) return;
    if (!SESSION_DOMAINS.has(domain) && input.sessionId !== undefined) return;
    const total = domain === "history" && Number.isSafeInteger(input.total) && Number(input.total) >= 0 ? Number(input.total) : undefined;
    const key = `${domain}|${sessionId || ""}`;
    if (!rememberRevision(key, input.revision)) return;
    emit(Object.freeze({ type: "revision" as const, domain, ...(sessionId ? { sessionId } : {}), revision: input.revision, ...(total === undefined ? {} : { total }), epoch }));
  } catch { /* malformed data never changes local state */ }
}
function scheduleReconnect() {
  if (!listeners.size || timer !== null) return;
  const delay = [250, 1_000, 3_000, 10_000][Math.min(attempts++, 3)];
  timer = setTimeout(() => { timer = null; connect(); }, delay);
}
function connect() {
  if (!listeners.size || source || timer !== null || typeof EventSource !== "function") return;
  epoch += 1;
  latestRevisions = new Map();
  let owner: EventSource;
  try { owner = new EventSource(EVENT_STREAM); }
  catch {
    connection("reconnecting");
    scheduleReconnect();
    return;
  }
  source = owner;
  for (const [name, domain] of EVENT_NAMES) owner.addEventListener(name, ((message: MessageEvent<string>) => consume(domain, message, owner)) as EventListener);
  owner.addEventListener("open", () => {
    if (source !== owner) return;
    attempts = 0;
    connection("connected");
  });
  owner.addEventListener("error", () => {
    if (source !== owner) return;
    source = null;
    try { owner.close(); } catch { /* best effort */ }
    connection("reconnecting");
    scheduleReconnect();
  });
}

export function subscribeLiveEvents(listener: Listener): () => void {
  if (typeof listener !== "function") throw new TypeError("Live event listener must be a function");
  listeners.add(listener);
  connect();
  // A new consumer needs the actual current state for its fallback cadence.
  // Only the EventSource open event may transition that state to connected.
  notify(listener, Object.freeze({ type: "connection" as const, state, epoch }));
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    if (timer !== null) clearTimeout(timer);
    timer = null; attempts = 0; latestRevisions = new Map();
    if (source) { try { source.close(); } catch { /* best effort */ } source = null; }
    state = "reconnecting";
  };
}

export function liveEventConnectionState() { return state; }
