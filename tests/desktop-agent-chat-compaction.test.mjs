// Compaction of an outgrown thread: the summary record, when a compaction runs and when it does not, its run and prompt, what it stores,
// and what it leaves alone. Everything here runs on fakes: no provider starts and nothing leaves the test.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  COMPACTION_EFFORT, COMPACTION_INSTRUCTIONS, COMPACTION_THRESHOLD, SUMMARY_TARGET, compactionChunk, compactionPrompt, createCompaction, olderThanWindow, summaryFromAnswer, threadSince,
} from "../desktop/runtime/agent-chat-compaction.mjs";
import { HISTORY_BUDGET, PROMPT_LIMIT, historyLine } from "../desktop/runtime/agent-chat-prompt.mjs";
import { SUMMARY_FILE, SUMMARY_LENGTH, normalizeSummary, summarizedView } from "../desktop/runtime/agent-chat-summary.mjs";
import {
  agentMessage, chatHarness, fakeRuns, finishTurn, otherRepositoryId, repositoryId, root, seed, send, until, userMessage,
} from "./helpers/agent-chat-harness.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";
const at = (minute) => new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();
const SIZE = 1_500;
const filler = (label, size = SIZE) => `${label} ${"x".repeat(size - label.length - 1)}`;
// A conversation of `count` messages, the owner first and Aril last when `count` is even, each about `size` characters. With 1,500
// characters the prompt's history holds the newest fifteen, so the rest are the older messages.
const exchange = (count, { size = SIZE, from = 0, label = "m" } = {}) => Array.from({ length: count }, (_, index) => {
  const id = index + 1;
  const text = filler(`${label}${id}`, size);
  return index % 2 === 0 ? { ...userMessage(id, text), at: at(from + index) } : agentMessage(id, { text, at: at(from + index) });
});
const seedThread = (h, count, options = {}) => seed(h, { messages: exchange(count, options), ...options.seed });
// 18 messages leave 3 older ones (about 4,500 characters); 23 leave 8 (about 12,000), over the threshold of 8,000.
const SHORT = 18;
const LONG = 24;
const quiet = () => new Promise((resolve) => setTimeout(resolve, 80));

const GOOD = Object.freeze({
  text: "Decided to start with T-2.\nOpen: which model for T-5.", through: { conversationId: "chat-0123456789ab", messageId: "m-4", at: at(3) }, at: at(9),
  provider: "claude", model: "claude-opus-5-5", effort: "low",
  timing: { eventMs: 1, textMs: 2, doneMs: 3, prompt: { instructions: 1, board: 0, taskLog: 0, conversation: 2, message: 0, other: 0 } },
});

const compactions = (h) => h.runs.filter((run) => run.options.tools === "none");
const nextCompaction = (h, index = 0) => until(() => compactions(h)[index] ?? null);
const summaryIs = (h, text) => until(async () => { const summary = await h.summaries.read(repositoryId); return summary?.text === text ? summary : null; });

/** A compaction controller over the harness's store and summaries, with a fake run, so a test drives it without a chat around it. */
function unit(h, overrides = {}) {
  const fakes = fakeRuns();
  const declared = [];
  const withdrawn = [];
  const compaction = createCompaction({
    store: h.store, summaries: h.summaries, now: h.now, runTurn: fakes.runTurn, spawn: h.spawn, env: { PATH: "C:\\Tools" },
    executable: (provider) => `C:\\bin\\${provider}.exe`, repositoryRoot: async () => root,
    declare: async (provider) => { declared.push(provider); return provider === "claude" ? SESSION : null; }, withdraw: (id) => withdrawn.push(id), busy: () => false, ...overrides,
  });
  return { compaction, runs: fakes.runs, declared, withdrawn };
}

async function olderOf(h) {
  const { messages } = await threadSince({ store: h.store, summaries: h.summaries, repositoryId });
  const older = olderThanWindow(messages);
  return { older, last: older.at(-1), all: messages };
}

