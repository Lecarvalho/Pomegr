import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMonitorStore } from "../../../../server/persistence/monitor-store.mjs";
import { createSessionCatalogInventory } from "../../../../server/sessions/catalog/session-catalog-inventory.mjs";
import { catalogShellRow, createRowActivityMemo } from "../../../../server/sessions/catalog/session-catalog-row.mjs";
import { SessionObservationStore } from "../../../../server/sessions/checkpoints/session-observation-store.mjs";
import { projectSessionActivityFallback, projectSessionCurrentActivity, reconcileSessionActivityFallback } from "../../../../server/sessions/domain/session-current-activity.mjs";
import { createSessionObservationCoordinator } from "../../../../server/runtime/session-observation-coordinator.mjs";

const PROGRESS = { phase: "implementing", percent: 40, confidence: "medium", reportedAt: "2026-09-29T10:00:00.000Z" };
const stamp = "2026-09-29T10:05:00.000Z";

function scheduler() {
  let clock = 0;
  const jobs = [];
  return {
    now: () => clock,
    schedule(task, delay) { const job = { task, at: clock + delay, cancelled: false, ran: false }; jobs.push(job); return job; },
    cancel(job) { job.cancelled = true; },
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        const next = jobs.filter((job) => !job.cancelled && !job.ran && job.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = next.at; next.ran = true; await next.task();
      }
      clock = target;
    },
  };
}

function memoryStore() {
  const values = new Map();
  return {
    getByQualifiedId: (id) => values.get(id) || null,
    evict: (id) => values.delete(id),
    setPinned() {},
    publish(candidate) {
      const id = `${candidate.providerId}:${candidate.localSessionId}`;
      const previous = values.get(id);
      const unchanged = Boolean(previous) && previous.serializedState === JSON.stringify(candidate.publicState);
      const snapshot = Object.freeze({ ...candidate, qualifiedId: id, revision: (previous?.revision || 0) + (unchanged ? 0 : 1), serializedState: JSON.stringify(candidate.publicState) });
      values.set(id, snapshot);
      return { accepted: true, unchanged, snapshot };
    },
  };
}

function evidence(id, extra = {}) {
  return {
    session: { title: "Secret prompt title", project: "Pomegr", startedAt: "2026-09-29T09:00:00.000Z", updatedAt: stamp, progress: PROGRESS },
    metrics: { agents: 3, activeAgents: 2, tokens: { allAgents: 12_345 } },
    agents: [{ id: "primary", status: "idle", executionTasks: [{ id: "task-secret-1", kind: "shell", status: "completed", workKind: "test", description: "echo SECRET-DESCRIPTION", startedAt: "2026-09-29T10:01:00.000Z", finishedAt: "2026-09-29T10:02:00.000Z", exitCode: 0 }] }, { id: "agent-uuid-1", status: "idle" }],
    toolCalls: [{ id: "call-secret-1", name: "SecretToolName", workKind: "read", actor: "primary", status: "ok", timestamp: "2026-09-29T10:03:00.000Z" }],
    localId: id, ...extra,
  };
}

async function fixture(t, { provider = "claude", ...options } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-row-"));
  const monitor = await openMonitorStore({ directory });
  t.after(async () => { monitor.close(); await rm(directory, { recursive: true, force: true }); });
  const inventoryFor = () => createSessionCatalogInventory({ store: () => monitor, providers: [provider] });
  const base = inventoryFor();
  const counter = { writes: 0 };
  const inventory = { ...base, upsertSummary: (...args) => { counter.writes += 1; return base.upsertSummary(...args); } };
  const clock = scheduler();
  const store = options.store || memoryStore();
  let publisher;
  const coordinator = createSessionObservationCoordinator({
    registry: { providers: [{ id: provider, source: "Claude Code" }], async startObservers(value) { publisher = value; return { async stop() {} }; } },
    store, catalogInventory: inventory, schedule: clock.schedule, cancel: clock.cancel, now: clock.now, monotonicNow: clock.now,
    deriveSession: async ({ evidence: value }) => ({ readiness: { core: "ready" }, publicState: value }),
  });
  await coordinator.start();
  return { monitor, inventory, counter, inventoryFor, clock, store, coordinator, publisher: () => publisher, provider };
}
const row = (h, id) => h.inventory.directory({ pageSize: 50 }).sessions.find((entry) => entry.id === `${h.provider}:${id}`);

