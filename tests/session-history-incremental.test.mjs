import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionHistoryStore } from "../monitor/session-history-store.mjs";

function request(hex, observedAt) {
  return { id: `request-${hex.padStart(16, "0")}`, agentId: "primary", observedAt, cacheLifetime: null,
    uncachedInputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, totalTokens: 10,
    precedingWork: [], issuedWork: [], model: null };
}

test("maintenance is bounded, preserves the current and prior complete history generations, and never runs on read", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-maintenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  for (let number = 1; number <= 4; number += 1) {
    await store.publish("codex:incremental", { complete: true, requests: [request(String(number), `2026-09-11T00:0${number}:00Z`)], activity: [] });
  }
  const beforeRead = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
  assert.equal((await store.read("codex:incremental", { kind: "requests" })).status, "ready");
  assert.equal((await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length, beforeRead);
  const step = await store.maintenanceStep({ budget: 1 });
  assert.equal(step.scanned, 1);
  await store.drain({ budget: 1 });
  const generations = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
  assert.equal(generations, 2);
  await store.stop();
  assert.equal((await store.maintenanceStep({ budget: 1 })).scanned, 0);
  store.start();
  assert.equal((await store.maintenanceStep({ budget: 1 })).scanned, 1, "restart enables bounded maintenance again");
  await store.stop();
  await store.stop();
  assert.equal((await store.maintenanceStep({ budget: 1 })).scanned, 0);
  store.start();
  assert.equal((await store.maintenanceStep({ budget: 1 })).scanned, 1, "restart enables bounded maintenance again");
  await store.stop();
});

test("maintenance leaves malformed and incomplete publication directories for conservative recovery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-conservative-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  await store.publish("codex:conservative", { complete: true, requests: [request("1", "2026-09-11T01:00:00Z")], activity: [] });
  const orphan = "a".repeat(64) + "-1";
  await mkdir(path.join(directory, orphan));
  await writeFile(path.join(directory, `${"a".repeat(64)}.index.json`), "{ damaged", "utf8");
  await store.drain({ budget: 128 });
  assert.ok((await readdir(directory)).includes(orphan));
  assert.equal((await store.read("codex:conservative", { kind: "requests" })).status, "ready");
});

function call(number, requestId = null) {
  return { id: `call-${number}`, timestamp: new Date(1_800_000_000_000 + number * 1000).toISOString(),
    actor: "Agent", tool: "Read", detail: "Read file", status: null, durationMs: 2, requestId, agentId: "primary" };
}
function numbered(number) { return request(number.toString(16), new Date(1_800_000_000_000 + number * 1000).toISOString()); }
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-units-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new SessionHistoryStore({ directory, maxResident: 0, maxIndexResident: 0 }) };
}
async function databasePath(directory) { return path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".history.sqlite"))); }
function changedPages(before, after) {
  let count = 0;
  for (let offset = 0; offset < Math.max(before.length, after.length); offset += 4096)
    if (!before.subarray(offset, offset + 4096).equals(after.subarray(offset, offset + 4096))) count += 1;
  return count;
}

test("one-row suffix reads and writes bounded indexed units with zero resident history at 100 and 10000 retained rows", async (t) => {
  const measured = [];
  for (const count of [100, 10_000]) {
    const { directory, store } = await fixture(t); const id = `codex:units-${count}`;
    await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: Array.from({ length: count }, (_, i) => numbered(i + 1)), activity: [] });
    const location = await databasePath(directory); const before = await readFile(location); const start = store.persistenceStats();
    await store.publishRequestContribution(id, { epoch: 1, sequence: 2, requests: [numbered(count + 1)], activity: [] });
    const after = await readFile(location); const end = store.persistenceStats();
    assert.equal(end.detailReads - start.detailReads, 0, "append never materializes retained detail");
    assert.equal(end.detailWrites - start.detailWrites, 1);
    assert.ok(end.writtenBytes - start.writtenBytes < 1024);
    const changed = changedPages(before, after);
    assert.ok(changed <= 16, `suffix modified ${changed} SQLite pages`);
    assert.ok(after.length - before.length <= 16 * 4096);
    const readStart = store.persistenceStats(); const page = await store.read(id, { kind: "requests", offset: "latest", limit: "60", overview: "0" });
    assert.equal(page.total, count + 1); assert.equal(page.items.at(-1).number, count + 1);
    assert.equal(store.persistenceStats().detailReads - readStart.detailReads, 60);
    assert.equal(store.persistenceStats().transactions, readStart.transactions);
    assert.equal(store.persistenceStats().maintenancePages, readStart.maintenancePages);
    measured.push({ retained: count, changedPages: changed, serializedRowBytes: end.writtenBytes - start.writtenBytes, databaseGrowth: after.length - before.length });
  }
  t.diagnostic(JSON.stringify(measured));
});

test("legacy v3 migration occurs only on background contribution and retains numbering through replacement", async (t) => {
  const { directory, store } = await fixture(t); const id = "codex:legacy-units";
  await store.publish(id, { complete: true, requests: [numbered(1), numbered(2)], activity: [call(1, numbered(1).id)] });
  await store.read(id, { kind: "requests" });
  assert.equal((await readdir(directory)).some((name) => name.endsWith(".sqlite")), false);
  await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: [numbered(3)], activity: [] });
  const restarted = new SessionHistoryStore({ directory, maxResident: 0 });
  assert.deepEqual((await restarted.read(id, { kind: "requests" })).items.map((item) => item.number), [1, 2, 3]);
  const fence = await store.activityFence(id);
  await store.publishOutcome(id, { complete: true, requests: [numbered(3)], activity: [] }, { activityFence: fence });
  await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: [numbered(4)], activity: [] });
  assert.equal((await store.read(id, { kind: "requests" })).total, 1, "replay preserves runtime stale admissions");
  await store.publishRequestContribution(id, { epoch: 1, sequence: 2, requests: [numbered(1)], activity: [] });
  assert.deepEqual((await store.read(id, { kind: "requests" })).items.map((item) => item.number), [1, 3]);
});

