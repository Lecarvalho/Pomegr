import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

for (const disk of [false, true]) {
  test(`activity history reads chronologically with stable latest and anchor pages (${disk ? "disk restore" : "memory"})`, async (t) => {
    const directory = disk ? await mkdtemp(path.join(os.tmpdir(), "pomegr-history-activity-order-")) : null;
    if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
    const sessionId = "codex:activity-order";
    const requests = Array.from({ length: 20 }, (_, index) => request(index.toString(16).padStart(16, "0"), `2026-09-10T00:${String(index).padStart(2, "0")}:00Z`));
    const activities = requests.map((item, index) => activity(`event-${String(index).padStart(2, "0")}`, `2026-09-10T01:${String(index).padStart(2, "0")}:00Z`, item.id));
    const store = new SessionHistoryStore({ directory });
    await store.publish(sessionId, { requests, activity: activities.slice(0, 16), complete: true });
    const reader = disk ? new SessionHistoryStore({ directory }) : store;

    const first = await reader.read(sessionId, { kind: "activity", limit: "8" });
    assert.deepEqual(first.items.map((item) => item.id), activities.slice(0, 8).map((item) => item.id));
    const located = await reader.read(sessionId, { kind: "activity", requestId: requests[10].id, limit: "8" });
    assert.equal(located.offset, 8);
    assert.ok(located.items.some((item) => item.requestId === requests[10].id));

    await store.publish(sessionId, { requests, activity: activities, complete: true });
    const latest = await reader.read(sessionId, { kind: "activity", offset: "latest", limit: "8" });
    const last = await reader.read(sessionId, { kind: "activity", offset: "last", limit: "8" });
    assert.equal(latest.offset, 16);
    assert.deepEqual(latest.items.map((item) => item.id), activities.slice(16).map((item) => item.id));
    assert.deepEqual(last, latest);

    const anchored = await reader.read(sessionId, { kind: "activity", anchor: activities[8].id, limit: "8" });
    assert.equal(anchored.offset, 8);
    assert.deepEqual(anchored.items.map((item) => item.id), activities.slice(8, 16).map((item) => item.id));
  });
}

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

for (const disk of [false, true]) {
  test(`Activity contribution publishes before request replay and a fenced replay retains a newer row (${disk ? "disk" : "memory"})`, async (t) => {
    const directory = disk ? await mkdtemp(path.join(os.tmpdir(), "pomegr-history-progressive-")) : null;
    if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new SessionHistoryStore({ directory });
    const sessionId = "codex:progressive";
    const revisions = [];
    const unsubscribe = store.subscribeRevisionEvents((event) => revisions.push(event));
    const early = activity("call-early", "2026-09-10T02:00:00Z", null);
    const later = activity("call-later", "2026-09-10T02:00:01Z", null);
    await store.publishActivityContribution(sessionId, { epoch: 1, sequence: 1, activity: [early] });
    const beforeReplay = await store.read(sessionId, { kind: "activity" });
    assert.equal(beforeReplay.status, "ready");
    assert.deepEqual(beforeReplay.items.map((item) => item.id), ["call-early"]);
    assert.equal((await store.read(sessionId, { kind: "requests" })).status, "loading");

    const fence = await store.activityFence(sessionId);
    await store.publishActivityContribution(sessionId, { epoch: 1, sequence: 2, activity: [later] });
    const linked = request("abcdefabcdefabcd", "2026-09-10T02:00:02Z");
    const rejectedReplay = await store.publishOutcome(sessionId, { complete: true, requests: [linked], activity: [activity("call-early", early.timestamp, linked.id)] }, { activityFence: fence });
    assert.equal(rejectedReplay.accepted, false);
    assert.equal((await store.read(sessionId, { kind: "activity" })).items.find((item) => item.id === "call-early").requestId, null, "an obsolete replay cannot write any domain");
    const replayFence = await store.activityFence(sessionId);
    const acceptedReplay = await store.publishOutcome(sessionId, { complete: true, requests: [linked], activity: [activity("call-early", early.timestamp, linked.id), later] }, { activityFence: replayFence });
    assert.equal(acceptedReplay.accepted, true);
    const afterReplay = await store.read(sessionId, { kind: "activity" });
    assert.deepEqual(afterReplay.items.map((item) => item.id).sort(), ["call-early", "call-later"]);
    assert.equal(afterReplay.items.find((item) => item.id === "call-early").requestId, linked.id);
    assert.equal(afterReplay.items.find((item) => item.id === "call-later").requestId, null);
    assert.equal((await store.read(sessionId, { kind: "requests" })).status, "ready");

    await store.publishActivityContribution(sessionId, { epoch: 2, sequence: 1, activity: [activity("call-epoch-two", "2026-09-10T02:00:03Z", null)] });
    await store.publishActivityContribution(sessionId, { epoch: 2, sequence: 2, activity: [activity("call-early", early.timestamp, null)] });
    assert.equal((await store.read(sessionId, { kind: "activity" })).items.find((item) => item.id === "call-early").requestId, linked.id, "partial source rows never clear resolved enrichment");
    await store.publishActivityContribution(sessionId, { epoch: 1, sequence: 99, activity: [activity("call-stale", "2026-09-10T02:00:04Z", null)] });
    assert.equal((await store.read(sessionId, { kind: "activity" })).items.some((item) => item.id === "call-stale"), false);
    assert.deepEqual(revisions.map((event) => event.domain), ["history", "history", "history", "history", "history"]);
    assert.deepEqual(revisions.map((event) => event.revision), [0, 1, 2, 3, 4]);
    assert.doesNotMatch(JSON.stringify(revisions), /codex:progressive/);
    unsubscribe();
    if (directory) {
      const restarted = new SessionHistoryStore({ directory });
      await restarted.publishActivityContribution(sessionId, { epoch: 1, sequence: 1, activity: [activity("call-after-restart", "2026-09-10T02:00:05Z", null)] });
      assert.equal((await restarted.read(sessionId, { kind: "activity" })).items.some((item) => item.id === "call-after-restart"), true, "a restarted observer starts a fresh internal admission epoch");
    }
  });
}