test("a summary record is a bounded text, the position it ends at, when it was written, and the run that wrote it", () => {
  assert.deepEqual(normalizeSummary(GOOD), GOOD);
  const bare = { text: GOOD.text, through: GOOD.through, at: GOOD.at, provider: "codex", model: null };
  assert.deepEqual(normalizeSummary(bare), bare, "the effort and the timing are optional, and so is the model");
  assert.equal(normalizeSummary({ ...GOOD, text: "x".repeat(SUMMARY_LENGTH) }).text.length, SUMMARY_LENGTH);
  assert.equal(normalizeSummary({ ...GOOD, text: "a\tb\nc" }).text, "a\tb\nc");
  for (const bad of [
    null, [], "text", { ...GOOD, text: "" }, { ...GOOD, text: "  \n " }, { ...GOOD, text: "x".repeat(SUMMARY_LENGTH + 1) }, { ...GOOD, text: "a\u0000b" }, { ...GOOD, text: "a\u0085b" }, { ...GOOD, text: 5 },
    { ...GOOD, through: null }, { ...GOOD, through: { ...GOOD.through, conversationId: "chat-x" } }, { ...GOOD, through: { ...GOOD.through, messageId: "m-0" } },
    { ...GOOD, through: { ...GOOD.through, at: "yesterday" } }, { ...GOOD, at: "soon" }, { ...GOOD, at: undefined }, { ...GOOD, provider: "gemini" }, { ...GOOD, model: "bad model" },
    { ...GOOD, effort: "max" }, { ...GOOD, effort: 3 },
  ]) assert.equal(normalizeSummary(bad), null, JSON.stringify(bad).slice(0, 120));
  // A timing outside its contract is left out; the summary keeps its text. Another key is not kept.
  const dropped = normalizeSummary({ ...GOOD, timing: { ...GOOD.timing, doneMs: -1 }, extra: "a prompt" });
  assert.equal(dropped.text, GOOD.text);
  assert.equal(Object.hasOwn(dropped, "timing"), false);
  assert.equal(Object.hasOwn(dropped, "extra"), false);
});

test("a client may know where a summary ends and when it was written, and never its text", () => {
  const view = summarizedView(normalizeSummary(GOOD));
  assert.deepEqual(view, { through: GOOD.through, at: GOOD.at });
  assert.equal(JSON.stringify(view).includes("Decided"), false);
  assert.equal(summarizedView(null), null);
  assert.equal(summarizedView(undefined), null);
});

test("the summary is one private file beside the repository's conversations, read back after a restart, and an invalid file reads as none", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seedThread(h, 4);
  assert.equal(await h.summaries.read(repositoryId), null);
  assert.equal(await h.summaries.write(repositoryId, GOOD), true);
  const file = path.join(h.directory, repositoryId, SUMMARY_FILE);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, repositoryId, summary: GOOD });
  assert.deepEqual(await h.reloadSummaries().read(repositoryId), GOOD, "a new process reads it from disk");
  // The conversations of the repository are unchanged by it.
  assert.deepEqual((await h.reload().index(repositoryId)).map((meta) => meta.id), [conversation.id]);
  // A summary outside the contract is refused and changes nothing.
  assert.equal(await h.summaries.write(repositoryId, { ...GOOD, text: "" }), false);
  assert.equal(await h.summaries.write("repo-x", GOOD), false);
  assert.deepEqual(await h.reloadSummaries().read(repositoryId), GOOD);
  // A file of another version, another repository, or no JSON reads as none; it is not deleted.
  for (const content of [JSON.stringify({ version: 2, repositoryId, summary: GOOD }), JSON.stringify({ version: 1, repositoryId: "repo-fedcba9876543210fedcba98", summary: GOOD }),
    "{not json", JSON.stringify({ version: 1, repositoryId, summary: { ...GOOD, text: "" } }), `${JSON.stringify({ version: 1, repositoryId, summary: GOOD })}${" ".repeat(70_000)}`]) {
    await fs.writeFile(file, content, "utf8");
    assert.equal(await h.reloadSummaries().read(repositoryId), null);
    assert.equal(await fs.readFile(file, "utf8"), content);
  }
  assert.equal(await h.reloadSummaries().read("repo-x"), null);
});

