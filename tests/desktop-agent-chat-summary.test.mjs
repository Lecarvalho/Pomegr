// The summary of a thread in the prompt and in what a client reads: the prompt carries it and the newest messages after it, the thread
// says only where it ends, and no read, search, list, or paired-device request ever returns its text. Everything here runs on fakes.

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import { threadSince } from "../desktop/runtime/agent-chat-compaction.mjs";
import {
  AGENT_CHAT_INSTRUCTIONS, BOARD_SNAPSHOT_BUDGET, BOARD_SNAPSHOT_LIMIT, BOARD_SNAPSHOT_ROOM, HISTORY_BUDGET, PROMPT_LIMIT, SUMMARY_SECTION_BUDGET, composePrompt, composePromptParts,
} from "../desktop/runtime/agent-chat-prompt.mjs";
import { SUMMARY_LENGTH } from "../desktop/runtime/agent-chat-summary.mjs";
import { afterPosition } from "../desktop/runtime/agent-chat-thread.mjs";
import { startLanGateway } from "../desktop/runtime/lan-gateway.mjs";
import {
  agentMessage, chatHarness, finishTurn, otherRepositoryId, pendingProposal, repositoryId, seed, send, userMessage,
} from "./helpers/agent-chat-harness.mjs";

const SENTINEL = "SUMMARY-ONLY-CONTENT-7f3a";
const at = (minute) => new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();
const label = (id) => `m${id}`;
const filler = (text, size = 1_500) => `${text} ${"x".repeat(size - text.length - 1)}`;
const exchange = (count) => Array.from({ length: count }, (_, index) => {
  const id = index + 1;
  return index % 2 === 0 ? { ...userMessage(id, filler(label(id))), at: at(index) } : agentMessage(id, { text: filler(label(id)), at: at(index) });
});
const summaryAt = (conversation, messageId, text = `Decided T-2 first. ${SENTINEL}`) => {
  const message = conversation.messages.find((candidate) => candidate.id === messageId);
  return { text, through: { conversationId: conversation.id, messageId, at: message.at }, at: "2026-09-02T08:00:00.000Z", provider: "claude", model: null, effort: "low" };
};
const conversationLines = (prompt) => /<conversation>\n([\s\S]*)\n<\/conversation>/u.exec(prompt)[1];
const mentions = (prompt, id) => new RegExp(`(?:Owner|Aril): ${label(id)} x`, "u").test(prompt);

test("the prompt carries the summary before the conversation, then only the newest messages after it, within the history budget", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: exchange(24) });
  assert.equal(await h.summaries.write(repositoryId, summaryAt(conversation, "m-8")), true);
  const sent = await send(h, { text: "What next?" });
  const prompt = h.runs[0].options.prompt;
  const section = /<summary_of_earlier_conversation>\n([^\n]*)\n(Decided T-2 first\. [^\n]*)\n<\/summary_of_earlier_conversation>\n\n<conversation>/u.exec(prompt);
  assert.ok(section, "the section stands directly before the conversation");
  assert.equal(section[2], `Decided T-2 first. ${SENTINEL}`);
  assert.ok(prompt.indexOf("</task_log_since_last_turn>") < prompt.indexOf("<summary_of_earlier_conversation>"), "after the task log");
  assert.ok(prompt.indexOf("</conversation>") < prompt.indexOf("<owner_message>"));
  assert.equal(prompt.split(SENTINEL).length, 2, "once");
  // The messages the summary covers are not in the conversation; the newest after it are, oldest first, and the oldest that do not fit are left out.
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) assert.equal(mentions(prompt, id), false, `m${id} is in the summary`);
  for (const id of [24, 23, 20, 10]) assert.equal(mentions(prompt, id), true, `m${id} is in the conversation`);
  assert.equal(mentions(prompt, 9), false, "sixteen messages follow the summary, and fifteen fit");
  const history = conversationLines(prompt);
  assert.ok(history.startsWith("(Earlier messages are left out.)\n"));
  assert.ok(history.length <= HISTORY_BUDGET + "(Earlier messages are left out.)\n".length);
  assert.ok(history.indexOf(label(10)) < history.indexOf(label(24)));
  assert.ok(prompt.length <= PROMPT_LIMIT);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
});

