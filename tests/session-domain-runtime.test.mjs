import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionReadiness } from "../monitor/observation-readiness.mjs";
import { createMonitorRuntime } from "../monitor/server.mjs";
import { SessionHistoryStore } from "../monitor/session-history-store.mjs";
import { SessionObservationCheckpointStore } from "../monitor/session-observation-checkpoints.mjs";
import { SessionObservationStore } from "../monitor/session-observation-store.mjs";
import { parseProviderSessionEvidence } from "../monitor/providers/provider-contract.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../shared/monitor-state.mjs";
import { monitorStateFromProviderEvidence } from "./helpers/provider-fixtures.mjs";

const evidence = JSON.parse(await readFile(new URL("./fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));
const sessionId = `codex:${evidence.localId}`;

function restoredStore(publicState) {
  const store = new SessionObservationStore();
  const outcome = store.restore({
    providerId: "codex",
    localSessionId: evidence.localId,
    qualifiedId: sessionId,
    evidence,
    readiness: createSessionReadiness("ready"),
    publicState,
    observedAt: "2026-09-14T12:00:00.000Z",
    source: { fingerprint: "restored-safe-fingerprint", completeOffset: 1 },
    revision: 5,
  });
  assert.equal(outcome.accepted, true);
  return store;
}

test("startup projects unchanged restored observations and cache misses rebuild only from committed state", async (context) => {
  let clock = Date.parse("2026-09-14T12:00:00.000Z");
  let transcriptReads = 0;
  let hydrations = 0;
  const capabilities = createEmptyProviderCapabilities();
  const provider = {
    id: "codex",
    source: "Codex",
    capabilities,
    homePolicy: { requestModelObservations: true, modelSelection: false, usageLimitActivity: { enabled: false } },
  };
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerFolders: { folders: { claudeConfigDir: null, claudeProjectsDir: null, codexHome: process.cwd() } },
    providerForSessionId: () => provider,
    async resolveCapabilities() { return capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession() { transcriptReads += 1; return null; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(publisher) {
      publisher.publishCatalog("codex", [{
        localId: evidence.localId,
        title: evidence.session.title,
        project: evidence.session.project,
        updatedAt: evidence.session.updatedAt,
        isLive: true,
        needsInput: false,
        activityStatus: "working",
      }]);
      return {
        async hydrate() { hydrations += 1; return false; },
        async stop() {},
      };
    },
  };
  const publicState = monitorStateFromProviderEvidence("codex", evidence);
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    observationStore: restoredStore(publicState),
    checkpointStore: false,
    historyStore: new SessionHistoryStore(),
    now: () => clock,
    sessionDomainIdleMs: 1_000,
    observationCommitDelayMs: 0,
    scheduleObservation: (task, delay = 0) => setTimeout(task, delay),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  await runtime.startObservation();
  context.after(async () => runtime.stopObservation());

  let summary;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    summary = runtime.serveSessionDomain(sessionId, "session-summary", null, null);
    if (summary.status === "ready" && summary.snapshot.value.lifecycle.activityStatus === "working") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(summary.status, "ready", "restored state is projected even without a new session commit");
  assert.equal(summary.snapshot.value.session.id, sessionId);
  assert.equal(summary.snapshot.value.lifecycle.activityStatus, "working", "catalog identity participates in the summary projection");
  const priorRevision = summary.revision;

  const events = [];
  const unsubscribe = runtime.subscribeRevisionEvents((event) => events.push(event));
  events.length = 0;
  clock += 1_001;
  const loading = runtime.serveSessionDomain(sessionId, "session-summary", null, priorRevision);
  assert.equal(loading.status, "loading", "idle derived entries drop while their committed source remains available");
  assert.equal(loading.snapshot, null);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    summary = runtime.serveSessionDomain(sessionId, "session-summary", null, priorRevision);
    if (summary.status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  unsubscribe();
  assert.equal(summary.status, "ready");
  assert.ok(summary.revision > priorRevision, "an evicted ETag is never reused after committed-state rebuild");
  assert.ok(events.some((event) => event.domain === "session-summary" && event.sessionId === sessionId));
  assert.equal(transcriptReads, 0, "session-domain serving never invokes provider session acquisition");
  assert.equal(hydrations, 0, "a committed restored observation does not need source hydration");
});

test("unsupported repository paths cannot enter evidence, checkpoints, or normalized history", async (context) => {
  const privatePath = "../PRIVATE_PATH_MUST_NOT_LEAK";
  const invalidEvidence = structuredClone(evidence);
  invalidEvidence.session.fileChanges = [{ path: privatePath, kind: "edited" }];
  const validateCandidate = ({ evidence: candidate, localSessionId }) => {
    parseProviderSessionEvidence(candidate, localSessionId);
    return true;
  };
  const observations = new SessionObservationStore({ validateCandidate });
  const rejected = observations.publish({
    providerId: "codex", localSessionId: evidence.localId, evidence: invalidEvidence,
    readiness: createSessionReadiness("ready"), publicState: {}, observedAt: "2026-09-14T12:00:00.000Z",
    source: { fingerprint: "safe", completeOffset: 1 },
  });
  assert.equal(rejected.accepted, false, "an unimplemented path field is rejected by the strict evidence contract");

  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-domain-path-checkpoint-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const checkpoints = new SessionObservationCheckpointStore({ directory, validateCandidate });
  await assert.rejects(checkpoints.write({
    providerId: "codex", localSessionId: evidence.localId, evidence: invalidEvidence,
    readiness: createSessionReadiness("ready"), observedAt: "2026-09-14T12:00:00.000Z", revision: 1,
    source: { fingerprint: "safe", completeOffset: 1 },
  }));
  assert.deepEqual(await readdir(directory).catch(() => []), []);

  const history = new SessionHistoryStore();
  await history.publish(sessionId, { complete: true, requests: [], activity: [{
    id: "safe-event", timestamp: "2026-09-14T12:00:00.000Z", actor: "Primary agent", tool: "Read", detail: "Safe label",
    workKind: "read", status: null, durationMs: null, requestId: null, agentId: "primary", filePath: privatePath,
  }] });
  const page = await history.read(sessionId, { kind: "activity" });
  assert.equal(page.items.length, 1);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_PATH_MUST_NOT_LEAK|filePath/u);
});

function catalogRuntime(context, { observationStore = new SessionObservationStore(), hydrate = async () => false, fillerRows = 40, primaryRow } = {}) {
  let publisher = null;
  const readSessions = [];
  const capabilities = createEmptyProviderCapabilities();
  const provider = {
    id: "codex",
    source: "Codex",
    capabilities,
    homePolicy: { requestModelObservations: true, modelSelection: false, usageLimitActivity: { enabled: false } },
  };
  // The primary row is the newest catalog row; filler rows are older, unobserved
  // catalog-only sessions. More rows than the default 24-session domain bound.
  const filler = Array.from({ length: fillerRows }, (_, index) => ({
    localId: `catalog-filler-${String(index).padStart(3, "0")}`,
    title: `Filler ${index}`,
    project: "Pomegr",
    updatedAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") - index * 60_000).toISOString(),
    isLive: false,
    needsInput: false,
    activityStatus: "idle",
  }));
  const rows = () => [primaryRow, ...filler];
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerFolders: { folders: { claudeConfigDir: null, claudeProjectsDir: null, codexHome: process.cwd() } },
    providerForSessionId: () => provider,
    async resolveCapabilities() { return capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession(id) { readSessions.push(id); return null; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(nextPublisher) {
      publisher = nextPublisher;
      publisher.publishCatalog("codex", rows());
      return { hydrate: (id) => hydrate(id, publisher), async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    observationStore,
    checkpointStore: false,
    historyStore: new SessionHistoryStore(),
    observationCommitDelayMs: 0,
    scheduleObservation: (task, delay = 0) => setTimeout(task, delay),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => runtime.stopObservation());
  return {
    runtime,
    readSessions,
    republishCatalog(mutate) {
      const next = rows().map((row) => ({ ...row }));
      mutate(next);
      publisher.publishCatalog("codex", next);
    },
  };
}

async function until(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

test("catalog churn never evicts or re-revisions a requested live session summary", async (context) => {
  const publicState = monitorStateFromProviderEvidence("codex", evidence);
  const primaryRow = {
    localId: evidence.localId, title: evidence.session.title, project: evidence.session.project,
    updatedAt: "2026-09-14T12:00:00.000Z", isLive: true, needsInput: false, activityStatus: "working",
  };
  const { runtime, republishCatalog } = catalogRuntime(context, { observationStore: restoredStore(publicState), primaryRow });
  await runtime.startObservation();
  const catalogRevision = () => runtime.serveCatalog()?.snapshot?.revision || 0;
  await until(() => runtime.serveCatalog()?.snapshot?.value?.sessions?.length === 41);

  const ready = await until(() => {
    const result = runtime.serveSessionDomain(sessionId, "session-summary", null, null);
    return result.status === "ready" ? result : null;
  });
  assert.ok(ready, "a requested live session summary reaches ready");
  const observed = [ready.revision];
  for (let round = 0; round < 6; round += 1) {
    const before = catalogRevision();
    republishCatalog((rows) => { rows.at(-1 - round).activityStatus = round % 2 ? "idle" : "stopped"; });
    assert.ok(await until(() => catalogRevision() > before), "catalog churn committed");
    const result = runtime.serveSessionDomain(sessionId, "session-summary", null, null);
    assert.equal(result.status, "ready", `round ${round}: catalog churn must not evict the requested live session`);
    observed.push(result.revision);
  }
  assert.deepEqual(observed, observed.map(() => ready.revision), "unchanged catalog rows never re-revision the summary");

  const before = catalogRevision();
  republishCatalog((rows) => { rows[0].activityStatus = "needs_input"; rows[0].needsInput = true; });
  assert.ok(await until(() => catalogRevision() > before));
  const changed = await until(() => {
    const result = runtime.serveSessionDomain(sessionId, "session-summary", null, ready.revision);
    return result.status === "ready" ? result : null;
  });
  assert.ok(changed, "a lifecycle change of the retained session commits a replacement");
  assert.ok(changed.revision > ready.revision, "the retained session revision only moves forward");
  assert.equal(changed.snapshot.value.lifecycle.activityStatus, "needs_input");
});

test("a requested catalog-only historical session queues hydration and its summary reaches ready", async (context) => {
  const historical = structuredClone(evidence);
  historical.historical = true;
  let hydrations = 0;
  const primaryRow = {
    localId: evidence.localId, title: evidence.session.title, project: evidence.session.project,
    updatedAt: "2026-09-14T12:00:00.000Z", isLive: false, needsInput: false, activityStatus: "stopped",
  };
  const { runtime, readSessions } = catalogRuntime(context, {
    primaryRow,
    hydrate: async (id, publisher) => {
      hydrations += 1;
      if (id === sessionId) publisher.publishSession("codex", evidence.localId, historical);
      return true;
    },
  });
  await runtime.startObservation();
  await until(() => runtime.serveCatalog()?.snapshot?.value?.sessions?.length === 41);

  const first = runtime.serveSessionDomain(sessionId, "session-summary", null, null);
  assert.notEqual(first.status, "unavailable");
  const ready = await until(() => {
    const result = runtime.serveSessionDomain(sessionId, "session-summary", null, null);
    return result.status === "ready" && result.snapshot.value.readiness !== "unavailable" ? result : null;
  });
  assert.ok(ready, "the summary becomes a committed evidence projection, not a permanent unavailable placeholder");
  assert.equal(ready.snapshot.value.session.id, sessionId);
  assert.equal(hydrations, 1, "the domain request queues exactly one asynchronous hydration");
  assert.deepEqual(readSessions, [], "serving never acquires provider evidence synchronously");
});

test("a historical session requested before the startup catalog commits serves loading, hydrates, and publishes its recovery revision", async (context) => {
  // Reproduces the Flow 0 stall: during monitor startup the catalog has not been
  // published, the session has no committed L1 evidence, and the domain GET
  // answered "unavailable" (HTTP 404, which the same-origin proxy turns into a
  // 503). Nothing was queued, so no revision event ever reached a historical
  // browser entry and later polls could not recover.
  const historical = structuredClone(evidence);
  historical.historical = true;
  let publisher = null;
  let hydrations = 0;
  const readSessions = [];
  const capabilities = createEmptyProviderCapabilities();
  const provider = {
    id: "codex", source: "Codex", capabilities,
    homePolicy: { requestModelObservations: true, modelSelection: false, usageLimitActivity: { enabled: false } },
  };
  const registry = {
    providers: [provider],
    defaultProvider: provider,
    providerFolders: { folders: { claudeConfigDir: null, claudeProjectsDir: null, codexHome: process.cwd() } },
    providerForSessionId: () => provider,
    async resolveCapabilities() { return capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession(id) { readSessions.push(id); return null; },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(nextPublisher) {
      publisher = nextPublisher; // catalog discovery has not published yet
      return {
        async hydrate(id) {
          hydrations += 1;
          if (id === sessionId) publisher.publishSession("codex", evidence.localId, historical);
          return id === sessionId;
        },
        async stop() {},
      };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    observationStore: new SessionObservationStore(),
    checkpointStore: false,
    historyStore: new SessionHistoryStore(),
    observationCommitDelayMs: 0,
    scheduleObservation: (task, delay = 0) => setTimeout(task, delay),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(async () => runtime.stopObservation());
  await runtime.startObservation();
  const events = [];
  const unsubscribe = runtime.subscribeRevisionEvents((event) => events.push(event));
  context.after(unsubscribe);

  const first = runtime.serveSessionDomain(sessionId, "session-summary", null, 238);
  assert.equal(first.status, "loading", "an incomplete startup catalog is not evidence that the session is unavailable");
  assert.equal(first.snapshot, null);
  const ready = await until(() => {
    const result = runtime.serveSessionDomain(sessionId, "session-summary", null, 238);
    return result.status === "ready" ? result : null;
  });
  assert.ok(ready, "the queued hydration commits a ready summary");
  assert.equal(ready.snapshot.value.session.id, sessionId);
  assert.ok(events.some((event) => event.domain === "session-summary" && event.sessionId === sessionId
    && event.revision === ready.revision), "the commit publishes the revision event a historical browser entry recovers from");
  assert.equal(hydrations, 1, "repeated startup requests queue one asynchronous hydration");
  assert.deepEqual(readSessions, [], "serving never acquires provider evidence synchronously");

  publisher.publishCatalog("codex", []);
  await until(() => runtime.serveCatalog()?.snapshot?.value?.readiness?.catalog === "ready"
    && runtime.serveSessionDomain("codex:absent-after-catalog", "session-summary", null, null).status === "unavailable");
  assert.equal(runtime.serveSessionDomain("codex:absent-after-catalog", "session-summary", null, null).status, "unavailable",
    "once every provider catalog has published, an unknown session without evidence stays unavailable");
});