test("coalesces a burst of append contributions without dropping rows or revising identical evidence", async () => {
  const store = new SessionHistoryStore();
  const sessionId = "codex:coalesced";
  const revisions = [];
  store.subscribeRevisionEvents((event) => revisions.push(event.revision));
  await Promise.all([
    store.publishActivityContribution(sessionId, { epoch: 1, sequence: 1, activity: [activity("call-one", "2026-09-10T03:00:00Z", null)] }),
    store.publishActivityContribution(sessionId, { epoch: 1, sequence: 2, activity: [activity("call-two", "2026-09-10T03:00:01Z", null)] }),
    store.publishActivityContribution(sessionId, { epoch: 1, sequence: 3, activity: [activity("call-three", "2026-09-10T03:00:02Z", null)] }),
  ]);
  assert.deepEqual((await store.read(sessionId, { kind: "activity" })).items.map((item) => item.id).sort(), ["call-one", "call-three", "call-two"]);
  assert.deepEqual(revisions, [0, 1]);
  await store.publishActivityContribution(sessionId, { epoch: 1, sequence: 4, activity: [activity("call-three", "2026-09-10T03:00:02Z", null)] });
  assert.deepEqual(revisions, [0, 1], "a source watermark alone does not churn the public revision");
});

test("bounds runtime admission state while restoring stale rejection after LRU eviction", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-admission-lru-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory, maxSessions: 2, maxResident: 0 });
  const target = "codex:admission-target";
  await store.publishActivityContribution(target, { epoch: 1, sequence: 2, activity: [activity("admission-current", "2026-09-10T03:00:00Z", null)] });
  for (const suffix of ["one", "two", "three", "four"]) {
    await store.publishActivityContribution(`codex:admission-${suffix}`, {
      epoch: 1, sequence: 1, activity: [activity(`admission-${suffix}`, "2026-09-10T03:00:01Z", null)],
    });
  }
  await store.publishActivityContribution(target, { epoch: 1, sequence: 1, activity: [activity("admission-stale", "2026-09-10T03:00:02Z", null)] });
  assert.equal((await store.read(target, { kind: "activity" })).items.some((item) => item.id === "admission-stale"), false,
    "an evicted current-runtime admission reloads its private watermark before accepting a contribution");
  await store.publishActivityContribution(target, { epoch: 1, sequence: 3, activity: [activity("admission-next", "2026-09-10T03:00:03Z", null)] });
  assert.equal((await store.read(target, { kind: "activity" })).items.some((item) => item.id === "admission-next"), true);
  assert.equal((await store.read("codex:admission-four", { kind: "activity" })).status, "ready", "admission eviction never deletes normalized history");

  const restarted = new SessionHistoryStore({ directory, maxSessions: 2, maxResident: 0 });
  await restarted.publishActivityContribution(target, { epoch: 1, sequence: 1, activity: [activity("admission-restarted", "2026-09-10T03:00:04Z", null)] });
  assert.equal((await restarted.read(target, { kind: "activity" })).items.some((item) => item.id === "admission-restarted"), true,
    "a fresh runtime nonce accepts a restarted observer's reset source sequence");
});