test("older messages short of the threshold start no compaction", async (context) => {
  const h = await chatHarness(context);
  await seedThread(h, SHORT);
  const { older } = await olderOf(h);
  assert.ok(older.length >= 2 && older.map(historyLine).join("\n").length <= COMPACTION_THRESHOLD);
  const { compaction, runs } = unit(h);
  compaction.afterTurn(repositoryId);
  await quiet();
  assert.equal(runs.length, 0);
  assert.equal(compaction.running(repositoryId), false);
  assert.equal(await h.summaries.read(repositoryId), null);
});

test("older messages past the threshold start one run on the thread's provider and model at low effort, with no tool, and store the summary it answers", async (context) => {
  const h = await chatHarness(context);
  await seed(h, { model: "claude-opus-5-5", messages: exchange(LONG) });
  const { older, last } = await olderOf(h);
  assert.ok(older.map(historyLine).join("\n").length > COMPACTION_THRESHOLD);
  const { compaction, runs, declared, withdrawn } = unit(h);
  compaction.afterTurn(repositoryId);
  const run = await until(() => runs[0]);
  assert.equal(compaction.running(repositoryId), true);
  const { options } = run;
  assert.deepEqual([options.provider, options.model, options.effort, options.tools, options.mcpServer, options.images, options.instructionsFile, options.cwd, options.sessionId],
    ["claude", "claude-opus-5-5", COMPACTION_EFFORT, "none", null, null, null, root, SESSION]);
  assert.equal(COMPACTION_EFFORT, "low");
  assert.deepEqual(declared, ["claude"], "a Claude Code run is declared, so it never shows in Sessions");
  assert.ok(options.prompt.startsWith(COMPACTION_INSTRUCTIONS));
  assert.match(COMPACTION_INSTRUCTIONS, new RegExp(`at most ${SUMMARY_TARGET} characters`, "u"));
  // The prompt holds the older messages, oldest first, and none of the newest ones that the prompt's history keeps.
  const body = /<messages>\n([\s\S]*)\n<\/messages>/u.exec(options.prompt)[1];
  assert.equal(body, older.map(historyLine).join("\n"));
  assert.equal(options.prompt.includes("<earlier_summary>"), false);
  const { all } = await olderOf(h);
  assert.equal(options.prompt.includes(all.at(-1).text), false);
  run.measured = { eventMs: 300, textMs: 2_000, doneMs: 4_500 };
  run.resolve({ status: "complete", text: "Owner chose T-2 first.\nOpen: model for T-5." });
  const summary = await summaryIs(h, "Owner chose T-2 first.\nOpen: model for T-5.");
  assert.deepEqual(summary.through, { conversationId: last.conversationId, messageId: last.id, at: last.at });
  assert.deepEqual([summary.provider, summary.model, summary.effort], ["claude", "claude-opus-5-5", "low"]);
  assert.equal(Number.isFinite(Date.parse(summary.at)), true);
  assert.deepEqual([summary.timing.eventMs, summary.timing.textMs, summary.timing.doneMs], [300, 2_000, 4_500]);
  assert.equal(summary.timing.prompt.instructions, COMPACTION_INSTRUCTIONS.length);
  assert.equal(summary.timing.prompt.board + summary.timing.prompt.taskLog + summary.timing.prompt.message, 0);
  assert.equal(Object.values(summary.timing.prompt).reduce((sum, length) => sum + length, 0), options.prompt.length);
  assert.deepEqual(await h.reloadSummaries().read(repositoryId), summary, "it is on disk");
  await until(() => !compaction.running(repositoryId));
  assert.deepEqual(withdrawn, [SESSION], "the declaration is withdrawn when the run ends");
  assert.equal(runs.length, 1, "what remains is short of the threshold: no second run");
});

