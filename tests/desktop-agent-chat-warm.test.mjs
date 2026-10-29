// Warm runs: a Claude Code process that Pomegr starts before the owner sends and holds, with no prompt, until the owner does. Everything
// here runs on a fake `spawn`: the real runner and the real warm module drive fake child processes, so no provider starts and the
// arguments, the stdin lines, the declarations, and the closes are the ones a real run would make.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { claudeUserLine, startChatProcess } from "../desktop/runtime/agent-chat-runner.mjs";
import { createWarmRuns, WARM_IDLE_MS, WARM_LIMIT, WARM_PREPARE } from "../desktop/runtime/agent-chat-warm.mjs";
import { agentMessage, chatHarness, otherRepositoryId, repositoryId, seed, send, sourceEnvironment, until, userMessage } from "./helpers/agent-chat-harness.mjs";

const thirdRepositoryId = "repo-aaaaaaaaaaaaaaaaaaaaaaaa";
const CLAUDE = { provider: "claude", model: null, effort: null };

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

// What Claude Code prints for one answered message, then its exit once stdin was closed.
function reply(child, text) {
  const lines = [
    { type: "system", subtype: "init" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } }, parent_tool_use_id: null },
    { type: "result", subtype: "success", is_error: false, result: text },
  ];
  child.stdout.emit("data", `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  child.emit("close", 0);
}

// A clock for the idle timers: a timer fires only when the test says so.
function fakeTimers() {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    options: { setTimer: (callback, ms) => { next += 1; timers.set(next, { callback, ms }); return next; }, clearTimer: (id) => { timers.delete(id); } },
    fire: () => { for (const [id, { callback }] of [...timers]) { timers.delete(id); callback(); } },
  };
}

async function warmHarness(context, overrides = {}) {
  const provider = fakeProvider();
  const clock = fakeTimers();
  let ids = 0;
  const h = await chatHarness(context, {
    runTurn: undefined, spawn: provider.spawn, warmOptions: clock.options,
    newSessionId: () => `0b7c2a4e-1f3d-4c5b-9a8e-${String((ids += 1)).padStart(12, "0")}`, ...overrides,
  });
  const warm = (payload = {}, repository = repositoryId) => h.handle("warm", { repositoryId: repository, ...CLAUDE, ...payload });
  const actions = () => h.declarations.map(({ action }) => action);
  return { h, provider, clock, warm, actions, spawns: provider.spawns };
}

const userLine = (child) => JSON.parse(child.stdin.writes[0][0]);

test("focus, warm, then send: the send uses the waiting run and writes its prompt as one stream-json user line", async (context) => {
  const { h, spawns, warm, actions, clock } = await warmHarness(context, { viaDataRoot: true });
  assert.deepEqual(await warm(), { ok: true });
  assert.equal(spawns.length, 1);
  const waiting = spawns[0];
  // The run waits with every argument fixed and no prompt: its stdin is open and empty, and nothing the owner will type is anywhere yet.
  assert.deepEqual(waiting.child.stdin.writes, []);
  assert.equal(waiting.child.stdin.ended, false);
  assert.ok(waiting.args.includes("--input-format"));
  assert.ok(waiting.args.includes("--append-system-prompt-file"), "the instructions file is part of the fixed arguments");
  assert.deepEqual(waiting.options, { cwd: "C:\\Work\\private-repo", env: waiting.options.env, shell: false, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  assert.deepEqual(actions(), ["declare"], "declared while it waits");
  const sessionId = waiting.args[waiting.args.indexOf("--session-id") + 1];
  assert.equal(h.declarations[0].sessionId, sessionId);
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].ms, WARM_IDLE_MS);

  const sent = await send(h, { text: "WARM-MESSAGE-4711 what should I do first?" });
  assert.equal(sent.ok, true);
  assert.equal(spawns.length, 1, "no new process");
  assert.equal(clock.timers.size, 0, "a run that was taken waits no more");
  const line = userLine(waiting.child);
  assert.equal(waiting.child.stdin.writes.length, 1);
  assert.equal(waiting.child.stdin.writes[0][1], "utf8");
  assert.equal(waiting.child.stdin.writes[0][0].endsWith("\n"), true);
  assert.deepEqual(Object.keys(line), ["type", "message"]);
  assert.equal(line.type, "user");
  assert.equal(line.message.role, "user");
  assert.equal(line.message.content.length, 1);
  assert.equal(line.message.content[0].type, "text");
  const prompt = line.message.content[0].text;
  assert.match(prompt, /WARM-MESSAGE-4711/u);
  assert.match(prompt, /<board_snapshot>/u, "the prompt is built as always, with a board read for this message");
  assert.equal(waiting.child.stdin.writes[0][0], claudeUserLine(prompt));
  // Nothing of the message is in an argument or the environment, and the capability reached the process as it always does.
  assert.equal(JSON.stringify(waiting.args).includes("WARM-MESSAGE"), false);
  assert.equal(JSON.stringify(waiting.options.env).includes("WARM-MESSAGE"), false);
  assert.equal(typeof waiting.options.env.POMEGR_CHAT_TASK_KEY, "string");
  assert.equal(waiting.child.stdin.ended, false, "stdin stays open until the result");

  reply(waiting.child, "Start with T-1.");
  assert.equal(waiting.child.stdin.ended, true, "stdin is closed after the result event");
  await until(async () => (await h.handle("thread", { repositoryId })).turn === null && (await h.handle("list", { repositoryId })).running === null);
  const answer = (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).conversation.messages.at(-1);
  assert.equal(answer.status, "complete");
  assert.equal(answer.text, "Start with T-1.");
  assert.equal(answer.timing.warm, true);
  assert.deepEqual({ environment: answer.timing.prepare.environment, declare: answer.timing.prepare.declare, server: answer.timing.prepare.server }, WARM_PREPARE);
  assert.ok(answer.timing.eventMs !== null && answer.timing.doneMs >= answer.timing.eventMs);
  // The declaration is withdrawn at the end of the turn, and the finished answer warms the next run on its own.
  await until(() => spawns.length === 2);
  assert.deepEqual(actions().slice(0, 4), ["declare", "declare", "withdraw", "declare"], "declared, declared again when taken, withdrawn at the end, then the next run waits");
  assert.equal(h.declarations[2].sessionId, sessionId);
  assert.deepEqual(spawns[1].child.stdin.writes, []);
});

test("the cold path uses the same stream-json line and the same prompt, and a warm answer records no more than a cold one", async (context) => {
  const warm = await warmHarness(context);
  await warm.warm();
  const warmSent = await send(warm.h, { text: "SAME-QUESTION" });
  const cold = await warmHarness(context);
  const coldSent = await send(cold.h, { text: "SAME-QUESTION" });
  assert.equal(warm.spawns.length, 1);
  assert.equal(cold.spawns.length, 1);
  const [warmLine, coldLine] = [warm.spawns[0].child, cold.spawns[0].child].map(userLine);
  assert.deepEqual(coldLine, { type: "user", message: { role: "user", content: [{ type: "text", text: coldLine.message.content[0].text }] } });
  assert.equal(coldLine.message.content[0].text.length, warmLine.message.content[0].text.length, "the same prompt is written, warm or cold");
  assert.equal(cold.spawns[0].child.stdin.writes.length, 1);
  // The same fixed arguments either way: the cold process was started with the warm one's argument list, apart from its own session ID.
  const fixed = (args) => args.map((argument, index) => (args[index - 1] === "--session-id" ? "<session>" : argument));
  assert.deepEqual(fixed(cold.spawns[0].args), fixed(warm.spawns[0].args));
  assert.equal(cold.spawns[0].args.includes("stream-json"), true);
  assert.equal(JSON.stringify(cold.spawns[0].args).includes("SAME-QUESTION"), false);
  reply(warm.spawns[0].child, "Warm.");
  reply(cold.spawns[0].child, "Cold.");
  for (const [side, sent] of [[warm, warmSent], [cold, coldSent]]) await until(async () => (await side.h.handle("read", { repositoryId, conversationId: sent.conversationId })).turn === null);
  const [warmTiming, coldTiming] = await Promise.all([[warm, warmSent], [cold, coldSent]].map(async ([side, sent]) => (await side.h.handle("read", { repositoryId, conversationId: sent.conversationId })).conversation.messages.at(-1).timing));
  assert.equal(warmTiming.warm, true);
  assert.equal(Object.hasOwn(coldTiming, "warm"), false, "a cold answer carries no warm flag");
  assert.deepEqual(Object.keys(coldTiming.prepare).includes("declare"), true);
  assert.equal(warmTiming.prompt.message, coldTiming.prompt.message);
});

test("a changed model, effort, or provider closes the waiting run and the send starts fresh", async (context) => {
  for (const change of [{ model: "claude-sonnet-4" }, { effort: "high" }]) {
    const { h, spawns, warm, actions } = await warmHarness(context);
    await warm();
    const first = spawns[0];
    const sent = await send(h, { text: "A different run", ...change });
    assert.equal(sent.ok, true);
    assert.equal(spawns.length, 2, JSON.stringify(change));
    assert.equal(first.child.kills, 1);
    assert.equal(first.child.stdin.ended, true);
    assert.deepEqual(first.child.stdin.writes, [], "the closed run never saw a prompt");
    assert.equal(spawns[1].child.stdin.writes.length, 1);
    assert.deepEqual(actions().slice(0, 3), ["declare", "withdraw", "declare"]);
    assert.equal(h.declarations[1].sessionId, first.args[first.args.indexOf("--session-id") + 1]);
    reply(spawns[1].child, "Cold.");
    await until(async () => (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).turn === null);
    const timing = (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).conversation.messages.at(-1).timing;
    assert.equal(Object.hasOwn(timing, "warm"), false);
  }
  // A request for another run replaces the held one.
  const { spawns, warm } = await warmHarness(context);
  await warm();
  await warm({ model: "claude-opus-4-1" });
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0].child.kills, 1);
  assert.equal(spawns[1].child.kills, 0);
});

test("a turn a warm run serves reads the environment no more, and a turn it cannot serve reads it", async (context) => {
  let reads = 0;
  const { h, spawns, warm } = await warmHarness(context, { sessionEnvironment: async () => { reads += 1; return { ...sourceEnvironment }; } });
  await warm();
  assert.equal(reads, 1, "the warm run read it when it started");
  const first = await send(h);
  assert.equal(first.ok, true);
  assert.equal(reads, 1, "the run that was taken holds its environment");
  reply(spawns[0].child, "Done.");
  await until(() => spawns.length === 2);
  assert.equal(reads, 2, "the answer warmed the next run, which read it again");
  const second = await send(h, { model: "claude-sonnet-4" });
  assert.equal(second.ok, true);
  assert.equal(spawns.length, 3, "another model could not use the waiting run");
  assert.equal(reads, 3, "so the turn read the environment for itself");
});

test("a send that adds an image to a conversation without images starts fresh, because the image folder is an argument", async (context) => {
  const { h, spawns, warm } = await warmHarness(context, { viaDataRoot: true });
  await warm();
  assert.equal(spawns[0].args.includes("--add-dir"), false);
  const image = await h.image("add", { repositoryId, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) });
  const sent = await send(h, { text: "With a picture", images: [image.image.id] });
  assert.equal(sent.ok, true);
  assert.equal(spawns.length, 2, "the waiting run could not serve the message");
  assert.equal(spawns[0].child.kills, 1);
  assert.deepEqual(spawns[0].child.stdin.writes, []);
  assert.ok(spawns[1].args.includes("--add-dir"));
});

test("the idle clock closes the run after five minutes and withdraws its declaration", async (context) => {
  const { h, spawns, warm, actions, clock } = await warmHarness(context);
  await warm();
  const waiting = spawns[0];
  assert.equal(clock.timers.size, 1);
  clock.fire();
  assert.equal(waiting.child.kills, 1);
  assert.equal(waiting.child.stdin.ended, true);
  assert.deepEqual(actions(), ["declare", "withdraw"]);
  assert.equal(h.declarations[1].sessionId, h.declarations[0].sessionId);
  // The next send starts fresh.
  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].child.stdin.writes.length, 1);
});

test("a repeated request for the same run keeps one process, starts its idle clock again, and declares it again", async (context) => {
  const { spawns, warm, actions, clock } = await warmHarness(context);
  await warm();
  await warm();
  await warm();
  assert.equal(spawns.length, 1);
  assert.equal(clock.timers.size, 1, "one idle clock at a time");
  await until(() => actions().length === 3);
  assert.deepEqual(actions(), ["declare", "declare", "declare"], "each request declares the same run again, so the monitor's eleven minutes start over");
});

test("only the idle clock, a send, a replacement, the limit, an early exit, and quitting close a run: no read, search, stop, or delete does", async (context) => {
  const { h, spawns, warm } = await warmHarness(context);
  await warm();
  await h.handle("list", { repositoryId });
  await h.handle("thread", { repositoryId });
  await h.handle("search", { repositoryId, query: "anything" });
  await h.handle("stop", { repositoryId, conversationId: "chat-0123456789ab" });
  await h.handle("delete", { repositoryId, conversationId: "chat-0123456789ab" });
  assert.equal(spawns[0].child.kills, 0);
  assert.equal(spawns[0].child.stdin.ended, false);
  h.chat.dispose();
  assert.equal(spawns[0].child.kills, 1, "quitting closes it");
  assert.equal(h.declarations.at(-1).action, "withdraw");
});

test("one run for each thread and two in total: a new one closes the oldest", async (context) => {
  const { spawns, warm } = await warmHarness(context);
  assert.equal(WARM_LIMIT, 2);
  await warm({}, repositoryId);
  await warm({}, repositoryId);
  assert.equal(spawns.length, 1, "one for the thread");
  await warm({}, otherRepositoryId);
  assert.equal(spawns.length, 2);
  await warm({}, thirdRepositoryId);
  assert.equal(spawns.length, 3);
  assert.equal(spawns[0].child.kills, 1, "the oldest closed");
  assert.equal(spawns[1].child.kills, 0);
  assert.equal(spawns[2].child.kills, 0);
  // A request that keeps a run makes it the newest, so the other one is the oldest.
  await warm({}, otherRepositoryId);
  await warm({}, repositoryId);
  assert.equal(spawns.length, 4);
  assert.equal(spawns[2].child.kills, 1, "the third repository's run was the oldest");
  assert.equal(spawns[1].child.kills, 0);
  assert.equal(spawns[3].child.kills, 0);
});

test("a request while a turn of the thread runs is a no-op, and a request for another thread is not", async (context) => {
  const { h, spawns, warm } = await warmHarness(context);
  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.equal(spawns.length, 1, "the turn's own run");
  assert.deepEqual(await warm(), { ok: true });
  assert.equal(spawns.length, 1, "nothing starts while the thread's turn runs");
  assert.deepEqual(await warm({}, otherRepositoryId), { ok: true });
  assert.equal(spawns.length, 2, "another thread may wait");
  reply(spawns[0].child, "Done.");
});

test("a run that exits or fails before it is used is discarded without a word, and the next send starts fresh", async (context) => {
  const { h, spawns, warm, actions, clock } = await warmHarness(context);
  await warm();
  spawns[0].child.emit("close", 1);
  assert.deepEqual(actions(), ["declare", "withdraw"]);
  assert.equal(clock.timers.size, 0);
  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].child.stdin.writes.length, 1);
  reply(spawns[1].child, "Fresh.");

  const failing = await warmHarness(context);
  failing.spawns.length = 0;
  await failing.warm();
  failing.spawns[0].child.emit("error", new Error("spawn EPERM C:\\private"));
  assert.deepEqual(failing.actions(), ["declare", "withdraw"]);
  assert.deepEqual(await failing.h.handle("list", { repositoryId }), { ok: true, conversations: [], running: null });
});

test("a spawn that throws leaves no run behind and no declaration", async (context) => {
  const { warm, actions } = await warmHarness(context, { spawn: () => { throw new Error("EACCES C:\\private\\claude.exe"); } });
  assert.deepEqual(await warm(), { ok: true });
  assert.deepEqual(actions(), ["declare", "withdraw"]);
});

test("Codex has no warm run: a request for it starts nothing, declares nothing, and a Codex thread asks for none", async (context) => {
  const { h, spawns, warm, actions } = await warmHarness(context);
  assert.deepEqual(await warm({ provider: "codex" }), { ok: true });
  assert.equal(spawns.length, 0);
  assert.deepEqual(actions(), []);
  // Without a run in the request the thread's last run decides: a Codex thread warms nothing.
  const sent = await send(h, { provider: "codex" });
  assert.equal(sent.ok, true);
  reply(spawns[0].child, "Done.");
  await until(async () => (await h.handle("list", { repositoryId })).running === null);
  assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawns.length, 1, "only the turn's own process");
});

test("a request without a run uses the run the thread last had, and none when the thread is new", async (context) => {
  const { h, spawns } = await warmHarness(context);
  assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
  assert.equal(spawns.length, 0, "a thread with no run has nothing to warm");
  const sent = await send(h, { model: "claude-sonnet-4" });
  reply(spawns[0].child, "Done.");
  await until(() => spawns.length === 2);
  // The answer itself warmed the same run it was given.
  assert.equal(spawns[1].args[spawns[1].args.indexOf("--model") + 1], "claude-sonnet-4");
  assert.equal(sent.ok, true);
  assert.deepEqual(await h.handle("warm", { repositoryId }), { ok: true });
  assert.equal(spawns.length, 2, "the same run is kept, not started again");
});

test("an answer that failed warms nothing", async (context) => {
  const { h, spawns } = await warmHarness(context);
  const sent = await send(h);
  spawns[0].child.emit("close", 1);
  await until(async () => (await h.handle("list", { repositoryId })).running === null);
  assert.equal(sent.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawns.length, 1);
});

// A thread of 24 messages of 1,500 characters each outgrows the prompt's history, so a compaction runs after the next turn.
const longThread = () => Array.from({ length: 24 }, (_, index) => {
  const text = `m${index + 1} ${"x".repeat(1_495)}`;
  const at = new Date(Date.UTC(2026, 8, 1, 12, index)).toISOString();
  return index % 2 === 0 ? { ...userMessage(index + 1, text), at } : agentMessage(index + 1, { text, at });
});

test("no run is warmed while a compaction of the thread runs; one is when the compaction has ended", async (context) => {
  const { h, spawns } = await warmHarness(context);
  await seed(h, { messages: longThread() });
  const sent = await send(h);
  assert.equal(sent.ok, true);
  reply(spawns[0].child, "Answered.");
  await until(() => spawns.length === 2);
  assert.ok(spawns[1].args.includes("--tools") && spawns[1].args[spawns[1].args.indexOf("--tools") + 1] === "", "the compaction run has no tools");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawns.length, 2, "nothing waits while the compaction runs");
  assert.deepEqual(await h.handle("warm", { repositoryId, ...CLAUDE }), { ok: true });
  assert.equal(spawns.length, 2, "an explicit request is a no-op then too");
  reply(spawns[1].child, "A summary of the earlier messages.");
  await until(() => spawns.length === 3);
  assert.equal(spawns[2].args[spawns[2].args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.deepEqual(spawns[2].child.stdin.writes, []);
});

test("stopping a turn that took a warm run ends its process as it does for any turn", async (context) => {
  const { h, spawns, warm, actions } = await warmHarness(context);
  await warm();
  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.equal((await h.handle("stop", { repositoryId, conversationId: sent.conversationId })).ok, true);
  assert.equal(spawns[0].child.kills, 1);
  await until(async () => (await h.handle("list", { repositoryId })).running === null);
  const message = (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).conversation.messages.at(-1);
  assert.equal(message.status, "stopped");
  assert.equal(message.timing.warm, true);
  await until(() => actions().includes("withdraw"));
});

test("a warm request is checked like every operation: an exact payload of a repository and a whole run", async (context) => {
  const { h, spawns } = await warmHarness(context);
  const invalid = { ok: false, error: "invalid" };
  for (const payload of [
    { repositoryId: "repo-short" }, {}, { repositoryId, extra: 1 }, { repositoryId, provider: "claude" }, { repositoryId, provider: "claude", model: null },
    { repositoryId, ...CLAUDE, text: "no" }, { repositoryId, provider: "gemini", model: null, effort: null }, { repositoryId, provider: "claude", model: "--help x", effort: null },
    { repositoryId, provider: "claude", model: null, effort: "max" }, { repositoryId, provider: "claude", model: 5, effort: null }, { repositoryId, provider: "claude", model: undefined, effort: null },
  ]) assert.deepEqual(await h.handle("warm", payload), invalid, JSON.stringify(payload));
  assert.equal(spawns.length, 0);
  assert.deepEqual(await h.handle("warm", { repositoryId, provider: "claude", model: "claude-opus-4-1[1m]", effort: "xhigh" }), { ok: true });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args[spawns[0].args.indexOf("--effort") + 1], "xhigh");
});

test("a paired device may warm; a disposed chat refuses", async (context) => {
  const { h, spawns } = await warmHarness(context);
  assert.deepEqual(await h.chat.handle("warm", { repositoryId, ...CLAUDE }, { paired: true }), { ok: true });
  assert.equal(spawns.length, 1);
  h.chat.dispose();
  assert.deepEqual(await h.chat.handle("warm", { repositoryId, ...CLAUDE }), { ok: false, error: "unavailable" });
  assert.equal(spawns.length, 1);
});

test("the waiting run's task bridge refuses every read before its turn starts, answers for the turn that took it, and is revoked at the end", async (context) => {
  const { h, spawns, warm } = await warmHarness(context);
  h.state.actions = (_action, _payload, _body, call) => (call.pathname === "/internal/agent-chat/task" ? { ok: true, task: { id: "T-1" } } : { ok: true });
  await warm();
  const { POMEGR_CHAT_TASK_ORIGIN: bridge, POMEGR_CHAT_TASK_KEY: key } = spawns[0].options.env;
  assert.match(bridge, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const read = () => fetch(`${bridge}/task?task_id=T-1`, { headers: { "x-pomegr-chat-task-key": key } });
  const reads = () => h.calls.filter((call) => call.pathname === "/internal/agent-chat/task").length;
  // The right key from the right address, and still nothing: no turn has taken the run.
  assert.equal((await read()).status, 403);
  assert.equal((await fetch(`${bridge}/tasks`, { headers: { "x-pomegr-chat-task-key": key } })).status, 403);
  assert.equal(reads(), 0, "the monitor was never asked");

  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.equal(spawns.length, 1);
  const answered = await read();
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { ok: true, task: { id: "T-1" } });
  assert.equal(reads(), 1);
  assert.equal((await fetch(`${bridge}/task?task_id=T-1`, { headers: { "x-pomegr-chat-task-key": "wrong" } })).status, 403);

  reply(spawns[0].child, "Done.");
  await until(async () => (await h.handle("list", { repositoryId })).running === null);
  await assert.rejects(() => read(), "the bridge closed with the turn");
});

test("a waiting run's bridge is closed with the run, whichever way the run ends", async (context) => {
  const { spawns, warm, clock } = await warmHarness(context);
  await warm();
  const { POMEGR_CHAT_TASK_ORIGIN: bridge, POMEGR_CHAT_TASK_KEY: key } = spawns[0].options.env;
  clock.fire();
  await assert.rejects(() => fetch(`${bridge}/task?task_id=T-1`, { headers: { "x-pomegr-chat-task-key": key } }));
});

test("the warm module: nothing starts without a process, for another provider, while the thread is busy, or after quitting", async () => {
  const started = [];
  const base = {
    startProcess: (options) => { started.push(options); return { alive: () => true, onExit: () => () => {}, close() {}, begin: () => null }; },
    spawn() {}, clock: () => 0, executable: () => "C:\\bin\\claude.exe", repositoryRoot: async () => "C:\\Work\\repo", instructions: async () => null,
    imageFolder: async () => null, environment: async () => ({}), declare: async () => "0b7c2a4e-1f3d-4c5b-9a8e-7d6f5e4c3b2a", redeclare() {}, withdraw() {},
    openBridge: async () => null, busy: () => false,
  };
  const withoutProcess = createWarmRuns({ ...base, startProcess: null });
  await withoutProcess.request("repo-1", CLAUDE);
  const busy = createWarmRuns({ ...base, busy: () => true });
  await busy.request("repo-1", CLAUDE);
  const codex = createWarmRuns(base);
  await codex.request("repo-1", { provider: "codex", model: null, effort: null });
  assert.equal(started.length, 0);
  const quitting = createWarmRuns(base);
  quitting.dispose();
  await quitting.request("repo-1", CLAUDE);
  assert.equal(started.length, 0);
  const ready = createWarmRuns(base);
  await ready.request("repo-1", CLAUDE);
  assert.equal(started.length, 1);
  assert.equal(started[0].images, null);
  assert.equal(ready.holds("repo-1", "claude"), true);
  assert.equal(ready.holds("repo-1", "codex"), false);
  assert.equal(ready.holds("repo-2", "claude"), false);
  // A key that differs closes the run in every field it is made of.
  const key = { repositoryId: "repo-1", provider: "claude", model: null, effort: null, command: "C:\\bin\\claude.exe", root: "C:\\Work\\repo", instructions: null, imageFolder: null };
  for (const change of [{ model: "m" }, { effort: "low" }, { command: "C:\\bin\\other.exe" }, { root: "C:\\Work\\moved" }, { instructions: "C:\\i.md" }, { imageFolder: "C:\\images" }]) {
    const run = createWarmRuns(base);
    await run.request("repo-1", CLAUDE);
    assert.equal(run.take({ ...key, ...change }, {}), null, JSON.stringify(change));
    assert.equal(run.holds("repo-1", "claude"), false, "a run that does not match is closed");
  }
  const match = createWarmRuns(base);
  await match.request("repo-1", CLAUDE);
  const turn = {};
  const taken = match.take(key, turn);
  assert.equal(taken.sessionId, "0b7c2a4e-1f3d-4c5b-9a8e-7d6f5e4c3b2a");
  assert.equal(match.holds("repo-1", "claude"), false, "a taken run is no longer held");
  assert.deepEqual((await taken.begin({ prompt: "p" }).done), { status: "failed", text: "" }, "a run that cannot begin fails the turn");
  assert.equal(match.take(key, {}), null);
});

// ---- the runner's process: a prompt written later ----------------------------------------------------------------

test("a started process holds no prompt, drops output that comes before one, and times the run from the moment its prompt is written", async () => {
  const provider = fakeProvider();
  let now = 100;
  const handle = startChatProcess({ spawn: provider.spawn, executable: "C:\\bin\\claude.exe", provider: "claude", cwd: "C:\\Work", env: {}, clock: () => now });
  const { child } = provider.spawns[0];
  assert.equal(handle.alive(), true);
  assert.deepEqual(child.stdin.writes, []);
  // Output before the prompt belongs to no turn.
  now = 150;
  child.stdout.emit("data", `${JSON.stringify({ type: "system", subtype: "init" })}\n`);
  const seen = [];
  now = 5_000;
  const run = handle.begin({ prompt: "Hello", onText: (text) => seen.push(text), onActivity: (activity) => seen.push(activity), warm: true });
  assert.equal(handle.begin({ prompt: "Again" }), null, "a process takes one prompt");
  assert.deepEqual(child.stdin.writes, [[claudeUserLine("Hello"), "utf8"]]);
  now = 5_040;
  child.stdout.emit("data", `${JSON.stringify({ type: "system", subtype: "init" })}\n`);
  now = 5_300;
  child.stdout.emit("data", `${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }, parent_tool_use_id: null })}\n`);
  now = 5_900;
  child.stdout.emit("data", `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hi" })}\n`);
  assert.equal(child.stdin.ended, true);
  child.emit("close", 0);
  assert.deepEqual(await run.done, { status: "complete", text: "Hi" });
  assert.deepEqual(run.timing(), { eventMs: 40, textMs: 300, doneMs: 900, warm: true });
  assert.equal(handle.alive(), false);
  assert.equal(handle.begin({ prompt: "Late" }), null, "a process that ended takes no prompt");
});

