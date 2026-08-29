import { createEmptyUsageLimits } from "../../shared/monitor-state.mjs";
import {
  assertProviderConformance,
  capabilitiesFromManifest,
  createProviderEvidenceAvailability,
  createProviderCapabilities,
  createProviderRuntimeReadiness,
  assertNormalizedObservationPublisher,
  assertProviderObserver,
  createScopedNormalizedObservationPublisher,
  parseProviderSessionReference,
  parseProviderSessionId,
  parseProviderSessionEvidence,
  parseProviderUsageLimits,
  qualifyProviderSessionId,
} from "./provider-contract.mjs";

function timestampValue(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareCatalogEntries(left, right) {
  const timeDifference = timestampValue(right.createdAt || right.updatedAt) - timestampValue(left.createdAt || left.updatedAt);
  if (timeDifference) return timeDifference;
  const providerDifference = left.providerIndex - right.providerIndex;
  if (providerDifference) return providerDifference;
  return left.localId.localeCompare(right.localId);
}

function automaticCandidates(entries) {
  const needsInput = entries.filter((entry) => entry.isLive && entry.needsInput);
  const otherLive = entries.filter((entry) => entry.isLive && !entry.needsInput);
  const historical = entries.filter((entry) => !entry.isLive);
  return [...needsInput, ...otherLive, ...historical];
}

const SESSION_ACTIVITY_STATUSES = new Set(["working", "needs_input", "idle", "unknown"]);

function normalizedSessionActivityStatus(entry) {
  if (!entry?.isLive) return "unknown";
  if (entry.needsInput) return "needs_input";
  return SESSION_ACTIVITY_STATUSES.has(entry.activityStatus) ? entry.activityStatus : "unknown";
}

function publicCatalogEntry(entry) {
  return {
    id: entry.id,
    provider: entry.provider.id,
    source: entry.provider.source,
    title: entry.title,
    project: entry.project,
    createdAt: entry.createdAt || entry.updatedAt,
    updatedAt: entry.updatedAt,
    isLive: Boolean(entry.isLive),
    needsInput: Boolean(entry.needsInput),
    activityStatus: normalizedSessionActivityStatus(entry),
  };
}

function normalizedResourceOwner(value) {
  if (!Number.isInteger(value?.pid) || value.pid <= 0) return null;
  if (typeof value.processStartIdentity !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9.:+-]{0,79}$/.test(value.processStartIdentity)) return null;
  return { pid: value.pid, processStartIdentity: value.processStartIdentity };
}

function resourceOwnerKey(owner) {
  return `${owner.pid}\0${owner.processStartIdentity}`;
}

function inspectCatalogEntries(entries) {
  const liveEntries = entries.filter((entry) => entry.isLive);
  const ownersBySessionId = new Map(liveEntries.map((entry) => [
    entry.id,
    normalizedResourceOwner(entry.resourceOwner),
  ]));
  const ownerCounts = new Map();
  for (const owner of ownersBySessionId.values()) {
    if (!owner) continue;
    const key = resourceOwnerKey(owner);
    ownerCounts.set(key, (ownerCounts.get(key) || 0) + 1);
  }
  const resourceTargets = liveEntries.map((entry) => {
    const owner = ownersBySessionId.get(entry.id);
    if (!owner) return { sessionId: entry.id, status: "unavailable" };
    if (ownerCounts.get(resourceOwnerKey(owner)) > 1) return { sessionId: entry.id, status: "shared" };
    return { sessionId: entry.id, pid: owner.pid, processStartIdentity: owner.processStartIdentity };
  });
  return {
    sessions: entries.map(publicCatalogEntry),
    resourceTargets,
  };
}

/**
 * Register provider adapters behind the provider-neutral monitor boundary.
 * Browser session IDs are parsed only as opaque provider-qualified IDs; they
 * are never interpreted as filesystem paths or handed to another provider.
 *
 * @param {any[]} adapters
 */
