import assert from "node:assert/strict";
import test from "node:test";

import { pairLanGatewayTestFixture, rawGatewayRequest, startLanGatewayTestFixture } from "./helpers/lan-gateway-test-fixture.mjs";

const REPOSITORY = "repo-0123456789abcdef01234567";

test("paired Aril pilot operations stay inside the authenticated gateway", async () => {
  const received = [];
  const fixture = await startLanGatewayTestFixture(async (operation, payload) => {
    received.push([operation, payload]);
    return { ok: true, pilot: { repositoryId: payload.repositoryId }, history: [] };
  });
  const { gateway, observed } = fixture;
  try {
    const cookie = await pairLanGatewayTestFixture(gateway);
    const headers = { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" };
    const payload = { repositoryId: REPOSITORY };
    const body = JSON.stringify({ operation: "read", payload });
    const response = await fetch(`${gateway.origin}/api/aril-pilot`, { method: "POST", headers, body });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true, pilot: { repositoryId: REPOSITORY }, history: [] });
    assert.deepEqual(received, [["read", payload]]);
    assert.deepEqual(observed, [], "pilot data is never forwarded to the web host");

    assert.equal((await fetch(`${gateway.origin}/api/aril-pilot`, { method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body })).status, 401);
    assert.equal((await fetch(`${gateway.origin}/api/aril-pilot`, { method: "POST", headers: { ...headers, Origin: "http://127.0.0.1:1" }, body })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/api/aril-pilot?x=1`, { method: "POST", headers, body })).status, 403);
    assert.equal((await fetch(`${gateway.origin}/api/aril-pilot`, { method: "POST", headers: { ...headers, "Content-Type": "application/jsonp" }, body })).status, 403);
    assert.equal(await rawGatewayRequest(gateway.origin, {
      path: "/api/aril-pilot", headers: { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json", "Transfer-Encoding": "chunked" }, body,
    }), 403);
    assert.equal((await fetch(`${gateway.origin}/api/aril-pilot`, { method: "POST", headers, body: JSON.stringify({ operation: "read", payload, extra: true }) })).status, 200);
    assert.deepEqual(received, [["read", payload]], "an envelope with extra keys is never dispatched");
    assert.deepEqual(observed, []);
  } finally { await fixture.close(); }
});

test("a pilot mutation cannot commit after paired access is revoked during review", async () => {
  let started;
  const begun = new Promise((resolve) => { started = resolve; });
  let release;
  const pendingReview = new Promise((resolve) => { release = resolve; });
  let committed = false;
  const fixture = await startLanGatewayTestFixture(async (_operation, _payload, isAuthorized) => {
    started();
    await pendingReview;
    if (!await isAuthorized()) return { ok: false, error: "conflict" };
    committed = true;
    return { ok: true };
  });
  const { gateway } = fixture;
  try {
    const cookie = await pairLanGatewayTestFixture(gateway);
    const request = fetch(`${gateway.origin}/api/aril-pilot`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "activate", payload: { repositoryId: REPOSITORY } }),
    }).catch(() => null);
    await begun;
    gateway.revoke();
    release();
    await request;
    assert.equal(committed, false);
  } finally { release(); await fixture.close(); }
});
