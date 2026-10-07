import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMonitorRuntime } from "../../../server/server.mjs";
import { SessionHistoryStore } from "../../../server/sessions/history/session-history-store.mjs";
import { SessionObservationStore } from "../../../server/sessions/checkpoints/session-observation-store.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../../shared/monitor-state.mjs";

// What a catalog event costs the runtime, counted as session-domain projections. The counters
// are the monitor-private ones the runtime reports in its diagnostics.
const fixture = JSON.parse(await readFile(new URL("../../fixtures/providers/codex/expected-session-evidence.json", import.meta.url), "utf8"));
const UPDATED_AT = "2026-09-14T12:00:00.000Z";

function sessionEvidence(localId, mutate = () => {}) {
  const evidence = structuredClone(fixture);
  evidence.localId = localId;
  evidence.historical = false;
  mutate(evidence);
  return evidence;
}
function liveRow(localId, overrides = {}) {
  return { localId, title: `Session ${localId}`, project: "Pomegr", updatedAt: UPDATED_AT, isLive: true, needsInput: false, activityStatus: "working", ...overrides };
}
// Repository discovery runs Git and settles whenever it settles. It is not part of what these
// tests count, so the monitor gets an inventory that never associates a session.
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

async function startMonitor(context, { rows, now } = {}) {
  let publisher = null;
  const capabilities = createEmptyProviderCapabilities();
  const provider = { id: "codex", source: "Codex", capabilities,
    homePolicy: { requestModelObservations: true, modelSelection: false, usageLimitActivity: { enabled: false } } };
  const registry = {
    providers: [provider], defaultProvider: provider,
    providerFolders: { folders: { claudeConfigDir: null, claudeProjectsDir: null, codexHome: process.cwd() } },
    providerForSessionId: () => provider,
    async resolveCapabilities() { return capabilities; },
    async readUsageLimits() { return createEmptyUsageLimits(); },
    async readSession() { throw new Error("serving and catalog commits must not acquire provider evidence"); },
    async inspectSessions() { return { sessions: [], resourceTargets: [] }; },
    unavailableMessage: () => "Unavailable",
    async startObservers(nextPublisher) {
      publisher = nextPublisher;
      publisher.publishCatalog("codex", rows);
      return { async hydrate() { return false; }, async stop() {} };
    },
  };
  const runtime = createMonitorRuntime({
    providerRegistry: registry, observationStore: new SessionObservationStore(), checkpointStore: false, historyStore: new SessionHistoryStore(),
    repositoryInventory: inertRepositoryInventory,
    observationCommitDelayMs: 0, scheduleObservation: (task, delay = 0) => setTimeout(task, delay),
    resourceUsageSampler: { async sample() {}, get() { return null; } }, ...(now ? { now } : {}),
  });
  context.after(async () => runtime.stopObservation());
  await runtime.startObservation();
  const domainEvents = [];
  context.after(runtime.subscribeRevisionEvents((event) => { if (event.sessionId && event.domain !== "history") domainEvents.push(event); }));
  const catalogRevision = () => runtime.serveCatalog()?.snapshot?.revision || 0;
  const counts = () => runtime.observationDiagnostics().sessionDomains;
  const summary = (localId) => {
    const result = runtime.serveSessionDomain(`codex:${localId}`, "session-summary", null, null);
    return result.status === "ready" ? result : null;
  };
  // One provider catalog publication and the catalog event that commits it.
  async function catalogEvent(nextRows) {
    const before = catalogRevision();
    publisher.publishCatalog("codex", nextRows);
    assert.ok(await until(() => catalogRevision() > before), "the catalog commit publishes its event");
  }
  // Catalog events until no retained session is projected any more: every late startup commit landed.
  async function quiesce(nextRows) {
    for (let round = 0, stable = 0; round < 40 && stable < 3; round += 1) {
      const before = counts().projections;
      await catalogEvent(nextRows);
      await new Promise((resolve) => setTimeout(resolve, 10));
      stable = counts().projections === before ? stable + 1 : 0;
    }
    domainEvents.length = 0;
  }
  return { runtime, publish: (evidence) => publisher.publishSession("codex", evidence.localId, evidence), catalogEvent, quiesce, counts, summary, domainEvents };
}

