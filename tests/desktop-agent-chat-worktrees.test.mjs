import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { normalizeProposal, applyOperations } from "../desktop/runtime/agent-chat-proposal.mjs";
import { composePrompt, conversationHistory, proposalOutcome } from "../desktop/runtime/agent-chat-prompt.mjs";
import { createWorktreeInventory } from "../desktop/runtime/agent-chat-worktrees.mjs";
import { createTaskWorktrees } from "../desktop/runtime/task-worktree.mjs";
import { agentMessage, chatHarness, finishTurn, readyBoard, repositoryId, root, seed, send, until, userMessage } from "./helpers/agent-chat-harness.mjs";

const operation = (id = "T-1", branch = true) => ({ op: "remove_worktree", id, branch });
const proposal = (operations = [operation()]) => ({ summary: "Remove old worktrees", operations });
const row = { taskId: "T-1", state: "done", column: "Done", clean: true, uniqueCommits: false, sizeMB: 3, atLeast: true };
// What `inventory` of the task worktrees answers: the Git facts of a worktree and no size.
const fact = { taskId: "T-1", clean: true, uniqueCommits: false };
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

test("task_worktrees says when its facts were read, that a size can be unknown, and that a removal reads the worktree again", () => {
  const base = { board: readyBoard(), repositoryName: "Example", message: "Clean up" };
  const prompt = composePrompt({ ...base, worktrees: [row, { ...row, taskId: "T-2", sizeMB: null, atLeast: false }], worktreesAt: Date.parse("2026-10-29T10:00:00.000Z") });
  assert.match(prompt, /"taskId":"T-1".*"size":"at least 3 MB"/u);
  assert.match(prompt, /"taskId":"T-2".*"size":"unknown"/u);
  assert.match(prompt, /read these facts at 2026-10-29T10:00:00\.000Z, so they may be a few minutes old, and a size can be unknown or older/u);
  assert.match(prompt, /reads a worktree's tree and commits again when the owner applies its removal/u);
  assert.doesNotMatch(composePrompt({ ...base, worktrees: [row] }), / at 20\d\d-/u, "no time is told when none was given");
});

test("owner and grant-write turns read the worktree facts, join the board, and store nothing", async (context) => {
  for (const grant of [false, true]) {
    const reads = [];
    const h = await chatHarness(context, { worktrees: { inventory: async (request) => { reads.push(request); return [fact]; } } });
    h.state.board.tasks = [{ ...readyBoard().tasks[0], id: "T-1", state: "done", columnId: "col-e" }];
    // A grant-write turn holds its promise until the answer is stored, so the run is finished before it is awaited.
    const sending = grant ? h.chat.grantWrite({ repositoryId, plans: ["plan.md"] }) : send(h);
    const run = await until(() => h.runs[0]);
    assert.deepEqual(reads, [{ repositoryRoot: root, repositoryId }], "Git facts of the repository, with no board and no size walk");
    assert.match(run.options.prompt, /<task_worktrees>/u);
    assert.match(run.options.prompt, /"taskId":"T-1","state":"done","column":"Done","clean":true,"uniqueCommits":false,"size":"unknown"/u, "the board of this turn, and a size nobody measured");
    assert.match(run.options.prompt, /Pomegr read these facts at 20\d\d-/u);
    run.resolve({ status: "complete", text: "No changes." });
    const sent = await sending;
    assert.equal(sent.ok, true);
    await until(async () => (await h.handle("read", { repositoryId, conversationId: sent.conversationId })).turn === null);
    assert.doesNotMatch(JSON.stringify(await h.reload().read(repositoryId, sent.conversationId)), /sizeMB|task_worktrees/u);
  }
});

test("an owner's next message answers from the cached facts without calling Git again, and a stale cache is read again once in the background", async (context) => {
  let wall = 5_000_000;
  const reads = [];
  const refresh = (() => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; })();
  const worktrees = { inventory: async (request) => { reads.push(request); return reads.length === 1 ? [fact] : refresh.promise; }, sizes: () => new Promise(() => {}) };
  const h = await chatHarness(context, { worktrees, worktreeInventory: createWorktreeInventory({ worktrees, now: () => wall }) });
  const first = await send(h);
  await finishTurn(h, h.runs[0], { status: "complete", text: "Ok." }, first.conversationId);
  assert.equal(reads.length, 1);
  assert.match(h.runs[0].options.prompt, /"taskId":"T-1".*"size":"unknown"/u, "the first turn did not wait on a size walk, which never ends here");

  wall += 60_000;
  const second = await send(h, { conversationId: first.conversationId, text: "And now?" });
  await finishTurn(h, h.runs[1], { status: "complete", text: "Ok." }, second.conversationId);
  assert.equal(reads.length, 1, "a fresh cache calls nothing");
  assert.match(h.runs[1].options.prompt, /"taskId":"T-1"/u);

  wall += 4 * 60_000;
  const third = await send(h, { conversationId: first.conversationId, text: "Later?" });
  await finishTurn(h, h.runs[2], { status: "complete", text: "Ok." }, third.conversationId);
  assert.equal(reads.length, 2, "a stale cache is read again");
  assert.match(h.runs[2].options.prompt, /"taskId":"T-1"/u, "and the turn did not wait for it");
  const fourth = await send(h, { conversationId: first.conversationId, text: "Again?" });
  await finishTurn(h, h.runs[3], { status: "complete", text: "Ok." }, fourth.conversationId);
  assert.equal(reads.length, 2, "one read at a time");
  refresh.resolve([]);
});