test("an accepted commit persists a ready row summary with a last-observed fallback", async (t) => {
  const h = await fixture(t);
  h.publisher().publishSession("claude", "s1", evidence("s1"));
  await h.clock.advance(1_000);
  const shown = row(h, "s1");
  assert.equal(shown.summaryReadiness, "ready");
  assert.equal(shown.agentCount, 3);
  assert.equal(shown.latestContextTotal, 12_345);
  assert.deepEqual(shown.progress, PROGRESS);
  assert.equal(shown.activeAgentCount, 0);
  assert.equal(shown.currentActivity, null);
  assert.deepEqual(shown.activityFallback, { label: "file read", observedAt: "2026-09-29T10:03:00.000Z", state: "last_observed", source: "tool", actor: "primary" });
});

test("the summary survives a new inventory and L1 eviction, and shell rows read it", async (t) => {
  const h = await fixture(t);
  h.publisher().publishCatalog("claude", [{ localId: "s1", title: "One", updatedAt: stamp, isLive: false, activityStatus: "idle" }]);
  h.publisher().publishSession("claude", "s1", evidence("s1"));
  await h.clock.advance(1_000);
  h.store.evict("claude:s1");
  const restarted = h.inventoryFor();
  restarted.initialize();
  const after = restarted.directory({ pageSize: 50 }).sessions.find((entry) => entry.id === "claude:s1");
  assert.equal(after.summaryReadiness, "ready");
  assert.equal(after.agentCount, 3);
  assert.equal(after.activityFallback.state, "last_observed");
  const shell = h.coordinator.shell({ selected: "claude:s1" }).value.sessions.find((entry) => entry.id === "claude:s1");
  assert.equal(shell.summaryReadiness, "ready");
  assert.equal(shell.agentCount, 3);
  assert.equal(shell.latestContextTotal, 12_345);
  await h.clock.advance(1_000);
  const committed = h.coordinator.shell().value.sessions.find((entry) => entry.id === "claude:s1");
  assert.equal(committed.summaryReadiness, "ready");
  assert.equal(committed.agentCount, 3);
  assert.equal(committed.activityFallback.label, "file read");
});

test("an unchanged accepted commit of a restored record seeds the summary", async (t) => {
  const store = memoryStore();
  const state = evidence("s1");
  store.publish({ providerId: "claude", localSessionId: "s1", evidence: state, readiness: {}, publicState: state, observedAt: stamp });
  const h = await fixture(t, { store });
  h.publisher().publishSession("claude", "s1", state);
  await h.clock.advance(1_000);
  assert.equal(h.store.getByQualifiedId("claude:s1").revision, 1);
  assert.equal(row(h, "s1").summaryReadiness, "ready");
});

test("a live row's writes coalesce and it leaves live with the last-observed form", async (t) => {
  const h = await fixture(t);
  const live = { localId: "s1", title: "One", updatedAt: stamp, isLive: true, activityStatus: "working" };
  h.publisher().publishCatalog("claude", [live]);
  await h.clock.advance(1_000);
  const writes = () => h.counter.writes;
  for (let index = 0; index < 5; index += 1) {
    h.publisher().publishSession("claude", "s1", evidence("s1", { metrics: { agents: 3 + index, tokens: { allAgents: 100 + index } } }));
    await h.clock.advance(1_000);
  }
  assert.equal(writes(), 0, "no write while the row is live within the quiet window");
  assert.notEqual(row(h, "s1")?.activityFallback?.state, "current");
  await h.clock.advance(6_000);
  assert.equal(writes(), 1);
  assert.equal(row(h, "s1").agentCount, 7);
  h.publisher().publishSession("claude", "s1", evidence("s1", { metrics: { agents: 9, tokens: { allAgents: 5 } } }));
  await h.clock.advance(1_000);
  h.publisher().publishCatalog("claude", [{ ...live, isLive: false, activityStatus: "idle" }]);
  await h.clock.advance(1_000);
  assert.equal(row(h, "s1").agentCount, 9);
  assert.equal(row(h, "s1").activityFallback.state, "last_observed");
  assert.equal(row(h, "s1").activeAgentCount, 0);
});