test("only one compaction runs for a repository at a time", async (context) => {
  const h = await chatHarness(context);
  await seedThread(h, LONG);
  const { compaction, runs } = unit(h);
  compaction.afterTurn(repositoryId);
  await until(() => runs[0]);
  compaction.afterTurn(repositoryId);
  compaction.afterTurn(repositoryId);
  await quiet();
  assert.equal(runs.length, 1);
  runs[0].resolve({ status: "complete", text: "Summary." });
  await summaryIs(h, "Summary.");
  await until(() => !compaction.running(repositoryId));
});

test("no compaction starts while a turn of the repository runs or waits, after dispose, or for a provider that is not installed", async (context) => {
  const h = await chatHarness(context);
  await seedThread(h, LONG);
  const held = unit(h, { busy: (id) => id === repositoryId });
  held.compaction.afterTurn(repositoryId);
  await quiet();
  assert.equal(held.runs.length, 0);
  const gone = unit(h);
  gone.compaction.dispose();
  gone.compaction.afterTurn(repositoryId);
  await quiet();
  assert.equal(gone.runs.length, 0);
  const none = unit(h, { executable: () => null });
  none.compaction.afterTurn(repositoryId);
  await quiet();
  assert.equal(none.runs.length, 0, "a provider that is not installed starts nothing");
});

test("a turn that starts stops the compaction, which is tried again after the next turn", async (context) => {
  const h = await chatHarness(context);
  await seedThread(h, LONG);
  const { compaction, runs, withdrawn } = unit(h);
  compaction.afterTurn(repositoryId);
  const run = await until(() => runs[0]);
  assert.equal(compaction.cancel(repositoryId), true);
  assert.equal(run.stops, 1, "Pomegr stops its own read-only run");
  assert.equal(compaction.running(repositoryId), false);
  assert.equal(compaction.cancel(repositoryId), false);
  // The run ends late with a whole answer: nothing is stored.
  run.resolve({ status: "complete", text: "Too late." });
  await quiet();
  assert.equal(await h.summaries.read(repositoryId), null);
  assert.deepEqual(withdrawn, [SESSION]);
  compaction.afterTurn(repositoryId);
  const again = await until(() => runs[1]);
  again.resolve({ status: "complete", text: "Second try." });
  await summaryIs(h, "Second try.");
  await until(() => !compaction.running(repositoryId));
  assert.equal(runs[1].stops, 0);
});

test("a controller that is disposed stops its run and stores nothing", async (context) => {
  const h = await chatHarness(context);
  await seedThread(h, LONG);
  const { compaction, runs } = unit(h);
  compaction.afterTurn(repositoryId);
  const run = await until(() => runs[0]);
  compaction.dispose();
  assert.equal(run.stops, 1);
  run.resolve({ status: "complete", text: "After dispose." });
  await quiet();
  assert.equal(await h.summaries.read(repositoryId), null);
});

test("a run that fails, is stopped, times out, or answers outside the contract leaves the old summary as it was", async (context) => {
  const h = await chatHarness(context);
  await seedThread(h, LONG);
  const first = (await olderOf(h)).older[1];
  const old = { ...GOOD, through: { conversationId: first.conversationId, messageId: first.id, at: first.at }, text: "The old summary." };
  assert.equal(await h.summaries.write(repositoryId, old), true);
  const { compaction, runs } = unit(h);
  const outcomes = [
    { status: "failed", text: "" }, { status: "stopped", text: "Half" }, { status: "timed_out", text: "Half" }, { status: "complete", text: "" }, { status: "complete", text: "  \n" },
    { status: "complete", text: "x".repeat(SUMMARY_LENGTH + 1) }, { status: "complete", text: "a\u0000b" }, { status: "complete", text: 42 }, null,
  ];
  for (const [index, outcome] of outcomes.entries()) {
    compaction.afterTurn(repositoryId);
    const run = await until(() => runs[index]);
    if (outcome === null) run.reject(new Error("the run broke")); else run.resolve(outcome);
    await until(() => !compaction.running(repositoryId));
    assert.deepEqual(await h.reloadSummaries().read(repositoryId), old, JSON.stringify(outcome)?.slice(0, 60));
  }
  assert.equal(runs.length, outcomes.length, "each completed turn tries again");
  assert.equal((await h.reload().index(repositoryId)).length, 1, "the thread itself is untouched");
});

