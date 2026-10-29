// A paired device asks for a warm run through the gateway: the real LAN gateway in front of the real chat controller, over a fake
// monitor and a fake provider process. The gateway forwards every chat operation to the chat, which judges it; `warm` needs no allowlist
// entry because the chat's own fixed operations are the list, and it carries no text and calls no model.

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import test from "node:test";

import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import { chatHarness, repositoryId } from "./helpers/agent-chat-harness.mjs";

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

test("a paired device warms a run through the gateway under the rules of every chat request, and an unauthorized request never reaches the chat", async (context) => {
  const spawns = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = Object.assign(new EventEmitter(), { write: () => true, end() {} });
    child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    spawns.push(child);
    return child;
  };
  const h = await chatHarness(context, { runTurn: undefined, spawn });
  const handed = [];
  const upstream = http.createServer((request, response) => response.end("{}"));
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
    const post = (payload, requestHeaders = headers) => fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ operation: "warm", payload }) });
    const run = { repositoryId, provider: "claude", model: null, effort: null };

    assert.equal((await post(run, { Origin: gateway.origin, "Content-Type": "application/json" })).status, 401);
    assert.equal((await post(run, { ...headers, Cookie: `${cookie.split("=")[0]}=forged` })).status, 401);
    assert.equal((await post(run, { ...headers, Origin: "http://127.0.0.1:1" })).status, 403);
    assert.deepEqual(handed, []);
    assert.equal(spawns.length, 0);

    const warmed = await post(run);
    assert.equal(warmed.status, 200);
    assert.deepEqual(await warmed.json(), { ok: true });
    assert.equal(handed.length, 1);
    assert.equal(handed[0].length, 2, "an operation and a payload: a paired device has no window event");
    assert.equal(spawns.length, 1, "the run waits on the desktop");
    // The shape rules are the chat's own, on a paired device too.
    assert.deepEqual(await (await post({ repositoryId, text: "a message" })).json(), { ok: false, error: "invalid" });
    assert.deepEqual(await (await post({ ...run, provider: "gemini" })).json(), { ok: false, error: "invalid" });
    assert.equal(spawns.length, 1);
    assert.deepEqual([...new Set(h.calls.map((call) => call.pathname))], ["/internal/tasks/worktree-root"], "only the repository's folder was asked: no board, log, or conversation was read");
  } finally {
    await gateway.close();
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  }
});
