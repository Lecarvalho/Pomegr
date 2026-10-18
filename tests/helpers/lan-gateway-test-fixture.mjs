import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { startLanGateway } from "../../desktop/runtime/lan-gateway.mjs";

const AUTHORIZATION = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const NETWORK = Object.freeze({
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

export async function startLanGatewayTestFixture(arilPilot) {
  const observed = [];
  const upstream = http.createServer((request, response) => { observed.push(request.url); response.end("{}"); });
  const upstreamOrigin = await listen(upstream);
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true,
    networkPolicy: NETWORK, arilPilot,
  });
  return { gateway, upstream, observed, async close() { await gateway.close(); await close(upstream); } };
}

export async function pairLanGatewayTestFixture(gateway) {
  const pairingUrl = new URL(gateway.createPairing().url);
  const response = await fetch(`${gateway.origin}/__pomegr/pair`, {
    method: "POST",
    headers: { Origin: gateway.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ secret: pairingUrl.hash.slice(1) }),
  });
  assert.equal(response.status, 204);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

export function rawGatewayRequest(origin, { path, headers, body }) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path, method: "POST", headers, agent: false }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end(body);
  });
}
