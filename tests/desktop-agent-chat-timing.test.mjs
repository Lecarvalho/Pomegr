// The timing of a chat run: the milliseconds from the start of the provider process to its first event, its first words, and its end,
// and the length of each part of the prompt. Numbers only. The run measures itself, the answer of an owner's message stores the
// timing, and an older record without one stays valid. Everything here runs on fakes: no provider starts.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AGENT_CHAT_INSTRUCTIONS } from "../desktop/runtime/agent-chat-prompt.mjs";
import { chatArguments, CLAUDE_FILE_TOOLS, runChatTurn } from "../desktop/runtime/agent-chat-runner.mjs";
import { normalizeConversation } from "../desktop/runtime/agent-chat-store.mjs";
import { normalizeTiming, PROMPT_PARTS, PROMPT_PART_MAX, TIMING_MAX_MS, timingOf } from "../desktop/runtime/agent-chat-timing.mjs";
import { agentMessage, chatHarness, finishTurn, repositoryId, seed, send, stamp, userMessage } from "./helpers/agent-chat-harness.mjs";

const PROMPT = Object.freeze({ instructions: 24_000, board: 18_000, taskLog: 300, conversation: 9_000, message: 52, other: 1_800 });
const TIMING = Object.freeze({ eventMs: 1_200, textMs: 6_800, doneMs: 11_400, prompt: PROMPT });

function fakeChild() {
  return Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), stdin: Object.assign(new EventEmitter(), { end() {} }), kill: () => true });
}
const line = (child, event) => child.stdout.emit("data", `${JSON.stringify(event)}\n`);
const delta = (text) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

test("a run measures the time to its first event, its first words, and its end from the start of the process", async () => {
  let now = 1_000;
  const child = fakeChild();
  const turn = runChatTurn({ spawn: () => child, executable: "C:/bin/claude.exe", provider: "claude", cwd: "C:/Work/repo", env: {}, prompt: "Hi", clock: () => now });
  assert.equal(turn.timing(), null, "nothing is measured until the run ends");
  now = 1_200;
  line(child, { type: "system", subtype: "init" });
  now = 1_500;
  line(child, { type: "stream_event", event: { type: "message_start" } });
  now = 1_800;
  line(child, delta("Hello"));
  now = 2_400;
  line(child, { type: "result", subtype: "success", is_error: false, result: "Hello" });
  child.emit("close", 0);
  assert.equal((await turn.done).status, "complete");
  assert.deepEqual(turn.timing(), { eventMs: 200, textMs: 800, doneMs: 1_400 });
});

test("a run that ends before any event or words has only its end", async () => {
  let now = 50;
  const child = fakeChild();
  const turn = runChatTurn({ spawn: () => child, executable: "C:/bin/codex.exe", provider: "codex", cwd: "C:/Work/repo", env: {}, prompt: "Hi", clock: () => now });
  now = 90;
  child.emit("close", 1);
  assert.deepEqual(await turn.done, { status: "failed", text: "" }, "the outcome keeps its shape");
  assert.deepEqual(turn.timing(), { eventMs: null, textMs: null, doneMs: 40 });
  // A first event with no text yet is a start without first words.
  now = 0;
  const quiet = fakeChild();
  const second = runChatTurn({ spawn: () => quiet, executable: "C:/bin/codex.exe", provider: "codex", cwd: "C:/Work/repo", env: {}, prompt: "Hi", clock: () => now });
  now = 30;
  line(quiet, { type: "turn.started" });
  now = 45;
  quiet.emit("close", 1);
  await second.done;
  assert.deepEqual(second.timing(), { eventMs: 30, textMs: null, doneMs: 45 });
});

