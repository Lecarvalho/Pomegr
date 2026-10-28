import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { createNotificationObservation } from "../../../server/runtime/notification-observation.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { withDatabase } from "./queue-test-support.mjs";

// The grant follow-up routes (T-183): desktop main reads settled bursts and acknowledges each one; the ack commits one notification.
const REPOSITORY_ID = `repo-${"a".repeat(24)}`;
const TOKEN = "d".repeat(40);
const DESKTOP = { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json" };
const PAIRED = { ...DESKTOP, "x-pomegr-lan-gateway": "1" };
const MESSAGE = { conversationId: "chat-0123456789ab", messageId: "m-4" };

async function setup(t, { followUps = true } = {}) {
  const directory = await mkdtemp(path.join(process.cwd(), ".follow-up-route-test-"));
  const clock = { now: 1700000000000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  const accepted = [];
  const notifications = createNotificationObservation({ now: () => clock.now, sourceScope: "test" });
  const runtime = { acceptArilFollowUp: (value) => { accepted.push(value); return notifications.acceptArilFollowUp(value); } };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN, agentAuthorizationToken: "a".repeat(40) }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(store.apply(REPOSITORY_ID, "create", { text: "work" }).ok, true);
  assert.equal(store.apply(REPOSITORY_ID, "aril_settings_set", { settings: { followUps,
    actions: { start: true, review: false, sendBack: false, merge: false, writeTasks: false },
    limits: { hours: 1, tasks: 2, tasksAtATime: 1, sendBacks: null, usagePercent: 80 }, workRules: [{ kind: "text", value: "work" }] } }).ok, true);
  assert.equal(store.apply(REPOSITORY_ID, "grant_start", {}).ok, true);
  withDatabase(directory, (db) => db.prepare("INSERT INTO task_log(repository_id, number, kind, at) VALUES (?, 1, 'grant_merge_refused', ?)").run(REPOSITORY_ID, clock.now));
  clock.now += 60_000;
  return { port: server.address().port, accepted, notifications };
}

function post(port, route, body, headers = DESKTOP) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/internal/tasks/${route}`, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("a settled burst is read, acknowledged with its chat message, and commits one follow-up notification", async (t) => {
  const { port, accepted, notifications } = await setup(t);
  const answer = await post(port, "grant-follow-ups", {});
  assert.equal(answer.status, 200);
  const [batch] = answer.json.batches;
  assert.deepEqual(batch.items, [{ kind: "grant_merge_refused", task: "T-1", provider: null }]);
  assert.deepEqual(Object.keys(batch).sort(), ["ended", "followUps", "grant", "items", "more", "repositoryId", "through"]);
  const ack = { repositoryId: REPOSITORY_ID, grant: batch.grant, through: batch.through, ended: null, message: MESSAGE };
  assert.deepEqual((await post(port, "grant-follow-up-ack", ack)).json, { ok: true });
  assert.equal(accepted.length, 1);
  const [occurrence] = notifications.readSnapshot().occurrences;
  assert.deepEqual({ kind: occurrence.kind, category: occurrence.category, action: occurrence.action, provider: occurrence.provider, deliveryEligible: occurrence.deliveryEligible },
    { kind: "aril_follow_up", category: "aril", action: "open_aril_chat", provider: null, deliveryEligible: true });
  assert.deepEqual(occurrence.data, { repositoryId: REPOSITORY_ID, ...MESSAGE, items: batch.items, more: 0, ended: null });
  assert.deepEqual((await post(port, "grant-follow-ups", {})).json, { ok: true, batches: [] });
  assert.deepEqual((await post(port, "grant-follow-up-ack", ack)).json, { ok: true }, "a repeated ack is settled again");
  assert.equal(accepted.length, 1, "and commits no second notification");
  assert.equal(notifications.readSnapshot().occurrences.length, 1);
});

test("with follow-ups off the burst is acknowledged and no notification is committed", async (t) => {
  const { port, accepted } = await setup(t, { followUps: false });
  const [batch] = (await post(port, "grant-follow-ups", {})).json.batches;
  assert.equal(batch.followUps, false);
  assert.deepEqual((await post(port, "grant-follow-up-ack", { repositoryId: REPOSITORY_ID, grant: batch.grant, through: batch.through, ended: null, message: null })).json, { ok: true });
  assert.equal(accepted.length, 0);
});

test("the follow-up routes are desktop-main-only and exact", async (t) => {
  const { port, accepted } = await setup(t);
  for (const route of ["grant-follow-ups", "grant-follow-up-ack"]) assert.equal((await post(port, route, {}, PAIRED)).status, 403);
  assert.equal((await post(port, "grant-follow-ups", { extra: 1 })).status, 400);
  const [batch] = (await post(port, "grant-follow-ups", {})).json.batches;
  const ack = { repositoryId: REPOSITORY_ID, grant: batch.grant, through: batch.through, ended: null, message: MESSAGE };
  for (const invalid of [{ ...ack, message: { conversationId: "chat-x", messageId: "m-1" } }, { ...ack, message: { ...MESSAGE, text: "x" } },
    { ...ack, repositoryId: "repo-bad" }, { ...ack, extra: true }, { repositoryId: REPOSITORY_ID, payload: ack }]) {
    assert.deepEqual((await post(port, "grant-follow-up-ack", invalid)).json, { ok: false, error: "invalid" });
  }
  assert.equal(accepted.length, 0);
});