test("a thread with no summary, an unreadable summary, or only another repository's summary is sent as before", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: exchange(24) });
  await send(h);
  assert.equal(h.runs[0].options.prompt.includes("summary_of_earlier_conversation"), false);
  assert.equal(mentions(h.runs[0].options.prompt, 10), true, "the same messages fill the history as before");
  assert.equal(mentions(h.runs[0].options.prompt, 9), false);
  // A summary of another repository is not this one's.
  const other = await chatHarness(context);
  const stored = await seed(other, { messages: exchange(24) });
  assert.equal(await other.summaries.write(otherRepositoryId, summaryAt(stored, "m-8")), true);
  await send(other);
  assert.equal(other.runs[0].options.prompt.includes(SENTINEL), false);
  assert.equal(conversation.messages.length, 24);
});

test("the messages after the summary that all fit leave nothing out, and a summary at the newest message leaves the conversation empty", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: exchange(24) });
  await h.summaries.write(repositoryId, summaryAt(conversation, "m-14"));
  await send(h);
  let history = conversationLines(h.runs[0].options.prompt);
  assert.equal(history.includes("(Earlier messages are left out.)"), false);
  assert.ok(history.startsWith(`Owner: ${label(15)} x`) || history.startsWith(`Aril: ${label(15)} x`));
  const end = await chatHarness(context);
  const full = await seed(end, { messages: exchange(24) });
  await end.summaries.write(repositoryId, summaryAt(full, "m-24"));
  await send(end);
  history = conversationLines(end.runs[0].options.prompt);
  assert.equal(history, "(This is the first message.)");
  assert.ok(end.runs[0].options.prompt.includes(SENTINEL), "the summary still stands before it");
});

test("a follow-up carries the summary too, and a grant write turn keeps its own prompt", async (context) => {
  const h = await chatHarness(context);
  const stored = await seed(h, { messages: [...exchange(24).slice(0, 22), userMessage(23, filler("m23")), agentMessage(24, { text: "A plan.", proposal: pendingProposal() })] });
  await h.summaries.write(repositoryId, summaryAt(stored, "m-8"));
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: stored.id, proposalId: "p-0123456789ab" }), { ok: true });
  const run = await h.followUp();
  assert.ok(run.options.prompt.includes(`Decided T-2 first. ${SENTINEL}`));
  assert.ok(run.options.prompt.indexOf("<summary_of_earlier_conversation>") < run.options.prompt.indexOf("<conversation>"));
  assert.ok(run.options.prompt.indexOf("</conversation>") < run.options.prompt.lastIndexOf("<proposal_outcome>"));
  await h.finishFollowUp(stored.id);
  const pending = h.chat.grantWrite({ repositoryId, plans: ["docs/plan.md"] });
  const grant = await (async () => { for (;;) { const found = h.runs.find((candidate) => candidate.options.prompt.includes("<grant_request>")); if (found) return found; await new Promise((resolve) => setTimeout(resolve, 1)); } })();
  assert.equal(grant.options.prompt.includes("summary_of_earlier_conversation"), false);
  assert.equal(grant.options.prompt.includes(SENTINEL), false);
  grant.resolve({ status: "complete", text: "No next step." });
  assert.equal((await pending).ok, true);
});

