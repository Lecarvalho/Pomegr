// A lowered effort and the warm run: a waiting Claude Code process takes the new effort through one control request before it is given its
// prompt (a probe on 2026-10-29 showed `apply_flag_settings` changes what the process reports it will send), and a process that does not
// acknowledge it is closed and the turn starts fresh at the lowered effort. Everything runs on fake child processes.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { claudeEffortLine, claudeUserLine, EFFORT_ACK_MS, startChatProcess } from "../desktop/runtime/agent-chat-runner.mjs";
import { chatHarness, repositoryId, until } from "./helpers/agent-chat-harness.mjs";

const SECRET = "jev-secret-key-0123456789";
const choice = (value) => ({ model: "jev-latest", answers: { effort: { type: "choice", choice: value } } });
const ACK = `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "pomegr-effort", response: {} } })}\n`;
const REFUSAL = `${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "pomegr-effort", error: "no" } })}\n`;

function fakeProvider() {
  const spawns = [];
  const spawn = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = Object.assign(new EventEmitter(), { writes: [], ended: false, write(data, encoding) { this.writes.push([data, encoding]); return true; },
      end(data, encoding) { if (data !== undefined) this.writes.push([data, encoding]); this.ended = true; } });
    child.kills = 0;
    child.kill = () => { child.kills += 1; queueMicrotask(() => child.emit("close", null)); return true; };
    spawns.push({ executable, args, options, child });
    return child;
  };
  return { spawns, spawn };
}

