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
  const activityPage = await store.read("claude:example", { kind: "activity", requestId: requests[10].id, limit: "8" });
  assert.ok(activityPage.items.some((item) => item.requestId === requests[10].id));
  assert.equal(activityPage.linkedCount, 1);
});

test("retains all complete rows, rejects unsafe nested work, and preserves last good record on incomplete updates", async () => {
  const store = new SessionHistoryStore();
  const requests = Array.from({ length: 250 }, (_, index) => request(index.toString(16).padStart(16, "0"), `2026-09-02T00:${String(index % 60).padStart(2, "0")}:00Z`));
  const first = await store.publish("codex:large", { requests, activity: [], complete: true });
  assert.equal((await store.read("codex:large", { kind: "requests", limit: "60" })).total, 250);
  assert.equal((await store.publish("codex:large", { requests: [], activity: [], complete: false })).revision, first.revision);
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
