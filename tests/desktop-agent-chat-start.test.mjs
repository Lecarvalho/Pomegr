// A session start proposed in the agent chat: read from Aril's answer, applied only from the desktop window, and
// sent to the manual start of the Tasks page. Every dependency is a fake: no provider process, monitor, or dialog.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AGENT_CHAT_CHANNEL, AGENT_CHAT_ERRORS, installAgentChatIpc } from "../desktop/runtime/agent-chat.mjs";
import { composePrompt, conversationHistory } from "../desktop/runtime/agent-chat-prompt.mjs";
import {
  applyOperations, extractProposal, normalizeOperation, normalizeProposal, START_FAILURES, START_OPERATION, startProposalTask,
} from "../desktop/runtime/agent-chat-proposal.mjs";
import { normalizeConversation } from "../desktop/runtime/agent-chat-store.mjs";
import { createTaskStart, TASK_START_STATUSES } from "../desktop/runtime/task-dispatch.mjs";
import {
  agentMessage, chatHarness, finishTurn, pendingProposal, readyBoard, repositoryId, seed, send, stamp, userMessage, withProposal,
} from "./helpers/agent-chat-harness.mjs";

const proposalId = "p-0123456789ab";
const trusted = { trusted: true };
const desktop = { event: trusted };
const startProposal = (overrides = {}) => pendingProposal({ summary: "Start a session for T-3", operations: [{ op: "start_session", id: "T-3" }], ...overrides });
const answerWith = (body) => `I propose the start.\n\n\`\`\`pomegr-board\n${JSON.stringify(body)}\n\`\`\``;
const storedProposal = async (h, id) => (await h.reload().read(repositoryId, id)).messages.find((message) => message.proposal)?.proposal;

/** A chat whose start is a fake of the desktop's manual start: `statuses` are answered in order, then `started`. */
async function startHarness(context, { statuses = [], startTask } = {}) {
  const starts = [];
  const fake = async (...args) => { starts.push(args); const next = statuses.length > 0 ? statuses.shift() : "started"; if (next instanceof Error) throw next; return typeof next === "string" ? { status: next } : next; };
  const h = await chatHarness(context, startTask === null ? {} : { startTask: startTask ?? fake });
  const conversation = await seed(h, { messages: withProposal(startProposal()) });
  const apply = (origin = desktop) => h.chat.handle("apply", { repositoryId, conversationId: conversation.id, proposalId }, origin);
  return { h, starts, conversation, apply, proposal: () => storedProposal(h, conversation.id) };
}

test("the start operation and its failure statuses are fixed, and follow the manual start's own statuses", () => {
  assert.equal(START_OPERATION, "start_session");
  assert.deepEqual([...START_FAILURES].sort(), TASK_START_STATUSES.filter((status) => status !== "started" && status !== "cancelled").sort());
  assert.equal(AGENT_CHAT_ERRORS.includes("desktop_only"), true);
});

test("a start names one exact task and nothing else", () => {
  assert.deepEqual(normalizeOperation({ op: "start_session", id: "T-63" }), { op: "start_session", id: "T-63" });
  for (const source of [
    { op: "start_session" }, { op: "start_session", id: "63" }, { op: "start_session", id: "T-0" }, { op: "start_session", id: "t-63" },
    { op: "start_session", id: "T-63", worktree: true }, { op: "start_session", id: "T-63", provider: "codex" }, { op: "start_session", id: "T-63", queue: true },
    { op: "start_session", id: ["T-63"] }, { op: "start_session", id: "T-63 ; rm" }, { op: "start", id: "T-63" }, { op: "start_task", id: "T-63" },
  ]) assert.equal(normalizeOperation(source), null, JSON.stringify(source));
});

test("a start stands alone in its proposal: with any other operation the whole proposal is unreadable", () => {
  const alone = { summary: "Start T-63", operations: [{ op: "start_session", id: "T-63" }] };
  assert.deepEqual(normalizeProposal(alone), alone);
  assert.equal(startProposalTask(alone), "T-63");
  for (const operations of [
    [{ op: "queue_task", id: "T-63" }, { op: "start_session", id: "T-63" }],
    [{ op: "start_session", id: "T-63" }, { op: "start_session", id: "T-64" }],
    [{ op: "start_session", id: "T-63" }, { op: "update_task", id: "T-63", text: "Other work" }],
    [{ op: "create_task", text: "New" }, { op: "start_session", id: "T-1" }],
  ]) {
    assert.equal(normalizeProposal({ summary: "Start", operations }), null);
    assert.deepEqual(extractProposal(answerWith({ summary: "Start", operations })), { text: "I propose the start.", proposal: null, unreadable: true });
  }
  assert.deepEqual(extractProposal(answerWith(alone)), { text: "I propose the start.", proposal: alone, unreadable: false });
  assert.equal(startProposalTask({ operations: [{ op: "queue_task", id: "T-1" }] }), null);
  assert.equal(startProposalTask({ operations: [] }), null);
  assert.equal(startProposalTask(null), null);
});