test("request contributions enrich Activity atomically without replacing prior live history", async () => {
  const store = new SessionHistoryStore();
  const sessionId = "codex:request-contribution";
  const early = activity("call-request", "2026-09-10T04:00:00Z", null);
  await store.publishActivityContribution(sessionId, { epoch: 1, sequence: 1, activity: [early] });
  const linked = request("1234567890abcdef", "2026-09-10T04:00:01Z");
  const enriched = { ...early, requestId: linked.id, durationMs: 42 };
  await store.publishRequestContribution(sessionId, { epoch: 1, sequence: 1, requests: [linked], activity: [enriched] });
  const requests = await store.read(sessionId, { kind: "requests" });
  const activities = await store.read(sessionId, { kind: "activity" });
  assert.equal(requests.status, "ready");
  assert.equal(requests.items[0].id, linked.id);
  assert.deepEqual(activities.items.map((item) => ({ id: item.id, requestId: item.requestId, durationMs: item.durationMs })), [{ id: "call-request", requestId: linked.id, durationMs: 42 }]);
  await store.publishRequestContribution(sessionId, { epoch: 1, sequence: 2, requests: [], activity: [] });
  assert.equal((await store.read(sessionId, { kind: "requests" })).items[0].id, linked.id, "bounded live request input cannot erase retained history");
});

test("an empty request contribution transitions Activity-first history to request-ready", async () => {
  const store = new SessionHistoryStore();
  const sessionId = "codex:empty-request-ready";
  const revisions = [];
  store.subscribeRevisionEvents((event) => revisions.push(event.revision));
  await store.publishActivityContribution(sessionId, {
    epoch: 1, sequence: 1, activity: [activity("empty-request-activity", "2026-09-10T04:30:00Z", null)],
  });
  assert.equal((await store.read(sessionId, { kind: "requests" })).status, "loading");
  await store.publishRequestContribution(sessionId, { epoch: 1, sequence: 1, requests: [], activity: [] });
  const requests = await store.read(sessionId, { kind: "requests" });
  assert.equal(requests.status, "ready");
  assert.equal(requests.total, 0);
  assert.deepEqual(revisions, [0, 1, 2]);
});

test("a failed Activity contribution write accepts the same source contribution on retry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blockedDirectory = path.join(root, "blocked");
  await writeFile(blockedDirectory, "not a directory", "utf8");
  const store = new SessionHistoryStore({ directory: blockedDirectory });
  const contribution = { epoch: 1, sequence: 1, activity: [activity("call-retry", "2026-09-10T05:00:00Z", null)] };
  await assert.rejects(store.publishActivityContribution("codex:retry", contribution));
  await rm(blockedDirectory);
  await store.publishActivityContribution("codex:retry", contribution);
  assert.equal((await store.read("codex:retry", { kind: "activity" })).items[0].id, "call-retry");
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

test("the immutable generation snapshot remains authoritative when the compatibility snapshot is stale", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-commit-pointer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = "codex:commit-pointer";
  const first = request("1111111111111111", "2026-09-10T10:00:00Z");
  const second = request("2222222222222222", "2026-09-10T10:01:00Z");
  const store = new SessionHistoryStore({ directory, maxResident: 0 });
  await store.publish(sessionId, { complete: true, requests: [first], activity: [] });
  const legacy = (await readdir(directory)).find((name) => name.startsWith("history-") && name.endsWith(".json"));
  const staleLegacy = await readFile(path.join(directory, legacy), "utf8");
  await store.publish(sessionId, { complete: true, requests: [first, second], activity: [] });
  await writeFile(path.join(directory, legacy), staleLegacy, "utf8");

  const committed = await new SessionHistoryStore({ directory, maxResident: 0 }).read(sessionId, { kind: "requests" });
  assert.deepEqual(committed.items.map((item) => item.id), [first.id, second.id]);

  const indexName = (await readdir(directory)).find((name) => name.endsWith(".index.json"));
  const index = JSON.parse(await readFile(path.join(directory, indexName), "utf8"));
  const key = indexName.slice(0, -".index.json".length);
  await writeFile(path.join(directory, `${key}-${index.revision}`, "snapshot.json"), "{ damaged", "utf8");
  const damaged = await new SessionHistoryStore({ directory, maxResident: 0 }).publish(sessionId, { complete: false });
  assert.equal(damaged, null, "a marked generation never falls back to a stale compatibility snapshot during recovery");
});

