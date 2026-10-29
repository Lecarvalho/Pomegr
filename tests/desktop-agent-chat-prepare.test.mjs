// The preparation of an Aril turn: every read a turn needs before its process starts begins together instead of one after another,
// each step times itself, and the refusals keep their order. Everything here runs on fakes and deferred promises: no provider starts.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPreparation } from "../desktop/runtime/agent-chat-prepare.mjs";
import { agentMessage, chatHarness, finishTurn, pendingProposal, repositoryId, seed, send, sourceEnvironment, until, userMessage, withProposal } from "./helpers/agent-chat-harness.mjs";

const unavailable = { ok: false, error: "unavailable" };
const invalid = { ok: false, error: "invalid" };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** A fake of every slow read, each held until the test lets it answer, with the order they started and answered in. */
function slowReads(names) {
  const gates = Object.fromEntries(names.map((name) => [name, deferred()]));
  const started = [];
  const answered = [];
  const hold = (name, value) => {
    started.push(name);
    return gates[name].promise.then(() => { answered.push(name); return value; });
  };
  return { gates, started, answered, hold, release: (name) => gates[name].resolve() };
}

/** A repository root with one workflow source in it, so the workflow read starts Git. */
async function workflowRoot(context) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pomegr-prepare-"));
  context.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await writeFile(path.join(folder, "AGENTS.md"), "synthetic workflow content");
  return folder;
}
const SETTLED = { settings: { settledAt: "2026-10-20T12:00:00.000Z" }, memory: [] };

function fakeReads(reads, { git = true } = {}) {
  return {
    repositoryGithub: { read: () => reads.hold("github", null) },
    worktrees: { inventory: () => reads.hold("worktrees", []) },
    sessionEnvironment: () => reads.hold("environment", { ...sourceEnvironment }),
    ...(git ? { execFile: (_file, _args, _options, callback) => { reads.hold("git", "").then((output) => callback(null, output)); } } : {}),
  };
}

test("an owner's message starts every read at once: the monitor, GitHub, and the environment together, then Git and the worktrees when the board arrives", async (context) => {
  const reads = slowReads(["github", "worktrees", "environment", "git", "log"]);
  const board = deferred();
  const h = await chatHarness(context, fakeReads(reads));
  h.state.rootAnswer = { ok: true, root: await workflowRoot(context) };
  h.state.board.aril = SETTLED;
  h.state.gate = board.promise;
  h.state.actions = (action) => (action === "log-read" ? reads.hold("log", { ok: false }) : { ok: true });
  const sending = send(h);
  let sent = null;
  void sending.then((answer) => { sent = answer; });

  // The board is still pending and nothing has answered, yet every read that does not need the board has been called.
  await until(() => ["github", "environment", "log"].every((name) => reads.started.includes(name)));
  assert.deepEqual(h.calls.map((call) => call.pathname), ["/api/tasks", "/internal/tasks/worktree-root", "/api/agents", "/internal/tasks/log-read"], "the four monitor reads went out together, in the same order as before");
  assert.deepEqual(reads.answered, []);
  assert.equal(reads.started.includes("worktrees") || reads.started.includes("git"), false, "the worktrees and the workflow files need the board");

  // The board arrives: the worktrees and Git begin at once, with GitHub, the log, and the environment still unanswered.
  board.resolve();
  await until(() => reads.started.includes("worktrees") && reads.started.includes("git"));
  assert.deepEqual(reads.answered, [], "no read has answered, so none of them waited for another");
  assert.equal(sent, null, "the turn waits for the slowest read");
  assert.equal(h.runs.length, 0);
  const index = await until(async () => { const found = await h.store.index(repositoryId); return found.length === 1 ? found : null; });
  assert.equal(index[0].messages, 0, "only the empty conversation exists: the owner's message is saved after the reads");

  for (const name of ["github", "worktrees", "environment", "git", "log"]) reads.release(name);
  assert.equal((await sending).ok, true);
  assert.equal(h.runs.length, 1);
  assert.match(h.runs[0].options.prompt, /<owner_message>\nWhat should I do first\?\n<\/owner_message>$/u);
});