test("the persisted row holds only allowlisted normalized keys", async (t) => {
  const h = await fixture(t);
  h.publisher().publishSession("claude", "s1", evidence("s1"));
  await h.clock.advance(1_000);
  const stored = h.monitor.database.prepare("SELECT summary_json AS json FROM session_catalog_headers WHERE local_id='s1'").get().json;
  assert.deepEqual(Object.keys(JSON.parse(stored)), ["agentCount", "latestContextTotal", "progress", "lastObserved"]);
  assert.deepEqual(Object.keys(JSON.parse(stored).lastObserved), ["label", "observedAt", "source", "actor"]);
  const everything = stored + JSON.stringify(row(h, "s1"));
  for (const secret of ["SecretToolName", "SECRET-DESCRIPTION", "task-secret", "call-secret", "agent-uuid", '"state":"current"', "\\\\", "C:"]) assert.ok(!everything.includes(secret), secret);
});

test("an older recorded time never replaces a newer summary", async (t) => {
  const h = await fixture(t);
  h.publisher().publishSession("claude", "s1", evidence("s1"));
  await h.clock.advance(1_000);
  const older = { agentCount: 1, latestContextTotal: 1, progress: null, lastObserved: null };
  assert.equal(h.inventory.upsertSummary("claude", "s1", older, "2026-09-29T09:00:00.000Z"), false);
  assert.equal(h.inventory.upsertSummary("claude", "s1", { ...older, extra: 1, agentCount: -1 }, stamp), false);
  assert.equal(row(h, "s1").agentCount, 3);
});

// --- The per-row activity memo: an unchanged resident row costs a lookup, not a walk -------------

function frozenSnapshot(id, extra = {}) {
  const store = new SessionObservationStore();
  const state = evidence(id, extra);
  return store.publish({ providerId: "claude", localSessionId: id, evidence: state, readiness: { core: "ready" }, publicState: state, observedAt: stamp }).snapshot;
}
const RUNNING = { agents: [{ id: "primary", status: "active", executionTasks: [{ id: "task-1", kind: "shell", status: "running", workKind: "test", startedAt: "2026-09-29T10:04:00.000Z", finishedAt: null, exitCode: null }] }] };
const liveEntry = (id, overrides = {}) => ({ id: `claude:${id}`, provider: "claude", source: "Claude Code", title: "One", project: "Pomegr", createdAt: stamp, updatedAt: stamp,
  isLive: true, needsInput: false, activityStatus: "working", detailReadiness: null, ...overrides });

test("an unchanged resident row reuses its activity fields, and each compared input walks again", () => {
  const memo = createRowActivityMemo();
  const snapshot = frozenSnapshot("s1", RUNNING);
  const commit = (entry, value = snapshot, restored = false) => { const activity = memo.activity(entry, value, restored); memo.settle(); return activity; };

  const first = commit(liveEntry("s1"));
  assert.deepEqual(memo.stats(), { walks: 1, reuses: 0, rows: 1 });
  assert.equal(first.activityFallback.state, "current");
  for (let pass = 0; pass < 5; pass += 1) {
    // A catalog commit hands over a new entry object; fields the walk never reads may differ.
    assert.equal(commit(liveEntry("s1", { title: `Renamed ${pass}`, updatedAt: "2026-09-29T11:00:00.000Z", needsInput: pass % 2 === 0, project: "Other" })), first);
  }
  assert.deepEqual(memo.stats(), { walks: 1, reuses: 5, rows: 1 }, "zero walks for an unchanged row");

  const idle = commit(liveEntry("s1", { activityStatus: "idle" }));
  assert.equal(idle.activityFallback.state, "last_observed", "the status is an input of the walk");
  const historical = commit(liveEntry("s1", { activityStatus: "idle", isLive: false }));
  assert.equal(memo.stats().walks, 3, "so is isLive");
  assert.deepEqual(historical, idle);
  const working = commit(liveEntry("s1"));
  assert.equal(working.activityFallback.state, "current");
  const restored = commit(liveEntry("s1"), snapshot, true);
  assert.equal(restored.activityFallback.state, "last_observed", "restored execution evidence stays last-observed");
  const replaced = commit(liveEntry("s1"), frozenSnapshot("s1", RUNNING));
  assert.equal(replaced.activityFallback.state, "current");
  assert.equal(memo.stats().walks, 6, "an equal snapshot in a new object is walked again");
  assert.equal(memo.stats().reuses, 5);
});