test("the section and its reserve are inside the prompt limit", () => {
  assert.equal(SUMMARY_SECTION_BUDGET, SUMMARY_LENGTH + 500);
  // The room left for the snapshot once every other part has its reserve; the snapshot's own bound is smaller still.
  assert.equal(BOARD_SNAPSHOT_ROOM + AGENT_CHAT_INSTRUCTIONS.length + HISTORY_BUDGET + SUMMARY_SECTION_BUDGET + 60_000 + 5_000, PROMPT_LIMIT);
  assert.equal(BOARD_SNAPSHOT_BUDGET, Math.min(BOARD_SNAPSHOT_ROOM, BOARD_SNAPSHOT_LIMIT));
  assert.ok(BOARD_SNAPSHOT_BUDGET < BOARD_SNAPSHOT_ROOM, "a smaller prompt answers faster, so the snapshot is held well below its room");
  const now = new Date("2026-10-01T00:00:00.000Z");
  const bare = composePromptParts({ board: {}, message: "Hi", summary: null, now });
  const longest = composePromptParts({ board: {}, message: "Hi", summary: "s".repeat(SUMMARY_LENGTH), now });
  assert.ok(longest.sections.conversation - bare.sections.conversation <= SUMMARY_SECTION_BUDGET);
  assert.ok(longest.sections.conversation - bare.sections.conversation > SUMMARY_LENGTH);
  assert.equal(composePrompt({ board: {}, message: "Hi", now }), bare.prompt);
  assert.equal(bare.prompt.includes("summary_of_earlier_conversation"), false);
  assert.equal(AGENT_CHAT_INSTRUCTIONS.includes("summary of earlier conversation"), true, "the instructions say what the summary is");
  // The parts and the rest are the whole prompt, with the instructions counted wherever they travel.
  for (const options of [{}, { includeInstructions: false }]) {
    const parts = composePromptParts({ board: {}, message: "Hi", summary: "A summary.", now, ...options });
    assert.equal(Object.values(parts.sections).reduce((sum, length) => sum + length, 0), parts.prompt.length + (options.includeInstructions === false ? AGENT_CHAT_INSTRUCTIONS.length + 2 : 0));
  }
});

test("the thread says where it was summarized and when, and never what the summary says", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: exchange(24) });
  const plain = await h.handle("thread", { repositoryId });
  assert.equal(plain.summarized, null);
  const record = summaryAt(conversation, "m-8");
  await h.summaries.write(repositoryId, record);
  const page = await h.handle("thread", { repositoryId, limit: 2 });
  assert.deepEqual(page.summarized, { through: { conversationId: conversation.id, messageId: "m-8", at: at(7) }, at: record.at });
  assert.deepEqual(Object.keys(page.summarized), ["through", "at"]);
  assert.deepEqual(Object.keys(page.summarized.through), ["conversationId", "messageId", "at"]);
  // Every page says it, the older ones too.
  assert.deepEqual((await h.handle("thread", { repositoryId, before: page.before })).summarized, page.summarized);
  for (const answer of [page, await h.handle("thread", { repositoryId }), await h.handle("list", { repositoryId }), await h.handle("read", { repositoryId, conversationId: conversation.id })]) {
    assert.equal(JSON.stringify(answer).includes(SENTINEL), false);
    assert.equal(JSON.stringify(answer).includes("Decided T-2"), false);
  }
  // The line is no message: the thread holds the same messages with or without it, and the summary is not searchable.
  assert.equal(page.messages.length, 2);
  assert.deepEqual((await h.handle("search", { repositoryId, query: SENTINEL })), { ok: true, matches: [] });
  assert.deepEqual((await h.handle("search", { repositoryId, query: "decided t-2" })), { ok: true, matches: [] });
  assert.equal((await h.handle("search", { repositoryId, query: label(3) })).matches.length > 0, true, "the messages it covers are still found");
  assert.equal((await h.handle("thread", { repositoryId: otherRepositoryId })).summarized, null, "another repository has none");
});

test("a list says when the summary was written only once there is one, so a client reads the thread again", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: exchange(4) });
  assert.deepEqual(Object.keys(await h.handle("list", { repositoryId })), ["ok", "conversations", "running"]);
  const record = summaryAt(conversation, "m-2");
  await h.summaries.write(repositoryId, record);
  const listed = await h.handle("list", { repositoryId });
  assert.deepEqual(Object.keys(listed), ["ok", "conversations", "running", "summarizedAt"]);
  assert.equal(listed.summarizedAt, record.at);
});

