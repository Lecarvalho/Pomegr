import { createEmptyUsageLimits } from "../../shared/monitor-state.mjs";
import {
  createProviderCapabilities,
  parseProviderSessionId,
  qualifyProviderSessionId,
} from "./provider-contract.mjs";

/** @typedef {import("./provider-contract").ProviderAdapter} ProviderAdapter */

function timestampValue(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareCatalogEntries(left, right) {
  const timeDifference = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
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

function publicCatalogEntry(entry) {
  return {
    id: entry.id,
    provider: entry.provider.id,
    source: entry.provider.source,
    title: entry.title,
    project: entry.project,
    updatedAt: entry.updatedAt,
    isLive: Boolean(entry.isLive),
    needsInput: Boolean(entry.needsInput),
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
 * @param {ProviderAdapter[]} adapters
 */
export function createProviderRegistry(adapters) {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new TypeError("Provider registry requires at least one adapter");
  }
  const providers = Object.freeze([...adapters]);
  const providersById = new Map();
  providers.forEach((provider, providerIndex) => {
    if (providersById.has(provider.id)) throw new TypeError(`Duplicate provider: ${provider.id}`);
    providersById.set(provider.id, { provider, providerIndex });
  });

  let catalogInFlight = null;

  async function loadCatalogEntries() {
    const results = await Promise.all(providers.map(async (provider, providerIndex) => {
      try {
        const sessions = await provider.listSessions();
        if (!Array.isArray(sessions)) return [];
        return sessions.flatMap((session) => {
          try {
            const id = qualifyProviderSessionId(provider.id, session.localId);
            return [{
              ...session,
              id,
              provider,
              providerIndex,
            }];
          } catch {
            return [];
          }
        });
      } catch {
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

  async function resolveCapabilities(provider, options = {}) {
    const declared = provider?.capabilities || createProviderCapabilities();
    if (options.historical || typeof provider?.resolveCapabilities !== "function") return declared;
    try {
      const resolved = await provider.resolveCapabilities();
      return createProviderCapabilities({ ...declared, ...(resolved || {}) });
    } catch {
      return createProviderCapabilities({ ...declared, usageLimits: false });
    }
  }

  async function readCandidate(entry, historical) {
    try {
      const evidence = await entry.provider.readSession(entry.localId, { historical });
      if (!evidence || evidence.localId !== entry.localId) return null;
      return { provider: entry.provider, evidence, sessionId: entry.id };
    } catch {
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

    resolveCapabilities,

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
        return await provider.readUsageLimits();
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
