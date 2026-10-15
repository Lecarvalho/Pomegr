// A create_task that places its new card: the parser, the apply order, the failure result, the stored round trip, and
// what Aril reads about it.
import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_CHAT_INSTRUCTIONS, proposalOutcome } from "../desktop/runtime/agent-chat-prompt.mjs";
import { applyOperations, normalizeOperation, normalizeProposal } from "../desktop/runtime/agent-chat-proposal.mjs";
import { chatHarness, pendingProposal, readyBoard, repositoryId, seed, withProposal } from "./helpers/agent-chat-harness.mjs";

// ---- The parser ------------------------------------------------------------------------------------------------

test("a create_task takes a column with an optional position, or a task to follow, and keeps it in the stored shape", () => {
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", place_after: "T-94" }), { op: "create_task", text: "x", placeAfter: "T-94" });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", column: " ready " }), { op: "create_task", text: "x", column: "Ready" });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", column: "Backlog", position: 0 }), { op: "create_task", text: "x", column: "Backlog", position: 0 });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", column: "Done", position: 100_000 }), { op: "create_task", text: "x", column: "Done", position: 100_000 });
  assert.deepEqual(normalizeOperation({ op: "create_task", text: "x", column: null, position: null, place_after: null }), { op: "create_task", text: "x" }, "null is no placement");
  assert.deepEqual(
    normalizeOperation({ op: "create_task", text: "x", place_after: "T-2", queue: true, provider: "claude" }),
    { op: "create_task", text: "x", run: { provider: "claude" }, placeAfter: "T-2", queue: true },
  );
});

test("a placement outside the contract refuses the operation and its whole proposal", () => {
  const bad = [
    { place_after: "T-0" }, { place_after: "t-4" }, { place_after: 4 }, { place_after: ["T-4"] },
    { column: "Later" }, { column: 2 }, { column: "" },
    { position: 0 }, { column: "Ready", position: -1 }, { column: "Ready", position: 1.5 }, { column: "Ready", position: 100_001 }, { column: "Ready", position: "1" },
    { place_after: "T-4", column: "Ready" }, { place_after: "T-4", position: 0 },
    { placeAfter: "T-4" }, { place_before: "T-4" },
  ];
  for (const fields of bad) {
    assert.equal(normalizeOperation({ op: "create_task", text: "x", ...fields }), null, JSON.stringify(fields));
    assert.equal(normalizeProposal({ summary: "Add", operations: [{ op: "create_task", text: "x", ...fields }] }), null, JSON.stringify(fields));
  }
  // No other operation takes a placement.
  assert.equal(normalizeOperation({ op: "update_task", id: "T-1", text: "x", column: "Ready" }), null);
  assert.equal(normalizeOperation({ op: "move_task", id: "T-1", column: "Ready", place_after: "T-2" }), null);
});

// ---- The apply order -------------------------------------------------------------------------------------------

const columns = [{ id: "col-a", name: "Backlog" }, { id: "col-b", name: "Ready" }, { id: "col-c", name: "In progress" }];
// Backlog holds T-1, T-94, T-2 from the top; Ready holds T-3.
const tasks = [
  { id: "T-2", columnId: "col-a", position: 2 },
  { id: "T-94", columnId: "col-a", position: 1 },
  { id: "T-1", columnId: "col-a", position: 0 },
  { id: "T-3", columnId: "col-b", position: 0 },
];
const board = (extra = []) => ({ columns, features: [], tasks: [...tasks, ...extra] });
// The create answers the board with the new card last in Backlog, as the store puts it.
const created = { id: "T-120", columnId: "col-a", position: 3 };

function monitor(reply = () => ({ ok: true })) {
  const calls = [];
  const post = async (action, payload) => {
    calls.push({ action, payload });
    if (action === "create") return { ok: true, taskId: "T-120", board: board([created]) };
    return reply(action, payload);
  };
  return { calls, post };
}

