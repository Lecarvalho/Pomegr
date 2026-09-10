import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionHistoryStore } from "../monitor/session-history-store.mjs";

const request = (id, observedAt) => ({
  id: `request-${id}`, agentId: "primary", observedAt, cacheLifetime: null,
  uncachedInputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, totalTokens: 10,
  precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null,
});
const activity = (id, timestamp, requestId) => ({
  id, timestamp, actor: "Primary agent", tool: "Read", workKind: "read", detail: "Safe label", status: null,
  durationMs: null, requestId, agentId: "primary",
});

test("persists sanitized pages with stable session-global request numbers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  await store.publish("codex:example", { requests: [request("0000000000000001", "2026-09-01T00:00:00Z")], activity: [], complete: true });
  await store.publish("codex:example", { requests: [request("0000000000000002", "2026-09-01T00:01:00Z"), request("0000000000000001", "2026-09-01T00:00:00Z")], activity: [], complete: true });
  const page = await store.read("codex:example", { kind: "requests", offset: "0", limit: "60" });
  assert.deepEqual(page.items.map((item) => item.number), [1, 2]);
  assert.deepEqual(page.overview, [[1, 2, 3, 4], [1, 2, 3, 4]]);
  assert.equal(page.items[0].id, "request-0000000000000001");
  const reloaded = new SessionHistoryStore({ directory });
  assert.deepEqual((await reloaded.read("codex:example", { kind: "requests" })).items.map((item) => item.number), [1, 2]);
  const saved = await readFile(path.join(directory, (await readdir(directory)).find((file) => file.endsWith(".json")) || "missing"), "utf8");
  assert.doesNotMatch(saved, /rawPrompt|PRIVATE_PATH/);
});

test("request lookup and activity anchor page bounded complete retained history", async () => {
  const store = new SessionHistoryStore();
  const requests = Array.from({ length: 80 }, (_, index) => request(index.toString(16).padStart(16, "0"), `2026-09-01T00:${String(index % 60).padStart(2, "0")}:00Z`));
  const activities = Array.from({ length: 20 }, (_, index) => activity(`event-${index}`, `2026-09-01T01:${String(index).padStart(2, "0")}:00Z`, requests[index].id));
  await store.publish("claude:example", { requests, activity: activities, complete: true });
  const around = await store.read("claude:example", { kind: "requests", requestId: requests[40].id, limit: "9" });
  assert.equal(around.total, 80); assert.ok(around.items.some((item) => item.id === requests[40].id)); assert.equal(around.items.length, 9);
  const latest = await store.read("claude:example", { kind: "requests", offset: "latest", limit: "60" });
  assert.equal(latest.offset, 20); assert.equal(latest.items.length, 60);
  assert.equal(latest.overview.length, 80);
  const activityPage = await store.read("claude:example", { kind: "activity", requestId: requests[10].id, limit: "8" });
  assert.ok(activityPage.items.some((item) => item.requestId === requests[10].id));
  assert.equal(activityPage.linkedCount, 1);
});

test("request prefetch pages can omit the full overview while activity and default reads retain their shape", async () => {
  const store = new SessionHistoryStore();
  const item = request("dddddddddddddddd", "2026-09-01T00:00:00Z");
  await store.publish("codex:prefetch", { requests: [item], activity: [], complete: true });
  const omitted = await store.read("codex:prefetch", { kind: "requests", overview: "0" });
  assert.equal(Object.hasOwn(omitted, "overview"), false);
  const included = await store.read("codex:prefetch", { kind: "requests", overview: "1" });
  assert.deepEqual(included.overview, [[1, 2, 3, 4]]);
  const activityPage = await store.read("codex:prefetch", { kind: "activity", overview: "0" });
  assert.equal(Object.hasOwn(activityPage, "overview"), false);
});

test("disk request overviews are full scoped index tuples and reject malformed or private tuple fields", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-overview-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  const requests = [request("aaaaaaaaaaaaaaaa", "2026-09-05T00:00:00Z"), request("bbbbbbbbbbbbbbbb", "2026-09-05T00:01:00Z")];
  requests[1].agentId = "child";
  await store.publish("codex:overview", { requests, activity: [], complete: true });
  const all = await store.read("codex:overview", { kind: "requests", limit: "1" });
  assert.deepEqual(all.overview, [[1, 2, 3, 4], [1, 2, 3, 4]]);
  assert.deepEqual((await store.read("codex:overview", { kind: "requests", scope: "primary" })).overview, [[1, 2, 3, 4]]);
  const indexPath = path.join(directory, (await readdir(directory)).find((file) => file.endsWith(".index.json")));
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.requests[0].overview = [1, 2, 3, 4, "PRIVATE"];
  await writeFile(indexPath, JSON.stringify(index), "utf8");
  const malformed = await new SessionHistoryStore({ directory }).read("codex:overview", { kind: "requests" });
  assert.equal(malformed.overview, null);
  assert.doesNotMatch(JSON.stringify(malformed), /PRIVATE/);
});