test("a process that exits before its prompt tells its listeners once, and a closed one ends its stdin and itself", async () => {
  const provider = fakeProvider();
  const handle = startChatProcess({ spawn: provider.spawn, executable: "C:\\bin\\claude.exe", provider: "claude", cwd: "C:\\Work", env: {} });
  const exits = [];
  const off = handle.onExit((code) => exits.push(code));
  const { child } = provider.spawns[0];
  handle.close();
  assert.equal(child.stdin.ended, true);
  assert.equal(child.kills, 1);
  await Promise.resolve();
  assert.deepEqual(exits, [null]);
  child.emit("close", 0);
  assert.deepEqual(exits, [null], "told once");
  off();
  const second = fakeProvider();
  const quiet = startChatProcess({ spawn: second.spawn, executable: "C:\\bin\\claude.exe", provider: "claude", cwd: "C:\\Work", env: {} });
  const heard = [];
  quiet.onExit((code) => heard.push(code))();
  second.spawns[0].child.emit("close", 1);
  assert.deepEqual(heard, [], "a listener that was removed hears nothing");
});

test("a Codex process takes its prompt as text up to the end of stdin, so it has nothing to hold", async () => {
  const provider = fakeProvider();
  const handle = startChatProcess({ spawn: provider.spawn, executable: "C:\\bin\\codex.exe", provider: "codex", cwd: "C:\\Work", env: {} });
  const run = handle.begin({ prompt: "Hello" });
  assert.deepEqual(provider.spawns[0].child.stdin.writes, [["Hello", "utf8"]]);
  assert.equal(provider.spawns[0].child.stdin.ended, true);
  provider.spawns[0].child.emit("close", 1);
  assert.equal((await run.done).status, "failed");
});

test("the user line escapes the characters that some readers split lines on", () => {
  const line = claudeUserLine("a\nb\r\nc\u2028d\u2029e \"quoted\" é ✓ \ud83e\udd51");
  assert.equal(line.slice(0, -1).includes("\n"), false);
  assert.equal(line.includes("\u2028") || line.includes("\u2029"), false);
  assert.equal(JSON.parse(line).message.content[0].text, "a\nb\r\nc\u2028d\u2029e \"quoted\" é ✓ \ud83e\udd51");
});
