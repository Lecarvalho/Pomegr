// The effort of a chat turn: the send carries it, the store keeps it on the conversation and on Aril's message, and the run
// passes it to the provider exactly as the task dispatcher passes a task's effort. Everything here runs on fakes.

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import test from "node:test";

import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import { chatArguments, CHAT_EFFORTS, runChatTurn } from "../desktop/runtime/agent-chat-runner.mjs";
import { normalizeConversation } from "../desktop/runtime/agent-chat-store.mjs";
import {
  agentMessage, chatHarness, finishTurn, pendingProposal, repositoryId, seed, send, stamp, userMessage, withProposal,
} from "./helpers/agent-chat-harness.mjs";

const read = (h, conversationId) => h.handle("read", { repositoryId, conversationId });
const invalid = { ok: false, error: "invalid" };

test("the run arguments pass a validated effort as the task dispatcher does, after the model", () => {
  assert.deepEqual(CHAT_EFFORTS, ["low", "medium", "high", "xhigh"]);
  const claude = chatArguments("claude", "claude-opus-5-5", null, null, null, null, "high");
  const index = claude.indexOf("--model");
  assert.deepEqual(claude.slice(index, index + 4), ["--model", "claude-opus-5-5", "--effort", "high"]);
  const codex = chatArguments("codex", "gpt-6.1-sol", null, null, null, null, "xhigh");
  const at = codex.indexOf("--model");
  assert.deepEqual(codex.slice(at, at + 4), ["--model", "gpt-6.1-sol", "-c", "model_reasoning_effort=xhigh"]);
  assert.equal(codex.at(-1), "-", "the effort stays before the prompt marker");
  // An effort alone, with no model, is still passed.
  assert.deepEqual(chatArguments("claude", null, null, null, null, null, "low").slice(-2), ["--effort", "low"]);
  assert.ok(chatArguments("codex", null, null, null, null, null, "medium").join(" ").includes("-c model_reasoning_effort=medium"));
});

test("an effort that is not one of the four levels, or none, adds no argument", () => {
  for (const provider of ["claude", "codex"]) {
    const plain = chatArguments(provider, "model-a");
    for (const bad of [null, undefined, "", "max", "High", "HIGH", " high", "high ", "--effort", "high; rm", 3, true, ["high"], { effort: "high" }]) {
      assert.deepEqual(chatArguments(provider, "model-a", null, null, null, null, bad), plain, JSON.stringify(bad));
    }
  }
  assert.equal(chatArguments("claude", null, null, null, null, null, "high").includes("model_reasoning_effort=high"), false);
  assert.equal(chatArguments("codex", null, null, null, null, null, "high").includes("--effort"), false);
});

test("a turn started with an effort spawns the provider with it", async () => {
  for (const [provider, effort, expected] of [["claude", "medium", ["--model", "m-1", "--effort", "medium"]], ["codex", "xhigh", ["--model", "m-1", "-c", "model_reasoning_effort=xhigh"]]]) {
    const spawns = [];
    const child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), stdin: Object.assign(new EventEmitter(), { end() {} }), kill: () => true });
    const turn = runChatTurn({ spawn: (...call) => { spawns.push(call); return child; }, executable: "C:/bin/tool.exe", provider, model: "m-1", effort, cwd: "C:/Work/repo", env: {}, prompt: "Hi" });
    const args = spawns[0][1];
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4), expected);
    assert.deepEqual(args, chatArguments(provider, "m-1", null, null, null, null, effort));
    child.emit("close", 1);
    await turn.done;
  }
});

test("a send with an effort stores it on the conversation and on Aril's message, runs with it, and reads it back", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h, { model: "claude-opus-5-5", effort: "high" });
  assert.equal(sent.ok, true);
  assert.equal(h.runs[0].options.effort, "high");
  assert.equal(h.runs[0].options.model, "claude-opus-5-5");
  const running = await read(h, sent.conversationId);
  assert.equal(running.turn.effort, "high");
  assert.equal(running.conversation.effort, "high");
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: "Run T-2 first." }, sent.conversationId);
  assert.equal(conversation.effort, "high");
  assert.equal(conversation.messages[0].effort, undefined, "a message of the owner carries no effort");
  assert.equal(conversation.messages[1].effort, "high");
  assert.equal((await h.reload().read(repositoryId, sent.conversationId)).messages[1].effort, "high", "the effort is on disk");
});

test("a later message takes the effort it names, and the conversation keeps the last one", async (context) => {
  const h = await chatHarness(context);
  const first = await send(h, { effort: "low" });
  await finishTurn(h, h.runs[0], { status: "complete", text: "One." }, first.conversationId);
  const second = await send(h, { conversationId: first.conversationId, effort: "xhigh", text: "Again" });
  assert.equal(second.ok, true);
  assert.equal(h.runs[1].options.effort, "xhigh");
  const conversation = await finishTurn(h, h.runs[1], { status: "complete", text: "Two." }, first.conversationId);
  assert.deepEqual(conversation.messages.filter((message) => message.role === "agent").map((message) => message.effort), ["low", "xhigh"]);
  assert.equal(conversation.effort, "xhigh");
});

