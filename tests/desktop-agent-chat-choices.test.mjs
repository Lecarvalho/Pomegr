// The choices Aril may offer under an answer: the block's strict reading, what is stored, what reaches the prompt, and where they are dropped.
// Every run is a fake: no provider process starts and no request leaves the test.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHOICES_FENCE, OPTIONS_MAX, OPTION_DETAIL_LENGTH, OPTION_LABEL_LENGTH, QUESTION_LENGTH, REPLIES_MAX, REPLY_LENGTH,
  choiceLabels, choicesHistory, extractChoices, normalizeChoices, shownAnswer,
} from "../desktop/runtime/agent-chat-choices.mjs";
import { AGENT_CHAT_INSTRUCTIONS, composePrompt, conversationHistory, historyLine } from "../desktop/runtime/agent-chat-prompt.mjs";
import { normalizeConversation } from "../desktop/runtime/agent-chat-store.mjs";
import { agentMessage, chatHarness, finishTurn, repositoryId, seed, send, stamp, until, userMessage } from "./helpers/agent-chat-harness.mjs";

const fence = (body) => `\`\`\`${CHOICES_FENCE}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;
const board = (operations = [{ op: "queue_task", id: "T-1" }]) => `\`\`\`pomegr-board\n${JSON.stringify({ summary: "Queue it", operations })}\n\`\`\``;
const option = (label, detail = "One line of trade-off.") => ({ label, detail });
const QUESTION = { question: "Which merge method fits?", options: [option("Squash"), option("Merge commit")] };

test("the block reads 1 to 4 quick replies, each one short line, none repeated whatever its case", () => {
  assert.deepEqual(normalizeChoices({ replies: ["Yes"] }), { replies: ["Yes"] });
  assert.deepEqual(normalizeChoices({ replies: ["  Squash ", "Merge commit", "Tell me more", "Not now"] }), { replies: ["Squash", "Merge commit", "Tell me more", "Not now"] });
  assert.deepEqual(normalizeChoices({ replies: ["a".repeat(REPLY_LENGTH)] }), { replies: ["a".repeat(REPLY_LENGTH)] });
  assert.equal(REPLIES_MAX, 4);
  for (const bad of [
    { replies: [] }, { replies: ["1", "2", "3", "4", "5"] }, { replies: ["a".repeat(REPLY_LENGTH + 1)] }, { replies: [""] }, { replies: ["   "] },
    { replies: ["Yes", "yes"] }, { replies: ["Yes", "Yes"] }, { replies: [7] }, { replies: ["two\nlines"] }, { replies: ["tab\there"] }, { replies: ["nul\u0000"] },
    { replies: ["line\u2028break"] }, { replies: ["c1\u0085control"] }, { replies: "Yes" }, { replies: null }, { replies: ["Yes"], extra: true }, {}, [], null, "replies", 4,
    { replies: ["Yes"], question: "Which?", options: QUESTION.options },
  ]) assert.equal(normalizeChoices(bad), null, JSON.stringify(bad));
});

test("the block reads one question with 2 to 4 options, a label and a one-line detail each, the recommended option first", () => {
  assert.deepEqual(normalizeChoices(QUESTION), QUESTION);
  const four = { question: "q".repeat(QUESTION_LENGTH), options: ["a", "b", "c", "d"].map((label, index) => option(label.repeat(index === 0 ? OPTION_LABEL_LENGTH : 1), "d".repeat(OPTION_DETAIL_LENGTH))) };
  assert.deepEqual(normalizeChoices(four), four);
  assert.deepEqual(normalizeChoices({ question: " Which? ", options: [option(" Squash ", " Fits. "), option("Merge")] }), { question: "Which?", options: [option("Squash", "Fits."), option("Merge")] });
  assert.equal(OPTIONS_MAX, 4);
  const withOptions = (options) => ({ question: "Which?", options });
  for (const bad of [
    withOptions([]), withOptions([option("Only")]), withOptions(["a", "b", "c", "d", "e"].map((label) => option(label))),
    withOptions([option("a".repeat(OPTION_LABEL_LENGTH + 1)), option("b")]), withOptions([option("a", "d".repeat(OPTION_DETAIL_LENGTH + 1)), option("b")]),
    withOptions([option("a", ""), option("b")]), withOptions([option("", "x"), option("b")]), withOptions([{ label: "a" }, option("b")]), withOptions([{ detail: "x" }, option("b")]),
    withOptions([{ ...option("a"), recommended: true }, option("b")]), withOptions([option("A"), option("a")]), withOptions([option("a", "two\nlines"), option("b")]),
    withOptions(["a", "b"]), withOptions([null, option("b")]), withOptions("a, b"),
    { question: "q".repeat(QUESTION_LENGTH + 1), options: QUESTION.options }, { question: "", options: QUESTION.options }, { question: "Two\nlines", options: QUESTION.options },
    { question: 3, options: QUESTION.options }, { options: QUESTION.options }, { question: "Which?" }, { ...QUESTION, extra: 1 },
  ]) assert.equal(normalizeChoices(bad), null, JSON.stringify(bad));
  assert.deepEqual(choiceLabels({ replies: ["A", "B"] }), ["A", "B"]);
  assert.deepEqual(choiceLabels(QUESTION), ["Squash", "Merge commit"]);
});