test("place_after creates the task, then moves it right under the named card, counted without the new card", async () => {
  const fake = monitor();
  const results = await applyOperations([{ op: "create_task", text: "Under T-94", placeAfter: "T-94" }], { post: fake.post, board: board() });
  assert.deepEqual(results, [{ ok: true, taskId: "T-120" }]);
  assert.deepEqual(fake.calls, [
    { action: "create", payload: { text: "Under T-94" } },
    { action: "move", payload: { id: "T-120", columnId: "col-a", position: 2 } },
  ]);
});

test("place_after follows the named card into its own column", async () => {
  const fake = monitor();
  assert.deepEqual(await applyOperations([{ op: "create_task", text: "x", placeAfter: "T-3" }], { post: fake.post, board: board() }), [{ ok: true, taskId: "T-120" }]);
  assert.deepEqual(fake.calls[1], { action: "move", payload: { id: "T-120", columnId: "col-b", position: 1 } });
});

test("a column placement moves to that column, at its position or last", async () => {
  const fake = monitor();
  const results = await applyOperations([
    { op: "create_task", text: "Top of Backlog", column: "Backlog", position: 0 },
    { op: "create_task", text: "Last in Ready", column: "Ready" },
  ], { post: fake.post, board: board() });
  assert.deepEqual(results, [{ ok: true, taskId: "T-120" }, { ok: true, taskId: "T-120" }]);
  assert.deepEqual(fake.calls.filter((call) => call.action === "move").map((call) => call.payload), [
    { id: "T-120", columnId: "col-a", position: 0 },
    { id: "T-120", columnId: "col-b", position: 100_000 },
  ]);
});

test("a placement into Ready never queues; queue: true adds queue_add after the move", async () => {
  const unqueued = monitor();
  await applyOperations([{ op: "create_task", text: "x", column: "Ready", position: 0 }], { post: unqueued.post, board: board() });
  assert.deepEqual(unqueued.calls.map((call) => call.action), ["create", "move"]);
  const queued = monitor();
  await applyOperations([{ op: "create_task", text: "x", column: "Ready", position: 0, queue: true }], { post: queued.post, board: board() });
  assert.deepEqual(queued.calls.map((call) => call.action), ["create", "move", "queue_add"]);
  assert.deepEqual(queued.calls[2].payload, { id: "T-120" });
});

test("a placement that names a missing task or column fails, names the created task, and stops the proposal", async () => {
  const missingTask = monitor();
  const rest = { op: "delete_task", id: "T-1" };
  assert.deepEqual(
    await applyOperations([{ op: "create_task", text: "x", placeAfter: "T-404" }, rest], { post: missingTask.post, board: board() }),
    [{ ok: false, error: "not_found", taskId: "T-120", part: "placement" }, { ok: false, error: "skipped" }],
  );
  assert.deepEqual(missingTask.calls.map((call) => call.action), ["create"], "no move is sent and nothing after it runs");

  const noColumn = monitor();
  assert.deepEqual(
    await applyOperations([{ op: "create_task", text: "x", column: "Review", queue: true }, rest], { post: noColumn.post, board: board() }),
    [{ ok: false, error: "not_found", taskId: "T-120", part: "placement" }, { ok: false, error: "skipped" }],
  );
  assert.deepEqual(noColumn.calls.map((call) => call.action), ["create"], "a task that was not placed is not queued");
});

test("a move the monitor refuses is the placement's failure, with the created task", async () => {
  const fake = monitor((action) => (action === "move" ? { ok: false, error: "conflict" } : { ok: true }));
  assert.deepEqual(
    await applyOperations([{ op: "create_task", text: "x", placeAfter: "T-94", queue: true }], { post: fake.post, board: board() }),
    [{ ok: false, error: "conflict", taskId: "T-120", part: "placement" }],
  );
  assert.deepEqual(fake.calls.map((call) => call.action), ["create", "move"]);
});