test("a catalog event projects no unchanged retained session, and exactly the one whose row changed", async (context) => {
  const ids = Array.from({ length: 6 }, (_, index) => `catalog-event-${index}`);
  const rows = (overrides = {}) => ids.map((id) => liveRow(id, overrides[id]));
  const monitor = await startMonitor(context, { rows: rows() });
  for (const id of ids) monitor.publish(sessionEvidence(id));
  assert.ok(await until(() => ids.every((id) => monitor.summary(id))), "every session's summary is committed");
  await monitor.quiesce(rows());
  const before = { counts: monitor.counts(), revisions: Object.fromEntries(ids.map((id) => [id, monitor.summary(id).revision])) };

  for (let event = 0; event < 5; event += 1) await monitor.catalogEvent(rows());
  assert.equal(monitor.counts().projections, before.counts.projections, "zero projections for six unchanged retained sessions across five catalog events");
  assert.ok(monitor.counts().unchangedInputs >= before.counts.unchangedInputs + 30, "each retained session was still offered to the store on each event");
  assert.deepEqual(monitor.domainEvents, [], "no session-domain revision is published");
  assert.deepEqual(Object.fromEntries(ids.map((id) => [id, monitor.summary(id).revision])), before.revisions);

  // The lifecycle of one row changes through the catalog only: a live row turns historical.
  const changed = ids[3];
  await monitor.catalogEvent(rows({ [changed]: { isLive: false, activityStatus: "stopped" } }));
  // Read at once: the retained session was re-projected inside that catalog commit.
  assert.equal(monitor.summary(changed).snapshot.value.lifecycle.isLive, false);
  assert.equal(monitor.summary(changed).snapshot.value.lifecycle.activityStatus, "stopped");
  assert.equal(monitor.counts().projections, before.counts.projections + 1, "exactly one projection");
  assert.deepEqual(monitor.domainEvents.map((event) => [event.sessionId, event.domain]), [[`codex:${changed}`, "session-summary"]]);
  for (const id of ids.filter((value) => value !== changed)) assert.equal(monitor.summary(id).revision, before.revisions[id], id);
});

test("a row that leaves the catalog re-projects its retained session in the same catalog commit", async (context) => {
  const ids = ["leaving-0", "leaving-1"];
  const monitor = await startMonitor(context, { rows: ids.map((id) => liveRow(id)) });
  for (const id of ids) monitor.publish(sessionEvidence(id));
  assert.ok(await until(() => ids.every((id) => monitor.summary(id))));
  await monitor.quiesce(ids.map((id) => liveRow(id)));
  assert.equal(monitor.summary("leaving-1").snapshot.value.lifecycle.isLive, true);
  const before = { projections: monitor.counts().projections, kept: monitor.summary("leaving-0").revision };

  await monitor.catalogEvent([liveRow("leaving-0")]);
  const lifecycle = monitor.summary("leaving-1").snapshot.value.lifecycle;
  assert.equal(lifecycle.isLive, false, "the session no longer has a live catalog row");
  assert.notEqual(lifecycle.activityStatus, "working");
  assert.equal(monitor.counts().projections, before.projections + 1);
  assert.equal(monitor.summary("leaving-0").revision, before.kept);
});

test("an open session that expires is re-projected by the expiry commit, without a provider publication", async (context) => {
  let clock = Date.now();
  // Open and idle: visible as live for five minutes after its last activity. The monitor's clock
  // is this test's, so the row expires only when the clock below is moved past that deadline.
  const openRows = [liveRow("open-expiring", { activityStatus: "open", updatedAt: new Date(clock - 5 * 60_000 + 50).toISOString() }), liveRow("open-neighbour")];
  const monitor = await startMonitor(context, { rows: openRows, now: () => clock });
  monitor.publish(sessionEvidence("open-expiring"));
  monitor.publish(sessionEvidence("open-neighbour"));
  assert.ok(await until(() => monitor.summary("open-expiring") && monitor.summary("open-neighbour")));
  await monitor.quiesce(openRows);
  assert.equal(monitor.summary("open-expiring").snapshot.value.lifecycle.activityStatus, "open");
  assert.equal(monitor.summary("open-expiring").snapshot.value.lifecycle.isLive, true);
  const before = { projections: monitor.counts().projections, neighbour: monitor.summary("open-neighbour").revision };

  clock += 1_000;
  assert.ok(await until(() => monitor.summary("open-expiring").snapshot.value.lifecycle.isLive === false), "the expiry timer's catalog commit re-projects the session");
  assert.equal(monitor.summary("open-expiring").snapshot.value.lifecycle.activityStatus, "open");
  assert.equal(monitor.counts().projections, before.projections + 1, "only the expired session is projected");
  assert.equal(monitor.summary("open-neighbour").revision, before.neighbour);
  assert.deepEqual(monitor.domainEvents.map((event) => [event.sessionId, event.domain]), [["codex:open-expiring", "session-summary"]]);
});

