// The follow-up Aril writes after the owner applied or dismissed a proposal: one read-only run per stored outcome,
// asked for by desktop main, with the outcome and a board that was read after it. Everything here runs on fakes.

import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_CHAT_INSTRUCTIONS, composePrompt, conversationHistory, proposalOutcome } from "../desktop/runtime/agent-chat-prompt.mjs";
import { normalizeConversation } from "../desktop/runtime/agent-chat-store.mjs";
import {
  agentMessage, chatHarness, finishTurn, pendingProposal, readyBoard, repositoryId, root, seed, send, stamp, token, until, userMessage, withProposal,
} from "./helpers/agent-chat-harness.mjs";

const proposalId = "p-0123456789ab";
const fence = (body) => `\`\`\`pomegr-board\n${JSON.stringify(body)}\n\`\`\``;
const answer = (h, operation, conversationId, id = proposalId) => h.handle(operation, { repositoryId, conversationId, proposalId: id });
const read = (h, conversationId) => h.handle("read", { repositoryId, conversationId });
const stored = async (h, conversationId) => (await h.reload().read(repositoryId, conversationId)).messages;

/** The outcome record of a follow-up prompt, and the one request under it. */
function outcomeOf(prompt) {
  const match = /\n<proposal_outcome>\n(.*)\n<\/proposal_outcome>\n(.*)$/u.exec(prompt);
  assert.ok(match, "the prompt ends with the outcome and one request");
  return { outcome: JSON.parse(match[1]), request: match[2] };
}

const snapshotOf = (prompt) => JSON.parse(/<board_snapshot>\n(.*)\n<\/board_snapshot>/u.exec(prompt)[1]);

const threeOperations = [{ op: "update_task", id: "T-1", text: "Reworded" }, { op: "queue_task", id: "T-2" }, { op: "delete_task", id: "T-3" }];

test("a full success asks Aril for one follow-up with the outcome and a board read after the apply", async (context) => {
  const h = await chatHarness(context);
  // The monitor's board changes with the apply, so the follow-up must read it again to see the new task.
  h.state.actions = (action) => {
    if (action === "create") { h.state.board = { ...h.state.board, tasks: [...h.state.board.tasks, { id: "T-9", text: "Invoice export", columnId: "col-a", state: "not_queued", featureId: null }] }; return { ok: true, taskId: "T-9", board: h.state.board }; }
    return { ok: true, board: h.state.board };
  };
  const operations = [{ op: "create_task", text: "Invoice export" }, { op: "queue_task", id: "T-2" }];
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations })) });
  assert.deepEqual(await answer(h, "apply", conversation.id), { ok: true });

  // The turn is there as soon as the apply answers, so the client that reads next keeps reading.
  const running = await read(h, conversation.id);
  assert.deepEqual({ ...running.turn, startedAt: null }, { conversationId: conversation.id, startedAt: null, provider: "claude", model: null, activity: "starting", text: "" });
  assert.equal(running.conversation.messages.at(-1).proposal.state, "applied", "the outcome is stored before Aril is asked");

  const run = await h.followUp();
  const { prompt } = run.options;
  assert.equal(prompt.includes("<owner_message>"), false, "no message of the owner is invented");
  const { outcome, request } = outcomeOf(prompt);
  assert.deepEqual(outcome, {
    kind: "board_changes", summary: "Tidy the board", outcome: "applied", succeeded: 2, failed: 0, not_applied: 0,
    operations: [{ n: 1, op: "create_task", result: "succeeded", created: "T-9" }, { n: 2, op: "queue_task", task: "T-2", result: "succeeded" }],
  });
  assert.match(request, /^The owner sent no new message\. Write one short follow-up .* with no proposal block\./u);
  assert.match(request, /Pomegr applied every operation\..*it has not started unless the snapshot shows a session on it\.$/u);
  assert.ok(snapshotOf(prompt).tasks.some((task) => task.id === "T-9"), "the snapshot was read after the apply");
  assert.match(prompt, /\[Proposal "Tidy the board" with 2 operation\(s\): the owner applied it; created T-9\.\]/u);
  assert.equal(run.options.cwd, root);
  assert.equal(prompt.includes(token), false);

  const before = h.calls.length;
  const after = await h.finishFollowUp(conversation.id, { status: "complete", text: "T-9 is on the board and T-2 waits in the queue." });
  const last = after.messages.at(-1);
  assert.deepEqual(last, { id: "m-3", role: "agent", text: "T-9 is on the board and T-2 waits in the queue.", at: last.at, provider: "claude", model: null, status: "complete", followUp: proposalId });
  assert.equal(h.calls.length, before, "the follow-up sends the monitor nothing once it has its board");
  assert.equal(h.followUps().length, 1);
  assert.deepEqual(await stored(h, conversation.id), after.messages, "and it is in the saved conversation");
});

