import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createChatRunDeclarations } from "../../server/providers/kernel/chat-run-declarations.mjs";
import { CHAT_RUN_DECLARE_PATH, CHAT_RUN_WITHDRAW_PATH, createRequestHandler } from "../../server/serving/request-handler.mjs";
import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";

const sessionId = "0b7c2a4e-1f3d-4c5b-9a8e-7d6f5e4c3b2a";

test("only desktop main declares and withdraws a chat run, with the session ID and nothing else", async (context) => {
  const token = "0123456789abcdef0123456789abcdef";
  const declarations = createChatRunDeclarations();
  const server = http.createServer(createRequestHandler({ authorizationToken: token, runtime: {
    declareChatRun: (id) => declarations.declare(id),
    withdrawChatRun: (id) => declarations.withdraw(id),
  } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { [DESKTOP_AUTH_HEADER]: token };
  const declare = `${origin}${CHAT_RUN_DECLARE_PATH}?sessionId=${sessionId}`;

  assert.equal((await fetch(declare, { method: "POST" })).status, 401);
  assert.equal((await fetch(declare, { method: "POST", headers: { [DESKTOP_AUTH_HEADER]: "wrong" } })).status, 401);
  assert.equal((await fetch(declare, { method: "POST", headers: { ...headers, Origin: origin } })).status, 401);
  assert.equal((await fetch(declare, { method: "GET", headers })).status, 401);
  assert.equal(declarations.has(sessionId), false);

  for (const url of [
    `${origin}${CHAT_RUN_DECLARE_PATH}?sessionId=not-a-uuid`,
    `${origin}${CHAT_RUN_DECLARE_PATH}?sessionId=${sessionId}&path=C%3A%5Cx`,
    `${origin}${CHAT_RUN_DECLARE_PATH}?sessionId=${sessionId}&sessionId=${sessionId}`,
    `${origin}${CHAT_RUN_DECLARE_PATH}`,
  ]) {
    const response = await fetch(url, { method: "POST", headers });
    assert.equal(response.status, 400, url);
    assert.deepEqual(await response.json(), { ok: false });
  }
  assert.equal((await fetch(declare, { method: "POST", headers, body: "text" })).status, 400, "a body is refused");
  assert.equal(declarations.has(sessionId), false);

  const declared = await fetch(declare, { method: "POST", headers });
  assert.equal(declared.status, 200);
  assert.deepEqual(await declared.json(), { ok: true });
  assert.equal(declared.headers.get("cache-control"), "no-store");
  assert.equal(declarations.has(sessionId), true);

  const withdrawn = await fetch(`${origin}${CHAT_RUN_WITHDRAW_PATH}?sessionId=${sessionId}`, { method: "POST", headers });
  assert.deepEqual(await withdrawn.json(), { ok: true });
  assert.equal(declarations.has(sessionId), false);
});
