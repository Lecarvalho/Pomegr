import assert from "node:assert/strict";
import test from "node:test";

import { createSessionHistory, installSessionHistoryIpc, SESSION_HISTORY_CHANNEL } from "../desktop/runtime/session-history.mjs";

const sessionId = "claude:session-123";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const request = { limit: 100 };
const page = {
  messages: [
    { kind: "owner", at: 12, text: "hello" },
    { kind: "agent", at: null, text: "world" },
    { kind: "tool", at: 13, name: "Read", outcome: "completed" },
  ],
  cursor: { fingerprint: "abc", offset: 40 },
  older: null,
  reset: false,
  status: "ok",
};
const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function harness(answer, overrides = {}) {
  const calls = [];
  const history = createSessionHistory({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: origin,
    authorizationToken: "secret",
    fetch: async (url, options) => { calls.push({ url, options }); return typeof answer === "function" ? answer(url, options) : answer; },
    ...overrides,
  });
  return { history, calls };
}

test("the channel is fixed and the installer is exported", () => {
  assert.equal(SESSION_HISTORY_CHANNEL, "pomegr:session-history");
  assert.equal(typeof installSessionHistoryIpc, "function");
});

test("an untrusted frame, malformed session ID, or malformed request is refused without a request", async () => {
  const { history, calls } = harness(() => json(page));
  assert.deepEqual(await history.run({}, sessionId, request), invalid);
  assert.deepEqual(await history.run(undefined, sessionId, request), invalid);
  for (const id of ["C:\\private", "claude:", "claude:a:b", "claude:../x", "claude:with space", "claude:" + "x".repeat(129), "other:session-123", undefined, 7]) {
    assert.deepEqual(await history.run(trusted, id, request), invalid, String(id));
  }
  for (const value of [null, [], "x", { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: 100, cursor: { fingerprint: "x", offset: 0 }, before: { fingerprint: "x", offset: 0 } }, { limit: 1, cursor: { fingerprint: "", offset: 0 } }, { limit: 1, cursor: { fingerprint: "x", offset: -1 } }, { limit: 1, extra: true }, { limit: 1, before: { fingerprint: "x", offset: 1 }, cursor: null }]) {
    assert.deepEqual(await history.run(trusted, sessionId, value), invalid, JSON.stringify(value));
  }
  assert.equal(calls.length, 0);
});

test("a read posts the bounded request with desktop authorization and returns only the page schema", async () => {
  const supplied = { limit: 50, cursor: { fingerprint: "source-hash", offset: 8192 } };
  const { history, calls } = harness(() => json(page));
  const result = await history.run(trusted, sessionId, supplied);
  assert.deepEqual(result, { ok: true, page });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls[0].url, `${origin}/internal/sessions/history-read`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["x-pomegr-desktop-authorization"], "secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), { sessionId, cursor: supplied.cursor, limit: 50 });
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test("malformed or failed history answers are unavailable", async () => {
  for (const body of [null, [], "x", { messages: [] }, { ...page, extra: "foreign" }, { ...page, reset: undefined }, { ...page, cursor: { fingerprint: "x", offset: 0, extra: true } }, { ...page, older: { fingerprint: "x", offset: -1 } }, { ...page, messages: [{ kind: "future", at: null, text: "x" }] }, { ...page, messages: [{ kind: "tool", at: null, name: "Read", outcome: "unknown" }] }, { ...page, messages: new Array(201).fill(page.messages[0]) }, { ...page, messages: [{ kind: "tool", at: null, name: "x".repeat(65), outcome: "completed" }] }, { ...page, messages: [{ kind: "tool", at: null, name: "Read", outcome: "completed", arguments: "secret" }] }, { ...page, messages: [{ kind: "agent", at: null, text: "x".repeat(32001) }] }, { ...page, status: "secret" }, { ...page, cursor: { fingerprint: "x".repeat(257), offset: 0 } }]) {
    assert.deepEqual(await harness(() => json(body)).history.run(trusted, sessionId, request), unavailable, JSON.stringify(body).slice(0, 120));
  }
  assert.deepEqual(await harness(() => json(page, 503)).history.run(trusted, sessionId, request), unavailable);
  assert.deepEqual(await harness(() => new Response("not json")).history.run(trusted, sessionId, request), unavailable);
});

test("fixed monitor errors pass through and transport failures remain private", async () => {
  for (const error of ["invalid", "not_found", "unavailable"]) {
    assert.deepEqual(await harness(() => json({ error }, 404)).history.run(trusted, sessionId, request), { ok: false, error });
  }
  for (const answer of [
    () => json({ error: "private path C:\\secret" }, 500),
    () => json({ ok: true, ...page }, 200),
    () => { throw new Error("C:\\secret"); },
  ]) assert.deepEqual(await harness(answer).history.run(trusted, sessionId, request), unavailable);
  assert.deepEqual(await harness(() => json(page), { monitorOrigin: "http://example.com" }).history.run(trusted, sessionId, request), unavailable);
  assert.deepEqual(await harness(() => json(page), { authorizationToken: "" }).history.run(trusted, sessionId, request), unavailable);
  const disposed = harness(() => json(page));
  disposed.history.dispose();
  assert.deepEqual(await disposed.history.run(trusted, sessionId, request), unavailable);
});

test("the IPC handler is installed once on its fixed channel and removes itself", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  let disposed = false;
  const remove = installSessionHistoryIpc({ ipcMain, action: { run: async (_event, id, options) => ({ ok: true, id, options }), dispose() { disposed = true; } } });
  assert.deepEqual([...handlers.keys()], [SESSION_HISTORY_CHANNEL]);
  assert.deepEqual(await handlers.get(SESSION_HISTORY_CHANNEL)(trusted, sessionId, request), { ok: true, id: sessionId, options: request });
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, true);
  installSessionHistoryIpc({ ipcMain, action: { run: async () => { throw new Error("C:\\secret"); } } });
  assert.deepEqual(await handlers.get(SESSION_HISTORY_CHANNEL)(trusted, sessionId, request), unavailable);
  assert.throws(() => installSessionHistoryIpc({}), TypeError);
});
