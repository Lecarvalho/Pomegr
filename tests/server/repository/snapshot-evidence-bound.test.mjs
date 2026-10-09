import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMonitorRuntime } from "../../../server/server.mjs";
import {
  MAX_SNAPSHOT_CHECK_AFTER_EVIDENCE_MS,
  normalizeRepositorySnapshot,
  sessionRepositorySnapshot,
} from "../../../server/repository/repository-snapshot.mjs";
import { SessionHistoryStore } from "../../../server/sessions/history/session-history-store.mjs";
import { SessionObservationCheckpointStore, repositorySnapshotFilename } from "../../../server/sessions/checkpoints/session-observation-checkpoints.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../../shared/monitor-state.mjs";
import { REPOSITORY_ID, validSnapshot } from "../../helpers/repository-snapshot-records.mjs";

const fixtureEvidence = JSON.parse(await readFile(new URL("../../fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));

const HOUR = 3_600_000;
const BOUND = MAX_SNAPSHOT_CHECK_AFTER_EVIDENCE_MS;
const EVIDENCE_AT = "2026-09-10T12:00:00.000Z";
const at = (offsetMs, from = EVIDENCE_AT) => new Date(Date.parse(from) + offsetMs).toISOString();
const bare = (overrides = {}) => ({ session: { repositoryAttribution: "single", repositoryId: REPOSITORY_ID, updatedAt: EVIDENCE_AT }, historical: true, ...overrides });
const sidecar = (checkedAt, overrides = {}) => normalizeRepositorySnapshot(validSnapshot({
  repositoryId: REPOSITORY_ID, checkedAt, comparisonCheckedAt: EVIDENCE_AT,
  pullRequests: { checkedAt: EVIDENCE_AT, items: [] }, ...overrides,
}));

test("the bound is one named constant of exactly 24 hours", () => {
  assert.equal(BOUND, 24 * HOUR);
});

test("a snapshot checked up to exactly the bound after the last evidence is used, one millisecond later it is not", () => {
  const evidence = bare();
  for (const offset of [-HOUR, 0, 5_000, BOUND - 1, BOUND]) {
    const snapshot = sidecar(at(offset));
    assert.equal(sessionRepositorySnapshot(evidence, snapshot), snapshot, `used at ${offset} ms`);
  }
  for (const offset of [BOUND + 1, BOUND + HOUR, 30 * BOUND]) {
    assert.equal(sessionRepositorySnapshot(evidence, sidecar(at(offset))), null, `ignored at ${offset} ms`);
  }
});

test("only the snapshot's own check time decides, not its older comparison or pull-request check times", () => {
  const evidence = bare();
  const carried = { comparisonCheckedAt: at(-10 * BOUND), pullRequests: { checkedAt: at(-10 * BOUND), items: [] } };
  const current = sidecar(at(HOUR), carried);
  assert.equal(sessionRepositorySnapshot(evidence, current), current, "carried-forward remote checks do not make a current snapshot stale");
  assert.equal(sessionRepositorySnapshot(evidence, sidecar(at(BOUND + 1), carried)), null, "nor do they make a late snapshot current");
});

test("a comparison that cannot be made is never trusted by default", () => {
  const snapshot = sidecar(at(HOUR));
  for (const updatedAt of [undefined, null, "", "not a time"]) {
    const evidence = bare({ session: { repositoryAttribution: "single", repositoryId: REPOSITORY_ID, updatedAt } });
    assert.equal(sessionRepositorySnapshot(evidence, snapshot), null, `evidence time ${JSON.stringify(updatedAt)}`);
  }
  assert.equal(sessionRepositorySnapshot({ historical: true, session: { repositoryAttribution: "single", repositoryId: REPOSITORY_ID } }, snapshot), null);
  assert.equal(sessionRepositorySnapshot(undefined, snapshot), null);
  assert.equal(sessionRepositorySnapshot(bare(), { ...snapshot, checkedAt: "not a time" }), null, "an unreadable check time");
  assert.equal(sessionRepositorySnapshot(bare(), { ...snapshot, checkedAt: undefined }), null);
});

test("the rule covers legacy launch attribution and adopted unbound sidecars, and exempts live evidence", () => {
  const late = sidecar(at(BOUND + 1));
  const launch = bare({ session: { repositoryAttribution: "launch", updatedAt: EVIDENCE_AT } });
  assert.equal(sessionRepositorySnapshot(launch, late), null);
  assert.equal(sessionRepositorySnapshot(launch, sidecar(at(BOUND))) !== null, true);
  const unbound = sidecar(at(BOUND + 1), { repositoryId: null });
  assert.equal(sessionRepositorySnapshot(bare(), unbound, { adoptsUnboundSidecar: true }), null);
  assert.equal(sessionRepositorySnapshot(bare(), sidecar(at(BOUND), { repositoryId: null }), { adoptsUnboundSidecar: true }) !== null, true);
  // A live session's own checks follow its evidence; the rule never withdraws what a live session shows.
  assert.equal(sessionRepositorySnapshot(bare({ historical: false }), late), late);
});

test("the decision is a pure function of the stored snapshot and the evidence", () => {
  const evidence = Object.freeze(bare());
  Object.freeze(evidence.session);
  const late = Object.freeze(sidecar(at(BOUND + 1)));
  const fine = Object.freeze(sidecar(at(HOUR)));
  for (let read = 0; read < 3; read += 1) {
    assert.equal(sessionRepositorySnapshot(evidence, late), null);
    assert.equal(sessionRepositorySnapshot(evidence, fine), fine);
  }
});

// The runtime wiring: every reader of the recorded snapshot sees an ignored one exactly as it sees none.
const SESSION_ID = `codex:${fixtureEvidence.localId}`;
const RECORDED_BRANCH = "feat/recorded";
const SIDECAR_BRANCH = "feat/from-sidecar";
const COMMITS = [at(-30 * 60_000), at(-20 * 60_000)];

function historicalEvidence() {
  return {
    ...fixtureEvidence, historical: true,
    session: { ...fixtureEvidence.session, startedAt: at(-HOUR), updatedAt: EVIDENCE_AT, repositoryAttribution: "single", repositoryId: REPOSITORY_ID, recordedGitBranch: RECORDED_BRANCH },
  };
}

function storedSnapshot(checkedAt) {
  return validSnapshot({
    repositoryId: REPOSITORY_ID, branch: SIDECAR_BRANCH, checkedAt, commitsInSession: 4,
    comparisonCheckedAt: EVIDENCE_AT, pullRequests: { checkedAt: EVIDENCE_AT, items: [] },
    commitTimesInWindow: COMMITS, sessionCommitPaths: ["src/committed.ts"], sessionCommitChanges: ["modified"],
  });
}

async function temporaryDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-snapshot-bound-"));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

// Settling depends on I/O and child processes, so a deadline rather than a turn count bounds each wait.
async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const flush = async (turns = 20) => { for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

const sha = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

/** One monitor run over a checkpoint directory, publishing the session unless it is restored from a checkpoint. */
async function monitorRun(context, directory, { publish = null, live = null } = {}) {
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(), homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } } };
  const store = new SessionObservationCheckpointStore({ directory });
  let sidecarReads = 0;
  for (const method of ["loadRepositorySnapshot", "loadRepositorySnapshots"]) {
    const original = store[method].bind(store);
    store[method] = async (...args) => { const result = await original(...args); sidecarReads += 1; return result; };
  }
  // Finished sidecar writes are counted here, so a test waits for one without opening the file: on Windows a reader
  // holding the sidecar open makes the store's rename over it fail.
  let sidecarWrites = 0;
  const writeSnapshot = store.writeRepositorySnapshot.bind(store);
  store.writeRepositorySnapshot = async (...args) => { const result = await writeSnapshot(...args); sidecarWrites += 1; return result; };
  let publisher;
  const catalogRow = (isLive) => ({ localId: fixtureEvidence.localId, title: "Synthetic", project: "synthetic", updatedAt: EVIDENCE_AT, isLive, needsInput: false, activityStatus: isLive ? "working" : "idle" });
  const gitReads = [];
  const registry = {
    providers: [provider], defaultProvider: provider, providerForSessionId: () => provider,
    repositoryAttributionForSession: () => (live ? { state: "single", root: path.resolve(directory, "work"), repositoryId: REPOSITORY_ID, recordedBranch: RECORDED_BRANCH, fingerprint: "synthetic" } : null),
    async resolveCapabilities() { return provider.capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(value) { publisher = value; return { async stop() {} }; },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, checkpointStore: store, monitorStore: false, historyStore: new SessionHistoryStore(),
    repositoryInventory: {
      ready: Promise.resolve(), async reconcile() {}, startPluginObservation() {}, async stopPluginObservation() {},
      async associateSession() { return null; }, async resolveRepository() { return null; }, subscribe() { return () => {}; },
      readRepositories() { return null; }, readRevision() { return null; }, capture() { return null; },
      refreshPluginSetup() { return null; }, readPluginSetup() { return null; }, preparePluginAction() { return null; },
    },
    async readGitState(root) {
      gitReads.push(root);
      return { available: true, branch: RECORDED_BRANCH, files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null }, _repositoryRoot: root };
    },
    async readPullRequests() { return { status: "unavailable", checkedAt: null, items: [] }; },
    now: () => Date.parse(live?.now ?? EVIDENCE_AT) + 5_000,
    observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0),
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await runtime.stopObservation(); } };
  context.after(stop);
  await runtime.startObservation();
  // The catalog row is committed before the evidence, as a live session's row is in a running monitor.
  const setSession = async (evidence, isLive) => {
    publisher.publishCatalog("codex", [catalogRow(isLive)]);
    await waitFor(() => runtime.serveCatalog().snapshot?.value?.sessions?.some((row) => row.id === SESSION_ID && row.isLive === isLive), "the committed catalog row");
    publisher.publishSession("codex", fixtureEvidence.localId, evidence);
  };
  if (publish) await setSession(publish.evidence, publish.isLive);
  return { runtime, stop, setSession, sidecarReads: () => sidecarReads, sidecarWrites: () => sidecarWrites, gitReads };
}