test("the applier of board changes never starts anything: a start reaching it posts nothing and is unsupported", async () => {
  const posts = [];
  const results = await applyOperations([{ op: "start_session", id: "T-1" }], { board: readyBoard(), post: async (...args) => { posts.push(args); return { ok: true }; } });
  assert.deepEqual(results, [{ ok: false, error: "unsupported" }]);
  assert.deepEqual(posts, []);
});

test("an explicit request ends in a stored start proposal for the named task, and nothing starts before the owner answers", async (context) => {
  const { h, starts } = await startHarness(context);
  const sent = await send(h, { text: "start T-3" });
  const prompt = h.runs[0].options.prompt;
  assert.match(prompt, /<owner_message>\nstart T-3\n<\/owner_message>/u);
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: answerWith({ summary: "Start a session for T-3", operations: [{ op: "start_session", id: "T-3" }] }) }, sent.conversationId);
  const { proposal } = conversation.messages.at(-1);
  assert.deepEqual({ ...proposal, id: null }, { id: null, summary: "Start a session for T-3", operations: [{ op: "start_session", id: "T-3" }], state: "pending" });
  assert.equal(conversation.messages.at(-1).text, "I propose the start.");
  assert.deepEqual(starts, [], "a proposal alone starts nothing");
  assert.deepEqual(h.actionCalls(), [], "and it changes nothing on the board");
});

test("applying on the desktop starts exactly one session through the manual start, and stores the launch", async (context) => {
  const { h, starts, apply, proposal } = await startHarness(context);
  assert.deepEqual(await apply(), { ok: true });
  assert.deepEqual(starts, [[trusted, repositoryId, "T-3"]], "the trusted window event, the repository, and the task: no path, text, or flag");
  await h.followUp();
  assert.deepEqual(h.calls.map((call) => call.pathname), ["/api/tasks", "/internal/tasks/worktree-root", "/api/agents"], "the chat sends the monitor no queue action, no task action, and no board change: only the reads of the follow-up");
  assert.deepEqual(await proposal(), { ...startProposal(), state: "applied", results: [{ ok: true, start: "started" }] });
});

test("a repeated Apply never starts a second session", async (context) => {
  const { starts, apply, proposal } = await startHarness(context);
  assert.deepEqual(await apply(), { ok: true });
  for (let index = 0; index < 3; index += 1) assert.deepEqual(await apply(), { ok: false, error: "conflict" });
  assert.equal(starts.length, 1);
  assert.equal((await proposal()).state, "applied");
});

test("two Apply answers at once reach the dispatcher once: the second is busy while the first is still starting", async (context) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const starts = [];
  const { apply, proposal } = await startHarness(context, { startTask: async (...args) => { starts.push(args); await held; return { status: "started" }; } });
  const first = apply();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await apply(), { ok: false, error: "busy" });
  assert.deepEqual(await apply(null), { ok: false, error: "desktop_only" });
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(starts.length, 1);
  assert.equal((await proposal()).state, "applied");
});

test("a paired device, or any call without the desktop window's event, is refused and the proposal stays as it was", async (context) => {
  const { h, starts, apply, proposal } = await startHarness(context);
  for (const origin of [null, {}, { event: null }, { event: undefined }, { paired: true }]) assert.deepEqual(await apply(origin), { ok: false, error: "desktop_only" }, JSON.stringify(origin));
  // The gateway's call shape: an operation and a payload, and no origin.
  assert.deepEqual(await h.handle("apply", { repositoryId, conversationId: (await h.store.list(repositoryId))[0].id, proposalId }), { ok: false, error: "desktop_only" });
  assert.deepEqual(starts, []);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await proposal(), startProposal(), "still pending, with no result, so the owner can apply it on the computer");
  assert.deepEqual(await apply(), { ok: true });
  assert.equal(starts.length, 1);
});

