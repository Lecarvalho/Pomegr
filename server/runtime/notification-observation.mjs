import { createNotificationLedger } from "../notifications/notification-ledger.mjs";

/** Joins committed observation callbacks to the bounded, in-memory ledger. */
export function createNotificationObservation({ now = Date.now } = {}) {
  const listeners = new Set();
  const ledger = createNotificationLedger({ now, onUpdate: publish });
  let unsubscribeCatalog = null;
  let stopped = false;
  let catalogScheduled = false;
  let serialized = JSON.stringify(ledger.readSnapshot());

  function publish(snapshot) {
    serialized = JSON.stringify(snapshot);
    const event = Object.freeze({ domain: "notifications", revision: snapshot.revision });
    for (const listener of listeners) {
      try { listener(event); } catch { /* One subscriber cannot block observation. */ }
    }
  }

  function acceptCatalogCommit(value) {
    if (stopped || !Number.isSafeInteger(value?.revision) || !Array.isArray(value.sessions)) return ledger.readSnapshot();
    try {
      return ledger.acceptFacts({ catalog: {
        revision: value.revision,
        readiness: value.readiness || "unavailable",
        sessions: value.sessions,
        activeSessionOverflow: value.activeSessionOverflow,
      } });
    } catch { return ledger.readSnapshot(); /* Failed derivation retains last known-good. */ }
  }

  function acceptProviderStatusCommit(committed) {
    if (stopped || !committed || !Number.isSafeInteger(committed.revision)
      || !Array.isArray(committed.value?.providers)) return ledger.readSnapshot();
    try {
      return ledger.acceptFacts({ providerStatus: {
        revision: committed.revision,
        providers: committed.value.providers,
      } });
    } catch { return ledger.readSnapshot(); /* Status polling remains independent. */ }
  }

  function attachCatalog({ subscribeRevisionEvents, serveNotificationCatalog }) {
    if (unsubscribeCatalog || typeof subscribeRevisionEvents !== "function"
      || typeof serveNotificationCatalog !== "function") return;
    stopped = false;
    const acceptLatest = () => {
      if (stopped || catalogScheduled) return;
      catalogScheduled = true;
      queueMicrotask(() => {
        catalogScheduled = false;
        if (stopped) return;
        try { acceptCatalogCommit(serveNotificationCatalog()); }
        catch { /* Catalog commit and its serving path stay independent. */ }
      });
    };
    unsubscribeCatalog = subscribeRevisionEvents((event) => {
      if (event?.domain === "sessions") acceptLatest();
    });
    // The subscription replays current revisions. This covers providers that do
    // not replay and coalesces rapid catalog commits onto the newest committed fact.
    acceptLatest();
  }

  function read(revision = null) {
    const value = ledger.readSnapshot();
    const snapshot = Object.freeze({ revision: value.revision, value, serialized });
    return Object.freeze({ status: revision === value.revision ? "unchanged" : "ready",
      revision: value.revision, snapshot });
  }

  function subscribeRevisionEvents(listener) {
    if (typeof listener !== "function") throw new TypeError("Revision subscriber must be a function");
    if (stopped) return () => {};
    listeners.add(listener);
    try { listener(Object.freeze({ domain: "notifications", revision: ledger.readSnapshot().revision })); }
    catch { /* Listener failure cannot block registration. */ }
    return () => listeners.delete(listener);
  }

  function stop() {
    stopped = true;
    unsubscribeCatalog?.();
    unsubscribeCatalog = null;
    listeners.clear();
  }

  return Object.freeze({ attachCatalog, acceptCatalogCommit, acceptProviderStatusCommit,
    read, readSnapshot: ledger.readSnapshot, subscribeRevisionEvents, stop });
}
