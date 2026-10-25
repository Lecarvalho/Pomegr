import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeOperation, normalizeProposal, applyOperations } from "../desktop/runtime/agent-chat-proposal.mjs";
import { AGENT_CHAT_INSTRUCTIONS, boardSnapshot, composePrompt, PROMPT_LIMIT, proposalOutcome } from "../desktop/runtime/agent-chat-prompt.mjs";
import { chatHarness, seed, pendingProposal, withProposal, repositoryId } from "./helpers/agent-chat-harness.mjs";

const actions = { start: false, review: true, sendBack: false, merge: false, writeTasks: false };
const limits = { hours: null, starts: null, concurrent: null, sendBacks: null, allowancePercent: null };
const reviewer = { provider: null, model: null, differentFromBuilder: false };
const settings = { actions, limits, workRules: [], reviewer };
const operations = [
  { op: "set_aril_settings", settings }, { op: "add_memory", text: "Use focused tests." },
  { op: "update_memory", id: 1, text: "Use the full suite." }, { op: "remove_memory", id: 2 },
];
const proposal = (ops) => ({ summary: "Set repository preferences", operations: ops });
const fence = (ops) => `\`\`\`pomegr-board\n${JSON.stringify(proposal(ops))}\n\`\`\``;
const validSettings = (value) => normalizeOperation({ op: "set_aril_settings", settings: value });

test("Aril settings mirror phase 3a fields, nested shapes, numeric and text bounds", () => {
  for (const operation of operations) assert.deepEqual(normalizeOperation(operation), operation);
  for (const [key, value] of Object.entries(settings)) assert.deepEqual(validSettings({ [key]: value }), { op: "set_aril_settings", settings: { [key]: value } });
  assert.ok(validSettings({}));
  for (const bad of [null, [], { pairedDevices: false }, { pairedDevices: true }, { other: 1 },
    { actions: { start: true } }, { actions: { ...actions, merge: 1 } }, { actions: { ...actions, pairedDevices: false } },
    { limits: { hours: 1 } }, { reviewer: { provider: null } }, { reviewer: { ...reviewer, provider: "other" } },
    { reviewer: { ...reviewer, differentFromBuilder: null } }, { reviewer: { ...reviewer, extra: 1 } },
    { reviewer: { ...reviewer, model: "x".repeat(121) } }, { reviewer: { ...reviewer, model: "bad/model" } }, { reviewer: { ...reviewer, model: "C:private" } },
  ]) assert.equal(validSettings(bad), null, JSON.stringify(bad));
  for (const [field, min, max] of [["hours", 1, 72], ["starts", 1, 100], ["concurrent", 1, 10], ["sendBacks", 0, 10], ["allowancePercent", 1, 100]]) {
    for (const value of [null, min, max]) assert.ok(validSettings({ limits: { ...limits, [field]: value } }));
    for (const value of [min - 1, max + 1, 1.5, "1", true]) assert.equal(validSettings({ limits: { ...limits, [field]: value } }), null);
  }
  for (const provider of [null, "claude", "codex"]) assert.ok(validSettings({ reviewer: { ...reviewer, provider, model: "x".repeat(120) } }));
  for (const [model, normalized] of [["", null], [" model-1 ", "model-1"], ["model@1+fast", "model@1+fast"]]) assert.equal(validSettings({ reviewer: { ...reviewer, model } }).settings.reviewer.model, normalized);
  const rule = (kind, value) => validSettings({ workRules: [{ kind, value }] });
  for (const [kind, value] of [["tag", "é".repeat(40)], ["text", "x".repeat(80)], ["feature", "feat-1"], ["tasks", Array(50).fill("T-1")]]) assert.ok(rule(kind, value));
  for (const [kind, value] of [["tag", "x".repeat(41)], ["tag", "a b"], ["tag", "IMAGE"], ["tag", "a/b"], ["text", "x".repeat(81)], ["text", "  "], ["text", "x\n"], ["text", "\u0085x"], ["tasks", []], ["tasks", Array(51).fill("T-1")], ["tasks", ["T-0"]], ["feature", 1], ["other", "x"]]) assert.equal(rule(kind, value), null);
  assert.ok(validSettings({ workRules: Array(20).fill({ kind: "text", value: "x" }) }));
  assert.equal(validSettings({ workRules: Array(21).fill({ kind: "text", value: "x" }) }), null);
  assert.equal(validSettings({ workRules: [{ kind: "text", value: "x", pairedDevices: true }] }), null);
});

test("memory validates exact payloads, safe positive IDs and untrimmed single-line bounds", () => {
  for (const op of ["add_memory", "update_memory"]) {
    const base = { op, ...(op === "update_memory" ? { id: 1 } : {}) };
    for (const text of ["x", "x".repeat(300), " x "]) assert.deepEqual(normalizeOperation({ ...base, text }), { ...base, text });
    for (const text of ["", " ", "x".repeat(301), ` ${"x".repeat(300)}`, "x\n", "\tx", "x\u007f", "x\u2028", null]) assert.equal(normalizeOperation({ ...base, text }), null);
    assert.equal(normalizeOperation({ ...base, text: "x", extra: true }), null);
  }
  for (const op of ["update_memory", "remove_memory"]) {
    const base = { op, ...(op === "update_memory" ? { text: "x" } : {}) };
    for (const id of [1, Number.MAX_SAFE_INTEGER]) assert.ok(normalizeOperation({ ...base, id }));
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) assert.equal(normalizeOperation({ ...base, id }), null);
  }
  assert.equal(normalizeOperation({ op: "remove_memory", id: 1, text: "x" }), null);
});