test("a follow-up and a grant write turn also begin their reads together", async (context) => {
  const followReads = slowReads(["environment"]);
  const board = deferred();
  const h = await chatHarness(context, fakeReads(followReads, { git: false }));
  h.state.gate = board.promise;
  const proposal = pendingProposal();
  const stored = await seed(h, { messages: withProposal(proposal) });
  assert.deepEqual(await h.handle("dismiss", { repositoryId, conversationId: stored.id, proposalId: proposal.id }), { ok: true });
  await until(() => followReads.started.includes("environment"));
  assert.deepEqual(followReads.answered, [], "the follow-up reads the environment while the board is pending");
  assert.equal(h.runs.length, 0);
  board.resolve();
  followReads.release("environment");
  await h.finishFollowUp(stored.id);
  assert.equal(h.runs.length, 1);

  const grantReads = slowReads(["github", "worktrees", "environment", "git"]);
  const second = await chatHarness(context, fakeReads(grantReads));
  second.state.rootAnswer = { ok: true, root: await workflowRoot(context) };
  second.state.board.aril = SETTLED;
  const gate = deferred();
  second.state.gate = gate.promise;
  const granted = second.chat.grantWrite({ repositoryId, plans: ["docs/plans/next.md"] });
  gate.resolve();
  await until(() => ["worktrees", "environment", "git"].every((name) => grantReads.started.includes(name)));
  assert.deepEqual(grantReads.answered, [], "a grant write turn reads the worktrees, Git, and the environment together");
  assert.equal(grantReads.started.includes("github"), false, "a grant write turn never asked for GitHub");
  for (const name of ["worktrees", "environment", "git"]) grantReads.release(name);
  const run = await until(() => second.runs[0]);
  run.resolve({ status: "complete", text: "Nothing left.\nNo tasks written." });
  assert.equal((await granted).ok, true);
});

test("a refusal comes back for the same reason as before, and none of them starts a read", async (context) => {
  const reads = slowReads(["github", "worktrees", "environment", "git"]);
  const missing = await chatHarness(context, { ...fakeReads(reads), files: [] });
  // The provider is missing, so nothing else is looked at.
  assert.deepEqual(await send(missing), { ok: false, error: "cli_missing" });
  // A conversation that does not exist, a payload outside the shape, and a conversation that is full come before any read.
  const h = await chatHarness(context, fakeReads(reads));
  assert.deepEqual(await send(h, { conversationId: "chat-0123456789ab" }), { ok: false, error: "not_found" });
  assert.deepEqual(await send(h, { text: "   " }), invalid);
  assert.deepEqual(await send(h, { repositoryId: "repo-short" }), invalid);
  const long = await seed(h, { messages: Array.from({ length: 199 }, (_, index) => (index % 2 === 0 ? userMessage(index + 1) : agentMessage(index + 1))) });
  assert.deepEqual(await send(h, { conversationId: long.id }), { ok: false, error: "limit" });
  assert.deepEqual([...missing.calls, ...h.calls], [], "the monitor is not asked");
  assert.deepEqual(reads.started, [], "no GitHub, worktree, Git, or environment read starts for a refusal that comes before the reads");
  assert.equal(missing.runs.length + h.runs.length, 0);
});

test("a message refused after the reads began is refused for the same reason, and the conversation made for it is removed", async (context) => {
  const github = deferred();
  const reads = [];
  const h = await chatHarness(context, { repositoryGithub: { read: () => { reads.push("github"); return github.promise; } } });
  // The board is not ready: unavailable, whatever the other reads do, and nothing is kept.
  h.state.board = { ...h.state.board, readiness: "loading" };
  const refusedBoard = send(h);
  await until(() => reads.length === 1);
  github.resolve(null);
  assert.deepEqual(await refusedBoard, unavailable);
  assert.deepEqual(await h.store.index(repositoryId), []);

  // An image that was never staged: invalid, with the new conversation removed again, although the reads ran.
  const second = await chatHarness(context, { repositoryGithub: { read: async () => null } });
  assert.deepEqual(await send(second, { images: ["img-0123456789ab"] }), invalid);
  assert.deepEqual(await second.store.index(repositoryId), []);
  assert.equal(second.runs.length, 0);

  // A prompt past its limit: invalid, nothing kept.
  const third = await chatHarness(context, { repositoryGithub: { read: async () => null } });
  third.state.board.features = [{ id: "feat-1", name: "x".repeat(200_000) }];
  assert.deepEqual(await send(third), invalid);
  assert.deepEqual(await third.store.index(repositoryId), []);
  assert.deepEqual(await third.reload().index(repositoryId), []);
});

test("closing the app while a message prepares refuses it and leaves no conversation behind", async (context) => {
  const reads = slowReads(["github"]);
  const h = await chatHarness(context, { repositoryGithub: { read: () => reads.hold("github", null) } });
  const sending = send(h);
  await until(async () => (await h.store.index(repositoryId)).length === 1);
  h.chat.dispose();
  reads.release("github");
  assert.deepEqual(await sending, unavailable);
  assert.deepEqual(await h.store.index(repositoryId), []);
  assert.deepEqual(await h.reload().index(repositoryId), []);
  assert.equal(h.runs.length, 0);
});

