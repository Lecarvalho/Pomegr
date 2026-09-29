import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMonitorStore } from "../../../../server/persistence/monitor-store.mjs";
import { createSessionCatalogInventory } from "../../../../server/sessions/catalog/session-catalog-inventory.mjs";
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
