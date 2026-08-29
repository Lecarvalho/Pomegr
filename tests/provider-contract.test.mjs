import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilitiesFromManifest,
  assertNormalizedObservationPublisher,
  assertProviderObserver,
  createScopedNormalizedObservationPublisher,
  createProviderCapabilityManifest,
  createProviderCapabilities,
  createProviderRuntimeReadiness,
  defineProvider,
  PROVIDER_CAPABILITY_KEYS,
  parseProviderSessionId,
  providerSource,
  qualifyProviderSessionId,
} from "../monitor/providers/provider-contract.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import { createEmptyMonitorState } from "../shared/monitor-state.mjs";

function capabilityManifest(supported = {}) {
  return Object.fromEntries(PROVIDER_CAPABILITY_KEYS.map((key) => [key, supported[key]
    ? { status: "supported" }
    : { status: "unsupported", limitation: { code: "monitor_not_implemented", documentation: `Synthetic adapter does not implement ${key}.` } }]));
}

test("qualifies provider-local session IDs without accepting paths", () => {
  assert.equal(qualifyProviderSessionId("claude", "session_123"), "claude:session_123");
  assert.equal(qualifyProviderSessionId("codex", "019fedff-eed0-7ce3-ad7d-f2fc749783d8"), "codex:019fedff-eed0-7ce3-ad7d-f2fc749783d8");
  assert.deepEqual(parseProviderSessionId("codex:thread-1"), { providerId: "codex", localSessionId: "thread-1" });
  assert.equal(parseProviderSessionId("unknown:thread-1"), null);
  assert.equal(parseProviderSessionId("codex:../thread-1"), null);
  assert.equal(parseProviderSessionId("codex:C:\\private\\thread.jsonl"), null);
  assert.equal(parseProviderSessionId("codex:thread:child"), null);
  assert.throws(() => qualifyProviderSessionId("codex", "../private"), /Unsafe provider-local session ID/);
});

test("derives browser capabilities from explicit support and runtime readiness", () => {
  const capabilities = createProviderCapabilities({ liveSessions: true, needsInput: true });
  assert.equal(capabilities.liveSessions, true);
  assert.equal(capabilities.needsInput, true);
  assert.equal(capabilities.estimatedCost, false);
  assert.equal(capabilities.contextMachinery, false);
  assert.equal(capabilities.cacheWriteUsage, false);
  assert.equal(capabilities.workflows, false);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.throws(() => createProviderCapabilities({ futureCapability: true }), /Unknown provider capability/);
  assert.throws(() => createProviderCapabilities({ liveSessions: "yes" }), /must be boolean/);
  assert.throws(() => createProviderCapabilityManifest({}), /explicitly classify every capability/);
  assert.throws(() => createProviderCapabilityManifest({ ...capabilityManifest(), liveSessions: { status: "unsupported" } }), /requires a bounded limitation/);
  const manifest = createProviderCapabilityManifest(capabilityManifest({ liveSessions: true, usageLimits: true }));
  const readiness = createProviderRuntimeReadiness(manifest, { usageLimits: { status: "unavailable", reason: "runtime_unavailable" } });
  assert.equal(readiness.liveSessions.status, "ready");
  assert.deepEqual(readiness.usageLimits, { status: "unavailable", reason: "runtime_unavailable" });
  assert.equal(capabilitiesFromManifest(manifest, readiness).liveSessions, true);
  assert.equal(capabilitiesFromManifest(manifest, readiness).usageLimits, false);
  assert.deepEqual(createProviderRuntimeReadiness(manifest).estimatedCost, { status: "not_applicable" });
});

test("validates provider declarations and optional usage readers", () => {
  const base = {
    id: "codex",
    source: "Codex",
    capabilityManifest: capabilityManifest({ liveSessions: true }),
    watchTargets: ["synthetic-root"],
    async listSessions() { return []; },
    async readSession() { return null; },
  };
  const provider = defineProvider(base);
  assert.equal(provider.source, providerSource("codex"));
  assert.equal(provider.capabilities.liveSessions, true);
  assert.deepEqual(provider.watchTargets, ["synthetic-root"]);
  assert.equal(Object.isFrozen(provider.watchTargets), true);
  assert.equal(Object.isFrozen(provider), true);
  assert.throws(() => defineProvider({ ...base, source: "Claude Code" }), /source must be Codex/);
  assert.throws(() => defineProvider({ ...base, capabilityManifest: capabilityManifest({ usageLimits: true }) }), /must implement readUsageLimits/);
  assert.throws(() => defineProvider({ ...base, watchTargets: [""] }), /watchTargets/);
  assert.throws(() => defineProvider({ ...base, unavailableMessage: "private" }), /unavailableMessage/);
  assert.throws(() => defineProvider({ ...base, resolveCapabilities: true }), /resolveCapabilities/);
  assert.throws(() => defineProvider({ ...base, resolveReadiness: async () => ({}) }), /declared together/);
  assert.throws(() => defineProvider({ ...base, readinessCapabilities: ["liveSessions"] }), /declared together/);
  assert.throws(() => defineProvider({ ...base, controlSession() {} }), /Unknown provider observation API/);
  assert.throws(() => defineProvider({ ...base, createObserver: true }), /createObserver/);
});

