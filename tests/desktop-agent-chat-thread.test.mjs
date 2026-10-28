// One continuous conversation with Aril for each repository: the thread is a view over the repository's saved conversations in
// message-time order, with search, and a message without a conversation goes to the thread's current one. Everything here
// runs on fakes: no provider starts and nothing leaves the test.

import assert from "node:assert/strict";
import test from "node:test";

import { conversationMeta } from "../desktop/runtime/agent-chat-store.mjs";
import { LIST_LIMIT, SEARCH_LIMIT, SEARCH_QUERY_LIMIT, THREAD_PAGE, lastAnswer, searchThread, threadHistory, threadPage } from "../desktop/runtime/agent-chat-thread.mjs";
import {
  addImage, agentMessage, chatHarness, finishTurn, otherRepositoryId, pendingProposal, repositoryId, seed, send, userMessage, withProposal,
} from "./helpers/agent-chat-harness.mjs";

const invalid = { ok: false, error: "invalid" };
const proposalId = "p-0123456789ab";
const FOLLOW_UPS = { grant: null, through: null, ended: null, messageId: null };

// September 2026, before the harness clock (October 1, 2026), so a message the test sends is always the newest.
const at = (minute) => new Date(Date.UTC(2026, 8, 1, 12, minute)).toISOString();
const asked = (id, text, minute) => ({ ...userMessage(id, text), at: at(minute) });
const answered = (id, text, minute, extra = {}) => agentMessage(id, { text, at: at(minute), ...extra });
const thread = (h, payload = {}, repository = repositoryId) => h.handle("thread", { repositoryId: repository, ...payload });
const search = (h, query, repository = repositoryId) => h.handle("search", { repositoryId: repository, query });
const texts = (page) => page.messages.map((message) => message.text);

/** The thread of conversations held in memory, as the store gives it: the index newest first, and a read that counts what it reads. */
function memorySource(conversations, reads = []) {
  const metas = conversations.map(conversationMeta).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return { metas, reads, read: async (id) => { reads.push(id); return conversations.find((conversation) => conversation.id === id) ?? null; } };
}
const idOf = (number) => `chat-${String(number).padStart(12, "0")}`;
const conversationAt = (number, messages, extra = {}) => ({ id: idOf(number), title: `Chat ${number}`, provider: "claude", model: null, createdAt: messages[0]?.at ?? at(0), updatedAt: messages.at(-1)?.at ?? at(0), messages, ...extra });

/** Two conversations whose messages interleave in time: A at 1, 2, 5, 6 and B at 3, 4, 7, 8. */
async function interleaved(h) {
  const first = await seed(h, { title: "First", messages: [asked(1, "a1", 1), answered(2, "a2", 2), asked(3, "a3", 5), answered(4, "a4", 6)] });
  const second = await seed(h, { title: "Second", messages: [asked(1, "b1", 3), answered(2, "b2", 4), asked(3, "b3", 7), answered(4, "b4", 8)] });
  return { first, second };
}

test("the thread orders the messages of every conversation by time and pages back from the newest", async (context) => {
  const h = await chatHarness(context);
  const { first, second } = await interleaved(h);
  const newest = await thread(h, { limit: 3 });
  assert.equal(newest.ok, true);
  assert.deepEqual(texts(newest), ["a4", "b3", "b4"]);
  assert.deepEqual(newest.messages.map((message) => message.conversationId), [first.id, second.id, second.id]);
  assert.equal(typeof newest.before, "string");

  const middle = await thread(h, { limit: 3, before: newest.before });
  assert.deepEqual(texts(middle), ["b1", "b2", "a3"]);
  const oldest = await thread(h, { limit: 3, before: middle.before });
  assert.deepEqual(texts(oldest), ["a1", "a2"]);
  assert.equal(oldest.before, null, "the oldest page has no page before it");
  assert.deepEqual(texts(await thread(h)), ["a1", "a2", "b1", "b2", "a3", "a4", "b3", "b4"], "a page of the default size holds the whole short thread");
});

test("messages at the same time keep the order of their conversations and of their place in each", async (context) => {
  const h = await chatHarness(context);
  const first = await seed(h, { messages: [asked(1, "first-1", 1), answered(2, "first-2", 1)] });
  const second = await seed(h, { messages: [asked(1, "second-1", 1), answered(2, "second-2", 1)] });
  const page = await thread(h);
  assert.deepEqual(texts(page), ["first-1", "first-2", "second-1", "second-2"]);
  assert.deepEqual(page.messages.map((message) => message.conversationId), [first.id, first.id, second.id, second.id]);
});