test("the summary replaces the old one and covers the messages after it, so the next run starts from it", async (context) => {
  const h = await chatHarness(context);
  await seedThread(h, LONG);
  const { older } = await olderOf(h);
  const early = older[2];
  assert.equal(await h.summaries.write(repositoryId, { ...GOOD, through: { conversationId: early.conversationId, messageId: early.id, at: early.at }, text: "Earlier decisions." }), true);
  const { compaction, runs } = unit(h);
  const { all } = await olderOf(h);
  assert.equal(all.some((message) => message.id === early.id), false, "the messages the summary covers are not read again");
  compaction.afterTurn(repositoryId);
  // Fewer older messages remain after the summary, and they are still over the threshold.
  assert.ok(older.slice(3).map(historyLine).join("\n").length > COMPACTION_THRESHOLD);
  const run = await until(() => runs[0]);
  assert.equal(/<messages>\n([\s\S]*)\n<\/messages>/u.exec(run.options.prompt)[1], older.slice(3).map(historyLine).join("\n"), "only the messages after the summary are sent");
  assert.match(run.options.prompt, /<earlier_summary>\nEarlier decisions\.\n<\/earlier_summary>\n\n<messages>\n/u);
  run.resolve({ status: "complete", text: "Earlier decisions, and more." });
  const summary = await summaryIs(h, "Earlier decisions, and more.");
  assert.equal(summary.through.messageId, older.at(-1).id);
});

test("a thread past the prompt limit is compacted in chunks, oldest first, each run starting from the summary before it", async (context) => {
  const h = await chatHarness(context);
  // Ten answers of 30,000 characters: none fits the prompt's history, and together they are over one compaction prompt.
  await seed(h, { messages: Array.from({ length: 10 }, (_, index) => agentMessage(index + 1, { text: filler(`big${index + 1}`, 30_000), at: at(index) })) });
  const { older } = await olderOf(h);
  assert.ok(older.map(historyLine).join("\n").length > PROMPT_LIMIT, "more than one prompt holds");
  const { compaction, runs } = unit(h);
  compaction.afterTurn(repositoryId);
  const one = await until(() => runs[0]);
  assert.ok(one.options.prompt.length <= PROMPT_LIMIT);
  const taken = /<messages>\n([\s\S]*)\n<\/messages>/u.exec(one.options.prompt)[1];
  const firstChunk = compactionChunk(older, undefined);
  assert.ok(firstChunk.length > 1 && firstChunk.length < older.length);
  assert.equal(taken, firstChunk.map(historyLine).join("\n"));
  assert.equal(runs.length, 1, "the second run waits for the first");
  one.resolve({ status: "complete", text: "First chunk summary." });
  const two = await until(() => runs[1]);
  assert.ok(two.options.prompt.length <= PROMPT_LIMIT);
  assert.match(two.options.prompt, /<earlier_summary>\nFirst chunk summary\.\n<\/earlier_summary>/u);
  const second = /<messages>\n([\s\S]*)\n<\/messages>/u.exec(two.options.prompt)[1];
  assert.equal(second, older.slice(firstChunk.length, firstChunk.length + compactionChunk(older.slice(firstChunk.length), "First chunk summary.").length).map(historyLine).join("\n"));
  // The first chunk is already stored: a later failure keeps it.
  assert.equal((await h.summaries.read(repositoryId)).text, "First chunk summary.");
  assert.equal((await h.summaries.read(repositoryId)).through.messageId, firstChunk.at(-1).id);
  two.resolve({ status: "complete", text: "Whole summary." });
  const summary = await summaryIs(h, "Whole summary.");
  assert.deepEqual(summary.through, { conversationId: older.at(-1).conversationId, messageId: older.at(-1).id, at: older.at(-1).at });
  assert.equal(runs.length, 2, "two runs hold the whole thread");
  await until(() => !compaction.running(repositoryId));
});