test("a failed manifest swap leaves the last compatibility snapshot serveable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-manifest-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = "codex:manifest-failure";
  const first = request("3333333333333333", "2026-09-10T11:00:00Z");
  const second = request("4444444444444444", "2026-09-10T11:01:00Z");
  const store = new SessionHistoryStore({ directory, maxResident: 0 });
  await store.publish(sessionId, { complete: true, requests: [first], activity: [] });
  const indexName = (await readdir(directory)).find((name) => name.endsWith(".index.json"));
  await rm(path.join(directory, indexName));
  await mkdir(path.join(directory, indexName));
  await assert.rejects(store.publish(sessionId, { complete: true, requests: [first, second], activity: [] }));

  const lastGood = await new SessionHistoryStore({ directory, maxResident: 0 }).publish(sessionId, { complete: false });
  assert.deepEqual(lastGood.requests.map((item) => item.id), [first.id]);
});

function manifestParseSpy(t) {
  let count = 0;
  const original = JSON.parse;
  t.mock.method(JSON, "parse", function parse(source, ...args) {
    if (typeof source === "string" && source.includes('"version":2') && source.includes('"sessionId"')) count += 1;
    return original(source, ...args);
  });
  return () => count;
}

test("reuses an unchanged index, invalidates it on external publish, and rejects removal or corruption", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-index-cache-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory, maxIndexResident: 4 });
  const id = "codex:index-cache";
  await store.publish(id, { requests: [request("aaaaaaaaaaaaaaaa", "2026-09-08T00:00:00Z")], activity: [], complete: true });
  const indexPath = path.join(directory, (await readdir(directory)).find((file) => file.endsWith(".index.json")));
  const parsed = manifestParseSpy(t);
  assert.equal((await store.read(id, { kind: "requests" })).revision, "1");
  assert.equal(parsed(), 1);
  assert.equal((await store.read(id, { kind: "requests" })).revision, "1");
  assert.equal(parsed(), 1, "unchanged manifest reuses parsed index");

  const external = new SessionHistoryStore({ directory });
  const beforeExternalPublish = parsed();
  await external.publish(id, { requests: [request("bbbbbbbbbbbbbbbb", "2026-09-08T00:01:00Z")], activity: [], complete: true });
  assert.equal((await store.read(id, { kind: "requests" })).revision, "2");
  assert.equal(parsed(), beforeExternalPublish + 3, "external manifest replacement reloads its committed snapshot and forces a reparse");

  await rm(indexPath);
  assert.equal((await store.read(id, { kind: "requests" })).status, "unavailable");
  await writeFile(indexPath, "{ malformed", "utf8");
  assert.equal((await store.read(id, { kind: "requests" })).status, "unavailable");
});

test("bounds resident index cache by entries and source bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-index-bounds-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory, maxIndexResident: 1, maxIndexBytes: 16 * 1024 * 1024 });
  await store.publish("codex:one", { requests: [request("1111111111111111", "2026-09-09T00:00:00Z")], activity: [], complete: true });
  await store.publish("codex:two", { requests: [request("2222222222222222", "2026-09-09T00:01:00Z")], activity: [], complete: true });
  const parsed = manifestParseSpy(t);
  await store.read("codex:one", { kind: "requests" });
  assert.equal((await store.read("codex:two", { kind: "requests" })).status, "ready");
  assert.equal((await store.read("codex:one", { kind: "requests" })).status, "ready");
  assert.equal(parsed(), 3, "one-entry cache reparses after LRU eviction");

  const byteBounded = new SessionHistoryStore({ directory, maxIndexResident: 4, maxIndexBytes: 1 });
  const byteParsed = manifestParseSpy(t);
  assert.equal((await byteBounded.read("codex:two", { kind: "requests" })).status, "ready");
  assert.equal((await byteBounded.read("codex:two", { kind: "requests" })).status, "ready");
  assert.equal(byteParsed(), 2, "manifest over byte budget is reparsed");
});
