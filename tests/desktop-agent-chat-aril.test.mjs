import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeOperation, normalizeProposal, applyOperations } from "../desktop/runtime/agent-chat-proposal.mjs";
import { AGENT_CHAT_INSTRUCTIONS, boardSnapshot, composePrompt, PROMPT_LIMIT, proposalOutcome } from "../desktop/runtime/agent-chat-prompt.mjs";
import { createArilSwitch } from "../desktop/runtime/aril-switch.mjs";
import { chatHarness, seed, pendingProposal, withProposal, repositoryId, root, send } from "./helpers/agent-chat-harness.mjs";

const actions = { start: false, review: true, sendBack: false, merge: false, writeTasks: false, markDone: false };
const limits = { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null };
const reviewer = { provider: null, model: null, differentFromBuilder: false };
const settings = { actions, mergeMethod: null, mergeMode: null, deleteBranch: null, limits, workRules: [], reviewer };
// Aril settings are the one operation of this kind left. Memory was a proposal once; Aril keeps it current by itself now (agent-chat-memory.mjs).
const operations = [{ op: "set_aril_settings", settings }];
const memoryOperations = [{ op: "add_memory", text: "Use focused tests." }, { op: "update_memory", id: 1, text: "Use the full suite." }, { op: "remove_memory", id: 2 }];
const proposal = (ops) => ({ summary: "Set repository preferences", operations: ops });
const fence = (ops) => `\`\`\`pomegr-board\n${JSON.stringify(proposal(ops))}\n\`\`\``;
const validSettings = (value) => normalizeOperation({ op: "set_aril_settings", settings: value });