test("extractChoices takes the block out of the shown text and keeps the answer whatever is wrong with it", () => {
  const replies = extractChoices(`Squash fits.\n\n${fence({ replies: ["Squash", "Tell me more"] })}\n`);
  assert.deepEqual(replies, { text: "Squash fits.", choices: { replies: ["Squash", "Tell me more"] }, unreadable: false });
  assert.deepEqual(extractChoices(`Which one?\r\n${fence(QUESTION)}\r\n`).choices, QUESTION);
  assert.equal(extractChoices(`Which one?\r\n${fence(QUESTION)}\r\n`).text, "Which one?");
  assert.deepEqual(extractChoices("Just an answer.\n\n\n\nTwo paragraphs."), { text: "Just an answer.\n\nTwo paragraphs.", choices: null, unreadable: false });
  assert.deepEqual(extractChoices(undefined), { text: "", choices: null, unreadable: false });
  assert.deepEqual(extractChoices(null), { text: "", choices: null, unreadable: false });
  // Anything that cannot be read leaves the answer text and offers nothing.
  for (const [name, answer] of [
    ["malformed JSON", `Text.\n${fence("{broken")}`],
    ["outside the contract", `Text.\n${fence({ replies: ["Yes", "yes"] })}`],
    ["two blocks", `Text.\n${fence({ replies: ["A"] })}\nMore.\n${fence({ replies: ["B"] })}`],
    ["a block never closed", `Text.\n\`\`\`${CHOICES_FENCE}\n{"replies": ["A"]`],
    ["an oversized block", `Text.\n${fence(`{"replies":["A"],"pad":"${"x".repeat(9_000)}"}`)}`],
    ["both forms", `Text.\n${fence({ replies: ["A"], ...QUESTION })}`],
  ]) {
    const read = extractChoices(answer);
    assert.equal(read.choices, null, name);
    assert.equal(read.unreadable, true, name);
    assert.ok(read.text.startsWith("Text.") && !read.text.includes(CHOICES_FENCE) && !read.text.includes("replies"), name);
  }
  assert.equal(extractChoices(`Text.\n\`\`\`${CHOICES_FENCE}\n{"replies": ["A"]`).text, "Text.");
});

test("a proposal block is no choices block and the other way round", () => {
  const read = extractChoices(`Plan.\n${board()}\n`);
  assert.equal(read.choices, null);
  assert.equal(read.unreadable, false);
  assert.ok(read.text.includes("pomegr-board"), "extractProposal reads that block, not this one");
});

test("shownAnswer hides a proposal block and a choices block, closed or still being written", () => {
  assert.equal(shownAnswer(`Plan.\n${fence({ replies: ["A"] })}\n`), "Plan.");
  assert.equal(shownAnswer(`Plan.\n\`\`\`${CHOICES_FENCE}\n{"replies": ["A`), "Plan.");
  assert.equal(shownAnswer(`Plan.\n\`\`\`${CHOICES_FENCE}`), "Plan.");
  assert.equal(shownAnswer(`Plan.\n${board()}\n${fence({ replies: ["A"] })}`), "Plan.");
  assert.equal(shownAnswer(`Plan.\n${fence(QUESTION)}\nAfter.`), "Plan.\n\nAfter.");
  assert.equal(shownAnswer("a\n\n\n\n\nb"), "a\n\nb");
  assert.equal(shownAnswer("```json\n{}\n```"), "```json\n{}\n```");
  assert.equal(shownAnswer(null), "");
});

