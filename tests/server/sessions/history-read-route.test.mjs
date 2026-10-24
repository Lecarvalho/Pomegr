import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { createMonitorRuntime } from "../../../server/server.mjs";
import { DESKTOP_AUTH_HEADER } from "../../../shared/local-auth.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const PAGE = {
  messages: [{ kind: "owner", at: null, text: "hello" }],
  cursor: null,
  older: null,
  reset: false,
  status: "ok",
};
const servers = new Set();

async function listen(runtime) {
  const server = http.createServer(createRequestHandler({ runtime, authorizationToken: TOKEN }));
  servers.add(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

async function post(base, body, headers = {}) {
  return fetch(`${base}/internal/sessions/history-read`, {
    method: "POST",
    headers: { "content-type": "application/json", [DESKTOP_AUTH_HEADER]: TOKEN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("history read is a desktop-only private POST and forwards bounded page arguments", async () => {
  const calls = [];
  const base = await listen({ async readSessionMessages(...args) { calls.push(args); return PAGE; } });

  const denied = await fetch(`${base}/internal/sessions/history-read`, { method: "POST", body: JSON.stringify({ sessionId: "claude:abc" }) });
  assert.equal(denied.status, 401);
  const get = await fetch(`${base}/internal/sessions/history-read`, { headers: { [DESKTOP_AUTH_HEADER]: TOKEN } });
  assert.equal(get.status, 401);
  const origin = await post(base, { sessionId: "claude:abc" }, { Origin: base });
  assert.equal(origin.status, 401);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/internal/sessions/history-read`, {
      method: "POST", headers: { Host: "wrong.invalid", [DESKTOP_AUTH_HEADER]: TOKEN },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end(JSON.stringify({ sessionId: "claude:abc" }));
  });
  assert.equal(hostStatus, 401);
  const response = await post(base, { sessionId: "claude:abc", cursor: { fingerprint: "f".repeat(64), offset: 4 }, limit: 25 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), PAGE);
  assert.deepEqual(calls, [["claude:abc", { cursor: { fingerprint: "f".repeat(64), offset: 4 }, limit: 25 }]]);
});

test("history read rejects malformed bodies and cursors", async () => {
  const base = await listen({ async readSessionMessages() { return PAGE; } });
  for (const body of ["{", {}, { sessionId: "bad" }, { sessionId: "claude:abc", cursor: { fingerprint: "f".repeat(64), offset: -1 } },
    { sessionId: "claude:abc", before: { fingerprint: "f".repeat(64), offset: 1.5 } },
    { sessionId: "claude:abc", cursor: { fingerprint: "f".repeat(64), offset: 1 }, before: { fingerprint: "f".repeat(64), offset: 2 } },
    { sessionId: "claude:abc", limit: 0 }, { sessionId: "claude:abc", limit: 201 }, { sessionId: "claude:abc", extra: true }]) {
    const response = await post(base, body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid" });
  }
});

test("history read defaults the limit, reports unknown sessions, and degrades unsupported adapters", async () => {
  const calls = [];
  const base = await listen({ async readSessionMessages(...args) { calls.push(args); return PAGE; } });
  const success = await post(base, { sessionId: "claude:abc" });
  assert.equal(success.status, 200);
  assert.deepEqual(calls[0][1], { limit: 100 });

  const unknown = await listen({ async readSessionMessages() { return null; } });
  const missing = await post(unknown, { sessionId: "claude:missing" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });

  const unsupported = await listen({ async readSessionMessages() { return undefined; } });
  const unavailable = await post(unsupported, { sessionId: "claude:abc" });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "unavailable" });
});

test("history read rejects an adapter page outside the shared schema", async () => {
  const base = await listen({ async readSessionMessages() { return { messages: [{ text: "raw" }] }; } });
  const response = await post(base, { sessionId: "claude:abc" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "unavailable" });
});

test("history read resolves known sessions without acquiring observation evidence", async () => {
  const calls = [];
  const adapter = { id: "claude", async readSessionMessages(...args) { calls.push(args); return { ...PAGE, status: "missing", messages: [] }; } };
  const runtime = createMonitorRuntime({
    providerRegistry: {
      providers: [adapter], providerForSessionId: () => adapter,
      readSession() { assert.fail("history read must not acquire/cache observation evidence"); },
    },
    observationStore: { entries: () => [], getByQualifiedId: (id) => id === "claude:known" ? { providerId: "claude" } : null },
    checkpointStore: false, monitorStore: false, notificationPersistence: false,
  });
  const base = await listen(runtime);
  const result = await post(base, { sessionId: "claude:known", limit: 2 });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, "missing");
  assert.deepEqual(calls, [["known", { limit: 2 }]]);
  assert.equal((await post(base, { sessionId: "claude:unknown" })).status, 404);
  delete adapter.readSessionMessages;
  assert.equal((await post(base, { sessionId: "claude:known" })).status, 503);
});