test("Aril settings mirror phase 3a fields, nested shapes, numeric and text bounds", () => {
  for (const operation of operations) assert.deepEqual(normalizeOperation(operation), operation);
  for (const [key, value] of Object.entries(settings)) assert.deepEqual(validSettings({ [key]: value }), { op: "set_aril_settings", settings: { [key]: value } });
  assert.ok(validSettings({}));
  assert.deepEqual(validSettings({ actions: { ...actions, markDone: true } }).settings, { actions: { ...actions, markDone: true } }, "Aril may propose the Mark done switch (T-182)");
  for (const method of [null, "squash", "merge", "rebase"]) assert.deepEqual(validSettings({ mergeMethod: method }).settings, { mergeMethod: method });
  for (const method of ["fast-forward", "", 1, false]) assert.equal(validSettings({ mergeMethod: method }), null);
  for (const mode of [null, "direct", "auto"]) assert.deepEqual(validSettings({ mergeMode: mode }).settings, { mergeMode: mode });
  for (const mode of ["queue", "", "Direct", 1, false, undefined]) assert.equal(validSettings({ mergeMode: mode }), null, String(mode));
  for (const value of [null, true, false]) assert.deepEqual(validSettings({ deleteBranch: value }).settings, { deleteBranch: value });
  for (const value of ["true", 0, 1, "delete", undefined]) assert.equal(validSettings({ deleteBranch: value }), null, String(value));
  for (const value of [true, false]) assert.deepEqual(validSettings({ followUps: value }).settings, { followUps: value });
  for (const value of [null, "true", 0, undefined]) assert.equal(validSettings({ followUps: value }), null, String(value));
  assert.deepEqual(validSettings({ mergeMethod: "squash", mergeMode: "auto", deleteBranch: true }).settings, { mergeMethod: "squash", mergeMode: "auto", deleteBranch: true });
  for (const bad of [null, [], { pairedDevices: false }, { pairedDevices: true }, { other: 1 },
    { actions: { start: true } }, { actions: { ...actions, merge: 1 } }, { actions: { ...actions, pairedDevices: false } },
    { actions: { ...actions, markDone: "yes" } }, { actions: Object.fromEntries(Object.entries(actions).filter(([key]) => key !== "markDone")) },
    { limits: { hours: 1 } }, { reviewer: { provider: null } }, { reviewer: { ...reviewer, provider: "other" } },
    { reviewer: { ...reviewer, differentFromBuilder: null } }, { reviewer: { ...reviewer, extra: 1 } },
    { reviewer: { ...reviewer, model: "x".repeat(121) } }, { reviewer: { ...reviewer, model: "bad/model" } }, { reviewer: { ...reviewer, model: "C:private" } },
  ]) assert.equal(validSettings(bad), null, JSON.stringify(bad));
  for (const [field, min, max] of [["hours", 1, 72], ["tasks", 1, 100], ["tasksAtATime", 1, 10], ["sendBacks", 0, 10], ["usagePercent", 1, 100]]) {
    for (const value of [null, min, max]) assert.ok(validSettings({ limits: { ...limits, [field]: value } }));
    for (const value of [min - 1, max + 1, 1.5, "1", true]) assert.equal(validSettings({ limits: { ...limits, [field]: value } }), null);
  }
  for (const retired of [
    { hours: 2, starts: 5, concurrent: 2, sendBacks: 1, allowancePercent: 50 },
    { ...limits, starts: 5 }, { ...limits, allowancePercent: 50 },
  ]) assert.equal(validSettings({ limits: retired }), null);
  for (const provider of [null, "claude", "codex"]) assert.ok(validSettings({ reviewer: { ...reviewer, provider, model: "x".repeat(120) } }));
  for (const [model, normalized] of [["", null], [" model-1 ", "model-1"], ["model@1+fast", "model@1+fast"]]) assert.equal(validSettings({ reviewer: { ...reviewer, model } }).settings.reviewer.model, normalized);
  const rule = (kind, value) => validSettings({ workRules: [{ kind, value }] });
  for (const [kind, value] of [["tag", "é".repeat(40)], ["text", "x".repeat(80)], ["feature", "feat-1"], ["tasks", Array(50).fill("T-1")]]) assert.ok(rule(kind, value));
  for (const [kind, value] of [["tag", "x".repeat(41)], ["tag", "a b"], ["tag", "IMAGE"], ["tag", "a/b"], ["text", "x".repeat(81)], ["text", "  "], ["text", "x\n"], ["text", "\u0085x"], ["tasks", []], ["tasks", Array(51).fill("T-1")], ["tasks", ["T-0"]], ["feature", 1], ["other", "x"]]) assert.equal(rule(kind, value), null);
  for (const path of ["plan.md", "docs/plan.md", "a_b/c-1.v2.md"]) assert.deepEqual(rule("plan", path).settings.workRules, [{ kind: "plan", value: path }]);
  for (const path of ["", "a", "plan.MD", "/plan.md", "./plan.md", "../plan.md", "docs/../plan.md", "docs//plan.md", "docs\\plan.md", "C:/plan.md", "a".repeat(198) + ".md", "docs/plan.md ", "next.md\n", "next.md\r"]) assert.equal(rule("plan", path), null, path);
  assert.ok(rule("plan", `${"a".repeat(197)}.md`));
  assert.ok(validSettings({ workRules: Array(20).fill({ kind: "text", value: "x" }) }));
  assert.equal(validSettings({ workRules: Array(21).fill({ kind: "text", value: "x" }) }), null);
  assert.equal(validSettings({ workRules: [{ kind: "text", value: "x", pairedDevices: true }] }), null);
});

test("settings stand alone, and a memory operation is no longer part of any proposal", () => {
  for (const operation of operations) assert.ok(normalizeProposal(proposal([operation])));
  for (const operation of operations) {
    for (const other of [operations[0], { op: "create_task", text: "x" }, { op: "start_session", id: "T-1" }, { op: "set_queue", on: true }]) {
      assert.equal(normalizeProposal(proposal([operation, other])), null);
      assert.equal(normalizeProposal(proposal([other, operation])), null);
    }
  }
  for (const operation of memoryOperations) assert.equal(normalizeProposal(proposal([operation])), null, operation.op);
});

test("applied operations use exact monitor payloads and fixed outcomes, stopping on failure", async () => {
  const names = ["aril_settings_set"];
  for (const [index, operation] of operations.entries()) {
    const calls = [];
    const payload = { ...operation };
    delete payload.op;
    const results = await applyOperations([operation], { board: {}, post: async (...args) => { calls.push(args); return { ok: true, settings: { secret: "private" }, entry: { text: "private" } }; } });
    assert.deepEqual(calls, [[names[index], payload]]);
    assert.deepEqual(results, [{ ok: true }]);
    assert.equal(proposalOutcome({ ...proposal([operation]), state: "applied", results }).outcome, "applied");
    for (const error of ["invalid", "not_found", "limit", "conflict", "unsupported", "private details"]) {
      const results = await applyOperations([operation, operations[0]], { board: {}, post: async () => ({ ok: false, error }) });
      assert.deepEqual(results, [{ ok: false, error: error === "private details" ? "unavailable" : error }, { ok: false, error: "skipped" }]);
    }
  }
});

