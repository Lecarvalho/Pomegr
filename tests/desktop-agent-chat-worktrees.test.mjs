import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProposal, applyOperations } from "../desktop/runtime/agent-chat-proposal.mjs";
import { composePrompt, conversationHistory, proposalOutcome } from "../desktop/runtime/agent-chat-prompt.mjs";
import { agentMessage, chatHarness, readyBoard, repositoryId, root, seed, send, until, userMessage } from "./helpers/agent-chat-harness.mjs";

const operation = (id = "T-1", branch = true) => ({ op: "remove_worktree", id, branch });
const proposal = (operations = [operation()]) => ({ summary: "Remove old worktrees", operations });
const row = { taskId: "T-1", state: "done", column: "Done", clean: true, uniqueCommits: false, sizeMB: 3, atLeast: true };
const proposalId = "p-0123456789ab";
const pending = (operations) => ({ ...proposal(operations), id: proposalId, state: "pending" });

test("removal proposals validate IDs, required boolean, standalone batches of 1–30, and grant exclusion", async () => {
  for (const n of [1, 30]) assert.deepEqual(normalizeProposal(proposal(Array.from({ length: n }, (_, i) => operation(`T-${i + 1}`, false))))?.operations.length, n);
  for (const operations of [[], Array.from({ length: 31 }, () => operation()), [operation(), { op: "delete_task", id: "T-1" }],
    [{ op: "remove_worktree", id: "T-1" }], [operation("../T-1")], [operation("T-0")], [operation("T-1", 1)], [{ ...operation(), path: root }]]) {
    assert.equal(normalizeProposal(proposal(operations)), null);
  }
  assert.equal(normalizeProposal(proposal(), { grantWrite: true }), null);
  assert.deepEqual(await applyOperations([operation()], { board: readyBoard(), post: () => { throw new Error("No board write"); } }), [{ ok: false, error: "unsupported" }]);
});

test("task_worktrees appears only with rows and projects facts without paths", () => {
  const base = { board: readyBoard(), repositoryName: "Example", message: "Clean up" };
  assert.doesNotMatch(composePrompt(base), /<task_worktrees>/u);
  const prompt = composePrompt({ ...base, worktrees: [{ ...row, path: "PRIVATE_PATH" }] });
  assert.match(prompt, /<task_worktrees>/u);
  assert.match(prompt, /at least 3 MB/u);
  assert.match(prompt, /These are Pomegr task worktrees still on disk/u);
  assert.doesNotMatch(prompt, /PRIVATE_PATH/u);
});

test("owner and grant-write turns acquire the repository inventory without storing it", async (context) => {
  for (const grant of [false, true]) {
    const reads = [];
    const h = await chatHarness(context, { worktrees: { inventory: async (request) => { reads.push(request); return [row]; } } });
    // A grant-write turn holds its promise until the answer is stored, so the run is finished before it is awaited.
    const sending = grant ? h.chat.grantWrite({ repositoryId, plans: ["plan.md"] }) : send(h);
    const run = await until(() => h.runs[0]);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].repositoryRoot, root);
    assert.deepEqual(reads[0].tasks, h.state.board.tasks);
    assert.deepEqual(reads[0].columns, h.state.board.columns);
    assert.match(run.options.prompt, /<task_worktrees>/u);
    run.resolve({ status: "complete", text: "No changes." });
    const sent = await sending;
    assert.equal(sent.ok, true);
    await until(async () => (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).turn === null);
    assert.doesNotMatch(JSON.stringify(await h.reload().read(repositoryId, sent.conversationId)), /sizeMB|task_worktrees/u);
  }
});

test("paired apply refuses removal before reading a board or touching Git", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: [agentMessage(1, { proposal: pending() })] });
  assert.deepEqual(await h.chat.handle("apply", { repositoryId, conversationId: conversation.id, proposalId }, { paired: true }), { ok: false, error: "desktop_only" });
  assert.equal(h.calls.length, 0);
});