test("a run that was never started measures nothing, and a stopped run still reports its end", async () => {
  const refused = runChatTurn({ spawn: () => { throw new Error("must not start"); }, executable: "C:/bin/claude.exe", provider: "unknown", cwd: "C:/Work/repo", env: {}, prompt: "Hi" });
  assert.equal((await refused.done).status, "failed");
  assert.equal(refused.timing(), null);
  let now = 0;
  const child = fakeChild();
  child.kill = () => { queueMicrotask(() => { now = 70; child.emit("close", null); }); return true; };
  const stopped = runChatTurn({ spawn: () => child, executable: "C:/bin/claude.exe", provider: "claude", cwd: "C:/Work/repo", env: {}, prompt: "Hi", clock: () => now });
  stopped.stop();
  assert.equal((await stopped.done).status, "stopped");
  assert.deepEqual(stopped.timing(), { eventMs: null, textMs: null, doneMs: 70 });
});

test("a run with no tools gives Claude Code the empty tool list and no allow list, and Codex its read-only sandbox without a server", () => {
  const read = chatArguments("claude", "m-1", null, null, null, null, "low");
  assert.equal(read[read.indexOf("--tools") + 1], CLAUDE_FILE_TOOLS.join(","));
  assert.ok(read.includes("--allowedTools"));
  const none = chatArguments("claude", "m-1", null, null, null, null, "low", "none");
  assert.equal(none[none.indexOf("--tools") + 1], "", "the tool list is empty");
  assert.equal(none.includes("--allowedTools"), false);
  assert.equal(none[none.indexOf("--permission-mode") + 1], "dontAsk");
  assert.deepEqual(none.slice(none.indexOf("--effort"), none.indexOf("--effort") + 2), ["--effort", "low"]);
  const codex = chatArguments("codex", "m-1", null, null, null, null, "low", "none");
  assert.deepEqual(codex, chatArguments("codex", "m-1", null, null, null, null, "low"), "Codex has no switch to remove its shell: the sandbox stays read-only");
  assert.ok(codex.includes("read-only"));
  // Anything but "none" is the default tool set.
  for (const other of [undefined, null, "", "None", "write", 0]) assert.deepEqual(chatArguments("claude", "m-1", null, null, null, null, "low", other), read);
});

test("a timing is whole numbers inside their bounds, with the end last, and nothing else", () => {
  assert.deepEqual(normalizeTiming(TIMING), TIMING);
  assert.deepEqual(normalizeTiming({ ...TIMING, eventMs: null, textMs: null }), { ...TIMING, eventMs: null, textMs: null });
  assert.deepEqual(PROMPT_PARTS, ["instructions", "board", "taskLog", "conversation", "message", "other"]);
  for (const bad of [
    null, [], "1", { ...TIMING, doneMs: -1 }, { ...TIMING, doneMs: 1.5 }, { ...TIMING, doneMs: TIMING_MAX_MS + 1 }, { ...TIMING, doneMs: Number.NaN }, { ...TIMING, doneMs: null },
    { ...TIMING, eventMs: 12_000 }, { ...TIMING, textMs: 12_000 }, { ...TIMING, eventMs: 7_000 }, { ...TIMING, eventMs: "1" }, { ...TIMING, textMs: undefined },
    { ...TIMING, extra: 1 }, { eventMs: 1, textMs: 2, doneMs: 3 }, { ...TIMING, prompt: { ...PROMPT, board: -1 } }, { ...TIMING, prompt: { ...PROMPT, board: PROMPT_PART_MAX + 1 } },
    { ...TIMING, prompt: { ...PROMPT, other: undefined } }, { ...TIMING, prompt: { ...PROMPT, text: "a prompt" } }, { ...TIMING, prompt: { ...PROMPT, board: "18000" } }, { ...TIMING, prompt: null },
  ]) assert.equal(normalizeTiming(bad), null, JSON.stringify(bad));
  assert.equal(Object.hasOwn(normalizeTiming({ ...TIMING, prompt: { ...PROMPT } }).prompt, "text"), false);
});