test("an unavailable placeholder is rebuilt only when its catalog row changes, in the same catalog commit", async (context) => {
  const id = "codex:registry-only";
  const rows = (overrides = {}) => [liveRow("registry-only", { detailReadiness: "unavailable", ...overrides }), liveRow("registry-neighbour")];
  const monitor = await startMonitor(context, { rows: rows() });
  assert.ok(await until(() => monitor.runtime.serveCatalog()?.snapshot?.value?.sessions?.length === 2));
  monitor.runtime.serveSessionDomain(id, "session-summary", null, null);
  const placeholder = await until(() => monitor.summary("registry-only"));
  assert.ok(placeholder, "a requested unavailable row serves its placeholder");
  assert.equal(placeholder.snapshot.value.readiness, "unavailable");
  assert.equal(placeholder.snapshot.value.view, "live");
  await monitor.quiesce(rows());
  const before = { projections: monitor.counts().projections, revision: monitor.summary("registry-only").revision };

  for (let event = 0; event < 3; event += 1) await monitor.catalogEvent(rows());
  assert.equal(monitor.counts().projections, before.projections, "an unchanged placeholder is not projected again");
  assert.equal(monitor.summary("registry-only").revision, before.revision);

  await monitor.catalogEvent(rows({ isLive: false, activityStatus: "stopped" }));
  const changed = monitor.summary("registry-only");
  assert.equal(changed.snapshot.value.view, "history");
  assert.equal(changed.snapshot.value.lifecycle.activityStatus, "stopped");
  assert.ok(changed.revision > before.revision);
  assert.equal(monitor.counts().projections, before.projections + 1);
  // The compatibility state response for the same row was rebuilt by that catalog commit too.
  const state = monitor.runtime.serveSession(id);
  assert.equal(state.status, "unavailable");
  assert.equal(JSON.parse(state.unavailableSnapshot.serialized).view, "history");
});

test("new evidence reaches the summary's catalog lifecycle through the catalog commit that follows it", async (context) => {
  // Characterizes the second summary revision after an evidence commit. The session event
  // projects with the row committed before it; the following catalog commit rebuilds the row
  // from the same new evidence, and only its activity fields differ.
  const id = "two-step";
  const monitor = await startMonitor(context, { rows: [liveRow(id)] });
  monitor.publish(sessionEvidence(id));
  assert.ok(await until(() => monitor.summary(id)));
  await monitor.quiesce([liveRow(id)]);
  const firstFinish = monitor.summary(id).snapshot.value.lifecycle.activityFallback.observedAt;
  const observed = [];
  context.after(monitor.runtime.subscribeRevisionEvents((event) => {
    if (event.domain !== "session-summary" || event.sessionId !== `codex:${id}`) return;
    const value = monitor.summary(id).snapshot.value;
    observed.push({ updatedAt: value.session.updatedAt, lastActivity: value.lifecycle.activityFallback.observedAt });
  }));
  observed.length = 0;
  const before = monitor.counts().projections;

  const laterFinish = "2026-08-10T13:05:00.000Z";
  monitor.publish(sessionEvidence(id, (evidence) => {
    evidence.session.updatedAt = laterFinish;
    evidence.agents[0].executionTasks.push({ ...evidence.agents[0].executionTasks[0], id: "command-2", startedAt: "2026-08-10T13:04:00.000Z", finishedAt: laterFinish });
  }));
  assert.ok(await until(() => observed.length >= 2), "the evidence commit and the catalog commit each publish a summary revision");
  await monitor.catalogEvent([liveRow(id)]);
  assert.deepEqual(observed, [
    { updatedAt: laterFinish, lastActivity: firstFinish },
    { updatedAt: laterFinish, lastActivity: laterFinish },
  ]);
  assert.equal(monitor.counts().projections, before + 2, "one projection per step, and none for the unchanged catalog event after them");
});