test("the activity memo forgets a row the last catalog commit did not build, and never remembers a mutable snapshot", () => {
  const memo = createRowActivityMemo();
  const one = frozenSnapshot("s1");
  const two = frozenSnapshot("s2");
  memo.activity(liveEntry("s1"), one); memo.activity(liveEntry("s2"), two); memo.settle();
  assert.equal(memo.stats().rows, 2);
  memo.activity(liveEntry("s1"), one); memo.settle();
  assert.deepEqual(memo.stats(), { walks: 2, reuses: 1, rows: 1 }, "s2 left the catalog and its record went with it");
  memo.activity(liveEntry("s1"), one); memo.activity(liveEntry("s2"), two); memo.settle();
  assert.deepEqual(memo.stats(), { walks: 3, reuses: 2, rows: 2 }, "a returning row is walked again");

  const state = evidence("s3");
  const mutable = Object.freeze({ qualifiedId: "claude:s3", publicState: state, evidence: state });
  for (let pass = 0; pass < 3; pass += 1) { memo.activity(liveEntry("s3"), mutable); memo.settle(); }
  assert.equal(memo.stats().walks, 6, "a snapshot that is not deep-frozen is walked every time");
  memo.clear();
  assert.equal(memo.stats().rows, 0);
});

test("a memoized shell row equals the row built without the memo", () => {
  const memo = createRowActivityMemo();
  const snapshots = [frozenSnapshot("s1"), frozenSnapshot("s1", RUNNING)];
  const entries = [liveEntry("s1"), liveEntry("s1", { activityStatus: "idle" }), liveEntry("s1", { isLive: false, activityStatus: "stopped" }),
    liveEntry("s1", { activityStatus: "needs_input", needsInput: true }), liveEntry("s1", { title: "Renamed" })];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const snapshot of snapshots) for (const entry of entries) for (const restoredActivity of [false, true]) {
      const activity = memo.activity(entry, snapshot, restoredActivity);
      memo.settle();
      assert.deepEqual(catalogShellRow(entry, { snapshot, restoredActivity, activity }), catalogShellRow(entry, { snapshot, restoredActivity }));
    }
  }
});

test("the row activity projections read only isLive and activityStatus from the catalog entry", () => {
  const reads = new Set();
  const entry = new Proxy(liveEntry("s1"), { get(target, property, receiver) { if (typeof property === "string") reads.add(property); return Reflect.get(target, property, receiver); } });
  const state = evidence("s1", RUNNING);
  projectSessionCurrentActivity(entry, { ...state.agents[0], currentActivity: { label: "Testing", observedAt: stamp }, liveness: { evidence: "observed", freshness: "current" } });
  projectSessionActivityFallback(entry, state.agents, state.toolCalls);
  reconcileSessionActivityFallback(entry, { state: "current", label: "Running tests", observedAt: stamp, source: "execution_task", actor: "primary" });
  assert.deepEqual([...reads].sort(), ["activityStatus", "isLive"]);
});