test("a paired device still dismisses a start, and a dismissed start can never be applied", async (context) => {
  const { h, starts, conversation, apply, proposal } = await startHarness(context);
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: conversation.id, proposalId }), { ok: true });
  assert.equal((await proposal()).state, "dismissed");
  assert.deepEqual(await apply(), { ok: false, error: "conflict" });
  assert.deepEqual(starts, []);
});

test("a held start stores the dispatcher's own fixed reason and keeps the proposal open for another try", async (context) => {
  const { starts, apply, proposal } = await startHarness(context, { statuses: ["gate_held", "tree_dirty"] });
  assert.deepEqual(await apply(), { ok: true });
  assert.deepEqual(await proposal(), { ...startProposal(), state: "pending", results: [{ ok: false, error: "not_started", start: "gate_held" }] });
  assert.deepEqual(await apply(), { ok: true });
  assert.deepEqual((await proposal()).results, [{ ok: false, error: "not_started", start: "tree_dirty" }]);
  assert.equal((await proposal()).state, "pending");
  assert.deepEqual(await apply(), { ok: true });
  assert.deepEqual(await proposal(), { ...startProposal(), state: "applied", results: [{ ok: true, start: "started" }] });
  assert.equal(starts.length, 3, "one request to the dispatcher for each Apply, and none by itself");
  assert.deepEqual(await apply(), { ok: false, error: "conflict" });
  assert.equal(starts.length, 3);
});

test("every refusal of the manual start is kept as its own status, and an ineligible task starts nothing", async (context) => {
  for (const status of START_FAILURES) {
    const { apply, proposal } = await startHarness(context, { statuses: [status] });
    assert.deepEqual(await apply(), { ok: true }, status);
    assert.deepEqual(await proposal(), { ...startProposal(), state: "pending", results: [{ ok: false, error: "not_started", start: status }] }, status);
  }
});

test("an answer outside the fixed statuses, or a start that throws, is a failed start and never a launch", async (context) => {
  for (const [answer, expected] of [
    [{ status: "launched" }, "unavailable"], [{ status: "C:\\private\\repo" }, "unavailable"], [{}, "unavailable"], [null, "unavailable"], ["started ", "unavailable"],
    [{ status: ["started"] }, "unavailable"], [new Error("C:\\private\\repo is locked"), "failed"],
  ]) {
    const { apply, proposal } = await startHarness(context, { statuses: [answer] });
    assert.deepEqual(await apply(), { ok: true });
    const stored = await proposal();
    assert.deepEqual(stored.results, [{ ok: false, error: "not_started", start: expected }]);
    assert.equal(stored.state, "pending");
    assert.equal(JSON.stringify(stored).includes("private"), false);
  }
});

test("a cancelled start changes nothing: no result, no state, and the owner may apply again", async (context) => {
  const { starts, apply, proposal } = await startHarness(context, { statuses: ["cancelled"] });
  assert.deepEqual(await apply(), { ok: true });
  assert.deepEqual(await proposal(), startProposal());
  assert.deepEqual(await apply(), { ok: true });
  assert.equal((await proposal()).state, "applied");
  assert.equal(starts.length, 2);
});

test("a chat with no dispatcher answers unavailable and keeps the proposal pending", async (context) => {
  const { apply, proposal } = await startHarness(context, { startTask: null });
  assert.deepEqual(await apply(), { ok: false, error: "unavailable" });
  assert.deepEqual(await proposal(), startProposal());
});

test("a start needs no board read, so a board that is not ready does not answer for the dispatcher", async (context) => {
  const { h, starts, apply } = await startHarness(context);
  h.state.board = { readiness: "loading", repositoryId };
  h.state.fetchError = new Error("monitor down");
  assert.deepEqual(await apply(), { ok: true });
  assert.equal(starts.length, 1);
});

test("the IPC bridge hands the window's own event to the chat, so only a trusted window reaches the start", async (context) => {
  const { h, starts, conversation } = await startHarness(context);
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  const remove = installAgentChatIpc({ ipcMain, isTrustedEvent: (event) => event?.trusted === true, chat: h.chat });
  const call = handlers.get(AGENT_CHAT_CHANNEL);
  const payload = { repositoryId, conversationId: conversation.id, proposalId };
  assert.deepEqual(await call({ trusted: false }, "apply", payload), { ok: false, error: "invalid" });
  assert.deepEqual(starts, []);
  assert.deepEqual(await call(trusted, "apply", payload), { ok: true });
  assert.equal(starts.length, 1);
  assert.equal(starts[0][0], trusted, "the event itself, for the manual start's own trust check");
  remove();
});