test("a page holds at most sixty messages and the pages together hold every message once", async (context) => {
  assert.equal(THREAD_PAGE, 60);
  const h = await chatHarness(context);
  const count = 100;
  const messages = (parity) => Array.from({ length: count }, (_, index) => (index % 2 === 0 ? asked(index + 1, `m${index * 2 + parity}`, index * 2 + parity) : answered(index + 1, `m${index * 2 + parity}`, index * 2 + parity)));
  await seed(h, { messages: messages(0) });
  await seed(h, { messages: messages(1) });
  const sizes = [];
  const seen = [];
  let page = await thread(h);
  for (;;) {
    sizes.push(page.messages.length);
    seen.unshift(...texts(page));
    if (page.before === null) break;
    page = await thread(h, { before: page.before });
  }
  assert.deepEqual(sizes, [60, 60, 60, 20]);
  assert.deepEqual(seen, Array.from({ length: 200 }, (_, index) => `m${index}`));
});

test("a thread answers the messages as read answers them, a turn, the next conversation, and the last run, and nothing else", async (context) => {
  const h = await chatHarness(context);
  assert.deepEqual(await thread(h), { ok: true, messages: [], before: null, turn: null, sendTo: null, run: null, updatedAt: null });
  const stored = await seed(h, { provider: "codex", model: "gpt-6-luna", messages: [asked(1, "Question", 1), answered(2, "Answer", 2, { proposal: pendingProposal(), provider: "codex", model: "gpt-6-luna" })] });
  const page = await thread(h);
  assert.deepEqual(Object.keys(page), ["ok", "messages", "before", "turn", "sendTo", "run", "updatedAt"]);
  assert.equal(page.updatedAt, stored.updatedAt, "the newest time any conversation changed");
  assert.deepEqual(page.messages, (await h.handle("read", { repositoryId, conversationId: stored.id })).conversation.messages.map((message) => ({ conversationId: stored.id, ...message })));
  assert.equal(page.sendTo, stored.id);
  assert.deepEqual(page.run, { provider: "codex", model: "gpt-6-luna" });
  assert.equal(JSON.stringify(page).includes("grantFollowUps"), false);
  assert.deepEqual(await thread(h, {}, otherRepositoryId), { ok: true, messages: [], before: null, turn: null, sendTo: null, run: null, updatedAt: null }, "another repository has its own thread");
});

test("a request outside the shape of thread or search is refused before anything is read", async (context) => {
  const h = await chatHarness(context);
  const { first } = await interleaved(h);
  const page = await thread(h, { limit: 2 });
  const refuse = async (operation, payload, rule) => assert.deepEqual(await h.handle(operation, payload), invalid, `${operation}: ${rule}`);
  for (const bad of [0, -1, 61, 1.5, "5", null, NaN, Infinity, [], {}]) await refuse("thread", { repositoryId, limit: bad }, `limit ${JSON.stringify(bad)}`);
  const forged = (parts) => Buffer.from(JSON.stringify(parts)).toString("base64url");
  const cursors = ["", "x", "not a cursor", "../x", page.before.slice(0, -3), `${page.before}A`, "A".repeat(201), forged([1, 2, "chat-short", 0]), forged([1, 2, first.id]), forged([1.5, 2, first.id, 0]),
    forged([1, 2, first.id, -1]), forged([1, 2, first.id, 200]), forged(["1", 2, first.id, 0]), forged({ at: 1 }), forged(7), Buffer.from("{not json").toString("base64url"), null, 5, true, [page.before], { cursor: page.before }];
  for (const bad of cursors) await refuse("thread", { repositoryId, before: bad }, `before ${JSON.stringify(bad)}`);
  await refuse("thread", { repositoryId, extra: 1 }, "an extra key");
  await refuse("thread", { repositoryId, conversationId: first.id }, "a conversation");
  await refuse("thread", { repositoryId: "repo-short" }, "a repository");
  for (const bad of ["", " ", "\n\t ", "x".repeat(SEARCH_QUERY_LIMIT + 1), "a\u0000b", "a\nb", "a\u001bb", "a\u007fb", "a\u0085b", 5, null, undefined, ["a"], { toString: () => "a" }]) {
    await refuse("search", { repositoryId, query: bad }, `query ${JSON.stringify(bad)}`);
  }
  await refuse("search", { repositoryId }, "no query");
  await refuse("search", { repositoryId, query: "a", extra: 1 }, "an extra key");
  await refuse("search", { repositoryId, query: "a", limit: 1 }, "a limit");
  await refuse("search", { repositoryId: "../x", query: "a" }, "a repository");
  assert.equal(h.calls.length, 0, "the monitor was never asked");
  assert.equal((await search(h, "x".repeat(SEARCH_QUERY_LIMIT))).ok, true, "the longest query is accepted");
  assert.equal((await thread(h, { limit: 60, before: page.before })).ok, true);
});

