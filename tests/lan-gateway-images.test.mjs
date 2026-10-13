import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";

const AUTHORIZATION = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CHAT_REPOSITORY = "repo-0123456789abcdef01234567";
const loopbackTestNetwork = Object.freeze({
  isBindHostAllowed: (host, mask) => host === "127.0.0.1" && mask === "255.255.255.0",
  isClientAddressAllowed: (address) => address === "127.0.0.1",
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

async function pair(gateway) {
  const pairingUrl = new URL(gateway.createPairing().url);
  const response = await fetch(`${gateway.origin}/__pomegr/pair`, {
    method: "POST",
    headers: { Origin: gateway.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ secret: pairingUrl.hash.slice(1) }),
  });
  assert.equal(response.status, 204);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("LAN gateway answers paired task images itself within strict bounds", async () => {
  const received = [];
  const observed = [];
  const upstream = http.createServer((request, response) => { observed.push(request.url); response.end("{}"); });
  const upstreamOrigin = await listen(upstream);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
    taskImage: async (repositoryId, operation, payload) => {
      received.push([repositoryId, operation, payload.taskId, payload.imageId, payload.bytes ? [...payload.bytes] : null]);
      if (payload.taskId === "T-9") return { ok: false, error: "limit", detail: "C:\secret" };
      return operation === "read" ? { ok: true, type: "png", bytes: PNG } : { ok: true, imageId: payload.imageId, path: "C:\secret" };
    },
  });
  try {
    const cookie = await pair(gateway);
    const query = (taskId = "T-3", extra = "") => `?repositoryId=${CHAT_REPOSITORY}&taskId=${taskId}&imageId=img-0123456789ab${extra}`;
    const addHeaders = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/octet-stream" };
    const add = (path, options = {}) => fetch(`${gateway.origin}/api/tasks/image-add${path}`, { method: "POST", headers: { ...addHeaders, ...options.headers }, body: options.body ?? PNG });

    const added = await add(query());
    assert.equal(added.status, 200);
    assert.deepEqual(await added.json(), { ok: true, imageId: "img-0123456789ab" });
    assert.deepEqual(received[0], [CHAT_REPOSITORY, "add", "T-3", "img-0123456789ab", [...PNG]]);
    assert.deepEqual(await (await add(query("T-9"))).json(), { ok: false, error: "limit" });

    const read = await fetch(`${gateway.origin}/api/tasks/image-read${query()}`, { headers: { Cookie: cookie } });
    assert.equal(read.headers.get("content-type"), "image/png");
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.deepEqual([...new Uint8Array(await read.arrayBuffer())], [...PNG]);

    const remove = await fetch(`${gateway.origin}/api/tasks/image-remove`, {
      method: "POST", headers: { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryId: CHAT_REPOSITORY, taskId: "T-3", imageId: "img-0123456789ab" }),
    });
    assert.deepEqual(await remove.json(), { ok: true });
    assert.equal(received.at(-1)[1], "remove");
    received.length = 0;

    assert.equal((await fetch(`${gateway.origin}/api/tasks/image-add${query()}`, { method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/octet-stream" }, body: PNG })).status, 401);
    assert.equal((await add(query(), { headers: { Origin: "http://127.0.0.1:1" } })).status, 403);
    assert.equal((await add(query(), { headers: { "Content-Type": "image/png" } })).status, 403);
    assert.equal((await add(query(), { body: new Uint8Array(5 * 1024 * 1024 + 1) })).status, 403);
    for (const bad of ["", "?repositoryId=repo-bad&taskId=T-3&imageId=img-0123456789ab", query("T-0"), query("T-3", "&x=1"), `?repositoryId=${CHAT_REPOSITORY}&taskId=T-3&imageId=../x`]) {
      assert.deepEqual(await (await add(bad)).json(), { ok: false, error: "invalid" }, bad);
    }
    assert.deepEqual(await (await add(query(), { body: new Uint8Array(0) })).json(), { ok: false, error: "invalid" });
    assert.equal((await fetch(`${gateway.origin}/api/tasks/image-read${query()}`)).status, 401);
    assert.deepEqual(received, []);
    assert.deepEqual(observed, [], "the web host never sees a task image");
  } finally { await gateway.close(); await close(upstream); }
});