// ---- The chat wired to the real manual start, over a fake monitor and a fake launcher. ----

const exe = "C:\\Users\\tester\\.local\\bin\\claude.exe";
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const planRoot = "C:\\Work\\repo";
const planToken = "A".repeat(43);
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function launcher() {
  const child = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => child.emit("exit", 0));
  return child;
}

async function dispatchHarness(context, { plan = () => ({ ok: true, plan: { taskId: "T-3", provider: "claude", model: null, effort: null, repositoryRoot: planRoot, prompt: "Do the thing", token: planToken } }), confirm = async () => true } = {}) {
  const monitor = [];
  const spawns = [];
  const confirmations = [];
  const starter = createTaskStart({
    isTrustedEvent: (event) => event?.trusted === true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret", platform: "win32",
    environment: { USERPROFILE: "C:\\Users\\tester", SystemRoot: "C:\\Windows" },
    fileExists: (file) => file === exe || file === powershell, directoryExists: (directory) => directory === planRoot,
    confirm: async (request) => { confirmations.push(request); return confirm(request); },
    fetch: async (url, options) => { monitor.push({ route: url.split("/").pop(), body: JSON.parse(options.body) }); return json(url.endsWith("start-plan") ? plan(monitor) : { ok: true }); },
    spawn: (...args) => { spawns.push(args); return launcher(); },
  });
  const h = await chatHarness(context, { startTask: (event, repository, taskId) => starter.startApproved(event, repository, taskId) });
  const conversation = await seed(h, { messages: withProposal(startProposal()) });
  const apply = (origin = desktop) => h.chat.handle("apply", { repositoryId, conversationId: conversation.id, proposalId }, origin);
  return { h, starter, monitor, spawns, confirmations, apply, proposal: () => storedProposal(h, conversation.id) };
}

test("an applied start takes the manual path with no second confirmation: one start plan, one launch, and no queue action", async (context) => {
  const d = await dispatchHarness(context);
  assert.deepEqual(await d.apply(), { ok: true });
  assert.deepEqual(d.confirmations, [], "Start session on the card is the confirmation; no native dialog follows");
  assert.deepEqual(d.monitor, [{ route: "start-plan", body: { repositoryId, payload: { id: "T-3" } } }], "the plan is asked for the task alone: no worktree override, no queue or board action");
  assert.equal(d.spawns.length, 1);
  assert.equal(d.spawns[0][2].shell, false);
  assert.deepEqual(await d.proposal(), { ...startProposal(), state: "applied", results: [{ ok: true, start: "started" }] });
  assert.deepEqual(await d.apply(), { ok: false, error: "conflict" });
  assert.equal(d.spawns.length, 1, "exactly one session");
  assert.equal(d.monitor.length, 1);
  await d.h.followUp();
  assert.deepEqual(d.h.actionCalls(), [], "the follow-up after the launch only reads");
});

test("the monitor's own refusals hold the start: a gate, a missing plugin, and a task that is not startable launch nothing", async (context) => {
  for (const error of ["gate_held", "tree_dirty", "plugin_missing", "not_startable", "unsupported_provider", "not_found", "unavailable"]) {
    const d = await dispatchHarness(context, { plan: () => ({ ok: false, error }) });
    assert.deepEqual(await d.apply(), { ok: true }, error);
    assert.deepEqual(d.spawns, [], error);
    assert.deepEqual(await d.proposal(), { ...startProposal(), state: "pending", results: [{ ok: false, error: "not_started", start: error }] }, error);
  }
});

test("a held start that the owner applies again launches once the monitor lets it, and only then", async (context) => {
  const d = await dispatchHarness(context, { plan: (monitor) => (monitor.filter((call) => call.route === "start-plan").length === 1 ? { ok: false, error: "gate_held" } : { ok: true, plan: { taskId: "T-3", provider: "claude", model: null, effort: null, repositoryRoot: planRoot, prompt: "Do the thing", token: planToken } }) });
  assert.deepEqual(await d.apply(), { ok: true });
  assert.equal(d.spawns.length, 0);
  assert.equal((await d.proposal()).state, "pending");
  assert.deepEqual(await d.apply(), { ok: true });
  assert.equal(d.spawns.length, 1);
  assert.equal((await d.proposal()).state, "applied");
});

