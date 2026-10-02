import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHistoryContributionPublisher } from "../../../../server/sessions/history/history-contribution-publisher.mjs";
import { SessionHistoryStore } from "../../../../server/sessions/history/session-history-store.mjs";

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
  test(`activity request groups bound headers and calls while retaining flat rows (${disk ? "disk" : "memory"})`, async (t) => {
    const directory = disk ? await mkdtemp(path.join(os.tmpdir(), "pomegr-history-groups-")) : null;
    if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new SessionHistoryStore({ directory });
    const sessionId = "codex:grouped-history";
    const requests = Array.from({ length: 8 }, (_, index) => request(index.toString(16).padStart(16, "0"), `2026-09-11T00:00:${String(index).padStart(2, "0")}Z`));
    const calls = requests.flatMap((item, index) => index >= 1 && index <= 4
      ? Array.from({ length: 55 }, (_, call) => ({ ...activity(`read-${index}-${String(call).padStart(3, "0")}`, `2026-09-11T01:${String(call % 60).padStart(2, "0")}:00Z`, item.id), workKind: "read" }))
      : [{ ...activity(`shell-${index}`, `2026-09-11T02:${String(index).padStart(2, "0")}:00Z`, item.id), workKind: "shell" }]);
    calls.push({ ...activity("unresolved-read", "2026-09-11T03:00:00Z", null), workKind: "read" });
    calls.push({ ...activity("linked-without-agent", "2026-09-11T03:01:00Z", requests[0].id), agentId: null, workKind: "read" });
    await store.publish(sessionId, { requests, activity: calls, complete: true });

    const allActors = await store.read(sessionId, { kind: "activity", from: "1", to: "5", selected: "1", scope: "all" });
    assert.ok(allActors.requestGroups.find((group) => group.request.number === 1).calls
      .some((call) => call.id === "linked-without-agent"), "a direct request association does not require an actor id");
    const primaryActors = await store.read(sessionId, { kind: "activity", from: "1", to: "5", selected: "1", scope: "primary" });
    assert.equal(primaryActors.requestGroups.find((group) => group.request.number === 1).calls
      .some((call) => call.id === "linked-without-agent"), false, "agent scopes exclude calls without a matching actor id");

    const grouped = await store.read(sessionId, { kind: "activity", from: "1", to: "7", selected: "4", scope: "primary" });
    assert.deepEqual(grouped.requestGroups.map((group) => group.request.number), [2, 3, 4, 5, 6]);
    assert.deepEqual(grouped.range, { from: 2, to: 6 });
    assert.equal(grouped.requestTotal, 8);
    assert.equal(grouped.callTotal, 221);
    assert.equal(grouped.requestGroups[4].calls.length, 0, "the page budget is spent before the last group");
    assert.equal(grouped.requestGroups[4].noMatchingCalls, false, "a budget-starved group still has recorded calls");
    assert.equal(grouped.requestGroups[4].continuation.remaining, 1);
    assert.equal(grouped.requestGroups[2].calls.length, 50);
    assert.equal(grouped.requestGroups[2].continuation.remaining, 5);
    assert.equal(grouped.requestGroups.reduce((total, group) => total + group.calls.length, 0), 200);
    assert.deepEqual(grouped.requestGroups[0].calls.map((call) => call.id),
      Array.from({ length: 50 }, (_, call) => `read-1-${String(call).padStart(3, "0")}`),
      "calls inside a request group retain chronological Activity order");
    const flatLatest = await store.read(sessionId, { kind: "activity", offset: "latest" });
    assert.ok(flatLatest.items.some((item) => item.id === "unresolved-read"), "legacy flat rows retain unresolved calls");

    const continued = await store.read(sessionId, { kind: "activity", selected: "4", continuation: grouped.requestGroups[2].continuation.cursor });
    const selected = continued.requestGroups.find((group) => group.request.number === 4);
    assert.equal(selected.calls.length, 5);
    assert.equal(selected.continuation, null);
    assert.equal(selected.noMatchingCalls, false);

    const emptySessionId = "codex:grouped-history-empty";
    await store.publish(emptySessionId, { requests: [requests[0]], activity: [], complete: true });
    const [empty] = (await store.read(emptySessionId, { kind: "activity" })).requestGroups;
    assert.deepEqual([empty.calls, empty.noMatchingCalls, empty.continuation], [[], true, null], "a header without recorded calls stays explicit");
  });
}