test("a partial application names what succeeded, what failed, and what was never applied", async (context) => {
  const h = await chatHarness(context);
  h.state.actions = (action) => (action === "queue_add" ? { ok: false, error: "conflict" } : { ok: true, board: h.state.board });
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations: threeOperations })) });
  assert.deepEqual(await answer(h, "apply", conversation.id), { ok: true });
  const run = await h.followUp();
  const { outcome, request } = outcomeOf(run.options.prompt);
  assert.equal(outcome.outcome, "partial");
  assert.deepEqual([outcome.succeeded, outcome.failed, outcome.not_applied], [1, 1, 1]);
  assert.deepEqual(outcome.operations, [
    { n: 1, op: "update_task", task: "T-1", result: "succeeded" },
    { n: 2, op: "queue_task", task: "T-2", result: "failed", error: "conflict" },
    { n: 3, op: "delete_task", task: "T-3", result: "not_applied" },
  ]);
  assert.match(request, /Pomegr stopped at the first operation that failed\..*Retry nothing and do not propose the rest again/u);
  assert.match(run.options.prompt, /it stopped at an operation that failed; 1 operation\(s\) succeeded, operation 2 failed \(conflict\), 1 were not applied\.\]/u);
  const actions = h.actionCalls().length;
  await h.finishFollowUp(conversation.id);
  assert.equal(h.actionCalls().length, actions, "the follow-up retries nothing: the delete after the failure is still not sent");
  assert.equal(h.actionCalls().some((call) => call.pathname.endsWith("/delete")), false);
  assert.equal((await stored(h, conversation.id))[1].proposal.state, "partial");
});

test("a refusal and a failure are told apart, and neither is reported as a change", async (context) => {
  for (const [reply, expected, words] of [
    [() => ({ ok: false, error: "not_found" }), { outcome: "refused", error: "not_found" }, /Pomegr refused the first operation, so nothing of this proposal was applied\./u],
    [() => { throw new Error("offline"); }, { outcome: "failed", error: "unavailable" }, /Pomegr could not carry out the first operation, so nothing of this proposal is confirmed as applied\./u],
  ]) {
    const h = await chatHarness(context);
    h.state.actions = reply;
    const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations: threeOperations })) });
    assert.deepEqual(await answer(h, "apply", conversation.id), { ok: true });
    const { outcome, request } = outcomeOf((await h.followUp()).options.prompt);
    assert.equal(outcome.outcome, expected.outcome);
    assert.deepEqual([outcome.succeeded, outcome.failed, outcome.not_applied], [0, 1, 2]);
    assert.deepEqual(outcome.operations[0], { n: 1, op: "update_task", task: "T-1", result: "failed", error: expected.error });
    assert.match(request, words);
    await h.finishFollowUp(conversation.id);
    assert.equal(h.followUps().length, 1);
  }
});

test("a task that was created before its operation failed is named as on the board", () => {
  const create = { op: "create_task", text: "New", queue: true };
  const outcome = proposalOutcome({ summary: "Add", state: "partial", operations: [create, { op: "queue_task", id: "T-1" }], results: [{ ok: false, error: "limit", taskId: "T-9" }, { ok: false, error: "skipped" }] });
  assert.equal(outcome.outcome, "partial", "the board changed, so it is not a refusal");
  assert.deepEqual(outcome.operations[0], { n: 1, op: "create_task", result: "failed", error: "limit", created: "T-9", queued: false });
  const images = proposalOutcome({ summary: "Add", state: "partial", operations: [{ op: "attach_images", id: "T-4", images: ["img-0123456789ab"] }], results: [{ ok: false, error: "conflict", part: "images" }] });
  assert.deepEqual(images.operations[0], { n: 1, op: "attach_images", task: "T-4", result: "failed", error: "conflict", images_attached: false });
  assert.equal(images.outcome, "refused");
  assert.equal(proposalOutcome(pendingProposal()), null, "a proposal the owner has not answered has no outcome");
  assert.equal(composePrompt({ board: readyBoard(), repositoryName: "x", followUp: pendingProposal() }), null);
});