test("paired Apply needs the owner's one permission for paired devices, whatever a repository's old pairedDevices says; desktop Apply is unaffected", async (context) => {
  for (const operation of operations) for (const pairedOn of [false, true]) for (const legacy of [undefined, false, true]) for (const paired of [false, true]) {
    const h = await chatHarness(context, { arilSwitch: createArilSwitch({ initial: { on: true, pairedOn } }) });
    h.state.board.aril = { settings: { ...settings, pairedDevices: legacy }, memory: { text: "", previous: null, updatedAt: null, updatedBy: null } };
    const saved = pendingProposal(proposal([operation]));
    const conversation = await seed(h, { messages: withProposal(saved) });
    const payload = { repositoryId, conversationId: conversation.id, proposalId: saved.id };
    const allowed = !paired || pairedOn;
    assert.deepEqual(await h.chat.handle("apply", payload, paired ? { paired: true } : { event: {} }), allowed ? { ok: true } : { ok: false, error: "desktop_only" });
    assert.equal(h.actionCalls().length, allowed ? 1 : 0);
    assert.ok(h.calls.some((call) => call.pathname === "/api/tasks"));
    const stored = (await h.reload().read(repositoryId, conversation.id)).messages[1].proposal;
    assert.equal(stored.state, allowed ? "applied" : "pending");
    if (allowed) await h.finishFollowUp(conversation.id);
  }
});

test("a follow-up containing any settings or memory operation is unreadable", async (context) => {
  for (const operation of [...operations, ...memoryOperations]) {
    const h = await chatHarness(context);
    const saved = pendingProposal({ operations: [{ op: "queue_task", id: "T-1" }] });
    const conversation = await seed(h, { messages: withProposal(saved) });
    assert.deepEqual(await h.handle("apply", { repositoryId, conversationId: conversation.id, proposalId: saved.id }), { ok: true });
    const after = await h.finishFollowUp(conversation.id, { status: "complete", text: fence([operation]) });
    assert.equal(after.messages.at(-1).proposalUnreadable, true);
    assert.equal(after.messages.at(-1).proposal, undefined);
    assert.equal(h.actionCalls().length, 1);
  }
});

test("snapshot includes served settings and the repository's memory text within the prompt budget", () => {
  const served = { ...settings, pairedDevices: true, settledAt: "2026-10-25T12:00:00.000Z" };
  // The memory is free text of at most 6,000 characters, sent whole with the time it was last changed; what the board also serves is left out.
  const memory = { text: Array.from({ length: 20 }, (_, index) => `- Line ${index + 1} ${"x".repeat(280)}`).join("\n"), previous: "- an older text", updatedAt: 999, updatedBy: "aril" };
  const board = { aril: { settings: served, memory }, features: [{ id: "feat-1", name: "Delivery", done: false }], tasks: Array.from({ length: 100 }, (_, i) => ({ id: `T-${i + 1}`, text: "x".repeat(4000) })) };
  const snapshot = boardSnapshot(board, { repositoryName: "Repo" });
  assert.deepEqual(snapshot.aril_settings, { ...settings, settledAt: served.settledAt }, "the first version's per-repository pairedDevices grants nothing now and is not sent");
  assert.equal(Object.hasOwn(snapshot.aril_settings, "pairedDevices"), false);
  assert.deepEqual(snapshot.features, [{ id: "feat-1", name: "Delivery", done: false }], "work rules need feature IDs, not titles");
  assert.deepEqual(snapshot.memory, { text: memory.text, updatedAt: new Date(999).toISOString() });
  assert.equal(snapshot.memory_omitted, undefined);
  assert.equal(boardSnapshot({ ...board, aril: { settings: served, memory: { ...memory, text: "" } } }, { repositoryName: "Repo" }).memory, null, "no text, no memory");
  assert.equal(boardSnapshot({ ...board, aril: { settings: served, memory: { ...memory, text: "y".repeat(7000) } } }, { repositoryName: "Repo" }).memory.text.length, 6000, "a text over the limit is cut to it");
  const prompt = composePrompt({ board, repositoryName: "Repo", message: "Advice" });
  assert.ok(prompt && prompt.length <= PROMPT_LIMIT);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Your settings and memory/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /grant_task_written/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /plan \(a repository-relative Markdown path/u);
  for (const { op } of operations) assert.ok(AGENT_CHAT_INSTRUCTIONS.includes(`"op":"${op}"`));
  assert.ok(AGENT_CHAT_INSTRUCTIONS.includes("What your settings and memory answer is settled: act on it and do not ask the owner again. Ask again only when the owner says a rule changed, or when <workflow_changes> lists a source that the rule depends on; then read that source, and propose an update to the setting, or update the memory, or ask only about what the change left unclear. A null setting is not settled: ask before relying on it, once, and propose the answer as a setting or save it in memory."));
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Never store secrets, credentials, or personal data/u);
});

