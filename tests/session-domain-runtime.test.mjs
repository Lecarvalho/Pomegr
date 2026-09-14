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