test("a dismissal changes no board, is kept in the saved conversation, and asks for a brief acknowledgment", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations: threeOperations })) });
  assert.deepEqual(await answer(h, "dismiss", conversation.id), { ok: true });
  const run = await h.followUp();
  const { outcome, request } = outcomeOf(run.options.prompt);
  assert.deepEqual(outcome, { kind: "board_changes", summary: "Tidy the board", outcome: "dismissed", operations_applied: 0 });
  assert.match(request, /The owner declined this proposal, and Pomegr applied none of its operations\. That is the owner's decision and not a failure\. Acknowledge it in one sentence\. Do not propose it or a variant of it again, and retry nothing\.$/u);
  await h.finishFollowUp(conversation.id, { status: "complete", text: "Understood, I left the board as it is." });
  assert.deepEqual(h.actionCalls(), [], "no task action was sent, before or after");
  const messages = await stored(h, conversation.id);
  assert.equal(messages[1].proposal.state, "dismissed");
  assert.equal(Object.hasOwn(messages[1].proposal, "results"), false);
  assert.equal(messages[2].followUp, proposalId);

  // A later turn of the owner reads both: the dismissal and Aril's acknowledgment of it.
  await send(h, { conversationId: conversation.id, text: "What else could we do?" });
  const next = h.runs.at(-1).options.prompt;
  assert.match(next, /\[Proposal "Tidy the board" with 3 operation\(s\): the owner dismissed it, so none of it was applied\.\]/u);
  assert.match(next, /Aril \(follow-up after the owner answered a proposal\): Understood, I left the board as it is\./u);
  assert.match(next, /<owner_message>\nWhat else could we do\?\n<\/owner_message>/u);
});

test("repeated and concurrent answers to one proposal make one follow-up", async (context) => {
  const h = await chatHarness(context);
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const conversation = await seed(h, { messages: withProposal() });
  const first = answer(h, "apply", conversation.id);
  await until(() => h.calls.length === 1);
  assert.deepEqual(await answer(h, "apply", conversation.id), { ok: false, error: "busy" });
  assert.deepEqual(await answer(h, "dismiss", conversation.id), { ok: false, error: "busy" });
  release();
  h.state.gate = null;
  assert.deepEqual(await first, { ok: true });
  for (const operation of ["apply", "dismiss", "apply"]) assert.deepEqual(await answer(h, operation, conversation.id), { ok: false, error: "conflict" });
  // A client that reconnects or draws again only reads: a read never asks for a follow-up.
  for (let round = 0; round < 5; round += 1) await read(h, conversation.id);
  await h.finishFollowUp(conversation.id);
  for (let round = 0; round < 5; round += 1) await read(h, conversation.id);
  assert.deepEqual(await answer(h, "dismiss", conversation.id), { ok: false, error: "conflict" });
  assert.equal(h.followUps().length, 1);
  assert.equal(h.runs.length, 1);
  assert.equal((await stored(h, conversation.id)).filter((message) => message.followUp === proposalId).length, 1);

  const dismissed = await chatHarness(context);
  const other = await seed(dismissed, { messages: withProposal() });
  assert.deepEqual(await Promise.all([answer(dismissed, "dismiss", other.id), answer(dismissed, "dismiss", other.id)]).then((answers) => answers.map((entry) => entry.ok).sort()), [false, true]);
  await dismissed.finishFollowUp(other.id);
  assert.equal(dismissed.followUps().length, 1);
});

test("an answer that changed nothing in the store asks for no follow-up", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal() });
  h.state.board = { readiness: "pending" };
  assert.deepEqual(await answer(h, "apply", conversation.id), { ok: false, error: "unavailable" }, "the board could not be read, so nothing ran and the proposal is still pending");
  assert.deepEqual(await answer(h, "apply", "chat-ffffffffffff"), { ok: false, error: "not_found" });
  assert.equal((await read(h, conversation.id)).turn, null);
  assert.equal(h.runs.length, 0);
});