test("timingOf rounds what a run measured, cuts it to the bounds, and stores nothing for a run that measured nothing", () => {
  assert.deepEqual(timingOf({ eventMs: 1_200.4, textMs: 6_800.6, doneMs: 11_400.2 }, PROMPT), { eventMs: 1_200, textMs: 6_801, doneMs: 11_400, prompt: PROMPT });
  assert.deepEqual(timingOf({ eventMs: null, textMs: null, doneMs: 10 }, { instructions: 5 }).prompt, { instructions: 5, board: 0, taskLog: 0, conversation: 0, message: 0, other: 0 });
  assert.equal(timingOf({ eventMs: 1, textMs: 2, doneMs: 9e9 }, PROMPT).doneMs, TIMING_MAX_MS, "a jumped clock cannot store a number beyond the bound");
  assert.equal(timingOf({ eventMs: 1, textMs: 2, doneMs: 5 }, { ...PROMPT, board: 9e9 }).prompt.board, PROMPT_PART_MAX);
  for (const measured of [null, undefined, {}, { doneMs: Number.NaN }, { doneMs: "5" }, { doneMs: Infinity }, []]) assert.equal(timingOf(measured, PROMPT), null, JSON.stringify(measured));
  assert.equal(timingOf({ doneMs: 5 }, null), null);
  // A first event after the first words cannot be: the record is refused rather than stored out of order.
  assert.equal(timingOf({ eventMs: 900, textMs: 100, doneMs: 1_000 }, PROMPT), null);
});

test("an owner's message stores the timing of its run on the answer, with the length of each part of its prompt", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h, { text: "What should I do first?" });
  const run = h.runs[0];
  run.measured = { eventMs: 1_200, textMs: 6_800, doneMs: 11_400 };
  const conversation = await finishTurn(h, run, { status: "complete", text: "Run T-2 first." }, sent.conversationId);
  const answer = conversation.messages.at(-1);
  assert.deepEqual(Object.keys(answer.timing), ["eventMs", "textMs", "doneMs", "prompt"]);
  assert.deepEqual([answer.timing.eventMs, answer.timing.textMs, answer.timing.doneMs], [1_200, 6_800, 11_400]);
  const prompt = run.options.prompt;
  const { prompt: parts } = answer.timing;
  assert.deepEqual(Object.keys(parts), [...PROMPT_PARTS]);
  assert.equal(parts.instructions, AGENT_CHAT_INSTRUCTIONS.length);
  assert.equal(parts.board, `<board_snapshot>\n${/<board_snapshot>\n([^\n]*)\n<\/board_snapshot>/u.exec(prompt)[1]}\n</board_snapshot>`.length);
  assert.equal(parts.message, "<owner_message>\nWhat should I do first?\n</owner_message>".length);
  assert.ok(parts.taskLog > 0 && parts.conversation > 0);
  assert.equal(Object.values(parts).reduce((sum, length) => sum + length, 0), prompt.length, "the parts and the rest add up to the whole prompt");
  // Numbers only: nothing of the prompt, the board, or the answer is in the record.
  assert.equal(JSON.stringify(answer.timing).includes("Run T-2"), false);
  assert.equal(JSON.stringify(answer.timing).includes("Existing task"), false);
  assert.deepEqual((await h.reload().read(repositoryId, sent.conversationId)).messages.at(-1).timing, answer.timing, "the timing is on disk");
});