/** Everything a browser can read about the recorded repository snapshot of the session, without revisions. */
function recordedView(runtime) {
  const domain = (name) => runtime.serveSessionDomain(SESSION_ID, name, null, null).snapshot?.value;
  const repository = domain("repository");
  const summary = domain("session-summary");
  const state = runtime.serveSession(SESSION_ID).snapshot?.publicState;
  return {
    repositoryDomain: repository && {
      readiness: repository.readiness, repository: repository.repository, pullRequests: repository.pullRequests,
      recordedAt: repository.recordedAt, commitsInSession: repository.commitsInSession, touchedFiles: repository.touchedFiles,
    },
    summary: summary && { readiness: summary.readiness, repository: summary.repository, commitEvents: summary.events?.items?.filter((item) => item.kind === "commit_observed").map((item) => item.at) },
    state: state && { repository: state.session?.repository, pullRequests: state.session?.pullRequests },
  };
}

async function settledView(run, { sidecarExpected }) {
  await waitFor(() => run.runtime.serveSessionDomain(SESSION_ID, "repository", null, null).status === "ready"
    && run.runtime.serveSessionDomain(SESSION_ID, "session-summary", null, null).status === "ready"
    && run.runtime.serveSession(SESSION_ID).snapshot, "the session domains");
  if (sidecarExpected) await waitFor(() => run.sidecarReads() > 0, "the recorder to read the sidecar");
  await flush();
  return recordedView(run.runtime);
}

