// A paired device applies a queue proposal of the agent chat: the real LAN gateway in front of the real chat
// controller, over a fake monitor. Authorization is the gateway's; the queue action is the chat's one request.

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import { chatHarness, pendingProposal, repositoryId, seed, withProposal } from "./helpers/agent-chat-harness.mjs";

const AUTHORIZATION = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const loopbackTestNetwork = Object.freeze({
  isBindHostAllowed: (host, mask) => host === "127.0.0.1" && mask === "255.255.255.0",
  isClientAddressAllowed: (address) => address === "127.0.0.1",
});

async function pair(gateway) {
  const secret = new URL(gateway.createPairing().url).hash.slice(1);
  const response = await fetch(`${gateway.origin}/__pomegr/pair`, {
    method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret }),
  });
  assert.equal(response.status, 204);
  return response.headers.get("set-cookie").split(";")[0];
}

test("a paired device applies a queue proposal through the gateway, and an unauthorized request never reaches the chat", async (context) => {
  const h = await chatHarness(context);
  h.state.actions = (_action, payload) => ({ ok: true, board: { queue: { status: payload.on ? "running" : "idle" } } });
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ summary: "Turn the queue on", operations: [{ op: "set_queue", on: true }] })) });
  const handed = [];
  const observed = [];
  const upstream = http.createServer((request, response) => { observed.push(request.url); response.end("{}"); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
    // The wiring of `shell-main.mjs`: the operation and the payload, and no origin.
    agentChat: (...args) => { handed.push(args); return h.chat.handle(args[0], args[1]); },
  });
  try {
    const cookie = await pair(gateway);
    const headers = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" };
    const body = JSON.stringify({ operation: "apply", payload: { repositoryId, conversationId: conversation.id, proposalId: "p-0123456789ab" } });
    const post = (requestHeaders) => fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers: requestHeaders, body });

    // No pairing cookie, a cookie Pomegr never issued, or another origin: refused before the chat is called.
    assert.equal((await post({ Origin: gateway.origin, "Content-Type": "application/json" })).status, 401);
    assert.equal((await post({ ...headers, Cookie: `${cookie.split("=")[0]}=forged` })).status, 401);
    assert.equal((await post({ ...headers, Origin: "http://127.0.0.1:1" })).status, 403);
    assert.deepEqual(handed, []);
    assert.deepEqual(h.actionCalls(), [], "no queue action was sent");

    const applied = await post(headers);
    assert.equal(applied.status, 200);
    assert.deepEqual(await applied.json(), { ok: true });
    assert.equal(handed.length, 1);
    assert.equal(handed[0].length, 2, "an operation and a payload: a paired device has no window event");
    assert.deepEqual(h.actionCalls().map((call) => [call.pathname, call.body]), [["/internal/tasks/queue_settings", { repositoryId, payload: { on: true } }]]);
    assert.deepEqual((await h.reload().read(repositoryId, conversation.id)).messages[1].proposal.results, [{ ok: true, queue: "on" }]);
    assert.deepEqual(await (await post(headers)).json(), { ok: false, error: "conflict" }, "a repeated Apply sends nothing more");
    assert.equal(h.actionCalls().length, 1);

    gateway.revoke();
    const revoked = await post(headers).then((response) => response.status, () => "closed");
    assert.ok(revoked === 401 || revoked === "closed", String(revoked));
    assert.equal(handed.length, 2, "a revoked device reaches nothing");
    assert.deepEqual(observed, [], "nothing is forwarded to the web host");
  } finally {
    await gateway.close();
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  }
});