test("scopes and validates normalized observer publication before it crosses providers", () => {
  const published = [];
  const publisher = assertNormalizedObservationPublisher({
    publishCatalog(providerId, entries) { published.push(["catalog", providerId, entries]); },
    publishSession(providerId, localSessionId, value) { published.push(["session", providerId, localSessionId, value]); },
    invalidateSession(providerId, localSessionId, reason) { published.push(["invalidate", providerId, localSessionId, reason]); },
  });
  const scoped = createScopedNormalizedObservationPublisher("codex", publisher);
  scoped.publishCatalog([{
    localId: "session-1",
    title: "Session",
    project: "pomegr",
    updatedAt: "2026-08-10T12:00:00.000Z",
    isLive: true,
    needsInput: false,
    activityStatus: "working",
  }]);
  scoped.invalidateSession("session-1", "source_replaced");
  assert.deepEqual(published.map(([kind, providerId]) => [kind, providerId]), [
    ["catalog", "codex"],
    ["invalidate", "codex"],
  ]);
  assert.throws(() => scoped.invalidateSession("session-1", "private_reason"), /invalidation reason/);
  assert.throws(() => assertNormalizedObservationPublisher({}), /publishCatalog/);
  assert.throws(() => assertProviderObserver({}), /implement start/);
  assert.equal(assertProviderObserver({ start() {}, hydrate() {}, listSessions() {} }).hydrate instanceof Function, true);
});

test("keeps static support distinct from runtime readiness and session evidence", async () => {
  const provider = defineProvider({
    id: "codex",
    source: "Codex",
    capabilityManifest: capabilityManifest({ liveSessions: true, usageLimits: true }),
    readinessCapabilities: ["usageLimits"],
    async resolveReadiness() { return {}; },
    async listSessions() { return []; },
    async readSession() { return null; },
    async readUsageLimits() { return createEmptyMonitorState().usageLimits; },
  });
  const registry = createProviderRegistry([provider]);
  const readiness = await registry.resolveReadiness(provider);
  const capabilities = await registry.resolveCapabilities(provider);

  assert.equal(provider.capabilityManifest.usageLimits.status, "supported");
  assert.deepEqual(readiness.usageLimits, { status: "unavailable", reason: "probe_failed" });
  assert.equal(capabilities.usageLimits, false);
  assert.equal(capabilities.liveSessions, true);
  assert.equal(registry.diagnostics().codex.readinessProbeFailures, 2);
});

test("keeps optional resource ownership private while passing it to the monitor", async () => {
  const provider = defineProvider({
    id: "codex",
    source: "Codex",
    capabilityManifest: capabilityManifest({ liveSessions: true }),
    async listSessions() {
      return [{
        localId: "resource-session",
        title: "Resource session",
        project: "pomegr",
        updatedAt: "2026-08-14T12:00:00.000Z",
        isLive: true,
        needsInput: false,
        activityStatus: "working",
        resourceOwner: {
          pid: 987_654_321,
          processStartIdentity: "ProcessStartMustNotLeak",
        },
      }];
    },
    async readSession() { return null; },
  });
  const registry = createProviderRegistry([provider]);

  const inspected = await registry.inspectSessions();
  assert.deepEqual(inspected.resourceTargets, [{
    sessionId: "codex:resource-session",
    pid: 987_654_321,
    processStartIdentity: "ProcessStartMustNotLeak",
  }]);
  assert.deepEqual(inspected.sessions, [{
    id: "codex:resource-session",
    provider: "codex",
      source: "Codex",
      title: "Resource session",
      project: "pomegr",
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
    isLive: true,
    needsInput: false,
    activityStatus: "working",
  }]);
  assert.deepEqual(await registry.listSessions(), inspected.sessions);
  assert.doesNotMatch(
    JSON.stringify(inspected.sessions),
    /987654321|ProcessStartMustNotLeak|resourceOwner|processStartIdentity|"pid"/,
  );
});

test("creates provider-aware empty state while preserving the Claude default", () => {
  assert.equal(createEmptyMonitorState().source, "Claude Code");
  assert.equal(createEmptyMonitorState({ source: "Codex", connected: true }).source, "Codex");
  assert.equal(createEmptyMonitorState().capabilities.estimatedCost, false);
  assert.equal(createEmptyMonitorState().capabilities.contextMachinery, false);
  assert.equal(createEmptyMonitorState().capabilities.workflows, false);
  assert.deepEqual(createEmptyMonitorState().metrics.tokens.requestSnapshots, { status: "unavailable", items: [] });
  assert.deepEqual(createEmptyMonitorState().workflows, []);
});