test("a read that fails never refuses the message and never leaves a rejection behind", async (context) => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  context.after(() => process.off("unhandledRejection", listener));
  const h = await chatHarness(context, {
    repositoryGithub: { read: async () => { throw new Error("gh failed: C:\\private"); } },
    worktrees: { inventory: async () => { throw new Error("walk failed: C:\\private"); } },
    sessionEnvironment: async () => { throw new Error("registry failed"); },
    execFile: () => { throw new Error("git failed"); },
  });
  h.state.board.aril = SETTLED;
  h.state.rootAnswer = { ok: true, root: await workflowRoot(context) };
  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].options.prompt.includes("C:\\private"), false);
  assert.match(h.runs[0].options.prompt, /Workflow changes are unknown\./u, "the failed Git read is told as unknown");
  // A board that is not ready with the same failures: refused, and the failures stay unseen.
  const refused = await chatHarness(context, {
    repositoryGithub: { read: async () => { throw new Error("gh failed"); } },
    worktrees: { inventory: async () => { throw new Error("walk failed"); } },
    sessionEnvironment: async () => { throw new Error("registry failed"); },
  });
  refused.state.board = "ready";
  assert.deepEqual(await send(refused), unavailable);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
});

test("an owner's message records how long each step took by its own clock, and the total up to the process start", async (context) => {
  let clock = 1_000;
  const github = deferred();
  const started = [];
  const h = await chatHarness(context, { clock: () => clock, repositoryGithub: { read: () => { started.push("github"); return github.promise; } } });
  const sending = send(h);
  await until(() => started.length === 1);
  // The new conversation exists once the store step is done; from here the clock moves and only GitHub is still pending.
  await until(async () => (await h.store.index(repositoryId)).length === 1);
  clock = 3_900;
  github.resolve({ squashMergeAllowed: true });
  const sent = await sending;
  assert.equal(sent.ok, true);
  h.runs[0].measured = { eventMs: 100, textMs: 200, doneMs: 300 };
  const answer = (await finishTurn(h, h.runs[0], { status: "complete", text: "Ok." }, sent.conversationId)).messages.at(-1);
  const { prepare } = answer.timing;
  assert.deepEqual(Object.keys(prepare), ["board", "root", "runs", "taskLog", "github", "workflow", "worktrees", "instructions", "context", "environment", "store", "declare", "server", "total"]);
  assert.equal(prepare.github, 2_900, "the step that waited");
  assert.equal(prepare.total, 2_900, "the whole preparation, from the message to the process");
  for (const step of ["board", "root", "runs", "taskLog", "workflow", "worktrees", "instructions", "environment", "declare", "server"]) assert.equal(prepare[step], 0, `${step} took no time of its own, and did not count the wait for GitHub`);
  for (const step of ["context", "store"]) assert.ok(Number.isInteger(prepare[step]) && prepare[step] <= prepare.total, step);
  // Numbers only: the stored record holds no word of the message, the board, or a path.
  assert.equal(JSON.stringify(answer.timing).match(/[A-Za-z]+/gu).every((word) => ["eventMs", "textMs", "doneMs", "prompt", "instructions", "board", "taskLog", "conversation", "message", "other", "prepare", "root", "runs", "github", "workflow", "worktrees", "context", "environment", "store", "declare", "server", "total"].includes(word)), true);
  assert.deepEqual((await h.reload().read(repositoryId, sent.conversationId)).messages.at(-1).timing.prepare, prepare, "the preparation is on disk");
});

test("a turn records only the steps it ran: no GitHub without a reader of it, and no instructions file for Codex", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h, { provider: "codex" });
  h.runs[0].measured = { eventMs: 1, textMs: 2, doneMs: 3 };
  const { prepare } = (await finishTurn(h, h.runs[0], { status: "complete", text: "Ok." }, sent.conversationId)).messages.at(-1).timing;
  assert.deepEqual(Object.keys(prepare), ["board", "root", "runs", "taskLog", "workflow", "worktrees", "context", "environment", "store", "declare", "server", "total"]);
  assert.ok(Object.values(prepare).every((ms) => Number.isInteger(ms) && ms >= 0 && ms <= prepare.total));
});