test("a chunk that fails keeps the summary the chunks before it stored", async (context) => {
  const h = await chatHarness(context);
  await seed(h, { messages: Array.from({ length: 10 }, (_, index) => agentMessage(index + 1, { text: filler(`big${index + 1}`, 30_000), at: at(index) })) });
  const { older } = await olderOf(h);
  const { compaction, runs } = unit(h);
  compaction.afterTurn(repositoryId);
  (await until(() => runs[0])).resolve({ status: "complete", text: "First chunk." });
  const second = await until(() => runs[1]);
  second.resolve({ status: "failed", text: "" });
  await until(() => !compaction.running(repositoryId));
  const kept = await h.reloadSummaries().read(repositoryId);
  assert.equal(kept.text, "First chunk.");
  assert.equal(kept.through.messageId, compactionChunk(older, undefined).at(-1).id, "it covers only the first chunk");
  // The next turn starts from it, with the messages after it.
  compaction.afterTurn(repositoryId);
  const retry = await until(() => runs[2]);
  assert.match(retry.options.prompt, /<earlier_summary>\nFirst chunk\.\n<\/earlier_summary>/u);
  retry.resolve({ status: "complete", text: "Whole." });
  await summaryIs(h, "Whole.");
  await until(() => !compaction.running(repositoryId));
});

test("a chunk always holds at least one message, and the prompt of a compaction names its parts", () => {
  const message = (id, text) => ({ conversationId: "chat-0123456789ab", id: `m-${id}`, role: "agent", text, at: at(id), provider: "claude", model: null, status: "complete" });
  const huge = [message(1, "y".repeat(32_000)), message(2, "z".repeat(32_000))];
  assert.equal(compactionChunk(huge, "s".repeat(SUMMARY_LENGTH)).length, 2, "two answers of 32,000 characters fit one prompt");
  assert.equal(compactionChunk(Array.from({ length: 10 }, (_, index) => message(index + 1, "y".repeat(32_000))), "s".repeat(SUMMARY_LENGTH)).length, 5);
  assert.equal(compactionChunk([message(1, "y".repeat(PROMPT_LIMIT))], undefined).length, 1, "a message too long for any prompt still forms a chunk");
  assert.equal(compactionPrompt(null, [message(1, "y".repeat(PROMPT_LIMIT))]), null, "and its prompt is refused");
  const composed = compactionPrompt("Earlier.", [message(1, "A decision."), message(2, "Another.")]);
  assert.equal(composed.prompt, [COMPACTION_INSTRUCTIONS, "", "<earlier_summary>", "Earlier.", "</earlier_summary>", "", "<messages>", "Aril: A decision.", "Aril: Another.", "</messages>"].join("\n"));
  assert.deepEqual(Object.keys(composed.sections), ["instructions", "board", "taskLog", "conversation", "message", "other"]);
  assert.equal(Object.values(composed.sections).reduce((sum, length) => sum + length, 0), composed.prompt.length);
  assert.equal(compactionPrompt(null, [message(1, "x")]).prompt.includes("<earlier_summary>"), false);
});

