// A paired device reads the thread of a repository and searches it through the gateway: the real LAN gateway in front of the real
// chat controller, over a fake monitor. Authorization is the gateway's; the shape of each request is the chat's own.

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import { agentMessage, chatHarness, repositoryId, seed, userMessage } from "./helpers/agent-chat-harness.mjs";

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

test("a paired device reads the thread and searches it through the gateway, under the rules of every chat request", async (context) => {
  const h = await chatHarness(context);
  const stamp = (minute) => new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();
  await seed(h, { messages: [{ ...userMessage(1, "Plan the Deploy"), at: stamp(1) }, agentMessage(2, { text: "Here is the deploy plan.", at: stamp(2) })] });
  await seed(h, { messages: [{ ...userMessage(1, "And the rollback"), at: stamp(3) }, agentMessage(2, { text: "Roll back with the button.", at: stamp(4) })] });
  const handed = [];
  const observed = [];
  const upstream = http.createServer((request, response) => { observed.push(request.url); response.end("{}"); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
    agentChat: (...args) => { handed.push(args); return h.chat.handle(args[0], args[1], { paired: true }); },
  });
  try {
    const cookie = await pair(gateway);
    const headers = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" };
    const post = (operation, payload, requestHeaders = headers) => fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ operation, payload }) });

    // No pairing cookie, a cookie Pomegr never issued, or another origin: refused before the chat is called.
    for (const [operation, payload] of [["thread", { repositoryId }], ["search", { repositoryId, query: "deploy" }]]) {
      assert.equal((await post(operation, payload, { Origin: gateway.origin, "Content-Type": "application/json" })).status, 401);
      assert.equal((await post(operation, payload, { ...headers, Cookie: `${cookie.split("=")[0]}=forged` })).status, 401);
      assert.equal((await post(operation, payload, { ...headers, Origin: "http://127.0.0.1:1" })).status, 403);
    }
    assert.deepEqual(handed, []);

    const page = await (await post("thread", { repositoryId, limit: 2 })).json();
    assert.equal(page.ok, true);
    assert.deepEqual(page.messages.map((message) => message.text), ["And the rollback", "Roll back with the button."]);
    assert.deepEqual(page.messages.map((message) => message.conversationId.length), [17, 17]);
    const older = await (await post("thread", { repositoryId, before: page.before })).json();
    assert.deepEqual(older.messages.map((message) => message.text), ["Plan the Deploy", "Here is the deploy plan."]);
    assert.equal(older.before, null);
    assert.deepEqual(handed.map(([operation]) => operation), ["thread", "thread"]);
    assert.equal(handed[0].length, 2, "an operation and a payload: a paired device has no window event");

    const found = await (await post("search", { repositoryId, query: "DEPLOY" })).json();
    assert.deepEqual(found.matches.map((match) => match.snippet), ["Here is the deploy plan.", "Plan the Deploy"]);
    assert.deepEqual(handed.at(-1), ["search", { repositoryId, query: "DEPLOY" }]);

    // The shape rules are the chat's own, on a paired device too.
    assert.deepEqual(await (await post("thread", { repositoryId, limit: 61 })).json(), { ok: false, error: "invalid" });
    assert.deepEqual(await (await post("thread", { repositoryId, before: "forged" })).json(), { ok: false, error: "invalid" });
    assert.deepEqual(await (await post("search", { repositoryId, query: "a\u0000b" })).json(), { ok: false, error: "invalid" });
    assert.deepEqual(await (await post("search", { repositoryId, query: "x".repeat(101) })).json(), { ok: false, error: "invalid" });
    assert.deepEqual(await (await post("search", { repositoryId, query: "a", extra: 1 })).json(), { ok: false, error: "invalid" });
    // The request bound of every chat request holds.
    assert.equal((await post("search", { repositoryId, query: "a", pad: "x".repeat(17 * 1024) })).status, 403);
    assert.equal(h.calls.length, 0, "the monitor was never asked");

    gateway.revoke();
    const revoked = await post("thread", { repositoryId }).then((response) => response.status, () => "closed");
    assert.ok(revoked === 401 || revoked === "closed", String(revoked));
    assert.deepEqual(observed, [], "nothing is forwarded to the web host");
  } finally {
    await gateway.close();
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  }
});
