// Aril's own Claude Code run registers in Claude Code's local session registry even though it keeps no session file.
// Desktop main gives each run a session ID of its own, declares it to the monitor before the run starts, and withdraws
// it when the turn ends, so the monitor leaves that registration out of the Sessions list. Everything here runs on fakes.

import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_SESSION_ID, chatArguments } from "../desktop/runtime/agent-chat-runner.mjs";
import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import { chatHarness, finishTurn, origin, pendingProposal, repositoryId, seed, send, token, until, withProposal } from "./helpers/agent-chat-harness.mjs";

const sessionId = "0b7c2a4e-1f3d-4c5b-9a8e-7d6f5e4c3b2a";

test("a Claude turn runs under the session ID it declared, and withdraws that ID when the turn ends", async (context) => {
  const h = await chatHarness(context, { newSessionId: () => sessionId });
  const answer = await send(h);
  assert.equal(answer.ok, true);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].options.sessionId, sessionId);
  assert.deepEqual(h.declarations.map(({ action, sessionId: id }) => [action, id]), [["declare", sessionId]], "declared before the run started, and nothing else yet");
  const [{ call }] = h.declarations;
  assert.equal(call.url, `${origin}/internal/agent-chat/run-declare?sessionId=${sessionId}`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, undefined, "the ID is the only value sent");
  assert.equal(call.init.headers[DESKTOP_AUTH_HEADER], token);
  assert.equal(call.init.redirect, "error");

  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, answer.conversationId);
  await until(() => h.declarations.length === 2);
  assert.deepEqual(h.declarations.map(({ action, sessionId: id }) => [action, id]), [["declare", sessionId], ["withdraw", sessionId]]);
  assert.equal(h.declarations[1].call.url, `${origin}/internal/agent-chat/run-withdraw?sessionId=${sessionId}`);
});

test("each turn gets a fresh random ID, and a failed or stopped run withdraws it too", async (context) => {
  const h = await chatHarness(context);
  const first = await send(h);
  const firstId = h.runs[0].options.sessionId;
  assert.match(firstId, CHAT_SESSION_ID);
  await finishTurn(h, h.runs[0], { status: "failed", text: "" }, first.conversationId);
  const second = await send(h, { conversationId: first.conversationId });
  assert.equal(second.ok, true);
  const secondId = h.runs[1].options.sessionId;
  assert.match(secondId, CHAT_SESSION_ID);
  assert.notEqual(secondId, firstId);
  await finishTurn(h, h.runs[1], { status: "stopped", text: "" }, first.conversationId);
  await until(() => h.declarations.length === 4);
  assert.deepEqual(h.declarations.map(({ action, sessionId: id }) => [action, id]), [["declare", firstId], ["withdraw", firstId], ["declare", secondId], ["withdraw", secondId]]);
});

test("a refused declaration still starts the run", async (context) => {
  const h = await chatHarness(context, { newSessionId: () => sessionId });
  h.state.declarationError = new Error("monitor gone");
  assert.equal((await send(h)).ok, true);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].options.sessionId, sessionId);
});

test("a Codex turn declares nothing: its ephemeral run registers nothing the catalog shows", async (context) => {
  const h = await chatHarness(context);
  const answer = await send(h, { provider: "codex" });
  assert.equal(answer.ok, true);
  assert.equal(h.runs[0].options.sessionId, null);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, answer.conversationId);
  assert.deepEqual(h.declarations, []);
});

test("a follow-up declares and withdraws its own run as a turn does", async (context) => {
  const h = await chatHarness(context, { newSessionId: () => sessionId });
  const conversation = await seed(h, { messages: withProposal(pendingProposal()) });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId: "p-0123456789ab" }), { ok: true });
  const run = await h.followUp();
  assert.equal(run.options.sessionId, sessionId);
  assert.deepEqual(h.declarations.map(({ action }) => action), ["declare"]);
  await h.finishFollowUp(conversation.id);
  await until(() => h.declarations.length === 2);
  assert.deepEqual(h.declarations.map(({ action, sessionId: id }) => [action, id]), [["declare", sessionId], ["withdraw", sessionId]]);
});

test("the Claude arguments carry the run's session ID; Codex and a malformed ID get none", () => {
  const plain = chatArguments("claude");
  const named = chatArguments("claude", null, null, null, sessionId);
  const at = plain.indexOf("--setting-sources");
  assert.deepEqual(named, [...plain.slice(0, at), "--session-id", sessionId, ...plain.slice(at)]);
  assert.ok(named.includes("--no-session-persistence"), "the run still keeps no session file");
  for (const bad of ["", "not-a-uuid", sessionId.toUpperCase(), `${sessionId} --help`, "--help", 7]) {
    assert.deepEqual(chatArguments("claude", null, null, null, bad), plain, JSON.stringify(bad));
  }
  assert.deepEqual(chatArguments("codex", null, null, null, sessionId), chatArguments("codex"));
});
