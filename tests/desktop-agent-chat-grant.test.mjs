import assert from "node:assert/strict";
import test from "node:test";

import { extractProposal, normalizeOperation } from "../desktop/runtime/agent-chat-proposal.mjs";
import { chatHarness, claudeExecutable, codexExecutable, finishTurn, repositoryId, send, until } from "./helpers/agent-chat-harness.mjs";

const plans = ["docs/plans/next.md", "docs/plans/later.md"];
const request = { repositoryId, plans };
const block = (operations) => `Next step.\n\`\`\`pomegr-board\n${JSON.stringify({ summary: "Build next step", operations })}\n\`\`\``;
const create = { op: "create_task", text: "Build the next step" };
const writes = (h) => h.calls.filter((call) => call.pathname === "/internal/tasks/grant-write-tasks");
async function answer(h, text, status = "complete") {
  const pending = h.chat.grantWrite(request);
  const run = await until(() => h.runs.at(-1));
  run.resolve({ status, text });
  const result = await pending;
  assert.equal(result.ok, true);
  return (await h.reload().read(repositoryId, result.conversationId)).messages.at(-1);
}

test("grant writes share the owner turn slot, including pending board reads", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h);
  assert.deepEqual(await h.chat.grantWrite(request), { ok: false, error: "busy" });
  await finishTurn(h, h.runs[0], { status: "complete", text: "Done" }, sent.conversationId);
  let release;
  h.state.gate = new Promise((resolve) => { release = resolve; });
  const pending = h.chat.grantWrite(request);
  assert.deepEqual(await h.chat.grantWrite(request), { ok: false, error: "busy" });
  assert.deepEqual(await send(h), { ok: false, error: "busy" });
  release();
  await until(() => h.runs[1]);
  h.runs[1].resolve({ status: "complete", text: "Nothing left.\nNo tasks written." });
  assert.equal((await pending).ok, true);
  assert.equal(writes(h).length, 0);
});

test("grant provider follows the reviewer rule, then installed Claude, then Codex, with default model", async (context) => {
  for (const [reviewer, files, expected] of [
    ["codex", [claudeExecutable, codexExecutable], "codex"],
    ["claude", [claudeExecutable, codexExecutable], "claude"],
    [null, [claudeExecutable, codexExecutable], "claude"],
    [null, [codexExecutable], "codex"],
  ]) {
    const h = await chatHarness(context, { files });
    h.state.board.aril = { settings: { reviewer: { provider: reviewer, model: "ignored" } }, memory: { text: "- Use repository checks", previous: null, updatedAt: 1, updatedBy: "owner" } };
    await answer(h, "Nothing left.\nNo tasks written.");
    const { provider, model, prompt } = h.runs[0].options;
    assert.equal(provider, expected);
    assert.equal(model, null);
    assert.ok(prompt.includes(plans.join("\n")));
    for (const text of ["Pomegr started this run because the owner's active grant", "Find the next step that has no task on this board", "check the code, the board, and the git log", "one to five, in order", "repository's own verification commands", "branch, pull request", '"#1".."#5"', "<board_snapshot>", "Existing task one", "Use repository checks", "<task_log_since_last_turn>"]) assert.ok(prompt.includes(text), text);
    assert.doesNotMatch(prompt, /<owner_message>/u);
    assert.equal(h.runs.length, 1);
  }
});

test("grant creates exact payload, persists applied marker and task IDs, and never follows up", async (context) => {
  const h = await chatHarness(context);
  h.state.actions = (action) => action === "grant-write-tasks" ? { ok: true, taskIds: ["T-4", "T-5"] } : { ok: true };
  const message = await answer(h, block([create, { ...create, text: "Follow it", complete_when: ["pr_open"], own_condition: "Checks pass", runs_after: ["#1", "T-1"] }]));
  assert.deepEqual(writes(h).map(({ body }) => body), [{ repositoryId, plan: plans[0], tasks: [
    { text: create.text }, { text: "Follow it", completeWhen: { checks: ["pr_open"], own: "Checks pass" }, after: ["#1", "T-1"] },
  ] }]);
  assert.equal(message.proposal.state, "applied");
  assert.equal(message.proposal.appliedBy, "grant");
  assert.equal(message.proposal.summary, "Applied by grant.");
  assert.deepEqual(message.proposal.results, [{ ok: true, taskId: "T-4" }, { ok: true, taskId: "T-5" }]);
  assert.deepEqual(message.proposal.operations[1].after, ["#1", "T-1"]);
  assert.equal((await h.store.index(repositoryId))[0].title, "Grant: tasks from next.md");
  assert.equal(h.runs.length, 1);
});