test("a cursor of a conversation that was deleted since still pages back through the rest", async (context) => {
  const h = await chatHarness(context);
  const { first } = await interleaved(h);
  const newest = await thread(h, { limit: 3 });
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: first.id }), { ok: true });
  const older = await thread(h, { before: newest.before });
  assert.deepEqual(texts(older), ["b1", "b2"]);
  assert.equal(older.before, null);
});

test("the thread shows the turn of the repository wherever it runs, a follow-up that waits included", async (context) => {
  const h = await chatHarness(context);
  const proposed = await seed(h, { messages: withProposal() });
  const current = await seed(h, { messages: [asked(1, "Earlier", 1), answered(2, "Earlier answer", 2)] });
  const sent = await send(h, { text: "Next question", provider: "codex", model: "gpt-6-luna", effort: "high" });
  assert.equal(sent.conversationId, current.id);
  let page = await thread(h);
  assert.equal(page.turn.conversationId, current.id);
  assert.deepEqual({ ...page.turn, startedAt: null }, { conversationId: current.id, startedAt: null, provider: "codex", model: "gpt-6-luna", effort: "high", activity: "starting", text: "" });
  assert.equal(texts(page).at(-1), "Next question", "the message is stored before the turn starts");
  assert.equal(page.updatedAt, page.messages.at(-1).at, "a stored message moves the time of the last update");
  assert.deepEqual(page.run, { provider: "codex", model: "gpt-6-luna", effort: "high" });

  h.runs[0].options.onText("Partly");
  assert.equal((await thread(h)).turn.text, "Partly");
  assert.equal((await thread(h, {}, otherRepositoryId)).turn, null, "another repository shows no turn");

  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: proposed.id, proposalId }), { ok: true });
  assert.equal((await thread(h)).turn.conversationId, current.id, "the turn that answers comes before the follow-up that waits");
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, current.id);
  await h.followUp();
  assert.equal((await thread(h)).turn.conversationId, proposed.id, "the follow-up now answers in the conversation of its proposal");
  await h.finishFollowUp(proposed.id);
  assert.equal((await thread(h)).turn, null);
});

test("the next message goes to the newest conversation that is not a grant follow-up conversation and has room", async (context) => {
  const h = await chatHarness(context);
  assert.equal((await thread(h)).sendTo, null);
  const older = await seed(h, { provider: "codex", model: "gpt-6-luna", messages: [asked(1, "Old", 1), answered(2, "Old answer", 2)] });
  const followUps = await h.store.create(repositoryId, { provider: "claude", model: null, title: "Grant follow-ups", grantFollowUps: FOLLOW_UPS });
  await h.store.save(repositoryId, { ...followUps, messages: [answered(1, "T-1 started.", 3, { grantFollowUp: true, model: null })] });
  const page = await thread(h);
  assert.equal(page.sendTo, older.id, "a grant follow-up conversation is never where the owner writes");
  assert.deepEqual(page.run, { provider: "codex", model: "gpt-6-luna" }, "the last run is the owner's, not the follow-ups'");
  assert.deepEqual(texts(page), ["Old", "Old answer", "T-1 started."], "the follow-up line is part of the thread");

  const full = Array.from({ length: 199 }, (_, index) => (index % 2 === 0 ? answered(index + 1, `n${index}`, 10 + index % 40) : asked(index + 1, `n${index}`, 10 + index % 40)));
  await seed(h, { messages: full });
  assert.equal((await thread(h)).sendTo, older.id, "a conversation without room for a message and its answer is passed over");
});

