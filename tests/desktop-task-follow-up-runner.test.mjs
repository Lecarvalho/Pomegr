import assert from "node:assert/strict";
import test from "node:test";
import { createTaskQueueRunner } from "../desktop/runtime/task-queue-runner.mjs";

// The runner's follow-up step (T-183): each settled burst is written to the chat once, then acknowledged.
const origin = "http://127.0.0.1:4317";
const repoA = "repo-0123456789abcdef01234567";
const repoB = "repo-fedcba987654321001234567";
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const batch = (repositoryId, overrides = {}) => ({ repositoryId, grant: 2, through: 40, followUps: true,
  items: [{ kind: "grant_merge", task: "T-5", provider: null }], more: 0, ended: null, ...overrides });

function harness({ batches, grantFollowUp }) {
  let timer = null;
  const calls = [];
  const written = [];
  const runner = createTaskQueueRunner({
    starter: { startQueued: async () => ({ status: "started" }) },
    monitorOrigin: origin, authorizationToken: "secret",
    setTimeout: (callback) => { timer = callback; return { unref() {} }; }, clearTimeout: () => {},
    fetch: async (url, options) => {
      const route = url.split("/").pop();
      calls.push({ route, body: JSON.parse(options.body) });
      if (route === "grant-follow-ups") return json({ ok: true, batches: typeof batches === "function" ? batches() : batches });
      if (route === "grant-follow-up-ack") return json({ ok: true });
      return json({ ok: true, starts: [] });
    },
    ...(grantFollowUp === false ? {} : { grantFollowUp: async (value) => { written.push(value); return grantFollowUp ? grantFollowUp(value) : { ok: true, conversationId: "chat-0123456789ab", messageId: `m-${written.length}` }; } }),
  });
  runner.start();
  return { calls, written, acks: () => calls.filter((call) => call.route === "grant-follow-up-ack").map((call) => call.body), tick: () => timer() };
}

test("each settled burst becomes one chat message and one ack that names it", async () => {
  const h = harness({ batches: [batch(repoA), batch(repoB, { grant: 7, through: 3, ended: "expired", items: [] })] });
  await h.tick();
  assert.deepEqual(h.written, [
    { repositoryId: repoA, grant: 2, items: batch(repoA).items, more: 0, ended: null },
    { repositoryId: repoB, grant: 7, items: [], more: 0, ended: "expired" },
  ]);
  assert.deepEqual(h.acks(), [
    { repositoryId: repoA, grant: 2, through: 40, ended: null, message: { conversationId: "chat-0123456789ab", messageId: "m-1" } },
    { repositoryId: repoB, grant: 7, through: 3, ended: "expired", message: { conversationId: "chat-0123456789ab", messageId: "m-2" } },
  ]);
});

test("with follow-ups off nothing is written and the burst is settled with no message", async () => {
  const h = harness({ batches: [batch(repoA, { followUps: false })] });
  await h.tick();
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.acks(), [{ repositoryId: repoA, grant: 2, through: 40, ended: null, message: null }]);
});

test("a busy conversation is asked again on the next tick; a failed write still settles the burst", async () => {
  let busy = true;
  const h = harness({ batches: [batch(repoA)], grantFollowUp: () => busy ? { ok: false, error: "busy" } : { ok: false, error: "limit" } });
  await h.tick();
  assert.deepEqual(h.acks(), []);
  busy = false;
  await h.tick();
  assert.equal(h.written.length, 2);
  assert.deepEqual(h.acks(), [{ repositoryId: repoA, grant: 2, through: 40, ended: null, message: null }]);
});

test("batches outside the contract are dropped, and a runner without a chat writer asks for none", async () => {
  const h = harness({ batches: [batch("repo-x"), batch(repoA, { ended: "crashed" }), batch(repoA, { grant: "2" }), batch(repoA, { through: -1 })] });
  await h.tick();
  assert.deepEqual([h.written, h.acks()], [[], []]);
  const none = harness({ batches: [batch(repoA)], grantFollowUp: false });
  await none.tick();
  assert.equal(none.calls.some((call) => call.route.startsWith("grant-follow-up")), false);
});
