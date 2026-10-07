import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createMonitorRuntime } from "../../../server/server.mjs";
import { createObservationStartupRepository } from "../../../server/runtime/observation-startup-repository.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../../shared/monitor-state.mjs";
import { SessionHistoryStore } from "../../../server/sessions/history/session-history-store.mjs";

const evidence = JSON.parse(await readFile(new URL("../../fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));

// Settling depends on I/O and child processes, so a deadline rather than a turn count bounds each wait.
async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const flush = async (turns = 10) => { for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

function recordingFixture(rows) {
  const recorded = [];
  const recorder = { async load() {}, async ensure() { return false; }, async record(sessionId, live) { recorded.push({ sessionId, live }); return true; } };
  const changed = [];
  let catalog = rows;
  const startup = createObservationStartupRepository({
    repositoryInventory: { ready: Promise.resolve(), async reconcile() {} },
    repositorySnapshotRecorder: recorder,
    isActive: () => true,
    catalog: () => catalog,
    onRecorded: (sessionId) => changed.push(sessionId),
  });
  return { startup, recorded, changed, setCatalog(next) { catalog = next; } };
}

test("a live check is recorded only for a session the committed catalog lists as live", async () => {
  const fixture = recordingFixture([
    { id: "codex:live", isLive: true, activityStatus: "working" },
    { id: "codex:idle", isLive: false, activityStatus: "idle" },
    { id: "codex:expired-open", isLive: false, activityStatus: "open" },
    { id: "codex:input-only", isLive: false, needsInput: true, activityStatus: "needs_input" },
  ]);
  fixture.startup.start();
  for (const id of ["codex:live", "codex:idle", "codex:expired-open", "codex:input-only", "codex:not-listed"]) fixture.startup.record(id, { repository: {} });
  await flush();
  assert.deepEqual(fixture.recorded.map((item) => item.sessionId), ["codex:live"]);
  assert.deepEqual(fixture.changed, ["codex:live"]);
  fixture.startup.stop();
});

test("a session that stops being listed live while the sidecar load is pending is not recorded", async () => {
  let releaseLoad;
  const loaded = new Promise((resolve) => { releaseLoad = resolve; });
  const recorded = [];
  let catalog = [{ id: "claude:ending", isLive: true }];
  const startup = createObservationStartupRepository({
    repositoryInventory: { ready: Promise.resolve(), async reconcile() {} },
    repositorySnapshotRecorder: { async load() { await loaded; }, async record(sessionId) { recorded.push(sessionId); return true; } },
    isActive: () => true,
    catalog: () => catalog,
    onRecorded() {},
  });
  startup.start();
  startup.record("claude:ending", { repository: {} });
  catalog = [{ id: "claude:ending", isLive: false, activityStatus: "idle" }];
  releaseLoad();
  await flush();
  assert.deepEqual(recorded, [], "the decision is repeated immediately before the write");
  startup.stop();
});

// The runtime wiring: a live-mode check completes for a bound session, and only the catalog's
// answer decides whether today's Git state becomes the session's recorded repository snapshot.
async function runtimeFixture(context, { isLive }) {
  const localId = evidence.localId;
  const root = path.resolve("synthetic-repository-root");
  const binding = { state: "single", root, repositoryId: "repo-0123456789abcdef01234567", recordedBranch: "feat/synthetic", fingerprint: "synthetic-binding" };
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(), homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } } };
  let publisher;
  const writes = [];
  const gitReads = [];
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    repositoryAttributionForSession: () => binding,
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(value) { publisher = value; return { async stop() {} }; },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, monitorStore: false, historyStore: new SessionHistoryStore(),
    repositoryInventory: {
      ready: Promise.resolve(), async reconcile() {}, startPluginObservation() {}, async stopPluginObservation() {},
      async associateSession() { return null; }, async resolveRepository() { return null; }, subscribe() { return () => {}; },
      readRepositories() { return null; }, readRevision() { return null; }, capture() { return null; },
      refreshPluginSetup() { return null; }, readPluginSetup() { return null; }, preparePluginAction() { return null; },
    },
    checkpointStore: {
      async loadRepositorySnapshots() { return []; },
      async loadRepositorySnapshot() { return null; },
      async writeRepositorySnapshot(providerId, sessionId, snapshot) { writes.push({ providerId, sessionId, snapshot }); },
      async load() { return { records: [] }; },
      async write() {},
    },
    async readGitState(requested) {
      gitReads.push(requested);
      return { available: true, branch: "feat/synthetic", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null }, _repositoryRoot: requested };
    },
    async readPullRequests() { return { status: "unavailable", checkedAt: null, items: [] }; },
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  context.after(() => runtime.stopObservation());
  await runtime.startObservation();
  publisher.publishCatalog("codex", [{ localId, title: "Synthetic", project: "synthetic", updatedAt: evidence.session.updatedAt, isLive, needsInput: false, activityStatus: isLive ? "working" : "idle" }]);
  await waitFor(() => runtime.serveCatalog().snapshot?.value?.sessions?.some((row) => row.id === `codex:${localId}` && row.isLive === isLive), "the committed catalog row");
  // Live-mode evidence, as a session that just ended or a restored live checkpoint still carries.
  publisher.publishSession("codex", localId, { ...evidence, historical: false,
    session: { ...evidence.session, repositoryAttribution: "single", repositoryId: binding.repositoryId, recordedGitBranch: binding.recordedBranch } });
  await waitFor(() => gitReads.length > 0, "the live Git check");
  return { writes, gitReads, localId };
}

test("a live check is recorded as the repository snapshot while the catalog lists the session live", async (context) => {
  const { writes, localId } = await runtimeFixture(context, { isLive: true });
  await waitFor(() => writes.length > 0, "the recorded snapshot");
  assert.equal(writes[0].sessionId, localId);
  assert.equal(writes[0].snapshot.branch, "feat/synthetic");
});

test("live-mode evidence of a session the catalog lists as not live never records today's Git state", async (context) => {
  const { writes, gitReads } = await runtimeFixture(context, { isLive: false });
  assert.ok(gitReads.length > 0, "the live-mode check does run");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(writes, [], "nothing is written as that session's recorded repository history");
});