test("send without a conversation continues the current one and keeps its title and the earlier messages", async (context) => {
  const h = await chatHarness(context);
  const first = await send(h, { text: "First question\nsecond line" });
  await finishTurn(h, h.runs[0], { status: "complete", text: "First answer." }, first.conversationId);
  const second = await send(h, { text: "Second question", provider: "codex", model: "gpt-6-sol" });
  assert.equal(second.conversationId, first.conversationId, "one thread, one conversation");
  assert.match(h.runs[1].options.prompt, /<conversation>\nOwner: First question\nsecond line\nAril: First answer\.\n<\/conversation>/u);
  await finishTurn(h, h.runs[1], { status: "complete", text: "Second answer." }, first.conversationId);
  const stored = await h.reload().read(repositoryId, first.conversationId);
  assert.equal(stored.title, "First question");
  assert.deepEqual([stored.provider, stored.model], ["codex", "gpt-6-sol"]);
  assert.deepEqual(stored.messages.map((message) => message.text), ["First question\nsecond line", "First answer.", "Second question", "Second answer."]);
  assert.equal((await h.store.index(repositoryId)).length, 1);
});

test("a conversation that is full rolls the thread over to a new one, and the prompt still carries the earlier messages", async (context) => {
  const h = await chatHarness(context);
  const messages = Array.from({ length: 199 }, (_, index) => (index % 2 === 0 ? answered(index + 1, `A${index}`, index) : asked(index + 1, `Q${index}`, index)));
  const full = await seed(h, { messages });
  const sent = await send(h, { text: "Question after the rollover" });
  assert.equal(sent.ok, true);
  assert.notEqual(sent.conversationId, full.id, "the full conversation takes nothing more");
  assert.equal((await h.store.read(repositoryId, full.id)).messages.length, 199);
  const prompt = h.runs[0].options.prompt;
  assert.match(prompt, /<conversation>\nAril: A0\nOwner: Q1\nAril: A2\n/u);
  assert.match(prompt, /Owner: Q197\nAril: A198\n<\/conversation>/u);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Answer." }, sent.conversationId);

  const page = await thread(h);
  assert.equal(page.sendTo, sent.conversationId);
  assert.deepEqual(texts(page).slice(-2), ["Question after the rollover", "Answer."]);
  assert.equal(new Set(page.messages.map((message) => message.conversationId)).size, 2, "the page spans the boundary");
  assert.deepEqual(await send(h, { conversationId: full.id }), { ok: false, error: "limit" }, "a named conversation that is full still answers limit");
});

test("a message is never written into a grant follow-up conversation", async (context) => {
  const h = await chatHarness(context);
  const followUps = await h.store.create(repositoryId, { provider: "claude", model: null, title: "Grant follow-ups", grantFollowUps: FOLLOW_UPS });
  await h.store.save(repositoryId, { ...followUps, messages: [answered(1, "T-3 merged.", 1, { grantFollowUp: true, model: null })] });
  const sent = await send(h, { text: "Reply to the follow-up" });
  assert.notEqual(sent.conversationId, followUps.id);
  const prompt = h.runs[0].options.prompt;
  assert.match(prompt, /<conversation>\nAril \(grant follow-up that Pomegr wrote from the task log, with no answer of yours\): T-3 merged\.\n<\/conversation>/u);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Seen." }, sent.conversationId);
  assert.equal((await h.store.read(repositoryId, followUps.id)).messages.length, 1);
});

test("a conversation that holds the images' limit rolls over for a message with an image, and a named one answers limit", async (context) => {
  const h = await chatHarness(context);
  const images = (start) => Array.from({ length: 4 }, (_, index) => ({ id: `img-${(start + index).toString(16).padStart(12, "0")}`, type: "png", bytes: 5 }));
  const messages = Array.from({ length: 10 }, (_, index) => ({ ...asked(index * 2 + 1, `Picture ${index}`, index * 2), images: images(index * 4 + 1) }));
  const exchanges = messages.flatMap((message, index) => [message, answered(index * 2 + 2, `Seen ${index}`, index * 2 + 1)]);
  const crowded = await seed(h, { messages: exchanges });
  const image = await addImage(h);
  assert.deepEqual(await send(h, { conversationId: crowded.id, images: [image.id] }), { ok: false, error: "limit" });
  const sent = await send(h, { text: "Another picture", images: [image.id] });
  assert.equal(sent.ok, true);
  assert.notEqual(sent.conversationId, crowded.id);
  assert.equal((await send(h, { text: "Busy" })).error, "busy");
  await finishTurn(h, h.runs[0], { status: "complete", text: "Seen." }, sent.conversationId);
  const plain = await send(h, { text: "No picture" });
  assert.equal(plain.conversationId, sent.conversationId, "a message without an image goes where the thread is now");
});