test("unchanged publish upgrades a legacy index while legacy indexes return ready detail with null overview", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-overview-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  const item = request("cccccccccccccccc", "2026-09-06T00:00:00Z");
  await store.publish("codex:migrate", { requests: [item], activity: [], complete: true });
  const indexPath = path.join(directory, (await readdir(directory)).find((file) => file.endsWith(".index.json")));
  const index = JSON.parse(await readFile(indexPath, "utf8")); delete index.requests[0].overview; await writeFile(indexPath, JSON.stringify(index), "utf8");
  const legacy = await new SessionHistoryStore({ directory }).read("codex:migrate", { kind: "requests" });
  assert.equal(legacy.status, "ready"); assert.equal(legacy.overview, null);
  await store.publish("codex:migrate", { requests: [item], activity: [], complete: true });
  const migrated = await new SessionHistoryStore({ directory }).read("codex:migrate", { kind: "requests" });
  assert.deepEqual(migrated.overview, [[1, 2, 3, 4]]);
  assert.equal(Number(migrated.revision), Number(legacy.revision) + 1);
  const afterMigration = await store.publish("codex:migrate", { requests: [item], activity: [], complete: true });
  assert.equal(String(afterMigration.revision), migrated.revision);
});

test("disk overview is index-backed and survives missing unselected detail blocks", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-overview-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  const requests = Array.from({ length: 200 }, (_, index) => {
    const item = request(index.toString(16).padStart(16, "0"), new Date(Date.parse("2026-09-07T00:00:00Z") + index * 1000).toISOString());
    item.uncachedInputTokens = index + 1; item.cacheWriteTokens = index % 3; item.cacheReadTokens = index * 2; item.outputTokens = index + 4;
    item.totalTokens = item.uncachedInputTokens + item.cacheWriteTokens + item.cacheReadTokens + item.outputTokens;
    item.agentId = index % 2 ? "child" : "primary";
    return item;
  });
  await store.publish("codex:index-overview", { requests, activity: [], complete: true });
  const key = (await readdir(directory)).find((file) => file.endsWith(".index.json")).replace(".index.json", "");
  const generation = (await readdir(directory, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.startsWith(`${key}-`)).name;
  await rm(path.join(directory, generation, "requests-0.json"));
  const latest = await new SessionHistoryStore({ directory }).read("codex:index-overview", { kind: "requests", offset: "latest", limit: "60" });
  assert.equal(latest.status, "ready");
  assert.equal(latest.items.length, 60);
  assert.equal(latest.overview.length, 200);
  assert.deepEqual(latest.overview[0], [1, 0, 0, 4]);
  assert.deepEqual(latest.overview.at(-1), [200, 1, 398, 203]);
  const primary = await new SessionHistoryStore({ directory }).read("codex:index-overview", { kind: "requests", scope: "primary", offset: "latest", limit: "1" });
  assert.equal(primary.overview.length, 100);
  assert.deepEqual(primary.overview[1], [3, 2, 4, 6]);
  const activity = await new SessionHistoryStore({ directory }).read("codex:index-overview", { kind: "activity" });
  assert.equal(Object.hasOwn(activity, "overview"), false);
});

test("retains all complete rows, rejects unsafe nested work, and preserves last good record on incomplete updates", async () => {
  const store = new SessionHistoryStore();
  const requests = Array.from({ length: 250 }, (_, index) => request(index.toString(16).padStart(16, "0"), `2026-09-02T00:${String(index % 60).padStart(2, "0")}:00Z`));
  const first = await store.publish("codex:large", { requests, activity: [], complete: true });
  assert.equal((await store.read("codex:large", { kind: "requests", limit: "60" })).total, 250);
  assert.equal((await store.publish("codex:large", { requests: [], activity: [], complete: false })).revision, first.revision);
  assert.equal((await store.read("codex:large", { kind: "requests" })).overview.length, 250);
  const unsafe = request("ffffffffffffffff", "2026-09-02T01:00:00Z");
  unsafe.precedingWork = [{ kind: "read", count: 1, rawPrompt: "PRIVATE_PROMPT" }];
  const next = await store.publish("codex:unsafe", { requests: [unsafe], activity: [], complete: true });
  assert.equal(next.requests[0].precedingWork[0].kind, "read");
  assert.doesNotMatch(JSON.stringify(next), /PRIVATE_PROMPT/);
  const unchanged = await store.publish("codex:unsafe", { requests: [unsafe], activity: [], complete: true });
  assert.equal(unchanged.revision, next.revision);
});

test("indexed disk pages strip injected private fields and retain empty reply activity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-private-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory }); const item = request("1111111111111111", "2026-09-03T00:00:00Z");
  const reply = activity("reply", "2026-09-03T00:00:01Z", item.id); reply.detail = "";
  await store.publish("claude:private", { requests: [item], activity: [reply], complete: true });
  const folder = (await readdir(directory)).find((name) => name.includes("-") && !name.endsWith(".json"));
  const blockPath = path.join(directory, folder, "requests-0.json"); const block = JSON.parse(await readFile(blockPath, "utf8")); block[0].rawPrompt = "PRIVATE_PROMPT"; await writeFile(blockPath, JSON.stringify(block), "utf8");
  const page = await new SessionHistoryStore({ directory }).read("claude:private", { kind: "requests" });
  assert.equal(page.status, "ready"); assert.doesNotMatch(JSON.stringify(page), /PRIVATE_PROMPT/);
  assert.equal((await new SessionHistoryStore({ directory }).read("claude:private", { kind: "activity" })).items[0].detail, "");
});

test("keeps only current and previous immutable page generations", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-prune-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  for (let revision = 1; revision <= 3; revision += 1) {
    await store.publish("codex:prune", { requests: [request(`${revision}`.padStart(16, "0"), `2026-09-04T00:0${revision}:00Z`)], activity: [], complete: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  const generations = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.equal(generations.length, 2);
  assert.equal((await new SessionHistoryStore({ directory }).read("codex:prune", { kind: "requests" })).status, "ready");
});