function reply(child, text) {
  const lines = [
    { type: "system", subtype: "init" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } }, parent_tool_use_id: null },
    { type: "result", subtype: "success", is_error: false, result: text },
  ];
  child.stdout.emit("data", `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  child.emit("close", 0);
}

const effortOf = (args) => args[args.indexOf("--effort") + 1];
const written = (child) => child.stdin.writes.map(([line]) => JSON.parse(line));

async function harness(context, jevAnswer, overrides = {}) {
  const provider = fakeProvider();
  const jevCalls = [];
  let ids = 0;
  const h = await chatHarness(context, {
    runTurn: undefined, spawn: provider.spawn, jevKey: { read: async () => SECRET },
    jevFetch: async (url, init) => { jevCalls.push({ url, init }); return new Response(JSON.stringify(choice(jevAnswer)), { status: 200 }); },
    newSessionId: () => `0b7c2a4e-1f3d-4c5b-9a8e-${String((ids += 1)).padStart(12, "0")}`, ...overrides,
  });
  const warm = (payload = {}) => h.handle("warm", { repositoryId, provider: "claude", model: null, effort: "high", ...payload });
  const send = (payload = {}) => h.handle("send", { repositoryId, conversationId: null, text: "thanks, that is all", provider: "claude", model: null, effort: "high", ...payload });
  return { h, spawns: provider.spawns, jevCalls, warm, send };
}

test("a lowered effort goes to the waiting run as one control request, and the prompt is written only after the run acknowledged it", async (context) => {
  const { h, spawns, jevCalls, warm, send } = await harness(context, "low");
  await warm();
  assert.equal(spawns.length, 1);
  assert.equal(effortOf(spawns[0].args), "high", "the run waits at the owner's effort");
  const waiting = spawns[0].child;
  assert.deepEqual(waiting.stdin.writes, []);
  const sending = send();
  await until(() => waiting.stdin.writes.length === 1);
  assert.equal(jevCalls.length, 1);
  assert.deepEqual(written(waiting), [{ type: "control_request", request_id: "pomegr-effort", request: { subtype: "apply_flag_settings", settings: { effortLevel: "low" } } }]);
  assert.equal(waiting.stdin.writes[0][0], claudeEffortLine("low"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(waiting.stdin.writes.length, 1, "no prompt beside the request: it waits for the answer");
  waiting.stdout.emit("data", ACK);
  const sent = await sending;
  assert.equal(sent.ok, true);
  assert.equal(spawns.length, 1, "the same process answers");
  assert.equal(waiting.kills, 0);
  assert.equal(waiting.stdin.writes.length, 2);
  assert.equal(JSON.parse(waiting.stdin.writes[1][0]).type, "user");
  assert.match(waiting.stdin.writes[1][0], /thanks, that is all/u);
  assert.equal(waiting.stdin.writes[1][0].includes(SECRET), false);
  reply(waiting, "You are welcome.");
  await until(async () => (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).turn === null);
  const answer = (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).conversation.messages.at(-1);
  assert.equal(answer.effort, "low");
  assert.equal(answer.timing.warm, true);
  assert.equal(answer.timing.route.by, "jev");
  assert.equal(answer.timing.route.effort, "low");
  // The lowered effort does not stay: the next warm run is the owner's.
  await until(() => spawns.length === 2);
  assert.equal(effortOf(spawns[1].args), "high");
  assert.deepEqual(spawns[1].child.stdin.writes, []);
});

test("a waiting run that answers the change with an error is closed and the turn starts fresh at the lowered effort", async (context) => {
  const { h, spawns, warm, send } = await harness(context, "low");
  await warm();
  const first = spawns[0].child;
  const sending = send();
  await until(() => first.stdin.writes.length === 1);
  first.stdout.emit("data", REFUSAL);
  const sent = await sending;
  assert.equal(sent.ok, true);
  assert.equal(first.kills, 1, "the run is closed, not left waiting");
  assert.equal(first.stdin.ended, true);
  assert.equal(first.stdin.writes.length, 1, "it never saw the prompt");
  assert.equal(spawns.length, 2);
  assert.equal(effortOf(spawns[1].args), "low");
  assert.equal(spawns[1].child.stdin.writes.length, 1);
  assert.equal(written(spawns[1].child)[0].type, "user");
  assert.equal(spawns[1].args.includes("--effort"), true);
  // The declarations are balanced: the closed run was withdrawn and the fresh one declared.
  const actions = h.declarations.map(({ action }) => action);
  assert.equal(actions.filter((action) => action === "withdraw").length >= 1, true);
  reply(spawns[1].child, "Welcome.");
  await until(async () => (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).turn === null);
  const answer = (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).conversation.messages.at(-1);
  assert.equal(answer.effort, "low");
  assert.equal(Object.hasOwn(answer.timing, "warm"), false, "a fresh run is not a warm answer");
  assert.equal(answer.timing.route.by, "jev");
});

test("a waiting run that exits before it answers is replaced by a fresh one at the lowered effort", async (context) => {
  const { spawns, warm, send } = await harness(context, "medium");
  await warm();
  const first = spawns[0].child;
  const sending = send();
  await until(() => first.stdin.writes.length === 1);
  first.emit("close", 1);
  const sent = await sending;
  assert.equal(sent.ok, true);
  assert.equal(spawns.length, 2);
  assert.equal(effortOf(spawns[1].args), "medium");
  assert.equal(written(spawns[1].child)[0].type, "user");
});

test("an answer that does not lower the effort writes no control request: the prompt is the run's first line", async (context) => {
  const { spawns, warm, send } = await harness(context, "high");
  await warm();
  const waiting = spawns[0].child;
  const sent = await send();
  assert.equal(sent.ok, true);
  assert.equal(waiting.stdin.writes.length, 1);
  assert.equal(written(waiting)[0].type, "user");
  assert.equal(spawns.length, 1);
});

test("with no warm run a lowered effort is the new process's own argument, and Codex takes it as its reasoning effort", async (context) => {
  const cold = await harness(context, "low");
  const sent = await cold.send();
  assert.equal(sent.ok, true);
  assert.equal(cold.spawns.length, 1);
  assert.equal(effortOf(cold.spawns[0].args), "low");
  assert.equal(cold.spawns[0].args.filter((argument) => argument === "--effort").length, 1);
  assert.equal(written(cold.spawns[0].child).length, 1, "no control request: the process starts at the lowered effort");
  const codex = await harness(context, "low");
  const codexSent = await codex.send({ provider: "codex" });
  assert.equal(codexSent.ok, true);
  assert.equal(codex.spawns.length, 1);
  assert.equal(codex.spawns[0].args.includes("model_reasoning_effort=low"), true);
  assert.equal(codex.spawns[0].args.includes("model_reasoning_effort=high"), false);
  assert.equal(codex.spawns[0].child.stdin.writes.length, 1);
});

test("a turn stopped while its lowered effort waits for the run's answer closes the run and never writes the prompt", async (context) => {
  const { h, spawns, warm, send } = await harness(context, "low");
  await warm();
  const first = spawns[0].child;
  const sending = send();
  await until(() => first.stdin.writes.length === 1);
  const { running } = await until(async () => { const listed = await h.handle("list", { repositoryId }); return listed.running ? listed : null; });
  assert.deepEqual(await h.handle("stop", { repositoryId, conversationId: running }), { ok: true });
  first.stdout.emit("data", ACK);
  assert.deepEqual(await sending, { ok: false, error: "unavailable" });
  assert.equal(first.kills, 1);
  assert.equal(first.stdin.writes.length, 1, "only the control request: the prompt was never written");
  assert.equal(spawns.length, 1, "no fresh process for a stopped turn");
  const answer = (await h.handle("read", { repositoryId, conversationId: running })).conversation.messages.at(-1);
  assert.equal(answer.status, "stopped");
});

// The process level: what `setEffort` writes, accepts, and refuses.
function process_(options = {}) {
  const provider = fakeProvider();
  const handle = startChatProcess({ spawn: provider.spawn, executable: "claude", provider: "claude", model: null, effort: "high", cwd: "C:\\Work", env: {}, ...options });
  return { handle, child: provider.spawns[0].child, spawns: provider.spawns };
}

test("setEffort writes the control request, resolves true only on a success answer to that request, and keeps the prompt for later", async () => {
  const { handle, child } = process_();
  const result = handle.setEffort("low");
  assert.deepEqual(child.stdin.writes, [[claudeEffortLine("low"), "utf8"]]);
  // Other output, another request's answer, and a line cut in two are not the answer.
  child.stdout.emit("data", `${JSON.stringify({ type: "system", subtype: "init" })}\nnot json\n`);
  child.stdout.emit("data", `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "someone-else" } })}\n`);
  child.stdout.emit("data", ACK.slice(0, 30));
  child.stdout.emit("data", ACK.slice(30));
  assert.equal(await result, true);
  // The prompt is written afterwards, and the run reads as always.
  const run = handle.begin({ prompt: "Hello", onText() {}, onActivity() {} });
  assert.equal(child.stdin.writes.at(-1)[0], claudeUserLine("Hello"));
  child.stdout.emit("data", `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hi" })}\n`);
  child.emit("close", 0);
  assert.deepEqual(await run.done, { status: "complete", text: "Hi" });
});