test("the prompt reads the newest messages of every conversation in thread order, and drops the oldest first", async (context) => {
  const h = await chatHarness(context);
  await interleaved(h);
  const sent = await send(h, { text: "Next" });
  assert.match(h.runs[0].options.prompt, /<conversation>\nOwner: a1\nAril: a2\nOwner: b1\nAril: b2\nOwner: a3\nAril: a4\nOwner: b3\nAril: b4\n<\/conversation>/u);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);

  const crowded = await chatHarness(context);
  const big = (id, text, minute) => asked(id, `${text} ${"x".repeat(1_900)}`, minute);
  await seed(crowded, { messages: Array.from({ length: 10 }, (_, index) => big(index + 1, `old${index}`, index * 2)) });
  await seed(crowded, { messages: Array.from({ length: 10 }, (_, index) => big(index + 1, `new${index}`, index * 2 + 1)) });
  await send(crowded, { text: "Next" });
  const prompt = crowded.runs[0].options.prompt;
  assert.ok(prompt.includes("(Earlier messages are left out.)"));
  assert.ok(prompt.includes("Owner: new9 "), "the newest message of the other conversation is kept");
  assert.equal(prompt.includes("Owner: old0 "), false, "the oldest is the first to go");
  const history = /<conversation>\n([\s\S]*)\n<\/conversation>/u.exec(prompt)[1];
  assert.ok(history.length <= 24_000);
  assert.ok(history.indexOf("Owner: old9 ") < history.indexOf("Owner: new9 "), "the kept lines stay in time order");
});

test("a follow-up reads the thread of the repository, not only the conversation of its proposal", async (context) => {
  const h = await chatHarness(context);
  const proposed = await seed(h, { messages: [asked(1, "Plan it", 1), answered(2, "Here is a plan.", 2, { proposal: pendingProposal() })] });
  await seed(h, { messages: [asked(1, "A later question", 5), answered(2, "A later answer", 6)] });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: proposed.id, proposalId }), { ok: true });
  const run = await h.followUp();
  assert.match(run.options.prompt, /<conversation>\nOwner: Plan it\nAril: Here is a plan\.\n\[Proposal "Tidy the board" with 2 operation\(s\): the owner dismissed it, so none of it was applied\.\]\nOwner: A later question\nAril: A later answer\n<\/conversation>/u);
  await h.finishFollowUp(proposed.id);
});

test("a conversation that lost its answer is repaired once by the thread, and left alone while a send of the repository is on its way", async (context) => {
  const h = await chatHarness(context);
  const lost = await seed(h, { messages: [asked(1, "Unanswered", 1)] });
  const current = await seed(h, { messages: [asked(1, "Earlier", 2), answered(2, "Earlier answer", 3)] });
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const sending = send(h, { text: "Holds the board read" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await thread(h)).messages.filter((message) => message.conversationId === lost.id).length, 1, "nothing is repaired while a send of this repository is reserved");
  release();
  assert.equal((await sending).conversationId, current.id);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, current.id);
  const repaired = (await thread(h)).messages.filter((message) => message.conversationId === lost.id);
  assert.deepEqual(repaired.map((message) => [message.role, message.status ?? null]), [["user", null], ["agent", "interrupted"]]);
  assert.equal((await thread(h)).messages.filter((message) => message.conversationId === lost.id).length, 2, "the repair happens once");
});