test("desktop applies every removal in order, rereads the board, keeps the flag, and follows up with each fixed result", async (context) => {
  const expected = ["removed", "removed", "not_found", "dirty", "unique_commits", "in_use", "in_use", "failed", "removed", "in_use"];
  const removed = [];
  const located = [];
  const h = await chatHarness(context, { worktrees: {
    inventory: async () => [],
    locate: async (request) => { located.push(request.taskId); return request.taskId === "T-3" ? null : root; },
    remove: async (request) => { removed.push(request); if (request.taskId === "T-8") throw new Error("PRIVATE_PATH"); return expected[Number(request.taskId.slice(2)) - 1]; },
  } });
  h.state.board.tasks = expected.slice(0, 8).map((_, i) => ({ ...readyBoard().tasks[0], id: `T-${i + 1}`, state: "done", run: { keepWorktree: true },
    ...(i === 5 ? { state: "not_queued", session: { id: "s-1" } } : {}), ...(i === 6 ? { review: { state: "running" } } : {}) }));
  h.state.board.tasks.push({ ...readyBoard().tasks[0], id: "T-10", session: null });
  h.state.actions = () => ({ ok: true, task: { editable: false } });
  const before = structuredClone(h.state.board);
  const operations = expected.map((_, i) => operation(`T-${i + 1}`, i !== 1));
  const conversation = await seed(h, { messages: [userMessage(1), agentMessage(2, { proposal: pending(operations) })] });
  assert.deepEqual(await h.chat.handle("apply", { repositoryId, conversationId: conversation.id, proposalId }, { event: {} }), { ok: true });
  const saved = (await h.reload().read(repositoryId, conversation.id)).messages[1].proposal;
  assert.deepEqual(saved.results.map((r) => r.worktree), expected);
  assert.equal(saved.state, "partial");
  assert.deepEqual(h.state.board, before);
  assert.deepEqual(h.actionCalls().filter((call) => call.init.method === "POST"), [], "no task action is sent");
  assert.deepEqual(removed.map((r) => [r.taskId, r.deleteBranch, r.detailed]), [["T-1", true, true], ["T-2", false, true], ["T-4", true, true], ["T-5", true, true], ["T-8", true, true], ["T-9", true, true]]);
  assert.ok(!located.includes("T-6") && !located.includes("T-7") && !located.includes("T-10"));
  assert.ok(h.calls.filter((call) => call.pathname === "/api/tasks").length >= expected.length);
  assert.deepEqual(proposalOutcome(saved).operations.map((r) => r.worktree), expected);
  const followUp = await h.followUp();
  assert.match(followUp.options.prompt, /unique_commits/u);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PATH/u);
  const answer = await h.finishFollowUp(conversation.id, { status: "complete", text: `Cleanup\n\`\`\`pomegr-board\n${JSON.stringify(proposal())}\n\`\`\`` });
  assert.equal(answer.messages.at(-1).proposalUnreadable, true);
  assert.equal(answer.messages.at(-1).proposal, undefined);
});

test("a dismissed or partly kept removal is told truthfully to the next turn", () => {
  const operations = [operation("T-1"), operation("T-2")];
  const partial = { ...pending(operations), state: "partial", results: [{ ok: true, worktree: "removed" }, { ok: false, worktree: "dirty", error: "dirty" }] };
  assert.match(conversationHistory([agentMessage(1, { proposal: partial })]).lines[0], /T-1 removed, T-2 dirty/u);
  assert.match(conversationHistory([agentMessage(1, { proposal: pending(operations) })]).lines[0], /has not answered it yet/u);
  const base = { board: readyBoard(), repositoryName: "Example" };
  const dismissed = composePrompt({ ...base, followUp: { ...pending(operations), state: "dismissed" } });
  assert.match(dismissed, /declined this proposal/u);
  assert.doesNotMatch(dismissed, /tried each removal/u);
  const told = composePrompt({ ...base, followUp: partial });
  assert.match(told, /tried each removal in order/u);
  assert.match(told, /"outcome":"partial"/u);
});

test("the store keeps a removal only in its truthful shapes", async (context) => {
  const h = await chatHarness(context);
  const operations = [operation("T-1"), operation("T-2")];
  const removed = { ok: true, worktree: "removed" };
  const kept = { ok: false, worktree: "in_use", error: "in_use" };
  const stored = async (proposal) => seed(h, { messages: [agentMessage(1, { proposal })] }).then(() => true, () => false);
  assert.equal(await stored({ ...pending(operations), state: "partial", results: [removed, kept] }), true);
  assert.equal(await stored({ ...pending(operations), state: "applied", results: [removed, removed] }), true);
  for (const bad of [
    { ...pending(operations), state: "applied", results: [removed, kept] },
    { ...pending(operations), state: "partial", results: [removed, removed] },
    { ...pending(operations), state: "pending", results: [removed, kept] },
    { ...pending(operations), state: "partial", results: [removed, { ok: true }] },
    { ...pending(operations), state: "partial", results: [removed, { ok: false, worktree: "unknown", error: "unknown" }] },
    { ...pending([operation("T-1"), { op: "delete_task", id: "T-2" }]) },
    pending(Array.from({ length: 31 }, (_, i) => operation(`T-${i + 1}`))),
  ]) assert.equal(await stored(bad), false);
});