test("a failed or stopped run still stores what it measured, and a run that measured nothing stores no timing", async (context) => {
  const h = await chatHarness(context);
  const first = await send(h);
  h.runs[0].measured = { eventMs: null, textMs: null, doneMs: 800 };
  const failed = await finishTurn(h, h.runs[0], { status: "failed", text: "" }, first.conversationId);
  assert.equal(failed.messages.at(-1).status, "failed");
  assert.deepEqual(failed.messages.at(-1).timing.doneMs, 800);
  assert.equal(failed.messages.at(-1).timing.eventMs, null);
  const second = await send(h, { conversationId: first.conversationId, text: "Again" });
  const unmeasured = await finishTurn(h, h.runs[1], { status: "complete", text: "Fine." }, second.conversationId);
  assert.equal(Object.hasOwn(unmeasured.messages.at(-1), "timing"), false);
  const third = await send(h, { conversationId: first.conversationId, text: "And again" });
  h.runs[2].measured = { eventMs: 1, textMs: 2, doneMs: Number.NaN };
  assert.equal(Object.hasOwn((await finishTurn(h, h.runs[2], { status: "complete", text: "Ok." }, third.conversationId)).messages.at(-1), "timing"), false);
});

test("a number that is out of bounds is cut to the bound before it is stored", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h);
  h.runs[0].measured = { eventMs: -5, textMs: 4_000_000, doneMs: 9_999_999_999 };
  const answer = (await finishTurn(h, h.runs[0], { status: "complete", text: "Ok." }, sent.conversationId)).messages.at(-1);
  assert.deepEqual([answer.timing.eventMs, answer.timing.textMs, answer.timing.doneMs], [0, TIMING_MAX_MS, TIMING_MAX_MS]);
});

test("the follow-up after an answered proposal and the grant follow-up store no timing", async (context) => {
  const h = await chatHarness(context);
  const stored = await seed(h, { messages: [userMessage(1), agentMessage(2, { proposal: { id: "p-0123456789ab", summary: "Tidy", state: "pending", operations: [{ op: "queue_task", id: "T-2" }] } })] });
  h.state.actions = () => ({ ok: true });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: stored.id, proposalId: "p-0123456789ab" }), { ok: true });
  const run = await h.followUp();
  run.measured = { eventMs: 1, textMs: 2, doneMs: 3 };
  const conversation = await h.finishFollowUp(stored.id);
  assert.equal(Object.hasOwn(conversation.messages.at(-1), "timing"), false);
  assert.equal(normalizeConversation({ id: "chat-0123456789ab", title: "T", provider: "claude", model: null, createdAt: stamp, updatedAt: stamp,
    messages: [agentMessage(1, { grantFollowUp: true, timing: TIMING })] }), null, "a grant follow-up line is no measured run");
});

test("a record without a timing stays valid, and a timing outside the contract is dropped without losing the message", async (context) => {
  const base = { id: "chat-0123456789ab", title: "T", provider: "claude", model: null, createdAt: stamp, updatedAt: stamp };
  const older = normalizeConversation({ ...base, messages: [userMessage(1), agentMessage(2)] });
  assert.equal(Object.hasOwn(older.messages[1], "timing"), false);
  const kept = normalizeConversation({ ...base, messages: [userMessage(1), agentMessage(2, { timing: TIMING })] });
  assert.deepEqual(kept.messages[1].timing, TIMING);
  for (const bad of [{ ...TIMING, doneMs: -1 }, { ...TIMING, prompt: { ...PROMPT, board: "x" } }, "slow", 12, [], { ...TIMING, secret: "a prompt" }]) {
    const dropped = normalizeConversation({ ...base, messages: [userMessage(1), agentMessage(2, { text: "Kept", timing: bad })] });
    assert.equal(dropped.messages[1].text, "Kept", JSON.stringify(bad));
    assert.equal(Object.hasOwn(dropped.messages[1], "timing"), false, JSON.stringify(bad));
  }
  assert.equal(Object.hasOwn(normalizeConversation({ ...base, messages: [userMessage(1, "Question"), { ...userMessage(2), timing: TIMING }] }).messages[1], "timing"), false, "a message of the owner carries none");
  const h = await chatHarness(context);
  const stored = await seed(h, { messages: [userMessage(1), agentMessage(2, { timing: TIMING })] });
  assert.deepEqual((await h.handle("read", { repositoryId, conversationId: stored.id })).conversation.messages[1].timing, TIMING);
});