test("search finds the newest messages of every conversation whatever the case, as plain text and never as a pattern", async (context) => {
  const h = await chatHarness(context);
  await seed(h, { messages: [asked(1, "How do I (re)run the Deploy step?", 1), answered(2, "Use the Deploy button. It reruns the step.", 2), asked(3, "Cost is $5 [approx] and a.b is a literal", 3)] });
  await seed(h, { messages: [asked(1, "deploy again", 4), answered(2, "No match here", 5)] });
  const followUps = await h.store.create(repositoryId, { provider: "claude", model: null, title: "Grant follow-ups", grantFollowUps: FOLLOW_UPS });
  await h.store.save(repositoryId, { ...followUps, messages: [answered(1, "T-8 deploy started.", 6, { grantFollowUp: true, model: null })] });

  const found = await search(h, "DEPLOY");
  assert.equal(found.ok, true);
  assert.deepEqual(Object.keys(found), ["ok", "matches"]);
  assert.deepEqual(found.matches.map((match) => [match.role, match.snippet]), [
    ["agent", "T-8 deploy started."], ["user", "deploy again"], ["agent", "Use the Deploy button. It reruns the step."], ["user", "How do I (re)run the Deploy step?"],
  ], "newest first, with the whole short text as its snippet");
  assert.deepEqual(Object.keys(found.matches[0]).sort(), ["at", "conversationId", "messageId", "role", "snippet"]);
  assert.equal(found.matches[0].conversationId, followUps.id);
  assert.equal(found.matches[0].messageId, "m-1");
  assert.equal(found.matches[0].at, at(6));
  // A character that a pattern would read specially is only itself: text that holds it matches, and a pattern that the text does not hold as text matches nothing.
  for (const literal of ["a.b", "(re)", "[approx]", "$5", "Cost is $5 [approx]"]) assert.equal((await search(h, literal)).matches.length, 1, literal);
  for (const pattern of [".*", "\\d", "^How", "a.+b", "(re|ru)n", "[A-Z]eploy", "Cos.", "Deploy|again"]) assert.deepEqual((await search(h, pattern)).matches, [], `${pattern} is not a pattern`);
  assert.equal((await search(h, "  Deploy  ")).matches.length, 4, "the query is trimmed");
  assert.deepEqual((await search(h, "nothing like this")).matches, []);
  assert.deepEqual((await search(h, "deploy", otherRepositoryId)).matches, [], "another repository has its own thread");
});

test("a snippet is a short plain excerpt around the match with the cut ends marked", async () => {
  const long = `${"before ".repeat(30)}NEEDLE${" after".repeat(40)}`;
  const conversation = { id: "chat-0123456789ab", createdAt: at(0), updatedAt: at(1), messages: [{ ...asked(1, long, 1) }] };
  const [match] = await searchThread(memorySource([conversation]), "needle");
  assert.ok(match.snippet.startsWith("…") && match.snippet.endsWith("…"));
  assert.ok(match.snippet.includes("NEEDLE"));
  assert.ok(match.snippet.length <= SEARCH_QUERY_LIMIT + 40 + 80 + 2);
  const spaced = { ...conversation, messages: [asked(1, "one\n\n  two\tneedle   three\r\nfour", 1)] };
  assert.equal((await searchThread(memorySource([spaced]), "needle"))[0].snippet, "one two needle three four", "whitespace is plain single spaces");
  const pairs = { ...conversation, messages: [asked(1, `${"😀".repeat(30)}needle${"😀".repeat(50)}`, 1)] };
  const cut = (await searchThread(memorySource([pairs]), "needle"))[0].snippet;
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(cut), false, "a cut never splits a pair");
  const tricky = { ...conversation, messages: [asked(1, "İstanbul ǅ needle ß", 1)] };
  assert.equal((await searchThread(memorySource([tricky]), "needle"))[0].snippet, "İstanbul ǅ needle ß", "a letter whose lower case is longer still gives the right excerpt");
  assert.equal((await searchThread(memorySource([tricky]), "ǆ")).length, 1, "case folding is per letter");
});

test("a search answers at most twenty matches, the newest first", async (context) => {
  assert.equal(SEARCH_LIMIT, 20);
  const h = await chatHarness(context);
  await seed(h, { messages: Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? asked(index + 1, `match ${index}`, index) : answered(index + 1, `match ${index}`, index))) });
  const found = await search(h, "match");
  assert.equal(found.matches.length, 20);
  assert.deepEqual(found.matches.map((match) => match.snippet).slice(0, 3), ["match 59", "match 58", "match 57"]);
  assert.equal(found.matches.at(-1).snippet, "match 40");
});