export function createProviderRegistry(adapters) {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new TypeError("Provider registry requires at least one adapter");
  }
  const providers = Object.freeze([...adapters]);
  const providersById = new Map();
  const diagnosticCategories = Object.freeze([
    "catalogReadFailures",
    "catalogEntriesRejected",
    "readinessProbeFailures",
    "sessionReadFailures",
    "sessionEvidenceRejected",
    "usageLimitReadFailures",
    "usageLimitEvidenceRejected",
    "observerStartFailures",
    "observerHydrationFailures",
    "observerPublicationRejected",
  ]);
  const diagnosticsByProvider = new Map();
  function recordDiagnostic(providerId, category) {
    if (!diagnosticCategories.includes(category)) return;
    const current = diagnosticsByProvider.get(providerId) || Object.fromEntries(diagnosticCategories.map((key) => [key, 0]));
    current[category] = Math.min(Number.MAX_SAFE_INTEGER, current[category] + 1);
    diagnosticsByProvider.set(providerId, current);
  }
  providers.forEach((provider, providerIndex) => {
    assertProviderConformance(provider);
    if (providersById.has(provider.id)) throw new TypeError(`Duplicate provider: ${provider.id}`);
    providersById.set(provider.id, { provider, providerIndex });
  });

  let catalogInFlight = null;

  /**
   * Start provider-owned acquisition/normalization workers.  The registry is
   * the sole bridge to the monitor-owned store publisher, so all values are
   * validated and scoped before crossing the provider boundary.  Existing
   * request-driven reads deliberately remain available during migration.
   *
   * @param {unknown} publisher
   * @param {AbortSignal | undefined} [parentSignal]
   */
  async function startObservers(publisher, parentSignal) {
    const target = assertNormalizedObservationPublisher(publisher);
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
    const observersByProvider = new Map();

    for (const provider of providers) {
      if (typeof provider.createObserver !== "function") continue;
      let observer;
      try {
        observer = assertProviderObserver(provider.createObserver());
        const scopedPublisher = createScopedNormalizedObservationPublisher(provider.id, {
          publishCatalog(providerId, entries) {
            try { target.publishCatalog(providerId, entries); }
            catch { recordDiagnostic(providerId, "observerPublicationRejected"); }
          },
          publishSession(providerId, localSessionId, evidence) {
            try { target.publishSession(providerId, localSessionId, evidence); }
            catch { recordDiagnostic(providerId, "observerPublicationRejected"); }
          },
          invalidateSession(providerId, localSessionId, reason) {
            try { target.invalidateSession(providerId, localSessionId, reason); }
            catch { recordDiagnostic(providerId, "observerPublicationRejected"); }
          },
          checkpointFor(providerId, localSessionId) {
            try { return typeof target.checkpointFor === "function" ? target.checkpointFor(providerId, localSessionId) : null; }
            catch { recordDiagnostic(providerId, "observerPublicationRejected"); return null; }
          },
        });
        await observer.start(scopedPublisher, controller.signal);
        observersByProvider.set(provider.id, observer);
      } catch {
        try { await observer?.stop?.(); } catch { /* provider failure remains isolated */ }
        recordDiagnostic(provider.id, "observerStartFailures");
        try { target.publishCatalog(provider.id, [], "unavailable"); } catch {
          recordDiagnostic(provider.id, "observerPublicationRejected");
        }
      }
    }

    let stopped = false;
    return Object.freeze({
      observers: Object.freeze([...observersByProvider.values()]),
      diagnostics() {
        return Object.freeze(Object.fromEntries([...observersByProvider].map(([providerId, observer]) => [
          providerId,
          typeof observer.diagnostics === "function" ? observer.diagnostics() : null,
        ])));
      },
      async hydrate(requestedSessionId) {
        const parsed = parseProviderSessionId(requestedSessionId);
        const observer = parsed ? observersByProvider.get(parsed.providerId) : null;
        if (!parsed || !observer || controller.signal.aborted) return false;
        try {
          return Boolean(await observer.hydrate(parsed.localSessionId));
        } catch {
          recordDiagnostic(parsed.providerId, "observerHydrationFailures");
          return false;
        }
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        controller.abort();
        if (parentSignal) parentSignal.removeEventListener("abort", abortFromParent);
        await Promise.allSettled([...observersByProvider.values()].map((observer) => (
          typeof observer.stop === "function" ? observer.stop() : undefined
        )));
      },
    });
  }

  async function loadCatalogEntries() {
    const results = await Promise.all(providers.map(async (provider, providerIndex) => {
      try {
        const sessions = await provider.listSessions();
        if (!Array.isArray(sessions)) return [];
        return sessions.flatMap((session) => {
          try {
            const reference = parseProviderSessionReference(session);
            const id = qualifyProviderSessionId(provider.id, reference.localId);
            return [{
              ...reference,
              id,
              provider,
              providerIndex,
            }];
          } catch {
            recordDiagnostic(provider.id, "catalogEntriesRejected");
            return [];
          }
        });
      } catch {
        recordDiagnostic(provider.id, "catalogReadFailures");
        return [];
      }
    }));
    const seen = new Set();
    return results.flat().sort(compareCatalogEntries).filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }

  function catalogEntries() {
    if (catalogInFlight) return catalogInFlight;

    const load = loadCatalogEntries()
      .finally(() => {
        if (catalogInFlight === load) catalogInFlight = null;
      });
    catalogInFlight = load;
    return load;
  }

  async function inspectSessions() {
    return inspectCatalogEntries(await catalogEntries());
  }

  async function resolveReadiness(provider, options = {}) {
    const manifest = provider?.capabilityManifest;
    if (!manifest) return {};
    if (options.historical) return createProviderRuntimeReadiness(manifest);
    try {
      const resolved = typeof provider.resolveReadiness === "function"
        ? await provider.resolveReadiness()
        : {};
      const readinessCapabilitySet = new Set(provider.readinessCapabilities || []);
      const resolvedKeys = Object.keys(resolved || {});
      if (resolvedKeys.length !== readinessCapabilitySet.size
        || resolvedKeys.some((key) => !readinessCapabilitySet.has(key))) {
        throw new TypeError("Provider readiness must report every declared readiness capability exactly once");
      }
      return createProviderRuntimeReadiness(manifest, resolved || {});
    } catch {
      recordDiagnostic(provider.id, "readinessProbeFailures");
      return createProviderRuntimeReadiness(manifest, Object.fromEntries(
        (provider.readinessCapabilities || []).map((key) => [key, { status: "unavailable", reason: "probe_failed" }]),
      ));
    }
  }

  async function resolveCapabilities(provider, options = {}) {
    const manifest = provider?.capabilityManifest;
    if (!manifest) return provider?.capabilities || createProviderCapabilities();
    return capabilitiesFromManifest(manifest, await resolveReadiness(provider, options));
  }

  async function readCandidate(entry, historical) {
    let evidence;
    try {
      evidence = await entry.provider.readSession(entry.localId, { historical });
    } catch {
      recordDiagnostic(entry.provider.id, "sessionReadFailures");
      return null;
    }
    if (!evidence) return null;
    try {
      const parsedEvidence = parseProviderSessionEvidence(evidence, entry.localId);
      return {
        provider: entry.provider,
        evidence: parsedEvidence,
        evidenceAvailability: createProviderEvidenceAvailability(
          entry.provider.capabilityManifest,
          parsedEvidence,
        ),
        sessionId: entry.id,
      };
    } catch {
      recordDiagnostic(entry.provider.id, "sessionEvidenceRejected");
      return null;
    }
  }

  return Object.freeze({
    providers,
    defaultProvider: providers[0],

    providerForSessionId(sessionId) {
      const parsed = parseProviderSessionId(sessionId);
      return parsed ? providersById.get(parsed.providerId)?.provider || null : null;
    },

    async listSessions() {
      return (await inspectSessions()).sessions;
    },

    inspectSessions,

    startObservers,

    createObserverLifecycle: startObservers,

    resolveReadiness,

    resolveCapabilities,

    diagnostics() {
      return Object.freeze(Object.fromEntries(providers.map((provider) => [
        provider.id,
        Object.freeze({ ...(diagnosticsByProvider.get(provider.id)
          || Object.fromEntries(diagnosticCategories.map((key) => [key, 0]))) }),
      ])));
    },

    async readSession(requestedSessionId = "", options = {}) {
      if (requestedSessionId) {
        const parsed = parseProviderSessionId(requestedSessionId);
        const registration = parsed ? providersById.get(parsed.providerId) : null;
        if (!parsed || !registration) return null;
        const catalogHint = options.catalogEntry?.id === requestedSessionId
          ? {
            ...options.catalogEntry,
            localId: parsed.localSessionId,
            provider: registration.provider,
          }
          : null;
        const catalogEntry = catalogHint || (await catalogEntries()).find((entry) => entry.id === requestedSessionId);
        return readCandidate(catalogEntry || {
          id: requestedSessionId,
          localId: parsed.localSessionId,
          provider: registration.provider,
        }, catalogEntry ? !catalogEntry.isLive : true);
      }

      const entries = await catalogEntries();
      for (const entry of automaticCandidates(entries)) {
        const selection = await readCandidate(entry, !entry.isLive);
        if (selection) return selection;
      }
      return null;
    },

    async readUsageLimits(provider, options = {}) {
      if (options.historical) return createEmptyUsageLimits();
      const capabilities = options.capabilities || await resolveCapabilities(provider, options);
      if (!capabilities.usageLimits || typeof provider?.readUsageLimits !== "function") {
        return createEmptyUsageLimits();
      }
      try {
        let value;
        try {
          value = await provider.readUsageLimits();
        } catch {
          recordDiagnostic(provider.id, "usageLimitReadFailures");
          return createEmptyUsageLimits({ error: "Usage limits are temporarily unavailable." });
        }
        try {
          return parseProviderUsageLimits(value);
        } catch {
          recordDiagnostic(provider.id, "usageLimitEvidenceRejected");
          return createEmptyUsageLimits({ error: "Usage limits are temporarily unavailable." });
        }
      } catch {
        return createEmptyUsageLimits({ error: "Usage limits are temporarily unavailable." });
      }
    },

    unavailableMessage(requestedSessionId = "") {
      if (requestedSessionId) return "The selected session is no longer available.";
      const provider = providers[0];
      return typeof provider.unavailableMessage === "function"
        ? provider.unavailableMessage("")
        : "No coding-agent sessions are available.";
    },

    watchTargets() {
      return providers.flatMap((provider) => provider.watchTargets || []);
    },
  });
}