test("setEffort answers false for an error answer, silence, an exit, a level outside the list, a second request, and a process that has its prompt", async () => {
  const refused = process_();
  const first = refused.handle.setEffort("low");
  assert.equal(await Promise.resolve(refused.handle.setEffort("medium")), false, "one request at a time");
  refused.child.stdout.emit("data", REFUSAL);
  assert.equal(await first, false);

  const silent = process_();
  assert.equal(await silent.handle.setEffort("low", 20), false, "no answer in time");
  assert.equal(EFFORT_ACK_MS, 2_000);

  const exiting = process_();
  const pending = exiting.handle.setEffort("low");
  exiting.child.emit("close", 1);
  assert.equal(await pending, false);
  assert.equal(await exiting.handle.setEffort("low"), false, "an ended process");

  const odd = process_();
  for (const level of ["max", "LOW", "", null, undefined, "low; rm", 3]) assert.equal(await odd.handle.setEffort(level), false, String(level));
  assert.deepEqual(odd.child.stdin.writes, [], "nothing outside the list is written");

  const begun = process_();
  begun.handle.begin({ prompt: "Hello", onText() {}, onActivity() {} });
  assert.equal(await begun.handle.setEffort("low"), false);
  assert.equal(begun.child.stdin.writes.length, 1);

  const codex = process_({ provider: "codex", executable: "codex" });
  assert.equal(await codex.handle.setEffort("low"), false, "Codex starts fresh and has no such request");
  assert.deepEqual(codex.child.stdin.writes, []);
});