test("a provider that is not installed keeps the action result and the board, and leaves one failed follow-up", async (context) => {
  const h = await chatHarness(context, { files: [] });
  h.state.actions = () => ({ ok: true, board: h.state.board });
  const conversation = await seed(h, { messages: [...withProposal(), userMessage(3), agentMessage(4, { proposal: pendingProposal({ id: "p-aaaaaaaaaaaa" }) })] });
  assert.deepEqual(await answer(h, "apply", conversation.id), { ok: true });
  await until(async () => (await read(h, conversation.id)).turn === null);
  let messages = await stored(h, conversation.id);
  assert.equal(messages[1].proposal.state, "applied");
  assert.deepEqual(messages[1].proposal.results, [{ ok: true }, { ok: true }]);
  assert.deepEqual({ ...messages.at(-1), at: null }, { id: "m-5", role: "agent", text: "", at: null, provider: "claude", model: null, status: "failed", followUp: proposalId });
  assert.equal(h.runs.length, 0, "no run could start");
  // The board stays usable from the chat: the next proposal is answered as before.
  assert.deepEqual(await answer(h, "dismiss", conversation.id, "p-aaaaaaaaaaaa"), { ok: true });
  await until(async () => (await read(h, conversation.id)).turn === null);
  messages = await stored(h, conversation.id);
  assert.equal(messages[3].proposal.state, "dismissed");
  assert.deepEqual(messages.filter((message) => message.followUp).map((message) => [message.followUp, message.status]), [[proposalId, "failed"], ["p-aaaaaaaaaaaa", "failed"]]);
});

test("a provider run that fails, and a monitor that stops answering, lose no action result", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal() });
  assert.deepEqual(await answer(h, "apply", conversation.id), { ok: true });
  const failed = await h.finishFollowUp(conversation.id, { status: "failed", text: "" });
  assert.equal(failed.messages[1].proposal.state, "applied");
  assert.deepEqual([failed.messages.at(-1).status, failed.messages.at(-1).followUp], ["failed", proposalId]);
  assert.equal(h.followUps().length, 1, "a failed follow-up is not asked for again");

  const offline = await chatHarness(context);
  const other = await seed(offline, { messages: withProposal() });
  let applied = false;
  offline.state.actions = () => { applied = true; return { ok: true }; };
  const original = offline.state.board;
  // The board answers for the apply and is gone when the follow-up asks.
  Object.defineProperty(offline.state, "board", { get: () => (applied ? { readiness: "pending" } : original) });
  assert.deepEqual(await answer(offline, "apply", other.id), { ok: true });
  await until(async () => (await read(offline, other.id)).turn === null);
  const messages = await stored(offline, other.id);
  assert.equal(messages[1].proposal.state, "applied");
  assert.deepEqual([messages.at(-1).status, messages.at(-1).followUp, messages.at(-1).text], ["failed", proposalId, ""]);
  assert.equal(offline.runs.length, 0);
});

test("a turn that already runs is not disturbed: the follow-up waits for it and then runs once", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal() });
  const sent = await send(h);
  assert.deepEqual(await answer(h, "apply", conversation.id), { ok: true }, "the board is changed while Aril answers elsewhere");
  assert.equal((await stored(h, conversation.id))[1].proposal.state, "applied");
  assert.equal(h.runs.length, 1, "no second run while one runs");
  assert.equal(h.runs[0].stops, 0);
  const waiting = await read(h, conversation.id);
  assert.equal(waiting.turn.activity, "starting", "the conversation reads as waiting for Aril");
  assert.deepEqual(await send(h, { conversationId: conversation.id }), { ok: false, error: "busy" });
  assert.equal((await h.handle("list", { repositoryId })).running, sent.conversationId);

  await finishTurn(h, h.runs[0], { status: "complete", text: "Start with T-1." }, sent.conversationId);
  const run = await h.followUp();
  assert.equal(outcomeOf(run.options.prompt).outcome.outcome, "applied");
  await h.finishFollowUp(conversation.id);
  assert.equal(h.runs.length, 2);
  assert.equal((await stored(h, conversation.id)).at(-1).followUp, proposalId);
});

