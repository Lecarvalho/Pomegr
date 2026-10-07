import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionHistoryStore } from "../../../../server/sessions/history/session-history-store.mjs";

// These tests count work and check file lifecycle; none asserts a duration. A store keeps
// pooled connections only between start() and stop(), so every test stops its store before
// removing the directory, as the monitor does: Windows cannot delete an open database.

const when = (number) => new Date(1_800_000_000_000 + number * 1000).toISOString();
const numbered = (number) => ({
  id: `request-${number.toString(16).padStart(16, "0")}`, agentId: "primary", observedAt: when(number), cacheLifetime: null,
  uncachedInputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, totalTokens: 10,
  precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null,
});
const call = (number, requestId = null) => ({
  id: `call-${number}`, timestamp: when(number), actor: "Agent", tool: "Read", workKind: "read", detail: "Read file",
  status: null, durationMs: 2, requestId, agentId: "primary",
});

async function open(t, { pooled = true, ...options } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-connections-"));
  const store = new SessionHistoryStore({ directory, maxResident: 0, maxIndexResident: 0, ...options });
  if (pooled) store.start();
  t.after(async () => { await store.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}
async function databaseFile(directory) {
  return path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".history.sqlite")));
}
// One step of a live session: a new request with its call, then the Activity-only follow-up.
async function contribute(store, id, number) {
  await store.publishRequestContribution(id, { epoch: 1, sequence: number, requests: [numbered(number)], activity: [call(number, numbered(number).id)] });
  await store.publishActivityContribution(id, { epoch: 1, sequence: number, activity: [call(number)] });
}
// Counts the real DatabaseSync.prepare calls, independently of the store's own counters.
async function countingPrepares(work) {
  const original = DatabaseSync.prototype.prepare; let count = 0;
  DatabaseSync.prototype.prepare = function counted(...args) { count += 1; return original.apply(this, args); };
  try { await work(); } finally { DatabaseSync.prototype.prepare = original; }
  return count;
}

test("opens and prepares per contribution are constant once a session is warm, and linear without the pool", async (t) => {
  const pooled = (await open(t)).store; const unpooled = (await open(t, { pooled: false })).store;
  const id = "codex:constant-work";
  const warm = async (store) => {
    await contribute(store, id, 1); await contribute(store, id, 2);
    await store.publishActivityContribution(id, { epoch: 1, sequence: 3, activity: [call(2)] }); // unchanged row path
    await store.read(id, { kind: "requests" }); await store.read(id, { kind: "activity" });
  };
  await warm(pooled); await warm(unpooled);

  const run = async (store) => {
    const before = store.persistenceStats(); let real;
    real = await countingPrepares(async () => { for (let number = 10; number < 30; number += 1) await contribute(store, id, number); });
    const after = store.persistenceStats();
    return { opens: after.opens - before.opens, prepares: after.prepares - before.prepares, real, transactions: after.transactions - before.transactions };
  };
  const warmPooled = await run(pooled);
  assert.deepEqual(warmPooled, { opens: 0, prepares: 0, real: 0, transactions: 40 }, "no database is opened and no statement is prepared for twenty more steps");
  const cold = await run(unpooled);
  assert.equal(cold.transactions, 40);
  assert.ok(cold.opens >= 40, `without the pool each transaction opens a database (${cold.opens})`);
  assert.ok(cold.prepares >= 200, `without the pool statements are prepared per row (${cold.prepares})`);
  assert.equal(cold.real, cold.prepares, "the store's counter matches the real prepare calls");
  assert.equal(pooled.persistenceStats().connections, 2, "the warm-up's read-write and read-only connections serve the whole run");
  assert.equal(unpooled.persistenceStats().connections, 0);
});

test("a pooled store returns the same results and does the same logical work as an unpooled one", async (t) => {
  const scenario = async (store) => {
    const id = "codex:equivalence";
    for (let number = 1; number <= 12; number += 1) await contribute(store, id, number);
    await store.publishRequestContribution(id, { epoch: 1, sequence: 13, requests: [numbered(3)], activity: [{ ...call(3, numbered(3).id), durationMs: 9 }] });
    await store.publishActivityContribution(id, { epoch: 2, sequence: 1, activity: [call(40)] });
    await store.publish(id, { complete: true, requests: [numbered(1), numbered(2), numbered(50)], activity: [call(1, numbered(1).id), call(2, numbered(2).id)] });
    await contribute(store, id, 60);
    const reads = [];
    for (const query of [{ kind: "requests" }, { kind: "requests", offset: "latest", limit: "2" }, { kind: "activity" }, { kind: "activity", offset: "latest" },
      { kind: "activity", from: "1", to: "5", selected: "2" }, { kind: "requests", requestId: numbered(2).id }]) reads.push(await store.read(id, query));
    const stats = store.persistenceStats(); // logical work only; opens, prepares and connections differ by design
    const work = { detailReads: stats.detailReads, detailWrites: stats.detailWrites, writtenBytes: stats.writtenBytes, transactions: stats.transactions };
    return { reads, work, fence: await store.activityFence(id) };
  };
  const pooled = await scenario((await open(t)).store);
  const unpooled = await scenario((await open(t, { pooled: false })).store);
  assert.deepEqual(pooled, unpooled);
  assert.ok(pooled.reads[0].total > 0);
});

