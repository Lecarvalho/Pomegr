import { createNotificationLedger } from "../notifications/notification-ledger.mjs";
import { comparePluginVersions, repositoryPluginSetupSchema } from "../../shared/repository-plugin-state.mjs";

/** Joins committed observation callbacks to the bounded, durable ledger. */
export function createNotificationObservation({ now = Date.now, persistence = null, sourceScope } = {}) {
  const listeners = new Set();
  const ledger = createNotificationLedger({ now, onUpdate: publish,
    onCommit: (state) => { if (persistence) void persistence.write(state); } });
  let unsubscribeCatalog = null;
  let stopped = false;
  let catalogScheduled = false;
  let serialized = JSON.stringify(ledger.readSnapshot());
  let startPromise = null;
  let releaseRevision = 0;
  const published = new Map();
  const pluginSetups = new Map();

  async function start() {
    if (!persistence) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const result = await persistence.load();
      if (result.state) ledger.restore(result.state);
      return result.status;
    })();
    return startPromise;
  }

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
        sourceScope,
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
        sourceScope,
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

  function acceptUsageCommit(committed) {
    if (stopped || !Number.isSafeInteger(committed?.revision) || !Array.isArray(committed.providers)) return ledger.readSnapshot();
    try { return ledger.acceptFacts({ usage: { ...committed, sourceScope } }); }
    catch { return ledger.readSnapshot(); }
  }

  function commitReleases() {
    const observations = [...published.values()];
    const plugin = [...pluginSetups.values()].filter((row) => row.pinned === false && row.setup?.readiness === "ready"
      && typeof row.setup.update?.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(row.setup.update.version)
      && row.setup.update?.status !== "unavailable" && row.setup.update?.status !== "unknown");
    if (plugin.length) {
      const latest = plugin.reduce((best, row) => comparePluginVersions(best.setup.update.version, row.setup.update.version) < 0 ? row : best);
      const version = latest.setup.update.version;
      const outdated = plugin.filter((row) => row.setup.update.version === version && row.setup.update.status === "available");
      const affected = new Set(outdated.map((row) => row.repositoryId));
      observations.push({ provider: null, product: "pomegr_plugin", version, channel: "main",
        observedAt: latest.setup.update.checkedAt,
        installation: affected.size ? { status: "installed", version: outdated[0].setup.version, channel: "main", affectedRepositories: affected.size } : null });
    }
    try { return ledger.acceptFacts({ releases: { revision: ++releaseRevision, observations, sourceScope } }); }
    catch { return ledger.readSnapshot(); }
  }

  function acceptReleaseObservations(values) {
    if (stopped || !Array.isArray(values)) return ledger.readSnapshot();
    for (const row of values) {
      if (row?.product !== "claude_code" && row?.product !== "codex_cli") continue;
      const expected = row.product === "claude_code"
        ? { provider: "claude", channel: "latest", sourceKey: "anthropics/claude-code" }
        : { provider: "codex", channel: "latest", sourceKey: "releases.openai.com/codex" };
      if (row.provider !== expected.provider || row.channel !== expected.channel || row.sourceKey !== expected.sourceKey
        || typeof row.version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(row.version)
        || !Number.isFinite(Date.parse(row.observedAt || "")) || !Number.isFinite(Date.parse(row.publishedAt || ""))) continue;
      published.set(row.product, { provider: row.provider, product: row.product, version: row.version,
        channel: row.channel, observedAt: row.observedAt, installation: null });
    }
    return commitReleases();
  }

  function acceptPluginSetupCommits(values) {
    if (stopped || !Array.isArray(values) || values.length > 400) return ledger.readSnapshot();
    const next = new Map();
    for (const value of values) {
      if (!value || typeof value.repositoryId !== "string" || !/^repo-[a-f0-9]{24}$/u.test(value.repositoryId)
        || !["claude", "codex"].includes(value.provider) || typeof value.pinned !== "boolean") return ledger.readSnapshot();
      const parsed = repositoryPluginSetupSchema.safeParse(value.setup);
      if (!parsed.success) return ledger.readSnapshot();
      next.set(`${value.repositoryId}:${value.provider}`, { repositoryId: value.repositoryId,
        provider: value.provider, pinned: value.pinned,
        setup: { readiness: parsed.data.readiness, version: parsed.data.version, update: parsed.data.update } });
    }
    pluginSetups.clear();
    for (const [key, value] of next) pluginSetups.set(key, value);
    return commitReleases();
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

  async function stop() {
    stopped = true;
    unsubscribeCatalog?.();
    unsubscribeCatalog = null;
    listeners.clear();
    await persistence?.drain();
  }

  return Object.freeze({ start, attachCatalog, acceptCatalogCommit, acceptProviderStatusCommit, acceptUsageCommit,
    acceptReleaseObservations, acceptPluginSetupCommits,
    read, readSnapshot: ledger.readSnapshot, subscribeRevisionEvents, stop });
}