test("the thread's messages after a position are told by the order of the thread, even when the position's conversation is gone", () => {
  const metas = [
    { id: "chat-000000000001", createdAt: at(0) }, { id: "chat-000000000002", createdAt: at(0) },
  ];
  const after = afterPosition(metas, { conversationId: "chat-000000000001", messageId: "m-3", at: at(5) });
  const message = (conversationId, id, minute) => ({ conversationId, id, at: at(minute) });
  assert.equal(after(message("chat-000000000001", "m-3", 5)), false, "the position itself is covered");
  assert.equal(after(message("chat-000000000001", "m-2", 4)), false);
  assert.equal(after(message("chat-000000000001", "m-4", 5)), true, "the next place in the same conversation");
  assert.equal(after(message("chat-000000000001", "m-4", 6)), true);
  assert.equal(after(message("chat-000000000002", "m-1", 5)), true, "at the same time, the later conversation follows");
  assert.equal(after(message("chat-000000000002", "m-1", 4)), false);
  const gone = afterPosition([], { conversationId: "chat-0000000000ff", messageId: "m-3", at: at(5) });
  assert.equal(gone(message("chat-000000000001", "m-1", 4)), false);
  assert.equal(gone(message("chat-000000000001", "m-1", 6)), true);
});

test("the messages after a summary are read back only as far as they reach, and the whole thread without one", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: exchange(24) });
  const without = await threadSince({ store: h.store, summaries: h.summaries, repositoryId });
  assert.equal(without.summary, null);
  assert.equal(without.messages.length, 24);
  await h.summaries.write(repositoryId, summaryAt(conversation, "m-20"));
  const since = await threadSince({ store: h.store, summaries: h.summaries, repositoryId });
  assert.deepEqual(since.messages.map((message) => message.id), ["m-21", "m-22", "m-23", "m-24"]);
  assert.equal(since.summary.text.includes(SENTINEL), true);
  assert.equal((await threadSince({ store: h.store, summaries: h.summaries, repositoryId, toWindow: true })).messages.length, 4);
});

const AUTHORIZATION = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const loopbackTestNetwork = Object.freeze({
  isBindHostAllowed: (host, mask) => host === "127.0.0.1" && mask === "255.255.255.0",
  isClientAddressAllowed: (address) => address === "127.0.0.1",
});

test("a paired device reads the thread, the list, a conversation, and a search, and none of them returns the summary's text", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: exchange(24) });
  const record = summaryAt(conversation, "m-8");
  await h.summaries.write(repositoryId, record);
  const upstream = http.createServer((request, response) => response.end("{}"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    authorizationToken: AUTHORIZATION, isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
    agentChat: (operation, payload) => h.chat.handle(operation, payload, { paired: true }),
  });
  try {
    const secret = new URL(gateway.createPairing().url).hash.slice(1);
    const paired = await fetch(`${gateway.origin}/__pomegr/pair`, { method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret }) });
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    const post = async (operation, payload) => {
      const response = await fetch(`${gateway.origin}/api/agent-chat`, { method: "POST", headers: { Cookie: cookie, Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ operation, payload }) });
      return { status: response.status, text: await response.text() };
    };
    const answers = [
      await post("thread", { repositoryId }), await post("thread", { repositoryId, limit: 60 }), await post("list", { repositoryId }),
      await post("read", { repositoryId, conversationId: conversation.id }), await post("search", { repositoryId, query: "decided" }), await post("search", { repositoryId, query: SENTINEL }),
    ];
    for (const answer of answers) {
      assert.equal(answer.status, 200);
      assert.equal(answer.text.includes(SENTINEL), false);
      assert.equal(answer.text.includes("Decided T-2"), false);
    }
    const thread = JSON.parse(answers[0].text);
    assert.deepEqual(thread.summarized, { through: { conversationId: conversation.id, messageId: "m-8", at: at(7) }, at: record.at });
    assert.equal(JSON.parse(answers[2].text).summarizedAt, record.at);
    assert.deepEqual(JSON.parse(answers[5].text), { ok: true, matches: [] });
  } finally {
    gateway.revoke();
    await gateway.close?.();
    upstream.close();
  }
});