test("a send with no effort, as an older client sends it, runs with none and stores none", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.equal(h.runs[0].options.effort ?? null, null);
  const running = await read(h, sent.conversationId);
  assert.equal(Object.hasOwn(running.turn, "effort"), false);
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
  assert.equal(Object.hasOwn(conversation, "effort"), false);
  assert.equal(Object.hasOwn(conversation.messages[1], "effort"), false);
  // A null effort is the same as none.
  const nulled = await send(h, { effort: null, conversationId: sent.conversationId, text: "Again" });
  assert.equal(nulled.ok, true);
  assert.equal(h.runs[1].options.effort ?? null, null);
});

test("an effort outside the four levels refuses the send before anything is read or run", async (context) => {
  const h = await chatHarness(context);
  for (const bad of ["", "max", "High", "default", "--effort", 3, true, undefined, ["low"], { level: "low" }]) {
    assert.deepEqual(await send(h, { effort: bad }), invalid, JSON.stringify(bad));
  }
  assert.equal(h.runs.length, 0);
  assert.equal(h.calls.length, 0);
});

test("the store reads a record without an effort as none, and refuses an effort that is no level", async (context) => {
  const h = await chatHarness(context);
  const older = await seed(h, { messages: [userMessage(1), agentMessage(2)] });
  const stored = await h.reload().read(repositoryId, older.id);
  assert.equal(Object.hasOwn(stored, "effort"), false);
  assert.equal(Object.hasOwn(stored.messages[1], "effort"), false);

  const base = { id: "chat-0123456789ab", title: "T", provider: "claude", model: null, createdAt: stamp, updatedAt: stamp, messages: [userMessage(1), agentMessage(2)] };
  assert.equal(normalizeConversation({ ...base, effort: "medium" }).effort, "medium");
  assert.equal(normalizeConversation({ ...base, effort: null }).effort, undefined);
  assert.equal(normalizeConversation({ ...base, effort: "extreme" }), null);
  assert.equal(normalizeConversation({ ...base, messages: [userMessage(1), agentMessage(2, { effort: "low" })] }).messages[1].effort, "low");
  assert.equal(normalizeConversation({ ...base, messages: [userMessage(1), agentMessage(2, { effort: "max" })] }), null);
  assert.equal(normalizeConversation({ ...base, messages: [userMessage(1), agentMessage(2, { effort: 4 })] }), null);
});

test("Aril's follow-up after an applied proposal runs with the effort of its conversation", async (context) => {
  const h = await chatHarness(context);
  const created = await h.store.create(repositoryId, { provider: "claude", model: "claude-opus-5-5", effort: "high", title: "Plan" });
  assert.equal(await h.store.save(repositoryId, { ...created, messages: withProposal(pendingProposal({ operations: [{ op: "queue_task", id: "T-2" }] })) }), true);
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: created.id, proposalId: "p-0123456789ab" }), { ok: true });
  const run = await h.followUp();
  assert.equal(run.options.effort, "high");
  assert.equal(run.options.model, "claude-opus-5-5");
  const waiting = await read(h, created.id);
  assert.equal(waiting.turn.effort, "high");
  const conversation = await finishTurn(h, run, { status: "complete", text: "Noted." }, created.id);
  assert.equal(conversation.messages.at(-1).effort, "high");
});

test("a conversation whose answer was lost keeps its effort on the interrupted message", async (context) => {
  const h = await chatHarness(context);
  const created = await h.store.create(repositoryId, { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh", title: "Lost" });
  assert.equal(await h.store.save(repositoryId, { ...created, messages: [userMessage(1, "Question whose answer was lost")] }), true);
  const lost = (await read(h, created.id)).conversation.messages.at(-1);
  assert.deepEqual({ ...lost, at: "" }, { id: "m-2", role: "agent", text: "", at: "", provider: "codex", model: "gpt-6.1-sol", effort: "xhigh", status: "interrupted" });
});

test("a paired device's send carries its effort through the gateway to the run, and an effort outside the levels is refused", async (context) => {
  const h = await chatHarness(context);
  const upstream = http.createServer((_request, response) => response.end("{}"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => upstream.close());
  const authorization = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    authorizationToken: authorization, isNetworkAllowed: async () => true,
    networkPolicy: { isBindHostAllowed: (host, mask) => host === "127.0.0.1" && mask === "255.255.255.0", isClientAddressAllowed: (address) => address === "127.0.0.1" },
    agentChat: (operation, payload) => h.chat.handle(operation, payload, { paired: true }),
  });
  context.after(() => gateway.close?.());
  const secret = new URL(gateway.createPairing().url).hash.slice(1);
  const paired = await fetch(`${gateway.origin}/__pomegr/pair`, { method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret }) });
  const cookie = paired.headers.get("set-cookie").split(";")[0];
  const post = async (payload) => (await fetch(`${gateway.origin}/api/agent-chat`, {
    method: "POST", headers: { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "send", payload }),
  })).json();
  const base = { repositoryId, conversationId: null, text: "From my phone", provider: "claude", model: "claude-opus-5-5" };

  assert.deepEqual(await post({ ...base, effort: "extreme" }), invalid);
  assert.equal(h.runs.length, 0);
  const sent = await post({ ...base, effort: "low" });
  assert.equal(sent.ok, true);
  assert.equal(h.runs[0].options.effort, "low");
  assert.equal((await read(h, sent.conversationId)).conversation.effort, "low");
});