test("threadPage and the search answer nothing for conversations that hold no message", async () => {
  const empty = { id: "chat-0123456789ab", createdAt: at(0), updatedAt: at(0), messages: [] };
  assert.deepEqual(await threadPage(memorySource([empty])), { messages: [], before: null });
  assert.deepEqual(await searchThread(memorySource([empty]), "a"), []);
  assert.equal(await threadPage(memorySource([empty]), { before: "nope" }), null);
  assert.deepEqual(await threadHistory(memorySource([empty]), () => false), []);
});

test("a search of a long thread pauses between batches, so it does not hold up the main process", async () => {
  const messages = Array.from({ length: 200 }, (_, index) => asked(index + 1, `line ${index}`, index));
  const conversations = [0, 1, 2].map((n) => ({ id: `chat-00000000000${n}`, createdAt: at(0), updatedAt: at(0), messages }));
  let pauses = 0;
  const found = await searchThread(memorySource(conversations), "no such text", async () => { pauses += 1; });
  assert.deepEqual(found, []);
  assert.equal(pauses, 3, "600 messages are three batches of 200 with a pause after each full batch");
  assert.equal((await searchThread(memorySource(conversations), "line 199", async () => { pauses += 1; })).length, 3);
});

// A repository holds any number of conversations, so a read of the thread takes them newest first and stops when it is done.
const chronicle = (count, perConversation = 4) => Array.from({ length: count }, (_, number) => conversationAt(number + 1, Array.from({ length: perConversation }, (_, index) => {
  const minute = number * perConversation + index;
  return index % 2 === 0 ? asked(index + 1, `topic ${number} line ${index}`, minute) : answered(index + 1, `topic ${number} line ${index}`, minute);
})));

test("the newest page of a long thread reads only the newest conversation, and each page back reads only what it needs", async () => {
  const conversations = chronicle(300);
  const reads = [];
  const source = memorySource(conversations, reads);
  const newest = await threadPage(source, { limit: 3 });
  assert.deepEqual(newest.messages.map((message) => message.text), ["topic 299 line 1", "topic 299 line 2", "topic 299 line 3"]);
  assert.deepEqual(reads, [idOf(300)], "one of three hundred conversations was read");
  reads.length = 0;
  const walked = [];
  let page = newest;
  for (let pages = 0; pages < 40; pages += 1) {
    walked.unshift(...page.messages.map((message) => message.text));
    if (page.before === null) break;
    page = await threadPage(source, { limit: 3, before: page.before });
  }
  assert.equal(walked.length, 120, "forty pages of three");
  assert.ok(new Set(reads).size <= 32, `forty pages of three touched ${new Set(reads).size} of three hundred conversations`);
  assert.ok(reads.length <= 80, `${reads.length} reads for forty pages`);
});

test("pages of conversations whose times overlap are the same as sorting every message", async () => {
  // A deterministic pseudo-random generator, so the thread is the same on every run.
  let seedValue = 7;
  const random = (limit) => { seedValue = (seedValue * 1103515245 + 12345) % 2147483648; return seedValue % limit; };
  const conversations = Array.from({ length: 25 }, (_, number) => {
    const start = random(300);
    const times = Array.from({ length: 1 + random(12) }, () => start + random(120)).sort((left, right) => left - right);
    return conversationAt(number + 1, times.map((minute, index) => (index % 2 === 0 ? asked(index + 1, `c${number} m${index}`, minute) : answered(index + 1, `c${number} m${index}`, minute))));
  });
  const all = conversations.flatMap((conversation) => conversation.messages.map((message, index) => ({ conversation, message, index })))
    .sort((left, right) => Date.parse(left.message.at) - Date.parse(right.message.at) || Date.parse(left.conversation.createdAt) - Date.parse(right.conversation.createdAt) || (left.conversation.id < right.conversation.id ? -1 : left.conversation.id > right.conversation.id ? 1 : 0) || left.index - right.index)
    .map(({ message }) => message.text);
  for (const limit of [1, 4, 7, 60]) {
    const reads = [];
    const source = memorySource(conversations, reads);
    const walked = [];
    let page = await threadPage(source, { limit });
    for (;;) {
      walked.unshift(...page.messages.map((message) => message.text));
      if (page.before === null) break;
      page = await threadPage(source, { limit, before: page.before });
    }
    assert.deepEqual(walked, all, `pages of ${limit}`);
  }
});