test("the store keeps choices in their one shape and leaves a value outside it out without losing the message", () => {
  const conversation = (messages) => ({ id: "chat-0123456789ab", title: "T", provider: "claude", model: null, createdAt: stamp, updatedAt: stamp, messages });
  const kept = normalizeConversation(conversation([agentMessage(1, { choices: { replies: ["Yes", "No"] } }), agentMessage(2, { choices: QUESTION })]));
  assert.deepEqual(kept.messages.map((message) => message.choices), [{ replies: ["Yes", "No"] }, QUESTION]);
  const outside = normalizeConversation(conversation([agentMessage(1, { choices: { replies: [] } }), agentMessage(2, { choices: "Yes" }), agentMessage(3, { choices: { replies: ["Yes"], extra: 1 } })]));
  assert.equal(outside.messages.length, 3);
  assert.ok(outside.messages.every((message) => message.choices === undefined && message.text === "An answer"));
  // An answer with a proposal carries no choices.
  const proposal = { id: "p-0123456789ab", summary: "Queue it", state: "pending", operations: [{ op: "queue_task", id: "T-1" }] };
  assert.equal(normalizeConversation(conversation([agentMessage(1, { proposal, choices: { replies: ["Yes"] } })])).messages[0].choices, undefined);
  // The quiet mark of a block that could not be read is kept, and a valid block wins over it.
  assert.equal(normalizeConversation(conversation([agentMessage(1, { choicesUnreadable: true })])).messages[0].choicesUnreadable, true);
  assert.equal(normalizeConversation(conversation([agentMessage(1, { choicesUnreadable: "yes" })])).messages[0].choicesUnreadable, undefined);
  assert.equal(normalizeConversation(conversation([agentMessage(1, { choices: { replies: ["Yes"] }, choicesUnreadable: true })])).messages[0].choicesUnreadable, undefined);
  // A grant follow-up line never carries choices.
  const line = { grantFollowUp: true, model: null, text: "Merged T-5." };
  assert.ok(normalizeConversation(conversation([agentMessage(1, line)])));
  assert.equal(normalizeConversation(conversation([agentMessage(1, { ...line, choices: { replies: ["Yes"] } })])), null);
  assert.equal(normalizeConversation(conversation([agentMessage(1, { ...line, choicesUnreadable: true })])), null);
});