// ---- Through the desktop chat ----------------------------------------------------------------------------------

test("one Apply creates a task and places it right after a named card in Backlog, and the stored proposal keeps the placement", async (context) => {
  const h = await chatHarness(context);
  const placed = { op: "create_task", text: "Follow-up of T-1", placeAfter: "T-1" };
  h.state.actions = (action) => {
    if (action !== "create") return { ok: true };
    const answer = readyBoard();
    answer.tasks = answer.tasks.map((task, index) => ({ ...task, position: index }));
    answer.tasks.push({ id: "T-9", text: "Follow-up of T-1", columnId: "col-a", state: "not_queued", position: 2 });
    return { ok: true, taskId: "T-9", board: answer };
  };
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations: [placed] })) });
  assert.deepEqual(await h.handle("apply", { repositoryId, conversationId: conversation.id, proposalId: "p-0123456789ab" }), { ok: true });
  assert.deepEqual(h.actionCalls().map((call) => [call.pathname.replace("/internal/tasks/", ""), call.body.payload]), [
    ["create", { text: "Follow-up of T-1" }],
    ["move", { id: "T-9", columnId: "col-a", position: 1 }],
  ]);
  const proposal = (await h.reload().read(repositoryId, conversation.id)).messages.find((message) => message.proposal).proposal;
  assert.equal(proposal.state, "applied");
  assert.deepEqual(proposal.operations, [placed]);
  assert.deepEqual(proposal.results, [{ ok: true, taskId: "T-9" }]);
});

test("a placement failure is stored with the created task and its part", async (context) => {
  const h = await chatHarness(context);
  h.state.actions = (action) => (action === "create" ? { ok: true, taskId: "T-9" } : { ok: true });
  const conversation = await seed(h, { messages: withProposal(pendingProposal({ operations: [{ op: "create_task", text: "x", placeAfter: "T-404" }] })) });
  assert.deepEqual(await h.handle("apply", { repositoryId, conversationId: conversation.id, proposalId: "p-0123456789ab" }), { ok: true });
  const proposal = (await h.reload().read(repositoryId, conversation.id)).messages.find((message) => message.proposal).proposal;
  assert.equal(proposal.state, "partial");
  assert.deepEqual(proposal.results, [{ ok: false, error: "not_found", taskId: "T-9", part: "placement" }]);
});

// ---- What Aril reads -------------------------------------------------------------------------------------------

test("Aril places a new card in the same proposal and no longer says a second proposal is needed", () => {
  assert.match(AGENT_CHAT_INSTRUCTIONS, /add "place_after":"T-n" to put it right under T-n, in T-n's column/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /For a card right above T-n, use "column" with T-n's column and "position" with T-n's position/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Placing a card in Ready does not queue it: set "queue": true as well when the owner asks for the queue\./u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /one proposal creates and places it, and no second proposal is needed to move it/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /"placed": false means it stays where the snapshot shows it/u);
});

test("the outcome row of a placed create names its placement, and a failed placement says the task was created and not placed", () => {
  const outcome = proposalOutcome({
    summary: "Add two tasks",
    state: "partial",
    operations: [{ op: "create_task", text: "a", column: "Ready", position: 0 }, { op: "create_task", text: "b", placeAfter: "T-404" }],
    results: [{ ok: true, taskId: "T-8" }, { ok: false, error: "not_found", taskId: "T-9", part: "placement" }],
  });
  assert.equal(outcome.outcome, "partial");
  assert.deepEqual(outcome.operations, [
    { n: 1, op: "create_task", column: "Ready", result: "succeeded", created: "T-8" },
    { n: 2, op: "create_task", place_after: "T-404", result: "failed", error: "not_found", created: "T-9", queued: false, placed: false },
  ]);
  assert.equal(JSON.stringify(outcome).includes("\"a\""), false, "no task text");
});