test("continuation prioritizes its request before the shared call-page budget", async () => {
  const store = new SessionHistoryStore();
  const requests = Array.from({ length: 5 }, (_, index) => request(`f${String(index).padStart(15, "0")}`, `2026-09-11T05:00:0${index}Z`));
  const calls = requests.flatMap((item, index) => Array.from({ length: index === 4 ? 55 : 50 }, (_, call) =>
    activity(`budget-${index}-${call}`, `2026-09-11T05:${String(call).padStart(2, "0")}:30Z`, item.id)));
  await store.publish("codex:continuation-budget", { requests, activity: calls, complete: true });
  const first = await store.read("codex:continuation-budget", { kind: "activity", from: "1", to: "5", selected: "5" });
  const target = first.requestGroups.find((group) => group.request.number === 5);
  assert.equal(target.calls.length, 0);
  assert.equal(target.continuation.remaining, 55);
  const second = await store.read("codex:continuation-budget", { kind: "activity", from: "1", to: "5", selected: "5", continuation: target.continuation.cursor });
  const continued = second.requestGroups.find((group) => group.request.number === 5);
  assert.equal(continued.calls.length, 50);
  assert.equal(continued.continuation.remaining, 5);
  const third = await store.read("codex:continuation-budget", { kind: "activity", from: "1", to: "5", selected: "5", continuation: continued.continuation.cursor });
  assert.equal(third.requestGroups.find((group) => group.request.number === 5).calls.length, 5);
  assert.equal(third.requestGroups.find((group) => group.request.number === 5).continuation, null);
});