test("a catalog commit walks no unchanged resident row, and one row after its evidence or lifecycle changes", async (t) => {
  const h = await fixture(t, { store: new SessionObservationStore() });
  const catalog = (overrides = {}) => ["s1", "s2", "s3", "s4"].map((localId) => ({ localId, title: localId, updatedAt: stamp, isLive: true, activityStatus: "working", ...(overrides[localId] || {}) }));
  h.publisher().publishCatalog("claude", catalog());
  for (const id of ["s1", "s2", "s3"]) h.publisher().publishSession("claude", id, evidence(id, RUNNING));
  await h.clock.advance(1_000);
  const counts = () => h.coordinator.diagnostics().catalogRowActivity;
  const shellRow = (id) => h.coordinator.catalog().snapshot.value.sessions.find((entry) => entry.id === `claude:${id}`);
  assert.equal(shellRow("s1").activityFallback.state, "current");
  assert.equal(shellRow("s4").summaryReadiness, "loading", "a row without a snapshot has nothing to walk");

  let before = counts();
  for (let pass = 0; pass < 4; pass += 1) {
    h.publisher().publishCatalog("claude", catalog());
    await h.clock.advance(1_000);
  }
  assert.equal(counts().walks, before.walks, "zero walks across four catalog commits of unchanged rows");
  assert.equal(counts().reuses, before.reuses + 12, "three resident rows reused in each");
  assert.equal(counts().rows, 3);

  before = counts();
  h.publisher().publishSession("claude", "s2", evidence("s2", { ...RUNNING, metrics: { agents: 5, tokens: { allAgents: 9 } } }));
  await h.clock.advance(1_000);
  assert.equal(counts().walks, before.walks + 1, "only the session with new evidence is walked");
  assert.equal(shellRow("s2").agentCount, 5);

  before = counts();
  h.publisher().publishCatalog("claude", catalog({ s3: { isLive: false, activityStatus: "idle" } }));
  await h.clock.advance(1_000);
  assert.equal(counts().walks, before.walks + 1, "only the row whose lifecycle changed is walked");
  assert.equal(shellRow("s3").activityFallback.state, "last_observed", "a row that left live shows its last-observed form in the same commit");
  assert.equal(shellRow("s1").activityFallback.state, "current");
  for (const id of ["s1", "s2", "s3"]) {
    const committed = shellRow(id);
    const direct = catalogShellRow({ ...committed, detailReadiness: null }, { snapshot: h.store.getByQualifiedId(`claude:${id}`) });
    for (const field of ["currentActivity", "activityFallback", "cacheTiming"]) assert.deepEqual(committed[field], direct[field], `${id} ${field}`);
  }

  assert.equal(counts().rows, 3);
  await h.coordinator.stop();
  assert.equal(counts().rows, 0, "stopping the coordinator drops every remembered row");
});

test("an old-schema database migrates and keeps its rows", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-row-old-"));
  const monitor = await openMonitorStore({ directory });
  t.after(async () => { monitor.close(); await rm(directory, { recursive: true, force: true }); });
  monitor.database.exec(`DROP TABLE IF EXISTS session_catalog_headers;
    CREATE TABLE session_catalog_headers (provider TEXT NOT NULL, local_id TEXT NOT NULL, title TEXT NOT NULL, project TEXT NOT NULL,
      created_at TEXT, updated_at TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, is_live INTEGER NOT NULL, needs_input INTEGER NOT NULL,
      activity_status TEXT NOT NULL, repository_id TEXT, generation TEXT NOT NULL, PRIMARY KEY(provider,local_id)) WITHOUT ROWID;
    INSERT INTO session_catalog_headers VALUES ('claude','old','Old','Pomegr','${stamp}','${stamp}',1,1,0,0,'unknown',NULL,'g');`);
  const inventory = createSessionCatalogInventory({ store: () => monitor, providers: ["claude"] });
  inventory.initialize();
  const migrated = inventory.directory({ pageSize: 10 }).sessions;
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].summaryReadiness, "loading");
  assert.equal(inventory.upsertSummary("claude", "old", { agentCount: 2, latestContextTotal: null, progress: null, lastObserved: null }, stamp), true);
  assert.equal(inventory.get("claude:old").agentCount, 2);
});