test("the prompt carries the talking rules, and the history says what was offered", () => {
  const instructions = AGENT_CHAT_INSTRUCTIONS;
  const rules = instructions.slice(instructions.indexOf("## How you talk"), instructions.indexOf("## What you can and cannot do"));
  assert.ok(rules.length > 0 && rules.length < 2_600, `the rules stay short (${rules.length})`);
  for (const text of [
    "Say the answer first, in as few words as carry it.", "Add detail only when the owner asks", 'the quick reply "Tell me more"',
    "Ask only what you cannot decide yourself.", "offer quick replies by default", `1 to ${REPLIES_MAX} short answers`, `at most ${REPLY_LENGTH} characters`,
    "Ask a multiple-choice question only when each option needs a line of trade-off.", `Give 2 to ${OPTIONS_MAX} options with your recommendation first`, "the panel marks the first one Recommended",
    `The question is at most ${QUESTION_LENGTH} characters, a label at most ${OPTION_LABEL_LENGTH}, and a detail one line of at most ${OPTION_DETAIL_LENGTH}`,
    "add no option for that", "it is not Apply", "Write at most one such block, last.", "Write none in an answer that carries a pomegr-board block",
  ]) assert.ok(rules.includes(text), text);
  // An acknowledgment gets one short line, no tool, no check, and no quick replies, and a flag only for something that needs the owner now.
  const acknowledgment = rules.split("\n").find((line) => line.startsWith("- When the owner's message only acknowledges"));
  assert.ok(acknowledgment, "the acknowledgment rule is a bullet of the talking rules");
  for (const text of [
    "only acknowledges, agrees, thanks, or says what they will do, and asks nothing, answer in one short line.",
    "Call no tool and run no check for it, and offer no quick replies.",
    "Add one short flag only when something already in the snapshot, the task log, or the conversation needs the owner's attention now",
    "a blocked or failed task, a check that will stop what they said they will do, a usage limit near its threshold", "Otherwise add nothing.",
  ]) assert.ok(acknowledgment.includes(text), text);
  assert.equal(rules.match(new RegExp(`\`\`\`${CHOICES_FENCE}\\n`, "gu")).length, 2, "one example of each form");
  assert.ok(instructions.indexOf("## How you talk") < instructions.indexOf("## Proposal block"), "the rules come before the proposal format");
  // The two examples are valid blocks of the contract they describe.
  for (const [, body] of rules.matchAll(new RegExp(`\`\`\`${CHOICES_FENCE}\\n(.*)\\n\`\`\``, "gu"))) assert.ok(normalizeChoices(JSON.parse(body)), body);

  assert.equal(historyLine(agentMessage(2, { text: "Squash fits.", choices: { replies: ["Squash", "Not now"] } })), 'Aril: Squash fits.\n[You offered these quick replies: Squash | Not now.]');
  assert.equal(historyLine(agentMessage(2, { text: "Pick one.", choices: QUESTION })), 'Aril: Pick one.\n[You asked "Which merge method fits?" with these options, the first one recommended: Squash | Merge commit.]');
  assert.equal(historyLine(agentMessage(2, { text: "Hm.", choicesUnreadable: true })), "Aril: Hm.\n[Pomegr could not read the choices block of this answer, so the owner saw no quick replies or options.]");
  assert.equal(historyLine(agentMessage(2, { text: "Plain." })), "Aril: Plain.");
  assert.deepEqual(choicesHistory(agentMessage(2)), []);
  const lines = conversationHistory([userMessage(1, "Which merge method?"), agentMessage(2, { text: "Squash fits.", choices: { replies: ["Squash", "Not now"] } }), userMessage(3, "Squash")]).lines;
  assert.deepEqual(lines, ["Owner: Which merge method?", "Aril: Squash fits.\n[You offered these quick replies: Squash | Not now.]", "Owner: Squash"]);
  const prompt = composePrompt({ board: { readiness: "ready", columns: [], features: [], tasks: [], queue: { status: "idle", order: [] } }, repositoryName: "repo", messages: [agentMessage(2, { choices: { replies: ["Squash"] } })], message: "Squash" });
  assert.ok(prompt.includes("[You offered these quick replies: Squash.]"));
});

test("an answer's choices block is stored on the message, not shown in its text, and reaches the thread", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h);
  const mid = await h.handle("read", { repositoryId, conversationId: sent.conversationId });
  assert.equal(mid.ok, true);
  h.runs[0].options.onText(`Squash fits.\n\n${fence({ replies: ["Squash", "Tell me more"] })}`);
  const running = await h.handle("read", { repositoryId, conversationId: sent.conversationId });
  assert.equal(running.turn.text, "Squash fits.", "the block that has begun is not shown while the answer is written");
  h.runs[0].options.onText(`Squash fits.\n\n\`\`\`${CHOICES_FENCE}\n{"replies": ["Squa`);
  assert.equal((await h.handle("read", { repositoryId, conversationId: sent.conversationId })).turn.text, "Squash fits.");
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: `Squash fits.\n\n${fence({ replies: ["Squash", "Tell me more"] })}` }, sent.conversationId);
  const answer = conversation.messages.at(-1);
  assert.equal(answer.text, "Squash fits.");
  assert.deepEqual(answer.choices, { replies: ["Squash", "Tell me more"] });
  assert.equal(answer.choicesUnreadable, undefined);
  assert.equal(answer.proposal, undefined);
  assert.equal(answer.proposalUnreadable, undefined);
  assert.deepEqual((await h.reload().read(repositoryId, sent.conversationId)).messages.at(-1).choices, { replies: ["Squash", "Tell me more"] }, "it is on disk");
  const page = await h.handle("thread", { repositoryId });
  assert.deepEqual(page.messages.at(-1).choices, { replies: ["Squash", "Tell me more"] });
  assert.equal(page.messages.at(-1).text, "Squash fits.");
  // The next prompt tells Aril what it offered, so the owner's tap is read as an answer to it.
  const next = await send(h, { text: "Squash" });
  assert.ok(h.runs[1].options.prompt.includes("Aril: Squash fits.\n[You offered these quick replies: Squash | Tell me more.]\n</conversation>"));
  assert.ok(h.runs[1].options.prompt.includes("<owner_message>\nSquash\n</owner_message>"));
  await finishTurn(h, h.runs[1], { status: "complete", text: "Noted." }, next.conversationId);
});

