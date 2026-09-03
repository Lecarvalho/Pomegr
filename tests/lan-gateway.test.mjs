import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { startLanGateway } from "../desktop/lan-gateway.mjs";

const AUTHORIZATION = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
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

function requestStatus(origin, { path = "/", headers = {} } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path, headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

async function pair(gateway) {
  const created = gateway.createPairing();
  const pairingUrl = new URL(created.url);
  assert.equal(pairingUrl.search, "");
  assert.match(pairingUrl.hash, /^#[A-Za-z0-9_-]{43}$/);
  const response = await fetch(`${gateway.origin}/__pomegr/pair`, {
    method: "POST",
    headers: { Origin: gateway.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ secret: pairingUrl.hash.slice(1) }),
  });
  assert.equal(response.status, 204);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie || "", /HttpOnly; SameSite=Strict; Path=\/$/);
  assert.equal(cookie?.includes("Secure"), false);
  return cookie.split(";", 1)[0];
}

test("LAN gateway pairs a same-subnet browser once and forwards only bounded read routes", async () => {
  const observed = [];
  const upstream = http.createServer((request, response) => {
    observed.push({ url: request.url, headers: request.headers });
    if (request.url === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Vary: "RSC" });
      response.write("data: ready\n\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json", Vary: "RSC", "Set-Cookie": "upstream=forbidden",
      "X-Pomegr-Revision": "42", "X-Accel-Buffering": "no", "X-Vinext-Rsc": "1",
      "Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "DENY",
    });
    response.end(JSON.stringify({ local: true }));
  });
  const upstreamOrigin = await listen(upstream);
  let changes = 0;
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true,
    networkPolicy: loopbackTestNetwork, onChange: () => { changes += 1; },
  });
  try {
    const pairingPage = await fetch(`${gateway.origin}/__pomegr/pair`);
    assert.equal(pairingPage.status, 200);
    const pairingMarkup = await pairingPage.text();
    assert.match(pairingMarkup, /Pair Pomegr/);
    const first = gateway.createPairing();
    const firstSecret = new URL(first.url).hash.slice(1);
    assert.doesNotMatch(pairingMarkup, new RegExp(firstSecret));
    assert.equal(await requestStatus(gateway.origin, { path: "/__pomegr/pair", headers: { Host: "localhost:1" } }), 400);
    assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: "http://127.0.0.1:1", "Content-Type": "application/json" }, body: JSON.stringify({ secret: firstSecret }),
    })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: `${firstSecret}x` }),
    })).status, 403);
    const redeemed = await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: firstSecret }),
    });
    assert.equal(redeemed.status, 204, "an incorrect attempt does not consume a live code");
    const cookie = redeemed.headers.get("set-cookie").split(";", 1)[0];

    assert.equal((await fetch(`${gateway.origin}/api/state`)).status, 401);
    const redirect = await fetch(gateway.origin, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/__pomegr/pair");

    assert.deepEqual(gateway.snapshot(), { pairedClients: 1 });
    assert.ok(changes >= 1);
    const access = await fetch(`${gateway.origin}/api/client-access`, { headers: { Cookie: cookie } });
    assert.deepEqual(await access.json(), { mode: "lan", canCopyTranscriptPath: false });
    assert.equal(access.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${gateway.origin}/api/state`, { headers: { Cookie: cookie, Origin: "http://127.0.0.1:1" } })).status, 403);

    await pair(gateway);
    await pair(gateway);
    await pair(gateway);
    assert.equal(gateway.snapshot().pairedClients, 4);
    const capacity = gateway.createPairing();
    const capacitySecret = new URL(capacity.url).hash.slice(1);
    for (let index = 0; index < 2; index += 1) {
      assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
        method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: capacitySecret }),
      })).status, 429, "capacity does not consume a valid pairing code");
    }

    const data = await fetch(`${gateway.origin}/api/state?revision=7`, {
      headers: { Cookie: cookie, RSC: "1", "Next-Url": "/?revision=7", "x-pomegr-desktop-authorization": "client-value" },
    });
    assert.equal(data.status, 200);
    assert.equal(data.headers.get("set-cookie"), null);
    assert.equal(data.headers.get("vary"), "RSC");
    assert.equal(data.headers.get("x-pomegr-revision"), "42");
    assert.equal(data.headers.get("x-accel-buffering"), "no");
    assert.equal(data.headers.get("x-vinext-rsc"), "1");
    assert.equal(data.headers.get("content-security-policy"), "default-src 'self'");
    assert.deepEqual(await data.json(), { local: true });
    const forwarded = observed.at(-1);
    assert.equal(forwarded.url, "/api/state?revision=7");
    assert.equal(forwarded.headers["x-pomegr-desktop-authorization"], AUTHORIZATION);
    assert.equal(forwarded.headers.cookie, undefined);
    assert.equal(forwarded.headers.rsc, "1");
    assert.equal(forwarded.headers["next-url"], "/?revision=7");

    const rsc = await fetch(`${gateway.origin}/settings.rsc?_rsc=test`, {
      headers: { Cookie: cookie, RSC: "1", "X-Vinext-Mounted-Slots": "main", "X-Vinext-Rsc-Render-Mode": "prefetch" },
    });
    assert.equal(rsc.status, 200);
    assert.equal(observed.at(-1).url, "/settings.rsc?_rsc=test");
    assert.equal(observed.at(-1).headers["x-vinext-mounted-slots"], "main");
    assert.equal((await fetch(`${gateway.origin}/api/transcript-path.rsc`, { headers: { Cookie: cookie } })).status, 404);

    const beforeDenied = observed.length;
    assert.equal((await fetch(`${gateway.origin}/api/transcript-path`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${gateway.origin}/api%2fstate`, { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(`${gateway.origin}/unknown`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal(observed.length, beforeDenied);

    const stream = await fetch(`${gateway.origin}/api/events`, { headers: { Cookie: cookie } });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
    gateway.revoke();
    const streamEnded = await Promise.race([
      reader.read().then((value) => value.done, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(streamEnded, true, "revocation closes active event streams");
    assert.equal(gateway.snapshot().pairedClients, 0);
    assert.equal((await fetch(`${gateway.origin}/api/state`, { headers: { Cookie: cookie } })).status, 403);
  } finally {
    await gateway.close();
    await close(upstream);
  }
  assert.deepEqual(await gateway.exit, { code: "LAN_GATEWAY_CLOSED" });
});

test("LAN gateway bounds idle client connections", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
  });
  const url = new URL(gateway.origin);
  const sockets = [];
  try {
    for (let index = 0; index < 16; index += 1) {
      const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
      sockets.push(socket);
      await once(socket, "connect");
    }
    const overflow = net.createConnection({ host: url.hostname, port: Number(url.port) });
    sockets.push(overflow);
    await once(overflow, "close");
    assert.equal(overflow.destroyed, true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway bounds pairing guesses without disclosing or consuming the code", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
  });
  try {
    const pairing = gateway.createPairing();
    const secret = new URL(pairing.url).hash.slice(1);
    for (let index = 0; index < 8; index += 1) {
      assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
        method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: `${secret}x` }),
      })).status, 403);
    }
    assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret }),
    })).status, 429);
    assert.deepEqual(gateway.snapshot(), { pairedClients: 0 });
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway bounds retained pairing attempt clients", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true,
    networkPolicy: { ...loopbackTestNetwork, pairingAttemptKey: (request) => request.headers["x-test-client"] },
  });
  try {
    const pairing = gateway.createPairing();
    const secret = new URL(pairing.url).hash.slice(1);
    for (let index = 0; index < 128; index += 1) {
      assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
        method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json", "X-Test-Client": `client_${index}` }, body: JSON.stringify({ secret: `${secret}x` }),
      })).status, 403);
    }
    assert.equal((await fetch(`${gateway.origin}/__pomegr/pair`, {
      method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json", "X-Test-Client": "client_129" }, body: JSON.stringify({ secret }),
    })).status, 429);
    assert.deepEqual(gateway.snapshot(), { pairedClients: 0 });
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("LAN gateway rejects malformed network inputs and closes access when identity changes", async () => {
  await assert.rejects(
    startLanGateway({ host: "8.8.8.8", subnetMask: "255.255.255.0", upstreamOrigin: "http://127.0.0.1:4317", authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true }),
    (error) => error.code === "LAN_GATEWAY_INVALID_NETWORK",
  );
  await assert.rejects(
    startLanGateway({ host: "192.168.1.2", subnetMask: "255.0.255.0", upstreamOrigin: "http://127.0.0.1:4317", authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true }),
    (error) => error.code === "LAN_GATEWAY_INVALID_NETWORK",
  );
  await assert.rejects(
    startLanGateway({ host: "192.168.1.2", subnetMask: "255.255.255.0", upstreamOrigin: "http://localhost:4317", authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true }),
    (error) => error.code === "LAN_GATEWAY_INVALID_UPSTREAM",
  );

  const upstream = http.createServer((request, response) => response.end("ok"));
  const upstreamOrigin = await listen(upstream);
  let allowed = true;
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => allowed, networkPolicy: loopbackTestNetwork,
  });
  try {
    const cookie = await pair(gateway);
    allowed = false;
    const response = await fetch(`${gateway.origin}/api/state`, { headers: { Cookie: cookie } }).then((value) => value.status, () => "closed");
    assert.ok(response === 403 || response === "closed");
    assert.equal(gateway.snapshot().pairedClients, 0);
  } finally {
    await gateway.close();
    await close(upstream);
  }
});