test("never holds more connections than its bound across more sessions than the bound", async (t) => {
  const { store } = await open(t, { connections: { maxConnections: 3 } });
  const ids = Array.from({ length: 7 }, (_, index) => `codex:bounded-${index}`);
  for (let round = 1; round <= 3; round += 1) {
    for (const id of ids) {
      await contribute(store, id, round);
      assert.ok(store.persistenceStats().connections <= 3);
      assert.equal((await store.read(id, { kind: "requests" })).total, round);
      assert.ok(store.persistenceStats().connections <= 3);
    }
  }
  assert.equal(store.persistenceStats().connections, 3);
  for (const id of ids) assert.equal((await store.read(id, { kind: "activity" })).total, 3, "every session is intact after its connection was evicted and reopened");
});

test("an idle connection closes on the injected schedule, releasing the file for deletion and recreation", async (t) => {
  let clock = 0; const timers = [];
  const { directory, store } = await open(t, { connections: {
    idleMs: 1000, now: () => clock,
    schedule: (task, delay) => { const timer = { task, delay, cancelled: false, unref() { this.unrefd = true; } }; timers.push(timer); return timer; },
    cancel: (timer) => { timer.cancelled = true; },
  } });
  const id = "codex:idle";
  await contribute(store, id, 1);
  assert.equal(store.persistenceStats().connections, 1);
  assert.equal(timers.filter((timer) => !timer.cancelled).length, 1);
  assert.equal(timers[0].unrefd, true);

  clock = 999; timers[0].task();
  assert.equal(store.persistenceStats().connections, 1, "not yet idle for the full time");
  clock = 1000; timers.filter((timer) => !timer.cancelled).at(-1).task();
  assert.equal(store.persistenceStats().connections, 0);

  const file = await databaseFile(directory);
  await rm(file); // Windows refuses this while a handle is open
  await contribute(store, id, 1);
  assert.equal((await store.read(id, { kind: "requests" })).total, 1);
  assert.equal((await store.read(id, { kind: "requests" })).items[0].number, 1, "numbering restarted in the recreated file");
});

test("stop closes every connection so the data root can be removed and recreated, and start resumes pooling", async (t) => {
  const { directory, store } = await open(t);
  const id = "codex:shutdown";
  await contribute(store, id, 1);
  await store.read(id, { kind: "requests" });
  assert.equal(store.persistenceStats().connections, 2, "a read-write connection for the writer, a read-only one for reads");

  await store.stop();
  assert.equal(store.persistenceStats().connections, 0);
  await rm(directory, { recursive: true }); // would fail with EPERM/EBUSY on Windows if any handle remained

  await contribute(store, id, 1); // a late call after shutdown still works, but retains nothing
  assert.equal(store.persistenceStats().connections, 0);
  assert.equal((await store.read(id, { kind: "requests" })).total, 1);

  store.start();
  await contribute(store, id, 2);
  assert.equal(store.persistenceStats().connections, 1);
  await store.stop();
  assert.equal(store.persistenceStats().connections, 0);
  const opened = store.persistenceStats().opens;
  await store.read(id, { kind: "requests" });
  assert.equal(store.persistenceStats().opens, opened + 2, "after stop a read opens and closes its own connections (existence check, then the read), as before pooling");
  assert.equal(store.persistenceStats().connections, 0);
});

test("a read-only pooled connection sees commits from the pooled writer and from an independent writer", async (t) => {
  const { directory, store } = await open(t);
  const id = "codex:visibility";
  await contribute(store, id, 1);
  assert.equal((await store.read(id, { kind: "requests" })).total, 1);
  const reader = store.persistenceStats().connections;
  await contribute(store, id, 2);
  assert.equal((await store.read(id, { kind: "requests" })).total, 2, "committed data is visible to the reader opened earlier");
  assert.equal(store.persistenceStats().connections, reader, "the reader connection was reused");

  const external = new DatabaseSync(await databaseFile(directory)); // default busy timeout 0: fails if the pool holds a lock
  try {
    external.exec("UPDATE meta SET value=json_set(value,'$.revision',99)");
    assert.equal((await store.read(id, { kind: "requests" })).revision, "99", "an independent commit is visible to the pooled reader");
    external.exec("UPDATE meta SET value=json_set(value,'$.revision',100)");
    await contribute(store, id, 3); // the pooled writer starts from the independent commit
  } finally { external.close(); }
  assert.equal((await store.read(id, { kind: "requests" })).revision, "101");
});

test("reads never create a database, open a writable connection, or retain a handle for a missing session", async (t) => {
  const { directory, store } = await open(t);
  const before = store.persistenceStats();
  assert.equal((await store.read("codex:missing", { kind: "requests" })).status, "unavailable");
  assert.equal((await store.activityFence("codex:missing")).revision, 0);
  assert.deepEqual(await readdir(directory), []);
  const after = store.persistenceStats();
  assert.equal(after.opens, before.opens);
  assert.equal(after.connections, 0);
});