const GITHUB = { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: false, defaultBranch: "main" };
test("the prompt shows the repository's GitHub merge settings, or unknown, and tells Aril to read the repository's rules first", () => {
  const board = { aril: { settings, memory: { text: "", previous: null, updatedAt: null, updatedBy: null } }, tasks: [] };
  const section = (repositoryGithub) => composePrompt({ board, repositoryName: "Repo", message: "Advice", repositoryGithub }).match(/<repository_github>\n([\s\S]*?)\n<\/repository_github>/u)?.[1];
  assert.equal(section(undefined), undefined, "a caller without a reader gets no section");
  assert.deepEqual(JSON.parse(section({ ...GITHUB, private: "omitted", defaultBranchRef: { name: "x" } })), GITHUB);
  assert.equal(section(null), "unknown");
  assert.equal(section({ ...GITHUB, autoMergeAllowed: "yes" }), "unknown");
  assert.deepEqual(JSON.parse(section({ ...GITHUB, defaultBranch: "bad..name" })), { ...GITHUB, defaultBranch: null });
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Before you propose merge settings, read the repository's own rules \(such as AGENTS\.md, CONTRIBUTING\.md, and its pull-request template\) and these GitHub settings, and propose values that fit them\. When they settle the answer, propose it and say where it came from; ask the owner only what they leave open\./u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /mergeMode is null \(not settled\), direct, or auto/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /deleteBranch is null \(the repository's own setting decides\), true, or false/u);
  for (const kind of ["grant_merge_auto", "grant_branch_deleted", "grant_branch_delete_refused"]) assert.match(AGENT_CHAT_INSTRUCTIONS, new RegExp(kind, "u"));
});

test("a message reads the repository's GitHub settings once for its prompt, and a failed read is unknown", async (context) => {
  const reads = [];
  const h = await chatHarness(context, { repositoryGithub: { read: async (id, folder) => { reads.push([id, folder]); return GITHUB; } } });
  assert.equal((await send(h)).ok, true);
  assert.deepEqual(reads, [[repositoryId, root]]);
  assert.ok(h.runs[0].options.prompt.includes(`<repository_github>\n${JSON.stringify(GITHUB)}\n</repository_github>`));
  const failing = await chatHarness(context, { repositoryGithub: { read: async () => { throw new Error("offline"); } } });
  assert.equal((await send(failing)).ok, true);
  assert.match(failing.runs[0].options.prompt, /<repository_github>\nunknown\n<\/repository_github>/u);
  const without = await chatHarness(context);
  assert.equal((await send(without)).ok, true);
  assert.equal(without.runs[0].options.prompt.includes("<repository_github>"), false);
});

test("LAN composition marks chat calls paired without accepting a client origin flag", async () => {
  const shell = await readFile(new URL("../desktop/runtime/shell-main.mjs", import.meta.url), "utf8");
  assert.match(shell, /agentChat: \(operation, payload\) => agentChat.handle\(operation, payload, \{ paired: true \}\)/u);
});

test("a task becomes Done under a grant only through the Mark done rule (T-182)", () => {
  assert.doesNotMatch(AGENT_CHAT_INSTRUCTIONS, /A merge never marks a task Done; the owner does that\./u);
  assert.doesNotMatch(AGENT_CHAT_INSTRUCTIONS, /mark a task Done under a grant\./u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /A merge alone never marks a task Done\. Done happens under a grant only through the Mark done rule: with markDone on/u);
  for (const condition of ["its pull request merged", "a fresh reading shows every Complete when check passed (an unavailable check is no pass)",
    "its review passed when reviews are on", "Complete when does not hold user_validated (that stays the owner's)", "the task is not blocked or stalled"]) {
    assert.ok(AGENT_CHAT_INSTRUCTIONS.includes(condition), condition);
  }
  assert.match(AGENT_CHAT_INSTRUCTIONS, /grant_done \(Aril marked a task Done under a grant\)/u);
});