test("Stop ends a follow-up like any turn, and takes back one that has not started", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal() });
  const sent = await send(h);
  await answer(h, "dismiss", conversation.id);
  assert.deepEqual(await h.handle("stop", { repositoryId, conversationId: conversation.id }), { ok: true });
  assert.equal((await read(h, conversation.id)).turn, null);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
  assert.equal(h.runs.length, 1, "the follow-up the owner stopped never runs");
  assert.equal((await stored(h, conversation.id))[1].proposal.state, "dismissed", "the dismissal stays");

  const running = await chatHarness(context);
  const other = await seed(running, { messages: withProposal() });
  await answer(running, "apply", other.id);
  const run = await running.followUp();
  assert.deepEqual(await running.handle("stop", { repositoryId, conversationId: other.id }), { ok: true });
  assert.equal(run.stops, 1);
  const after = await running.finishFollowUp(other.id, { status: "stopped", text: "T-1 was" });
  assert.deepEqual([after.messages.at(-1).status, after.messages.at(-1).text, after.messages.at(-1).followUp], ["stopped", "T-1 was", proposalId]);
});

test("a follow-up offers no proposal: a block in it is taken out and nothing can be applied from it", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal() });
  await answer(h, "dismiss", conversation.id);
  const text = `Understood.\n\n${fence({ summary: "Try again", operations: [{ op: "delete_task", id: "T-1" }] })}`;
  const after = await h.finishFollowUp(conversation.id, { status: "complete", text });
  const last = after.messages.at(-1);
  assert.equal(last.text, "Understood.");
  assert.equal(Object.hasOwn(last, "proposal"), false);
  assert.equal(Object.hasOwn(last, "proposalUnreadable"), false);
  assert.equal(after.messages.filter((message) => message.proposal?.state === "pending").length, 0, "nothing is left to apply");
  assert.deepEqual(h.actionCalls(), []);
  assert.equal(h.followUps().length, 1, "a follow-up never causes another");
});

test("a start and a queue change are followed up with what Pomegr confirmed, and the follow-up starts and changes nothing", async (context) => {
  const starts = [];
  let status = "gate_held";
  const h = await chatHarness(context, { startTask: async (...args) => { starts.push(args); return { status }; } });
  const startProposal = pendingProposal({ summary: "Start T-3", operations: [{ op: "start_session", id: "T-3" }] });
  const conversation = await seed(h, { messages: withProposal(startProposal) });
  const desktop = { event: { sender: {} } };
  const apply = (origin) => h.chat.handle("apply", { repositoryId, conversationId: conversation.id, proposalId }, origin);

  assert.deepEqual(await apply(undefined), { ok: false, error: "desktop_only" });
  assert.equal((await read(h, conversation.id)).turn, null, "a start a paired device may not apply asks for nothing");

  assert.deepEqual(await apply(desktop), { ok: true });
  let follow = outcomeOf((await h.followUp()).options.prompt);
  assert.deepEqual(follow.outcome, { kind: "session_start", summary: "Start T-3", task: "T-3", outcome: "refused", session_launched: false, status: "gate_held" });
  assert.match(follow.request, /No session started for T-3: Pomegr answered "gate_held"\..*Do not propose the start again\.$/u);
  await h.finishFollowUp(conversation.id);
  assert.equal(starts.length, 1, "a held start is not tried again by the follow-up");

  status = "started";
  assert.deepEqual(await apply(desktop), { ok: true });
  follow = outcomeOf((await h.followUp()).options.prompt);
  assert.deepEqual(follow.outcome, { kind: "session_start", summary: "Start T-3", task: "T-3", outcome: "applied", session_launched: true });
  assert.match(follow.request, /That launch is the only confirmed fact: the snapshot may not show the session yet/u);
  await h.finishFollowUp(conversation.id);
  assert.equal(starts.length, 2, "one launch for one Apply");
  assert.deepEqual(h.actionCalls(), []);
  assert.equal(proposalOutcome({ ...startProposal, results: [{ ok: false, error: "not_started", start: "failed" }] }).outcome, "failed");

  const queue = await chatHarness(context);
  queue.state.actions = () => ({ ok: true, board: { ...readyBoard(), queue: { status: "running", order: ["T-1"] } } });
  const queued = await seed(queue, { messages: withProposal(pendingProposal({ summary: "Queue on", operations: [{ op: "set_queue", on: true }] })) });
  assert.deepEqual(await answer(queue, "apply", queued.id), { ok: true });
  follow = outcomeOf((await queue.followUp()).options.prompt);
  assert.deepEqual(follow.outcome, { kind: "queue_change", summary: "Queue on", asked_for: "on", outcome: "applied", queue: "on" });
  assert.match(follow.request, /The queue is on\. Pomegr may start the queued tasks by itself from now on, but no start is confirmed\. Name a task as started only when the snapshot shows a session on it\./u);
  await queue.finishFollowUp(queued.id);
  assert.deepEqual(queue.actionCalls().map((call) => call.pathname), ["/internal/tasks/queue_settings"], "the queue action was sent once, by the Apply");
  const unanswered = { summary: "Queue on", state: "pending", operations: [{ op: "set_queue", on: true }] };
  assert.equal(proposalOutcome({ ...unanswered, results: [{ ok: false, error: "unavailable" }] }).outcome, "failed");
  assert.deepEqual(proposalOutcome({ ...unanswered, results: [{ ok: false, error: "conflict" }] }), { kind: "queue_change", summary: "Queue on", asked_for: "on", outcome: "refused", queue_changed: false, error: "conflict" });
  assert.equal(proposalOutcome({ ...unanswered, state: "applied", operations: [{ op: "set_queue", on: false }], results: [{ ok: true, queue: "off" }] }).queue, "off");
});

