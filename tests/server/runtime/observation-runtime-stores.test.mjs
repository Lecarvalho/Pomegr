import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REPOSITORY_SNAPSHOT_VERSION } from "../../../server/repository/repository-snapshot.mjs";
import { createMonitorRuntime } from "../../../server/server.mjs";
import { SessionObservationCheckpointStore } from "../../../server/sessions/checkpoints/session-observation-checkpoints.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../../shared/monitor-state.mjs";

// The unchanged-input skip in the wiring the monitor runs with: its own checkpoint store,
// sidecar recorders, monitor store, and history store, all under a temporary data root. With
// those switched off every side channel answers null or a constant, which would hide a source
// that hands the domain store a new object for unchanged content on every commit.
const fixture = JSON.parse(await readFile(new URL("../../fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));
const RECORDED = "recorded-sidecars";
const LIVE = "live-files";
const REPOSITORY_ID = `repo-${"a".repeat(24)}`;
const at = (minute) => new Date(Date.UTC(2026, 7, 10, 13, minute)).toISOString();

// Repository discovery runs Git and settles whenever it settles; it is not what this test counts.
const inertRepositoryInventory = {
  ready: Promise.resolve(),
  async reconcile() {}, startPluginObservation() {}, async stopPluginObservation() {},
  async associateSession() { return null; }, async resolveRepository() { return null; },
  subscribe() { return () => {}; }, readRepositories() { return null; }, readRevision() { return null; },
  capture() { return null; }, refreshPluginSetup() { return null; }, readPluginSetup() { return null; }, preparePluginAction() { return null; },
};

// Polls until the monitor reaches a state; the bound only ends a run that never would.
async function until(predicate, attempts = 2_000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

function evidenceFor(localId, session = {}, updatedAt = fixture.session.updatedAt) {
  const evidence = structuredClone(fixture);
  evidence.localId = localId;
  evidence.historical = false;
  evidence.session = { ...evidence.session, ...session, updatedAt };
  return evidence;
}
const liveRow = (localId) => ({ localId, title: `Session ${localId}`, project: "Pomegr", updatedAt: at(0), isLive: true, needsInput: false, activityStatus: "working" });

test("unchanged sessions are skipped with the monitor's own stores, recorded sidecars, and live repository files", { timeout: 120_000 }, async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pomegr-runtime-stores-"));
  // Torn down newest first: the monitor closes its stores before their directory is removed.
  const teardown = [() => rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })];
  context.after(async () => { for (const step of teardown.reverse()) await step(); });
  const dataRoot = path.join(temporary, "data");
  const repositoryRoot = path.join(temporary, "repository");
  const outside = path.join(temporary, "outside");
  await mkdir(path.join(repositoryRoot, "inside"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(repositoryRoot, "inside", "file.txt"), "test");
  await writeFile(path.join(outside, "file.txt"), "test");

  // Sidecars an earlier monitor run recorded for one session: Git-observed files with their
  // commit times, and a compaction.
  const seeded = new SessionObservationCheckpointStore({ directory: path.join(dataRoot, "observation-cache-v1") });
  await seeded.writeRepositorySnapshot("codex", RECORDED, {
    version: REPOSITORY_SNAPSHOT_VERSION, branch: "main", isMain: true, files: [], comparison: null, comparisonCheckedAt: null, pullRequests: null,
    commitsInSession: 1, checkedAt: at(6), repositoryId: null, commitTimesInWindow: [at(4)],
    sessionCommitPaths: ["docs/notes.md"], sessionCommitChanges: ["modified"], sessionCommitsTruncated: false,
  });
  await seeded.writeSessionEventRecord("codex", RECORDED, { version: 1, refills: [], compactions: [{ at: at(3), agentId: "primary", trigger: "manual" }] });

  let publisher = null;
  let gitReads = 0;
  const capabilities = createEmptyProviderCapabilities();
  const provider = { id: "codex", source: "Codex", capabilities,
    homePolicy: { requestModelObservations: true, modelSelection: false, usageLimitActivity: { enabled: false } } };
  const registry = {
    providers: [provider], defaultProvider: provider,
    providerFolders: { folders: { claudeConfigDir: null, claudeProjectsDir: null, codexHome: null } },
    providerForSessionId: () => provider,
    // The live session is bound to one repository on its recorded branch.
    repositoryAttributionForSession: (sessionId) => (sessionId === `codex:${LIVE}`
      ? { state: "single", root: repositoryRoot, repositoryId: REPOSITORY_ID, recordedBranch: "main" } : null),
    async resolveCapabilities() { return capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession() { throw new Error("serving and catalog commits must not acquire provider evidence"); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(nextPublisher) {
      publisher = nextPublisher;
      publisher.publishCatalog("codex", [liveRow(RECORDED), liveRow(LIVE)]);
      return { async hydrate() { return false; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    pomegrPaths: { environment: { POMEGR_DATA_DIR: dataRoot } },
    repositoryInventory: inertRepositoryInventory, notificationPersistence: false, releaseObservation: { start() {}, async stop() {} },
    observationCommitDelayMs: 0, checkpointDelayMs: 0, scheduleObservation: (task, delay = 0) => setTimeout(task, delay),
    persistenceMaintenanceOptions: { schedule: () => ({}), cancel() {} },
    resourceUsageSampler: { async sample() {}, get() { return null; } },
    // One live Git check answers with two changed files; it is not repeated during the test.
    enrichmentCacheMs: 60 * 60_000,
    readGitState: async (root) => {
      gitReads += 1;
      return { available: true, branch: "main", isMain: true, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null },
        files: [{ status: "modified", path: "inside/file.txt" }, { status: "modified", path: "kept.txt" }], _repositoryRoot: root };
    },
    readPullRequests: async () => ({ status: "unavailable", checkedAt: null, items: [] }),
  });
  teardown.push(() => runtime.stopObservation());
  await runtime.startObservation();
  const domainEvents = [];
  teardown.push(runtime.subscribeRevisionEvents((event) => { if (event.sessionId && event.domain !== "history") domainEvents.push(event); }));
  const counts = () => runtime.observationDiagnostics().sessionDomains;
  const domain = (localId, name) => {
    const result = runtime.serveSessionDomain(`codex:${localId}`, name, null, null);
    return result.status === "ready" ? result.snapshot.value : null;
  };
  const catalogRevision = () => runtime.serveCatalog()?.snapshot?.revision || 0;
  async function catalogEvent() {
    const before = catalogRevision();
    publisher.publishCatalog("codex", [liveRow(RECORDED), liveRow(LIVE)]);
    assert.ok(await until(() => catalogRevision() > before), "the catalog commit publishes its event");
  }

  publisher.publishSession("codex", RECORDED, evidenceFor(RECORDED, { repositoryAttribution: "launch" }));
  publisher.publishSession("codex", LIVE, evidenceFor(LIVE, { repositoryAttribution: "single", repositoryId: REPOSITORY_ID }));
  assert.ok(await until(() => domain(RECORDED, "session-summary") && domain(LIVE, "session-summary")), "both sessions commit");

  // The live Git check answers after the first projection; later evidence carries its result.
  assert.ok(await until(() => gitReads > 0), "the live repository check ran");
  let republished = 0;
  assert.ok(await until(() => {
    if (domain(LIVE, "repository")?.repository?.files?.length === 2) return true;
    republished += 1;
    if (republished % 20 === 1) publisher.publishSession("codex", LIVE, evidenceFor(LIVE, { repositoryAttribution: "single", repositoryId: REPOSITORY_ID }, at(20 + Math.floor(republished / 20))));
    return false;
  }), "the live session's changed files are validated against its repository root");
  // The check's result is written as that session's own repository sidecar, which recommits it.
  const repositorySidecars = () => readdirSync(path.join(dataRoot, "observation-cache-v1")).filter((name) => name.startsWith("repository-")).length;
  assert.ok(await until(() => repositorySidecars() === 2), "the live check is recorded beside the seeded sidecar");

  // Every production source has answered: the recorded sidecars and the monitor store's blocks.
  assert.ok(await until(() => domain(RECORDED, "repository")?.touchedFiles?.files?.some((file) => file.path === "docs/notes.md" && file.source === "committed")),
    "the recorded repository sidecar reaches the Touched here list");
  const recordedEvent = (kind, time) => domain(RECORDED, "session-summary").events.items.some((item) => item.kind === kind && item.at === time);
  assert.ok(await until(() => recordedEvent("context_compacted", at(3))), "the recorded event sidecar reaches the feed");
  assert.ok(await until(() => recordedEvent("commit_observed", at(4))), "and so do the recorded commit times");
  for (const localId of [RECORDED, LIVE]) {
    assert.ok(await until(() => domain(localId, "resources")?.retained?.readiness === "ready"), `${localId}: the monitor store's resource block is committed`);
    assert.ok(await until(() => domain(localId, "repository")?.touchedFiles?.readiness === "ready"), `${localId}: the monitor store's file history is committed`);
  }

  // Catalog events until nothing is projected any more.
  for (let round = 0, stable = 0; round < 60 && stable < 5; round += 1) {
    const before = counts().projections;
    await catalogEvent();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stable = counts().projections === before ? stable + 1 : 0;
  }
  domainEvents.length = 0;
  const before = counts();

  for (let event = 0; event < 5; event += 1) await catalogEvent();
  assert.equal(counts().projections, before.projections, "zero projections for two unchanged sessions across five catalog events");
  assert.ok(counts().unchangedInputs >= before.unchangedInputs + 10, "both sessions were offered to the store on every event and skipped");
  assert.ok(counts().liveRepositoryValidations >= before.liveRepositoryValidations + 5, "the live file list was validated against the filesystem on every event");
  assert.deepEqual(domainEvents, [], "no session-domain revision is published");

  // The filesystem changes under an unchanged session: a directory becomes a link out of the repository.
  await rm(path.join(repositoryRoot, "inside"), { recursive: true, force: true });
  try {
    await symlink(outside, path.join(repositoryRoot, "inside"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    context.diagnostic(`directory links are unavailable here (${error.code || "unknown"}); the escape case did not run`);
    return;
  }
  const escaped = counts().projections;
  await catalogEvent();
  assert.deepEqual(domain(LIVE, "repository").repository.files, [{ status: "modified", path: "kept.txt" }], "the escaped path is withdrawn by the next catalog commit");
  assert.equal(counts().projections, escaped + 1, "only the session whose validated list changed is projected");
  assert.equal(gitReads, 1, "no further Git check ran: the withdrawal came from the catalog commit alone");
});