test("the task window's own start still asks its native confirmation, and a chat start never borrows that answer", async (context) => {
  const d = await dispatchHarness(context, { confirm: async () => false });
  assert.deepEqual(await d.starter.start(trusted, repositoryId, "T-3"), { status: "cancelled" });
  assert.deepEqual(d.confirmations, [{ taskId: "T-3", separateWorktree: false }]);
  assert.deepEqual(d.spawns, []);
  assert.deepEqual(await d.apply(), { ok: true });
  assert.equal(d.confirmations.length, 1);
  assert.equal(d.spawns.length, 1);
});

test("a start refused while the app is closing launches nothing and is stored as not started", async (context) => {
  const d = await dispatchHarness(context);
  d.starter.dispose();
  assert.deepEqual(await d.apply(), { ok: true });
  assert.deepEqual(d.spawns, []);
  assert.deepEqual((await d.proposal()).results, [{ ok: false, error: "not_started", start: "unavailable" }]);
});

test("an untrusted event that reaches the chat is refused by the manual start itself", async (context) => {
  const d = await dispatchHarness(context);
  assert.deepEqual(await d.apply({ event: { trusted: false } }), { ok: true });
  assert.deepEqual(d.confirmations, []);
  assert.deepEqual(d.spawns, []);
  assert.deepEqual((await d.proposal()).results, [{ ok: false, error: "not_started", start: "invalid" }]);
});

// ---- What is stored and what Aril is told afterwards. ----

const conversationWith = (proposal) => ({ id: "chat-0123456789ab", title: "Start", provider: "claude", model: null, createdAt: stamp, updatedAt: stamp, messages: [userMessage(1, "start T-3"), agentMessage(2, { proposal })] });

test("the store keeps a start only in its three truthful shapes", () => {
  const launched = startProposal({ state: "applied", results: [{ ok: true, start: "started" }] });
  const held = startProposal({ state: "pending", results: [{ ok: false, error: "not_started", start: "gate_held" }] });
  for (const proposal of [startProposal(), launched, held, startProposal({ state: "dismissed" }), { ...held, state: "dismissed" }]) {
    assert.deepEqual(normalizeConversation(conversationWith(proposal)).messages[1].proposal, proposal);
  }
  for (const [name, proposal] of [
    ["a launch that is still pending", { ...launched, state: "pending" }],
    ["a held start stored as applied", { ...held, state: "applied" }],
    ["a partly applied start", { ...held, state: "partial" }],
    ["a status outside the fixed set", startProposal({ results: [{ ok: false, error: "not_started", start: "exploded" }] })],
    ["a launch with a failure status", startProposal({ state: "applied", results: [{ ok: true, start: "gate_held" }] })],
    ["a failure without not_started", startProposal({ results: [{ ok: false, error: "conflict", start: "gate_held" }] })],
    ["a board result on a start", startProposal({ state: "applied", results: [{ ok: true }] })],
    ["a start result on a board change", pendingProposal({ state: "applied", results: [{ ok: true, start: "started" }, { ok: true }] })],
    ["a start beside another operation", startProposal({ operations: [{ op: "start_session", id: "T-3" }, { op: "queue_task", id: "T-3" }] })],
  ]) assert.equal(normalizeConversation(conversationWith(proposal)), null, name);
});

test("the next prompt tells Aril what happened to the start, so no answer reports a session that did not launch", () => {
  const line = (proposal) => conversationHistory([agentMessage(2, { proposal })]).lines[0];
  assert.match(line(startProposal()), /\[Proposal to start a session for T-3: the owner has not answered it yet\.\]/u);
  assert.match(line(startProposal({ state: "applied", results: [{ ok: true, start: "started" }] })), /\[Proposal to start a session for T-3: the owner applied it and Pomegr launched a session for the task\.\]/u);
  assert.match(line(startProposal({ results: [{ ok: false, error: "not_started", start: "gate_held" }] })), /\[Proposal to start a session for T-3: the owner applied it and no session started \(gate_held\)\.\]/u);
  assert.match(line(startProposal({ state: "dismissed" })), /\[Proposal to start a session for T-3: the owner dismissed it, so none of it was applied\.\]/u);
  const prompt = composePrompt({ board: readyBoard(), repositoryName: "repo", messages: withProposal(startProposal({ results: [{ ok: false, error: "not_started", start: "tree_dirty" }] })), message: "why?", now: new Date(stamp) });
  assert.match(prompt, /no session started \(tree_dirty\)/u);
});