test("one multiple-choice question is stored whole", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h);
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: `Both work.\n${fence(QUESTION)}` }, sent.conversationId);
  assert.deepEqual(conversation.messages.at(-1).choices, QUESTION);
  assert.equal(conversation.messages.at(-1).text, "Both work.");
});

test("a block that cannot be read is dropped silently, leaving the answer and a quiet mark", async (context) => {
  for (const block of [fence("{broken"), fence({ replies: ["a", "A"] }), `${fence({ replies: ["a"] })}\n${fence({ replies: ["b"] })}`, `\`\`\`${CHOICES_FENCE}\n{"replies": ["a"]`]) {
    const h = await chatHarness(context);
    const sent = await send(h);
    const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: `The answer.\n${block}` }, sent.conversationId);
    const answer = conversation.messages.at(-1);
    assert.equal(answer.text, "The answer.");
    assert.equal(answer.choices, undefined);
    assert.equal(answer.choicesUnreadable, true);
    assert.equal(answer.proposalUnreadable, undefined, "the owner is told nothing");
    assert.equal(answer.status, "complete");
    const next = await send(h, { text: "Go on" });
    assert.ok(h.runs[1].options.prompt.includes("[Pomegr could not read the choices block of this answer, so the owner saw no quick replies or options.]"));
    await finishTurn(h, h.runs[1], { status: "complete", text: "Ok." }, next.conversationId);
  }
});

test("an answer that carries a proposal carries no choices, and the proposal is read as before", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h);
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: `Queue it.\n${board()}\n${fence({ replies: ["Yes"] })}` }, sent.conversationId);
  const answer = conversation.messages.at(-1);
  assert.equal(answer.text, "Queue it.");
  assert.equal(answer.proposal.state, "pending");
  assert.deepEqual(answer.proposal.operations, [{ op: "queue_task", id: "T-1" }]);
  assert.equal(answer.choices, undefined);
  assert.equal(answer.choicesUnreadable, undefined);
  // An invalid proposal beside valid choices is an unreadable proposal and no choices.
  const second = await send(h, { text: "Again" });
  const again = (await finishTurn(h, h.runs[1], { status: "complete", text: `Hm.\n\`\`\`pomegr-board\n{broken}\n\`\`\`\n${fence({ replies: ["Yes"] })}` }, second.conversationId)).messages.at(-1);
  assert.equal(again.proposalUnreadable, true);
  assert.equal(again.choices, undefined);
  assert.equal(again.text, "Hm.");
});

test("a failed, stopped, or timed-out answer keeps its text without any choices block", async (context) => {
  for (const status of ["failed", "stopped", "timed_out"]) {
    const h = await chatHarness(context);
    const sent = await send(h);
    const conversation = await finishTurn(h, h.runs[0], { status, text: `Half an answer.\n${fence({ replies: ["Yes"] })}` }, sent.conversationId);
    const answer = conversation.messages.at(-1);
    assert.equal(answer.text, "Half an answer.", status);
    assert.equal(answer.choices, undefined, status);
    assert.equal(answer.choicesUnreadable, undefined, status);
  }
});

test("a follow-up after an outcome may offer replies, and a grant task-writing turn never does", async (context) => {
  const h = await chatHarness(context);
  const proposal = { id: "p-0123456789ab", summary: "Queue it", state: "pending", operations: [{ op: "queue_task", id: "T-1" }] };
  const conversation = await seed(h, { messages: [userMessage(1), agentMessage(2, { text: "Here is a plan.", proposal })] });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId: proposal.id }), { ok: true });
  const after = await h.finishFollowUp(conversation.id, { status: "complete", text: `Understood.\n${fence({ replies: ["Show me another"] })}` });
  assert.deepEqual(after.messages.at(-1).choices, { replies: ["Show me another"] });
  assert.equal(after.messages.at(-1).followUp, proposal.id);

  const grant = await chatHarness(context);
  const pending = grant.chat.grantWrite({ repositoryId, plans: ["docs/plans/next.md"] });
  const run = await until(() => grant.runs.at(-1));
  run.resolve({ status: "complete", text: `Nothing left.\n${fence({ replies: ["Yes"] })}` });
  const result = await pending;
  assert.equal(result.ok, true);
  const written = (await grant.reload().read(repositoryId, result.conversationId)).messages.at(-1);
  assert.equal(written.text, "Nothing left.");
  assert.equal(written.choices, undefined);
  assert.equal(written.choicesUnreadable, undefined);
});