test("a follow-up, a grant write turn, and a run that measured nothing store no timing, so no preparation", async (context) => {
  const h = await chatHarness(context);
  const proposal = pendingProposal();
  const stored = await seed(h, { messages: withProposal(proposal) });
  await h.handle("dismiss", { repositoryId, conversationId: stored.id, proposalId: proposal.id });
  const run = await h.followUp();
  run.measured = { eventMs: 1, textMs: 2, doneMs: 3 };
  const conversation = await h.finishFollowUp(stored.id);
  assert.equal(Object.hasOwn(conversation.messages.at(-1), "timing"), false);
  const grant = h.chat.grantWrite({ repositoryId, plans: ["docs/plans/next.md"] });
  const grantRun = await until(() => h.runs.find((candidate) => candidate !== run));
  grantRun.measured = { eventMs: 1, textMs: 2, doneMs: 3 };
  grantRun.resolve({ status: "complete", text: "Nothing left.\nNo tasks written." });
  const granted = await grant;
  assert.equal(Object.hasOwn((await h.reload().read(repositoryId, granted.conversationId)).messages.at(-1), "timing"), false);
  // A message whose run measured nothing stores no timing, and so no preparation.
  const sent = await send(h, { text: "Another question" });
  const second = h.runs.at(-1);
  second.measured = null;
  const unmeasured = await finishTurn(h, second, { status: "stopped", text: "" }, sent.conversationId);
  assert.equal(Object.hasOwn(unmeasured.messages.at(-1), "timing"), false);
});

test("createPreparation times each step by itself and starts a step at once", async () => {
  let now = 0;
  const prep = createPreparation(() => now);
  let began = false;
  const deferredBoard = deferred();
  const board = prep.step("board", () => { began = true; return deferredBoard.promise; });
  assert.equal(began, true, "work begins when the step is made, not a tick later");
  const root = prep.step("root", async () => "root");
  await root();
  const github = prep.step("github", (rootValue, boardValue) => `${rootValue}/${boardValue}`, [root, board]);
  now = 500;
  deferredBoard.resolve("board");
  assert.equal(await github(), "root/board");
  now = 700;
  assert.deepEqual(prep.measure(), { board: 500, root: 0, github: 0, total: 700 }, "a step counts its own work, not the wait for the steps it needed");
  assert.equal(await board(), "board", "a reader may be called again");
});

test("createPreparation adds work in sequence to one step, rounds to whole milliseconds, and counts a failure's time too", async () => {
  let now = 0;
  const prep = createPreparation(() => now);
  assert.equal(await prep.time("store", async () => { now += 0.6; return "created"; }), "created");
  await prep.time("store", async () => { now += 0.6; });
  await assert.rejects(prep.time("store", async () => { now += 0.6; throw new Error("failed"); }), /failed/u);
  now = 10.4;
  assert.deepEqual(prep.measure(), { store: 2, total: 10 });
});

test("a step that fails waits inside its reader, passes the failure to the steps that need it, and cannot fail unseen", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const prep = createPreparation(() => 0);
    const failing = prep.step("runs", () => { throw new Error("no runs"); });
    let ran = false;
    const dependent = prep.step("context", () => { ran = true; return "never"; }, [failing]);
    prep.step("worktrees", async () => { throw new Error("nobody reads this"); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, [], "a step nobody reads cannot raise an unhandled rejection");
    await assert.rejects(failing(), /no runs/u);
    await assert.rejects(dependent(), /no runs/u);
    assert.equal(ran, false, "a step does not run without what it needs");
    assert.deepEqual(Object.keys(prep.measure()).sort(), ["runs", "total", "worktrees"], "a step that never ran has no time");
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("the worktrees step of a cold turn takes no time, the read it starts runs in the background, and the next turn finds the rows at no time either", async (context) => {
  let clock = 1_000;
  const read = deferred();
  const walks = [];
  let reads = 0;
  const worktrees = {
    inventory: () => { reads += 1; return read.promise; },
    sizes: () => { walks.push("walk"); return new Promise(() => {}); },
  };
  const h = await chatHarness(context, { clock: () => clock, worktrees });
  const prepared = async (index) => {
    const sent = await send(h);
    h.runs[index].measured = { eventMs: 1, textMs: 2, doneMs: 3 };
    return (await finishTurn(h, h.runs[index], { status: "complete", text: "Ok." }, sent.conversationId)).messages.at(-1).timing.prepare;
  };
  // The turn is over while the read, which would take seven seconds on this clock, is still running.
  const first = await prepared(0);
  assert.equal(reads, 1);
  assert.equal(first.worktrees, 0, "a cold turn waits for nothing");
  assert.equal(first.total, 0);
  assert.match(h.runs[0].options.prompt, /<task_worktrees>\nTask worktree facts are still being read/u);
  clock += 7_000;
  read.resolve([{ taskId: "T-1", clean: true, uniqueCommits: false }]);
  await until(() => walks.length === 1);
  const second = await prepared(1);
  assert.equal(second.worktrees, 0, "cached facts wait for nothing");
  assert.deepEqual(walks, ["walk"], "the cached turn started no second walk");
  assert.equal(reads, 1);
  assert.match(h.runs[1].options.prompt, /"taskId":"T-1"/u);
});