test("a failed connection is evicted and a fresh handle is used, for writes and reads", async (t) => {
  const { directory, store } = await open(t);
  const id = "codex:evicted";
  await contribute(store, id, 1);
  await store.read(id, { kind: "requests" });
  const file = await databaseFile(directory);
  const external = new DatabaseSync(file);
  const original = external.prepare("SELECT value FROM meta WHERE id=1").get().value;
  try {
    external.prepare("UPDATE meta SET value=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(original), version: 4 })); // schema mismatch
    const beforeFailure = store.persistenceStats();
    await assert.rejects(store.publishRequestContribution(id, { epoch: 1, sequence: 9, requests: [numbered(9)], activity: [] }), /Invalid history metadata/);
    assert.equal((await store.read(id, { kind: "requests" })).status, "unavailable", "unreadable history is unavailable, as without the pool");
    assert.equal(store.persistenceStats().connections, 0, "both handles were evicted");

    external.prepare("UPDATE meta SET value=? WHERE id=1").run(original);
    const opensBefore = store.persistenceStats().opens;
    await contribute(store, id, 2);
    assert.equal((await store.read(id, { kind: "requests" })).total, 2);
    assert.equal(store.persistenceStats().opens, opensBefore + 2, "one fresh read-write and one fresh read-only connection");
    assert.equal(store.persistenceStats().transactions, beforeFailure.transactions + 2);
  } finally { external.close(); }
});

test("a transaction that fails before commit rolls back completely and its connection is not reused", async (t) => {
  let fail = false;
  const { store } = await open(t, { beforeHistoryCommit: () => { if (fail) throw new Error("fixture interrupted commit"); } });
  const id = "codex:rolled-back";
  await store.publishActivityContribution(id, { epoch: 1, sequence: 1, activity: [call(1)] });
  const fence = await store.activityFence(id); const opens = store.persistenceStats().opens;
  fail = true;
  await assert.rejects(store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: [numbered(1)], activity: [call(1, numbered(1).id)] }), /interrupted/);
  assert.equal(store.persistenceStats().connections, 1, "only the reader used by activityFence remains");
  assert.deepEqual(await store.activityFence(id), fence, "revision, numbering and admissions are unchanged");
  assert.equal((await store.read(id, { kind: "requests" })).status, "loading");
  fail = false;
  await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: [numbered(1)], activity: [call(1, numbered(1).id)] });
  assert.equal((await store.read(id, { kind: "requests" })).items[0].number, 1);
  assert.ok(store.persistenceStats().opens > opens, "the writer reopened after the failure");
});

for (const pooled of [false, true]) {
  test(`a killed writer's hot journal is recovered by the next writer, never by a read (${pooled ? "pooled" : "unpooled"})`, async (t) => {
    const { directory, store } = await open(t, { pooled });
    const id = "codex:hot-journal";
    await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: Array.from({ length: 100 }, (_, index) => numbered(index + 1)), activity: [] });
    assert.equal((await store.read(id, { kind: "requests" })).total, 100);
    const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE');
      db.exec("UPDATE rows SET data=data || 'interrupted' WHERE kind='requests'"); process.exit(7);`, await databaseFile(directory)]);
    assert.equal(killed.status, 7);
    assert.equal((await readdir(directory)).some((name) => name.endsWith("-journal")), true);

    assert.equal((await store.read(id, { kind: "requests" })).status, "unavailable", "a read cannot repair the journal");
    assert.equal((await readdir(directory)).some((name) => name.endsWith("-journal")), true, "and does not touch it");
    await store.publishRequestContribution(id, { epoch: 1, sequence: 2, requests: [numbered(101)], activity: [] });
    assert.equal((await readdir(directory)).some((name) => name.endsWith("-journal")), false);
    const page = await store.read(id, { kind: "requests" });
    assert.equal(page.total, 101);
    assert.doesNotMatch(JSON.stringify(page), /interrupted/);
  });
}

test("maintenance reclaims pages while connections are pooled, and later reads and writes see consistent data", async (t) => {
  const { directory, store } = await open(t);
  const id = "codex:maintained";
  await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: Array.from({ length: 600 }, (_, index) => numbered(index + 1)), activity: [] });
  await store.publish(id, { complete: true, requests: [numbered(1)], activity: [] }); // frees the pages of the other rows
  assert.equal((await store.read(id, { kind: "requests" })).total, 1);
  const connections = store.persistenceStats().connections;
  assert.ok(connections >= 1);
  const file = await databaseFile(directory); const size = (await stat(file)).size;
  for (let step = 0; step < 6; step += 1) await store.drain({ budget: 1 });
  assert.ok((await stat(file)).size < size, "pages were reclaimed in place");
  assert.equal(store.persistenceStats().connections, connections, "maintenance neither used nor evicted pooled connections");
  assert.equal((await store.read(id, { kind: "requests" })).total, 1);
  await store.publishRequestContribution(id, { epoch: 1, sequence: 2, requests: [numbered(2)], activity: [] });
  assert.deepEqual((await store.read(id, { kind: "requests" })).items.map((item) => item.number), [1, 2]);
});