test("failed atomic contribution rolls back rows, numbering, readiness, and admissions and retries after restart", async (t) => {
  const { directory } = await fixture(t); let fail = false;
  const store = new SessionHistoryStore({ directory, maxResident: 0, beforeHistoryCommit: () => { if (fail) throw new Error("fixture interrupted commit"); } });
  const id = "codex:rollback-units";
  await store.publishActivityContribution(id, { epoch: 1, sequence: 1, activity: [call(1)] });
  const before = await store.activityFence(id); fail = true;
  await assert.rejects(store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: [numbered(1)], activity: [call(1, numbered(1).id)] }));
  const restarted = new SessionHistoryStore({ directory, maxResident: 0 });
  assert.deepEqual(await restarted.activityFence(id), before);
  assert.equal((await restarted.read(id, { kind: "requests" })).status, "loading");
  assert.equal((await restarted.read(id, { kind: "activity" })).items[0].requestId, null);
  fail = false;
  await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: [numbered(1)], activity: [call(1, numbered(1).id)] });
  assert.equal((await restarted.read(id, { kind: "requests" })).items[0].number, 1);
});

test("a killed writer recovers its last committed transaction in scheduled maintenance", async (t) => {
  const { directory, store } = await fixture(t); const id = "codex:crash-units";
  await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: Array.from({ length: 100 }, (_, i) => numbered(i + 1)), activity: [] });
  const location = await databasePath(directory);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE');
    db.exec("UPDATE rows SET data=data || 'interrupted' WHERE kind='requests'"); process.exit(7);`, location]);
  assert.equal(result.status, 7);
  const restarted = new SessionHistoryStore({ directory, maxResident: 0 });
  await restarted.drain({ budget: 1 });
  const page = await restarted.read(id, { kind: "requests" });
  assert.equal(page.total, 100); assert.equal(page.items[0].number, 1);
  assert.doesNotMatch(JSON.stringify(page), /interrupted/);
});

test("coalescing preserves disjoint request and Activity contributions and rejects overflow explicitly", async (t) => {
  const { store } = await fixture(t); const id = "codex:coalesced-units";
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.publishRequestContribution(id, {
    epoch: 1, sequence: i + 1, requests: [numbered(i + 1)], activity: [call(i + 1, numbered(i + 1).id)],
  })));
  assert.equal((await store.read(id, { kind: "requests" })).total, 20);
  assert.equal((await store.read(id, { kind: "activity" })).total, 20);
  const pending = Array.from({ length: 24 }, (_, i) => store.publishActivityContribution(`codex:bounded-${i}`, { epoch: 1, sequence: 1, activity: [call(i)] }));
  await assert.rejects(store.publishActivityContribution("codex:overflow", { epoch: 1, sequence: 1, activity: [call(25)] }), /capacity exceeded/);
  await Promise.all(pending); assert.equal(store.persistenceBusy(), false);
  await assert.rejects(store.publishActivityContribution(id, { epoch: 1, sequence: 2, activity: Array(16_385).fill(call(1)) }), /capacity exceeded/);
  assert.equal((await store.read(id, { kind: "activity" })).total, 20);
});

test("indexed selected reads sanitize private fields and model identifiers without touching disk or unrelated detail", async (t) => {
  const { directory, store } = await fixture(t); const id = "codex:privacy-units";
  await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: Array.from({ length: 100 }, (_, i) => ({ ...numbered(i + 1), rawPrompt: "PRIVATE_PROMPT" })), activity: [] });
  const location = await databasePath(directory); const db = new DatabaseSync(location);
  const item = { ...numbered(100), number: 100, model: "C:PRIVATE_PATH", rawResponse: "PRIVATE_RESPONSE" };
  db.prepare("UPDATE rows SET data=? WHERE kind='requests' AND id=?").run(JSON.stringify(item), item.id);
  db.prepare("UPDATE rows SET data='broken' WHERE kind='requests' AND id=?").run(numbered(1).id); db.close();
  const before = await stat(location); const beforeStats = store.persistenceStats();
  const page = await store.read(id, { kind: "requests", offset: "latest", limit: "1", overview: "0" });
  assert.equal(page.status, "ready"); assert.equal(page.items[0].model, null);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
  assert.equal(store.persistenceStats().detailReads - beforeStats.detailReads, 1);
  assert.equal((await stat(location)).mtimeMs, before.mtimeMs);
  assert.equal(store.persistenceStats().transactions, beforeStats.transactions);
});

test("compaction reclaims at most the maintenance page budget and yields immediately to demand", async (t) => {
  const { directory, store } = await fixture(t); const id = "codex:compact-units";
  await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: Array.from({ length: 1000 }, (_, i) => numbered(i + 1)), activity: [] });
  await store.publish(id, { complete: true, requests: [numbered(1)], activity: [] });
  const location = await databasePath(directory); const size = (await stat(location)).size;
  const yielded = await store.maintenanceStep({ budget: 32, shouldYield: () => true });
  assert.equal(yielded.scanned, 0); assert.equal(yielded.yielded, true);
  for (let i = 0; i < 5; i += 1) {
    const before = store.persistenceStats(); await store.drain({ budget: 1 });
    assert.ok(store.persistenceStats().maintenancePages - before.maintenancePages <= 1);
  }
  assert.ok((await stat(location)).size < size);
  assert.equal((await store.read(id, { kind: "requests" })).items[0].number, 1);
  await store.stop(); assert.equal((await store.maintenanceStep()).scanned, 0);
});