test("a paired device's answer is followed up like the desktop's, with the conversation's provider and model", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal(), provider: "codex", model: "gpt-synthetic" });
  // A call with no window event is the paired-device route.
  assert.deepEqual(await h.chat.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId }), { ok: true });
  const run = await h.followUp();
  assert.deepEqual([run.options.provider, run.options.model], ["codex", "gpt-synthetic"]);
  assert.equal(run.options.images, null);
  const after = await h.finishFollowUp(conversation.id);
  assert.deepEqual([after.messages.at(-1).provider, after.messages.at(-1).model], ["codex", "gpt-synthetic"]);
});

test("deleting the conversation and closing the app drop a follow-up that waits", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: withProposal() });
  const sent = await send(h);
  await answer(h, "apply", conversation.id);
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: conversation.id }), { ok: true });
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done." }, sent.conversationId);
  assert.equal(h.runs.length, 1);

  const closing = await chatHarness(context);
  const other = await seed(closing, { messages: withProposal() });
  await send(closing);
  await answer(closing, "dismiss", other.id);
  closing.chat.dispose();
  closing.runs[0].resolve({ status: "stopped", text: "" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closing.runs.length, 1, "no run starts while the app closes");
  assert.equal((await stored(closing, other.id))[1].proposal.state, "dismissed", "the dismissal was stored before");
});

test("the stored contract keeps a follow-up marker and refuses one beside a proposal", () => {
  const conversation = (message) => ({ id: "chat-0123456789ab", title: "T", provider: "claude", model: null, createdAt: stamp, updatedAt: stamp, messages: [userMessage(1), agentMessage(2, { proposal: pendingProposal({ state: "dismissed" }) }), message] });
  const kept = normalizeConversation(conversation(agentMessage(3, { followUp: proposalId })));
  assert.equal(kept.messages[2].followUp, proposalId);
  assert.equal(Object.hasOwn(kept.messages[1], "followUp"), false);
  for (const bad of [{ followUp: "p-1" }, { followUp: 7 }, { followUp: null }, { followUp: proposalId, proposalUnreadable: true }, { followUp: proposalId, proposal: pendingProposal({ id: "p-bbbbbbbbbbbb" }) }]) {
    assert.equal(normalizeConversation(conversation(agentMessage(3, bad))), null);
  }
  assert.match(conversationHistory(kept.messages).lines[2], /^Aril \(follow-up after the owner answered a proposal\): An answer$/u);
});

test("the instructions tell Aril how to follow up: confirmed facts only, a dismissal is no failure, and no proposal", () => {
  for (const words of [
    "## After the owner answers a proposal",
    "<proposal_outcome>",
    "Report only what the outcome and the snapshot confirm.",
    "Never report a failed or not applied operation as done.",
    "A dismissal is the owner's decision. It is not a failure and not an error.",
    "Say that a session started only when the outcome says that Pomegr launched it, or the snapshot shows a session on that task.",
    "Never write a proposal block in a follow-up.",
    "Do not retry anything, and do not propose the same change, start, or queue state again.",
    "an earlier proposal that the conversation shows as dismissed stays dismissed",
  ]) assert.ok(AGENT_CHAT_INSTRUCTIONS.includes(words), words);
});