test("a first turn does not wait on a folder walk that never ends", async (context) => {
  const h = await chatHarness(context, { worktrees: { inventory: async () => [fact], sizes: () => new Promise(() => {}) } });
  const sending = send(h);
  const run = await until(() => h.runs[0]);
  assert.match(run.options.prompt, /"size":"unknown"/u);
  assert.equal((await sending).ok, true);
});

test("a removal reads the live tree and commits again, whatever the cached facts say", async (context) => {
  // The cache says T-1 is clean. Then its tree changes. Apply must see the live tree, and Git must not remove anything.
  const repositoryRoot = path.resolve("/work/repo");
  const directory = path.join(repositoryRoot, ".pomegr", "worktrees", "T-1");
  const state = { dirty: false, commits: "0\n", removed: false };
  const git = [];
  const listing = () => `worktree ${repositoryRoot.replaceAll("\\", "/")}\nHEAD a\nbranch refs/heads/main\n\n${state.removed ? "" : `worktree ${directory.replaceAll("\\", "/")}\nHEAD b\nbranch refs/heads/tasks/T-1\n\n`}`;
  const worktrees = createTaskWorktrees({
    environment: {},
    directoryExists: (target) => target === directory && !state.removed,
    openDirectory: async () => { throw new Error("no walk"); },
    execFile: (_file, args, _options, callback) => {
      git.push(args.slice(2).join(" "));
      const stdout = args[2] === "worktree" && args[3] === "list" ? listing() : args[2] === "status" ? (state.dirty ? " M work.txt\n" : "") : args[2] === "rev-list" ? state.commits : "";
      if (args[2] === "worktree" && args[3] === "remove") state.removed = true;
      queueMicrotask(() => callback(null, stdout, ""));
    },
  });
  const h = await chatHarness(context, { worktrees });
  h.state.rootAnswer = { ok: true, root: repositoryRoot };
  h.state.board.tasks = [{ ...readyBoard().tasks[0], id: "T-1", state: "done", columnId: "col-e" }];
  const sent = await send(h);
  assert.match(h.runs[0].options.prompt, /"taskId":"T-1","state":"done","column":"Done","clean":true,"uniqueCommits":false/u);
  const conversation = await finishTurn(h, h.runs[0], { status: "complete", text: "Ok." }, sent.conversationId);
  const asked = git.length;
  assert.ok(git.some((command) => command.startsWith("status")), "the turn read the tree once");

  const apply = async (id) => {
    const stored = await seed(h, { messages: [userMessage(1), agentMessage(2, { proposal: { ...pending([operation("T-1", false)]), id } })] });
    assert.deepEqual(await h.chat.handle("apply", { repositoryId, conversationId: stored.id, proposalId: id }, { event: {} }), { ok: true });
    await h.finishFollowUp(stored.id);
    return (await h.reload().read(repositoryId, stored.id)).messages[1].proposal;
  };

  // The tree is now dirty; the cache still says clean. The removal sees the live tree.
  state.dirty = true;
  const dirty = await apply("p-aaaaaaaaaaaa");
  assert.deepEqual(dirty.results.map(({ worktree }) => worktree), ["dirty"]);
  assert.equal(dirty.state, "partial");
  assert.ok(git.slice(asked).some((command) => command.startsWith("status")), "the apply read the live tree");
  assert.equal(git.some((command) => command.startsWith("worktree remove")), false, "nothing was removed");

  // The tree is clean again, but a commit now exists nowhere else.
  state.dirty = false;
  state.commits = "1\n";
  assert.deepEqual((await apply("p-bbbbbbbbbbbb")).results.map(({ worktree }) => worktree), ["unique_commits"]);
  assert.equal(git.some((command) => command.startsWith("worktree remove")), false, "nothing was removed");

  // Both facts are fine now: the same apply removes it, and the next turn no longer lists the worktree.
  state.commits = "0\n";
  assert.deepEqual((await apply("p-cccccccccccc")).results.map(({ worktree }) => worktree), ["removed"]);
  assert.equal(git.filter((command) => command.startsWith("worktree remove")).length, 1);
  const next = await send(h, { conversationId: conversation.id, text: "Anything left?" });
  assert.equal(next.ok, true);
  const run = await until(() => h.runs.at(-1).options.prompt.includes("Anything left?") ? h.runs.at(-1) : null);
  assert.doesNotMatch(run.options.prompt, /<task_worktrees>/u, "the removed worktree left the cached rows at once");
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