test("an ignored snapshot is seen by every reader exactly as no snapshot is, and its file is untouched", async (context) => {
  const withoutDirectory = await temporaryDirectory(context);
  const withDirectory = await temporaryDirectory(context);
  const control = await monitorRun(context, withoutDirectory, { publish: { evidence: historicalEvidence(), isLive: false } });
  const absent = await settledView(control, { sidecarExpected: false });
  await control.stop();
  assert.equal(absent.repositoryDomain.readiness, "ready", "a session without a snapshot is ready");
  assert.equal(absent.repositoryDomain.repository.branch, RECORDED_BRANCH, "it falls back to its recorded branch");
  assert.equal(absent.repositoryDomain.recordedAt, null);

  const store = new SessionObservationCheckpointStore({ directory: withDirectory });
  await store.writeRepositorySnapshot("codex", fixtureEvidence.localId, storedSnapshot(at(BOUND + 1)));
  const file = path.join(withDirectory, repositorySnapshotFilename("codex", fixtureEvidence.localId));
  const before = await sha(file);

  const ignoredRun = await monitorRun(context, withDirectory, { publish: { evidence: historicalEvidence(), isLive: false } });
  const ignored = await settledView(ignoredRun, { sidecarExpected: true });
  assert.deepEqual(ignored, absent, "the repository domain, state, touched files and session events match a session with no snapshot");
  assert.equal(JSON.stringify(ignored).includes(SIDECAR_BRANCH), false);
  assert.deepEqual(ignored.summary.commitEvents, []);
  await ignoredRun.stop();
  assert.equal(await sha(file), before, "the file is byte-identical");

  // After a restart over the same files, the restored session gives the same answer.
  const restarted = await monitorRun(context, withDirectory);
  const afterRestart = await settledView(restarted, { sidecarExpected: true });
  assert.deepEqual(afterRestart, absent);
  await restarted.stop();
  assert.equal(await sha(file), before);
});

