export type HistoryPublication = Readonly<{ domain: "history"; revision: number; receivedAt: number }>;
type Listener = (publication: HistoryPublication) => void;

const EVENT_STREAM = "/api/events";
const listeners = new Set<Listener>();
let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let lastRevision = -1;

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function consume(message: MessageEvent<string>) {
  try {
    const value: unknown = JSON.parse(message.data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const event = value as { domain?: unknown; revision?: unknown };
    if (event.domain !== "history" || !validRevision(event.revision) || event.revision <= lastRevision) return;
    lastRevision = event.revision;
    const receivedAt = typeof performance === "undefined" ? -1 : performance.now();
    if (!Number.isFinite(receivedAt) || receivedAt < 0) return;
    const publication = Object.freeze({ domain: "history" as const, revision: event.revision, receivedAt });
    for (const listener of listeners) {
      try { listener(publication); } catch { /* a consumer cannot break the shared stream */ }
    }
  } catch {
    // Malformed or future event shapes cannot alter browser state.
  }
}

function scheduleReconnect() {
  if (!listeners.size || reconnectTimer !== null) return;
  const delay = [250, 1_000, 3_000, 10_000][Math.min(reconnectAttempt++, 3)];
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (!listeners.size || eventSource || typeof EventSource !== "function") return;
  // A new stream may belong to a restarted monitor whose revision domain has
  // reset. Deduplication is scoped to one connection so recovery can resume.
  lastRevision = -1;
  const source = new EventSource(EVENT_STREAM);
  eventSource = source;
  source.addEventListener("history", ((message: MessageEvent<string>) => {
    // A closed stream can still deliver a queued browser event after an error.
    // Never let that old connection advance the new stream's revision epoch.
    if (eventSource !== source) return;
    consume(message);
  }) as EventListener);
  source.addEventListener("error", () => {
    if (eventSource !== source) return;
    eventSource = null;
    try { source.close(); } catch { /* cleanup is best effort */ }
    scheduleReconnect();
  });
}

export function subscribeHistoryPublications(listener: Listener): () => void {
  if (typeof listener !== "function") throw new TypeError("History publication listener must be a function");
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    if (eventSource) {
      try { eventSource.close(); } catch { /* cleanup is best effort */ }
      eventSource = null;
    }
    lastRevision = -1;
  };
}