test("history revisions replay bounded per-session events without a synthetic global event", async () => {
  const store = new SessionHistoryStore();
  await store.publish("codex:events-one", { requests: [request("eeeeeeeeeeeeeeee", "2026-09-11T04:00:00Z")], activity: [], complete: true });
  await store.publish("codex:events-two", { requests: [request("ffffffffffffffff", "2026-09-11T04:01:00Z")], activity: [], complete: true });
  const events = [];
  const unsubscribe = store.subscribeRevisionEvents((event) => events.push(event));
  unsubscribe();
  assert.deepEqual(events.map((event) => ({ domain: event.domain, sessionId: event.sessionId, revision: event.revision, total: event.total })), [
    { domain: "history", sessionId: "codex:events-one", revision: 1, total: 1 },
    { domain: "history", sessionId: "codex:events-two", revision: 1, total: 1 },
  ]);
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
    assert.deepEqual(revisions.map((event) => event.domain), ["history", "history", "history", "history"]);
    assert.deepEqual(revisions.map((event) => event.revision), [1, 2, 3, 4]);
    assert.deepEqual(revisions.map((event) => event.sessionId), Array(4).fill(sessionId));
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
  assert.deepEqual(revisions, [1]);
  await store.publishActivityContribution(sessionId, { epoch: 1, sequence: 4, activity: [activity("call-three", "2026-09-10T03:00:02Z", null)] });
  assert.deepEqual(revisions, [1], "a source watermark alone does not churn the public revision");
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
  assert.deepEqual(revisions, [1, 2]);
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

test("unchanged publication replaces a v2 activity index before grouped reads", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-v2-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = "codex:v2-activity-index";
  const item = request("abababababababab", "2026-09-06T01:00:00Z");
  const call = { ...activity("v2-call", "2026-09-06T01:00:01Z", item.id), workKind: "shell", durationMs: 25 };
  const store = new SessionHistoryStore({ directory });
  await store.publish(sessionId, { requests: [item], activity: [call], complete: true });
  const indexPath = path.join(directory, (await readdir(directory)).find((file) => file.endsWith(".index.json")));
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.version = 2;
  delete index.activity[0].workKind;
  delete index.activity[0].durationMs;
  delete index.activity[0].status;
  await writeFile(indexPath, JSON.stringify(index), "utf8");

  assert.equal((await new SessionHistoryStore({ directory }).read(sessionId, { kind: "activity" })).status, "unavailable");
  const migrated = await store.publish(sessionId, { requests: [item], activity: [call], complete: true });
  assert.equal(migrated.revision, 2);
  const grouped = await new SessionHistoryStore({ directory }).read(sessionId, { kind: "activity" });
  assert.equal(grouped.status, "ready");
  assert.equal(grouped.requestGroups[0].calls[0].id, "v2-call");
  assert.deepEqual(grouped.byKind, [{ kind: "shell", count: 1, medianDurationMs: 25 }]);
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
    if (typeof source === "string" && source.includes('"version":3') && source.includes('"sessionId"')) count += 1;
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

test("retains each request's bounded recorded model and serves unsafe or legacy values as unreported", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-model-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  const recorded = { ...request("2222222222222221", "2026-09-04T00:00:00Z"), model: " claude-opus-5 " };
  const switched = { ...request("2222222222222222", "2026-09-04T00:01:00Z"), model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" };
  const pathLike = { ...request("2222222222222223", "2026-09-04T00:02:00Z"), model: String.raw`C:\Users\PRIVATE_USER\model` };
  const driveRelative = { ...request("2222222222222226", "2026-09-04T00:05:00Z"), model: "C:PRIVATE_USER" };
  const markup = { ...request("2222222222222224", "2026-09-04T00:03:00Z"), model: "<synthetic>" };
  const legacy = request("2222222222222225", "2026-09-04T00:04:00Z");
  await store.publish("claude:models", { requests: [recorded, switched, pathLike, markup, legacy, driveRelative], activity: [], complete: true });

  const expected = ["claude-opus-5", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", null, null, null, null];
  for (const reader of [store, new SessionHistoryStore({ directory })]) {
    const page = await reader.read("claude:models", { kind: "requests" });
    assert.deepEqual(page.items.map((item) => item.model), expected);
    const groups = await reader.read("claude:models", { kind: "activity" });
    // Grouped Activity serves the latest five request headers.
    assert.deepEqual(groups.requestGroups.map((group) => group.request.model), expected.slice(-5));
  }
  for (const name of await readdir(directory, { recursive: true })) {
    if (name.endsWith(".json")) assert.doesNotMatch(await readFile(path.join(directory, name), "utf8"), /PRIVATE_USER|synthetic/);
  }
});

function paddedRequest(hex, observedAt) {
  return { id: `request-${hex.padStart(16, "0")}`, agentId: "primary", observedAt, cacheLifetime: null,
    uncachedInputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, totalTokens: 10,
    precedingWork: [], issuedWork: [], model: null };
}

test("maintenance is bounded, preserves the current and prior complete history generations, and never runs on read", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-maintenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  for (let number = 1; number <= 4; number += 1) {
    await store.publish("codex:incremental", { complete: true, requests: [paddedRequest(String(number), `2026-09-11T00:0${number}:00Z`)], activity: [] });
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
  assert.equal((await store.maintenanceStep({ budget: 1 })).scanned, 0, "stop is idempotent");
});

test("maintenance leaves malformed and incomplete publication directories for conservative recovery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-conservative-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionHistoryStore({ directory });
  await store.publish("codex:conservative", { complete: true, requests: [paddedRequest("1", "2026-09-11T01:00:00Z")], activity: [] });
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
function numbered(number) { return paddedRequest(number.toString(16), new Date(1_800_000_000_000 + number * 1000).toISOString()); }
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

test("a newer disjoint suffix cannot overtake a failed predecessor", async () => {
  const jobs = [];
  const accepted = [];
  let calls = 0;
  const owner = createHistoryContributionPublisher({ isActive: () => true,
    schedule: (task) => { jobs.push(task); return task; }, cancel() {},
    store: { async publishRequestContribution(_id, contribution) {
      calls += 1;
      if (calls === 1) throw new Error("synthetic storage interruption");
      accepted.push(contribution); return {};
    } },
  });
  await owner.publish("requests", "codex:synthetic", { epoch: 1, sequence: 1, requests: [{ id: "one" }], activity: [{ id: "call-one" }] });
  await owner.publish("requests", "codex:synthetic", { epoch: 1, sequence: 2, requests: [{ id: "two" }], activity: [{ id: "call-two" }] });
  assert.equal(calls, 1);
  assert.equal(jobs.length, 1);
  jobs.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(accepted[0].requests.map((item) => item.id), ["one", "two"]);
  assert.deepEqual(accepted[0].activity.map((item) => item.id), ["call-one", "call-two"]);
  assert.equal(accepted[0].sequence, 2);
  assert.equal(owner.busy(), false);
  owner.stop();
});

test("shutdown fences in-flight failures from scheduling retries in a later lifetime", async () => {
  let reject;
  const jobs = [];
  const owner = createHistoryContributionPublisher({ isActive: () => true,
    schedule: (task) => { jobs.push(task); return task; },
    store: { publishActivityContribution() { return new Promise((_resolve, fail) => { reject = fail; }); } },
  });
  const work = owner.publish("activity", "codex:synthetic", { epoch: 1, sequence: 1, activity: [] });
  await Promise.resolve(); owner.stop(); reject(new Error("synthetic")); await work;
  assert.equal(jobs.length, 0);
});

const mixedRows = (requestId, marked) => [
  { ...activity("call-shell", "2026-09-12T01:00:01Z", requestId), tool: "Bash", workKind: "shell", status: "failed", durationMs: 30 },
  { ...activity("call-read", "2026-09-12T01:00:02Z", requestId), tool: "Read", workKind: "read", durationMs: 10 },
  { ...activity("row-input", "2026-09-12T01:00:00Z", requestId), tool: "User input", workKind: "input" },
  { ...activity("row-reply", "2026-09-12T01:00:03Z", requestId), tool: "Assistant replied", workKind: "report", detail: "" },
  { ...activity("row-notice", "2026-09-12T01:00:04Z", requestId), tool: "Task completed", workKind: "agent" },
  { ...activity("row-shell-failed", "2026-09-12T01:00:05Z", requestId), tool: "Shell failed", workKind: "shell", status: "failed" },
].map((row) => marked ? { ...row, call: row.id.startsWith("call-") } : row);
function assertToolCallAggregates(page) {
  assert.deepEqual(page.byKind, [{ kind: "shell", count: 1, medianDurationMs: 30 }, { kind: "read", count: 1, medianDurationMs: 10 }]);
  assert.deepEqual(page.shellTasks, { total: 1, failed: 1 });
  assert.equal(page.requestGroups[0].calls.length, 6, "request groups still list every recorded row");
  for (const row of [...page.items, ...page.requestGroups[0].calls]) assert.equal(Object.hasOwn(row, "call"), false, "the marker stays monitor-private");
}

for (const [label, disk, marked] of [["memory, marked", false, true], ["disk index, marked", true, true], ["memory, legacy labels", false, false], ["disk index, legacy labels", true, false]]) {
  test(`activity aggregates count tool calls only (${label})`, async (t) => {
    const directory = disk ? await mkdtemp(path.join(os.tmpdir(), "pomegr-history-calls-")) : null;
    if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
    const item = request("cdcdcdcdcdcdcdcd", "2026-09-12T01:00:00Z");
    const store = new SessionHistoryStore({ directory });
    await store.publish("claude:tool-calls", { requests: [item], activity: mixedRows(item.id, marked), complete: true });
    const reader = disk ? new SessionHistoryStore({ directory }) : store;
    assertToolCallAggregates(await reader.read("claude:tool-calls", { kind: "activity" }));
  });
}

test("a block-store ref committed before the tool-call marker is classified by its row label", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-calls-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const item = request("efefefefefefefef", "2026-09-12T01:00:00Z");
  const store = new SessionHistoryStore({ directory });
  await store.publishRequestContribution("claude:legacy-refs", { epoch: 1, sequence: 1, requests: [item], activity: mixedRows(item.id, true) });
  assertToolCallAggregates(await store.read("claude:legacy-refs", { kind: "activity" }));
  const db = new DatabaseSync(path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".history.sqlite"))));
  db.exec("UPDATE rows SET ref=json_remove(ref,'$.call'), data=json_remove(data,'$.call') WHERE kind='activity'");
  db.close();
  assertToolCallAggregates(await new SessionHistoryStore({ directory }).read("claude:legacy-refs", { kind: "activity" }));
});