test("a search reads conversations newest first and stops once twenty matches cannot be beaten, and finds the same as reading everything", async () => {
  const conversations = chronicle(300);
  const reads = [];
  const found = await searchThread(memorySource(conversations, reads), "line 1");
  assert.equal(found.length, SEARCH_LIMIT);
  assert.deepEqual(found.slice(0, 2).map((match) => match.snippet), ["topic 299 line 1", "topic 298 line 1"]);
  assert.ok(reads.length <= SEARCH_LIMIT + 1, `${reads.length} conversations read`);
  const rareReads = [];
  const rare = await searchThread(memorySource(conversations, rareReads), "topic 7 line 2");
  assert.deepEqual(rare.map((match) => match.snippet), ["topic 7 line 2"]);
  assert.equal(rareReads.length, 300, "with fewer matches than the limit every conversation is read, one at a time");
  assert.deepEqual((await searchThread(memorySource(conversations), "TOPIC 7 LINE 2")).map((match) => match.conversationId), [idOf(8)]);
});

test("the history of a prompt reads back from the newest conversation only as far as it needs", async () => {
  const conversations = chronicle(300);
  const reads = [];
  const source = memorySource(conversations, reads);
  const messages = await threadHistory(source, (loaded) => loaded.length >= 10);
  assert.ok(messages.length >= 10 && messages.length <= 10 + THREAD_PAGE);
  assert.equal(messages.at(-1).text, "topic 299 line 3");
  assert.ok(new Set(reads).size <= 20, `${new Set(reads).size} conversations read`);
  const everything = await threadHistory(memorySource(chronicle(3)), () => false);
  assert.equal(everything.length, 12, "a thread that never fills the history is read to its start");
});

test("the time of the newest complete answer comes from the index, without reading a message", async () => {
  const conversations = [
    conversationAt(1, [asked(1, "q", 1), answered(2, "a", 2)]),
    conversationAt(2, [asked(1, "q", 3), answered(2, "failed", 4, { status: "failed" }), answered(3, "a follow-up line", 9, { grantFollowUp: true })]),
  ];
  const source = memorySource(conversations);
  assert.equal(lastAnswer(source.metas), Date.parse(at(2)));
  assert.deepEqual(source.reads, []);
  assert.equal(lastAnswer([]), null);
});

test("a repository never refuses a message for the number of its conversations", async (context) => {
  const h = await chatHarness(context);
  const followUps = { grant: null, through: null, ended: null, messageId: null };
  for (let index = 0; index < 60; index += 1) assert.ok(await h.store.create(repositoryId, { provider: "claude", model: null, title: `Chat ${index}`, grantFollowUps: followUps }));
  const sent = await send(h, { text: "Sixty-one conversations, and a message" });
  assert.equal(sent.ok, true);
  assert.equal((await h.store.index(repositoryId)).length, 61);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
  // Full conversations are passed over for a new one however many there are, and the thread is read across all of them.
  const full = (number) => Array.from({ length: 199 }, (_, index) => (index % 2 === 0 ? answered(index + 1, `A${number}-${index}`, number * 200 + index) : asked(index + 1, `Q${number}-${index}`, number * 200 + index)));
  const crowded = await chatHarness(context);
  for (let number = 0; number < 55; number += 1) await seed(crowded, { messages: full(number % 5) });
  const next = await send(crowded, { text: "Past fifty full conversations" });
  assert.equal(next.ok, true);
  assert.equal((await crowded.store.index(repositoryId)).length, 56);
  assert.equal((await crowded.store.read(repositoryId, next.conversationId)).messages.length, 1);
  assert.deepEqual(await send(crowded, { text: "Busy" }), { ok: false, error: "busy" });
});

test("a list answer holds the newest fifty conversations, and says so by being only an answer", async (context) => {
  assert.equal(LIST_LIMIT, 50);
  const h = await chatHarness(context);
  const followUps = { grant: null, through: null, ended: null, messageId: null };
  for (let index = 0; index < 55; index += 1) await h.store.create(repositoryId, { provider: "claude", model: null, title: `Chat ${index}`, grantFollowUps: followUps });
  const listed = await h.handle("list", { repositoryId });
  assert.equal(listed.conversations.length, 50);
  assert.equal((await h.store.index(repositoryId)).length, 55);
});