test("grant rejects other operations, extra fields even if empty, and malformed dependencies or blocks", async (context) => {
  for (const text of [
    block([create, { op: "delete_task", id: "T-1" }]), "Bad\n```pomegr-board\n{broken}\n```",
    block([{ ...create, feature: null }]), block([{ ...create, queue: false }]), block([{ ...create, images: null }]),
    block([{ ...create, column: null }]), block([{ ...create, provider: null }]), block([{ ...create, run: {} }]),
    block([{ ...create, runs_after: ["#1"] }]), block([{ ...create, runs_after: ["T-999"] }]), block(Array(6).fill(create)),
  ]) {
    const h = await chatHarness(context);
    const message = await answer(h, text);
    assert.equal(writes(h).length, 0, text);
    assert.equal(message.proposalUnreadable, true, text);
    assert.equal(message.proposal, undefined);
  }
});

test("grant records fixed refusals and never retries or exposes monitor errors", async (context) => {
  for (const response of [{ ok: false, error: "not_active" }, { ok: false, error: "not_allowed" }, { ok: false, error: "limit" }, { ok: false, error: "private error" }, new Error("private error")]) {
    const h = await chatHarness(context);
    h.state.actions = (action) => {
      if (action !== "grant-write-tasks") return { ok: true };
      if (response instanceof Error) throw response;
      return response;
    };
    const message = await answer(h, block([create]));
    assert.equal(message.proposal.state, "applied");
    assert.deepEqual(message.proposal.results, [{ ok: false, error: ["not_active", "not_allowed"].includes(response.error) ? "conflict" : response.error === "limit" ? "limit" : "unavailable" }]);
    assert.doesNotMatch(JSON.stringify(message), /private error/u);
    assert.equal(writes(h).length, 1);
    assert.equal(h.runs.length, 1);
  }
});

test("runs_after is bounded and only accepted by grant proposal validation", () => {
  const options = { grantWrite: true };
  assert.deepEqual(normalizeOperation({ ...create, runs_after: ["#1", "T-1"] }, options), { ...create, after: ["#1", "T-1"] });
  for (const runs_after of [null, "T-1", ["#0"], ["#6"], ["#01"], ["T-0"], ["T-1", "T-1"], Array.from({ length: 9 }, (_, i) => `T-${i + 1}`)]) {
    assert.equal(normalizeOperation({ ...create, runs_after }, options), null);
  }
  assert.equal(extractProposal(block([{ ...create, runs_after: ["T-1"] }])).unreadable, true, "owner turns unchanged");
});

test("a grant outcome that cannot be saved reports unavailable and releases its slot", async (context) => {
  let saves = 0;
  const conversation = { id: "chat-0123456789ab", messages: [] };
  const h = await chatHarness(context, { store: {
    index: async () => [],
    create: async () => conversation,
    read: async () => conversation,
    save: async () => ++saves === 1,
  } });
  const pending = h.chat.grantWrite(request);
  await until(() => h.runs[0]);
  h.runs[0].resolve({ status: "complete", text: "Nothing left.\nNo tasks written." });
  assert.deepEqual(await pending, { ok: false, error: "unavailable" });
  assert.deepEqual(await h.chat.grantWrite({ repositoryId, plans: [] }), { ok: false, error: "invalid" });
});

test("unfinished and stopped grant runs write nothing; missing CLI releases the slot", async (context) => {
  for (const status of ["failed", "timed_out", "stopped"]) {
    const h = await chatHarness(context);
    const message = await answer(h, block([create]), status);
    assert.equal(message.status, status);
    assert.equal(message.proposal, undefined);
    assert.equal(writes(h).length, 0);
  }
  const h = await chatHarness(context, { files: [] });
  assert.deepEqual(await h.chat.grantWrite(request), { ok: false, error: "cli_missing" });
  assert.deepEqual(await h.chat.grantWrite(request), { ok: false, error: "cli_missing" });
  assert.equal(h.runs.length, 0);
});
