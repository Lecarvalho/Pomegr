import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import { createLanSharingController } from "../desktop/runtime/lan-sharing.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const log = { entries: [{ id: 1, task: "T-2", kind: "started", at: 123, pullRequest: null }], more: false, arilCursor: 0 };

async function harness(context, taskLog) {
  const forwarded = [];
  const upstream = http.createServer((request, response) => { forwarded.push(request.url); response.end("{}"); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    authorizationToken: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", isNetworkAllowed: async () => true,
    networkPolicy: { isBindHostAllowed: () => true, isClientAddressAllowed: (address) => address === "127.0.0.1" }, taskLog,
  });
  context.after(async () => { await gateway.close(); await new Promise((resolve) => upstream.close(resolve)); assert.deepEqual(forwarded, []); });
  const secret = new URL(gateway.createPairing().url).hash.slice(1);
  const paired = await fetch(`${gateway.origin}/__pomegr/pair`, { method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret }) });
  assert.equal(paired.status, 204);
  const headers = { Cookie: paired.headers.get("set-cookie").split(";")[0], Origin: gateway.origin, "Content-Type": "application/json" };
  const post = (body = JSON.stringify({ repositoryId }), overrides = {}, query = "") => fetch(`${gateway.origin}/api/tasks/log-read${query}`, { method: "POST", headers: { ...headers, ...overrides }, body });
  return { gateway, headers, post };
}

test("task log refuses unauthorized, non-POST, query, body and origin violations without reading or forwarding", async (context) => {
  const calls = [];
  const { gateway, headers, post } = await harness(context, (...args) => { calls.push(args); return { ok: true, log }; });
  assert.equal((await post(undefined, { Cookie: "" })).status, 401);
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) assert.equal((await fetch(`${gateway.origin}/api/tasks/log-read`, { method, headers })).status, 405);
  assert.equal((await post(undefined, {}, "?repositoryId=bad")).status, 403);
  assert.equal((await post(" ".repeat(257))).status, 403);
  assert.equal((await post(undefined, { "Content-Type": "text/plain" })).status, 403);
  assert.equal((await post(undefined, { Origin: "http://example.com" })).status, 403);
  assert.equal((await post(undefined, { Origin: "" })).status, 403);
  for (const body of ["{", "null", "[]", "{}", JSON.stringify({ repositoryId, after: 1 }), JSON.stringify({ repositoryId: "repo-bad" }), JSON.stringify({ repositoryId: 1 })]) {
    assert.equal((await post(body)).status, 400, body);
  }
  assert.deepEqual(calls, []);
});

test("task log calls desktop main once and passes its bounded answer through with no-store", async (context) => {
  const calls = [];
  const answer = { ok: true, log };
  const { post } = await harness(context, (...args) => { calls.push(args); return answer; });
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), answer);
  assert.deepEqual(calls, [[repositoryId]]);
});

test("task log returns fixed failures and contains missing or throwing readers", async (context) => {
  let answer = { ok: false, error: "invalid" };
  const { post } = await harness(context, () => { if (answer) return answer; throw new Error("private"); });
  assert.deepEqual(await (await post()).json(), answer);
  answer = null;
  assert.deepEqual(await (await post()).json(), { ok: false, error: "unavailable" });
  const absent = await harness(context);
  assert.deepEqual(await (await absent.post()).json(), { ok: false, error: "unavailable" });
});

test("the sharing controller passes the shared log reader to the gateway", async () => {
  const taskLog = async () => ({ ok: true, log });
  let received;
  const controller = createLanSharingController({
    networkReader: { read: async () => ({ status: "available", candidates: [{ id: "lan-home", address: "192.168.1.20", subnetMask: "255.255.255.0" }] }) },
    taskLog, schedule: () => null,
    startGateway: async (options) => { received = options.taskLog; return { origin: "http://192.168.1.20:1234", snapshot: () => ({ pairedClients: 0 }), revoke() {}, close() {} }; },
  });
  try { await controller.setSharing(true); assert.equal(received, taskLog); } finally { await controller.dispose(); }
});