test("settings stand alone and memory combines only with memory", () => {
  for (const operation of operations) assert.ok(normalizeProposal(proposal([operation])));
  assert.ok(normalizeProposal(proposal(operations.slice(1))));
  for (const operation of operations) {
    for (const other of [operations[0], { op: "create_task", text: "x" }, { op: "start_session", id: "T-1" }, { op: "set_queue", on: true }]) {
      assert.equal(normalizeProposal(proposal([operation, other])), null);
      assert.equal(normalizeProposal(proposal([other, operation])), null);
    }
  }
});

test("applied operations use exact monitor payloads and fixed outcomes, stopping on failure", async () => {
  const names = ["aril_settings_set", "aril_memory_add", "aril_memory_update", "aril_memory_remove"];
  for (const [index, operation] of operations.entries()) {
    const calls = [];
    const payload = { ...operation };
    delete payload.op;
    const results = await applyOperations([operation], { board: {}, post: async (...args) => { calls.push(args); return { ok: true, settings: { secret: "private" }, entry: { text: "private" } }; } });
    assert.deepEqual(calls, [[names[index], payload]]);
    assert.deepEqual(results, [{ ok: true }]);
    assert.equal(proposalOutcome({ ...proposal([operation]), state: "applied", results }).outcome, "applied");
    for (const error of ["invalid", "not_found", "limit", "conflict", "unsupported", "private details"]) {
      const results = await applyOperations([operation, operations[1]], { board: {}, post: async () => ({ ok: false, error }) });
      assert.deepEqual(results, [{ ok: false, error: error === "private details" ? "unavailable" : error }, { ok: false, error: "skipped" }]);
    }
  }
});

test("paired Apply reads current pairedDevices; desktop Apply is unaffected for every operation", async (context) => {
  for (const operation of operations) for (const pairedDevices of [undefined, false, true]) for (const paired of [false, true]) {
    const h = await chatHarness(context);
    h.state.board.aril = { settings: { ...settings, pairedDevices }, memory: [] };
    const saved = pendingProposal(proposal([operation]));
    const conversation = await seed(h, { messages: withProposal(saved) });
    const payload = { repositoryId, conversationId: conversation.id, proposalId: saved.id };
    const allowed = !paired || pairedDevices === true;
    assert.deepEqual(await h.chat.handle("apply", payload, paired ? { paired: true } : { event: {} }), allowed ? { ok: true } : { ok: false, error: "desktop_only" });
    assert.equal(h.actionCalls().length, allowed ? 1 : 0);
    assert.ok(h.calls.some((call) => call.pathname === "/api/tasks"));
    const stored = (await h.reload().read(repositoryId, conversation.id)).messages[1].proposal;
    assert.equal(stored.state, allowed ? "applied" : "pending");
    if (allowed) await h.finishFollowUp(conversation.id);
  }
});

test("a follow-up containing any settings or memory operation is unreadable", async (context) => {
  for (const operation of operations) {
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

test("snapshot includes served settings and bounded oldest-first memory within the prompt budget", () => {
  const served = { ...settings, pairedDevices: true };
  const memory = Array.from({ length: 110 }, (_, index) => ({ id: index + 1, text: "x".repeat(310), createdAt: index, updatedAt: 999, private: "omitted" })).reverse();
  const board = { aril: { settings: served, memory }, features: [{ id: "feat-1", name: "Delivery", done: false }], tasks: Array.from({ length: 100 }, (_, i) => ({ id: `T-${i + 1}`, text: "x".repeat(4000) })) };
  const snapshot = boardSnapshot(board, { repositoryName: "Repo" });
  assert.deepEqual(snapshot.aril_settings, served);
  assert.deepEqual(snapshot.features, [{ id: "feat-1", name: "Delivery", done: false }], "work rules need feature IDs, not titles");
  assert.deepEqual(snapshot.memory, Array.from({ length: 100 }, (_, i) => ({ id: i + 1, text: "x".repeat(300) })));
  const prompt = composePrompt({ board, repositoryName: "Repo", message: "Advice" });
  assert.ok(prompt && prompt.length <= PROMPT_LIMIT);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Your settings and memory/u);
  for (const { op } of operations) assert.ok(AGENT_CHAT_INSTRUCTIONS.includes(`"op":"${op}"`));
  assert.match(AGENT_CHAT_INSTRUCTIONS, /null means not settled/u);
  assert.match(AGENT_CHAT_INSTRUCTIONS, /Never store secrets, credentials, or personal data/u);
});

test("LAN composition marks chat calls paired without accepting a client origin flag", async () => {
  const shell = await readFile(new URL("../desktop/runtime/shell-main.mjs", import.meta.url), "utf8");
  assert.match(shell, /agentChat: \(operation, payload\) => agentChat.handle\(operation, payload, \{ paired: true \}\)/u);
});