test("a snapshot checked exactly at the bound is used by every reader", async (context) => {
  const directory = await temporaryDirectory(context);
  const store = new SessionObservationCheckpointStore({ directory });
  await store.writeRepositorySnapshot("codex", fixtureEvidence.localId, storedSnapshot(at(BOUND)));
  const run = await monitorRun(context, directory, { publish: { evidence: historicalEvidence(), isLive: false } });
  await settledView(run, { sidecarExpected: true });
  await waitFor(() => (recordedView(run.runtime).summary?.commitEvents || []).length === COMMITS.length, "the recorded commit events");
  const used = recordedView(run.runtime);
  assert.equal(used.repositoryDomain.repository.branch, SIDECAR_BRANCH);
  assert.equal(used.repositoryDomain.recordedAt, at(BOUND));
  assert.equal(used.repositoryDomain.commitsInSession, 4);
  assert.equal(used.state.repository.branch, SIDECAR_BRANCH);
  assert.deepEqual([...used.summary.commitEvents].sort(), COMMITS);
  assert.equal(JSON.stringify(used.repositoryDomain.touchedFiles).includes("src/committed.ts"), true);
});

test("a session with no last-evidence time cannot compare, so its snapshot is not used and it still reaches ready", async (context) => {
  const directory = await temporaryDirectory(context);
  const store = new SessionObservationCheckpointStore({ directory });
  await store.writeRepositorySnapshot("codex", fixtureEvidence.localId, storedSnapshot(EVIDENCE_AT));
  const evidence = historicalEvidence();
  evidence.session.updatedAt = null;
  const run = await monitorRun(context, directory, { publish: { evidence, isLive: false } });
  const view = await settledView(run, { sidecarExpected: true });
  assert.equal(view.repositoryDomain.readiness, "ready");
  assert.equal(view.repositoryDomain.repository.branch, RECORDED_BRANCH);
  assert.equal(view.repositoryDomain.recordedAt, null);
  assert.deepEqual(view.summary.commitEvents, []);
});

test("a resumed session records a new snapshot over an ignored one, and the new snapshot is then used", async (context) => {
  const directory = await temporaryDirectory(context);
  const store = new SessionObservationCheckpointStore({ directory });
  await store.writeRepositorySnapshot("codex", fixtureEvidence.localId, storedSnapshot(at(10 * BOUND)));
  const file = path.join(directory, repositorySnapshotFilename("codex", fixtureEvidence.localId));
  const before = await sha(file);

  const resumedAt = at(40 * BOUND);
  // No start time means no commit-window read, so the live check starts no Git process.
  const liveEvidence = { ...historicalEvidence(), historical: false, session: { ...historicalEvidence().session, startedAt: null, updatedAt: resumedAt } };
  const run = await monitorRun(context, directory, { live: { now: resumedAt }, publish: { evidence: liveEvidence, isLive: true } });
  await waitFor(() => run.sidecarWrites() > 0, "the live check to replace the old snapshot");
  assert.notEqual(await sha(file), before);
  const replaced = JSON.parse(await readFile(file, "utf8")).snapshot;
  assert.equal(replaced.checkedAt, at(5_000, resumedAt), "the new snapshot carries the new check time");
  assert.equal(replaced.branch, RECORDED_BRANCH, "and the live branch, not the old sidecar's");
  assert.ok(run.gitReads.length > 0);

  // The session ends: its evidence turns historical, the catalog row is no longer live, and the new snapshot is used.
  await run.setSession({ ...liveEvidence, historical: true }, false);
  await waitFor(() => recordedView(run.runtime).repositoryDomain?.repository?.historical === true
    && recordedView(run.runtime).repositoryDomain.recordedAt === replaced.checkedAt, "the ended session to serve its new snapshot");
  assert.equal(recordedView(run.runtime).repositoryDomain.repository.branch, RECORDED_BRANCH);
});