test("the answer of a compaction is stored as plain text: a proposal block is dropped and nothing in it is applied", async (context) => {
  const h = await chatHarness(context);
  await seedThread(h, LONG);
  const block = ["```pomegr-board", JSON.stringify({ summary: "Do things", operations: [{ op: "create_task", text: "A task" }, { op: "declare_rework", fix: "T-2", reworks: "T-1", cause: "latent" }, { op: "start_session", id: "T-2" }] }), "```"].join("\n");
  const { compaction, runs } = unit(h);
  compaction.afterTurn(repositoryId);
  const run = await until(() => runs[0]);
  run.resolve({ status: "complete", text: `Owner chose T-2.\n\n${block}\n\nOpen: model.\n\n\`\`\`pomegr-board\n{"summary":"never closed"` });
  const summary = await until(async () => await h.summaries.read(repositoryId));
  assert.equal(summary.text, "Owner chose T-2.\n\nOpen: model.");
  assert.equal(summary.text.includes("pomegr-board"), false);
  await until(() => !compaction.running(repositoryId));
  // Nothing reached the board or the monitor for it, and no proposal was written into the thread.
  assert.deepEqual(h.actionCalls(), []);
  assert.deepEqual(h.requests((call) => call.pathname.includes("aril-declare-rework") || call.pathname.includes("start")), []);
  const stored = await h.reload().index(repositoryId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].messages, LONG, "no message was added by the compaction");
  assert.equal(summaryFromAnswer("Plain\r\ntext"), "Plain\ntext");
  assert.equal(summaryFromAnswer(undefined), "");
  // A choices block is no part of a summary either, closed or not.
  assert.equal(summaryFromAnswer('Decided.\n\n```pomegr-replies\n{"replies":["Yes"]}\n```\n\nOpen: model.\n\n```pomegr-replies\n{"replies":['), "Decided.\n\nOpen: model.");
});

test("a compaction runs after a complete turn of the chat, never after one that did not complete", async (context) => {
  const h = await chatHarness(context);
  await seed(h, { model: "claude-opus-5-5", messages: exchange(LONG) });
  const failed = await send(h, { model: "claude-opus-5-5", effort: "high" });
  await finishTurn(h, h.runs[0], { status: "failed", text: "" }, failed.conversationId);
  await quiet();
  assert.equal(compactions(h).length, 0, "a failed turn is no reason to ask the provider again");
  const sent = await send(h, { conversationId: failed.conversationId, model: "claude-opus-5-5", effort: "high", text: "Again" });
  await finishTurn(h, h.runs[1], { status: "complete", text: "Done." }, sent.conversationId);
  const run = await nextCompaction(h);
  assert.deepEqual([run.options.provider, run.options.model, run.options.effort, run.options.tools, run.options.mcpServer], ["claude", "claude-opus-5-5", "low", "none", null]);
  assert.equal(h.declarations.filter(({ action }) => action === "declare").at(-1).sessionId, run.options.sessionId);
  run.resolve({ status: "complete", text: "Chose T-2." });
  await summaryIs(h, "Chose T-2.");
  await until(() => h.declarations.filter(({ action }) => action === "withdraw").at(-1)?.sessionId === run.options.sessionId);
});

test("a message of the owner stops the compaction of its repository, and the next completed turn tries again", async (context) => {
  const h = await chatHarness(context);
  await seed(h, { messages: exchange(LONG) });
  const first = await send(h);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, first.conversationId);
  const run = await nextCompaction(h);
  const second = await send(h, { conversationId: first.conversationId, text: "One more thing" });
  assert.equal(second.ok, true, "the message is not refused for the compaction");
  assert.equal(run.stops, 1);
  run.resolve({ status: "complete", text: "Late summary." });
  await finishTurn(h, h.runs.find((candidate) => candidate.options.tools !== "none" && candidate !== h.runs[0]), { status: "complete", text: "Noted." }, second.conversationId);
  assert.equal(await h.summaries.read(repositoryId), null, "the stopped run stored nothing");
  const again = await nextCompaction(h, 1);
  again.resolve({ status: "complete", text: "Second summary." });
  await summaryIs(h, "Second summary.");
  assert.equal(again.stops, 0);
});

test("a repository's compaction is its own: another repository's turn neither stops it nor is held by it", async (context) => {
  const h = await chatHarness(context);
  await seed(h, { messages: exchange(LONG) });
  const first = await send(h);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, first.conversationId);
  const run = await nextCompaction(h);
  h.state.board = { ...h.state.board, repositoryId: otherRepositoryId };
  const other = await send(h, { repositoryId: otherRepositoryId, text: "Elsewhere" });
  assert.equal(other.ok, true);
  assert.equal(run.stops, 0);
  assert.equal(HISTORY_BUDGET, 24_000);
  run.resolve({ status: "complete", text: "Summary." });
  await summaryIs(h, "Summary.");
  assert.equal(await h.summaries.read(otherRepositoryId), null);
});
