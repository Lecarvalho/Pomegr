import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { normalizedSessionHistory } from "../monitor/providers/session-history.mjs";
import { parseProviderSessionEvidence } from "../monitor/providers/provider-contract.mjs";
import { parseCodexRequestActivityEvidence, stampCodexActivityRequestIds } from "../monitor/providers/codex-activity-correlation.mjs";

const stamp = (index) => new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();

function codexResponse(index) {
  const record = (type, payload) => ({ timestamp: stamp(index), type, payload });
  const usage = { input_tokens: index + 2, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 };
  return [
    record("turn_context", { turn_id: "PRIVATE_TURN", model: "gpt-6-astra" }),
    record("event_msg", { type: "agent_message", id: `PRIVATE_REPLY_ID-${index}`, text: "PRIVATE_REPLY" }),
    record("response_item", { type: "function_call", call_id: `PRIVATE_CALL-${index}`, name: "exec_command", arguments: '{"cmd":"PRIVATE_COMMAND"}' }),
    record("token_usage_record", { response_id: `PRIVATE_RESPONSE-${index}`, usage }),
    record("response_item", { type: "function_call_output", call_id: `PRIVATE_CALL-${index}`, output: "PRIVATE_OUTPUT" }),
    record("event_msg", { type: "token_count", info: { last_token_usage: usage } }),
  ];
}

function linkedCodex(records, actorId = "primary") {
  const parsed = parseCodexRequestActivityEvidence(records, { actor: { id: actorId, label: "Agent" }, actorId, sourceKey: actorId, unlimited: true, stableFallbackIdentity: true });
  const evidence = { agents: [{ id: actorId, label: "Agent" }], usageSnapshots: parsed.usageSnapshots, toolCalls: parsed.toolCalls, activity: parsed.replies };
  stampCodexActivityRequestIds({ sessionId: "test", ...evidence, linkGroups: [parsed.links], unlimited: true });
  return normalizedSessionHistory("codex", "test", evidence);
}

test("Codex closing usage links multiple request groups in one turn without crossing actors", () => {
  const records = [...codexResponse(0), ...codexResponse(1).slice(1)];
  const history = linkedCodex(records);
  assert.equal(history.requests.length, 2);
  for (const request of history.requests) assert.equal(history.activity.filter((item) => item.requestId === request.id).length, 2);
  const child = linkedCodex(records, "agent-child");
  assert.ok(child.activity.every((item) => item.agentId === "agent-child"));
  assert.ok(child.requests.every((item) => !history.requests.some((parent) => parent.id === item.id)));
  assert.equal(JSON.stringify(history).includes("PRIVATE"), false);
  assert.deepEqual(linkedCodex([...records, ...records]), history, "duplicate source records cannot inflate links or work");
});

test("Codex request links fail closed at mismatched usage, missing receipts and structural boundaries", () => {
  const source = codexResponse(0);
  for (const boundary of [
    { type: "turn_context", payload: {} },
    { type: "compacted", payload: {} },
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [] } },
    { type: "event_msg", payload: { type: "token_count", info: null } },
    { type: "token_usage_record", payload: { usage: null } },
  ]) {
    const result = linkedCodex([...source.slice(0, -1), boundary, source.at(-1)]);
    assert.ok(result.activity.every((item) => item.requestId === null));
  }
  const mismatched = structuredClone(source);
  mismatched.at(-1).payload.info.last_token_usage.input_tokens = 9;
  // The real formats have separate objects, unlike this fixture's shared usage object.
  mismatched[3].payload.usage = { ...mismatched[3].payload.usage, input_tokens: 2 };
  assert.ok(linkedCodex(mismatched).activity.every((item) => item.requestId === null));
  assert.ok(linkedCodex(source.slice(0, -1)).activity.every((item) => item.requestId === null));
  assert.ok(linkedCodex([...source.slice(0, -1), ...codexResponse(1).slice(1, 3), source.at(-1)])
    .activity.every((item) => item.requestId === null), "a new response before the prior receipt is ambiguous");
  assert.ok(linkedCodex([source.at(-1), ...source.slice(0, -1)]).activity.every((item) => item.requestId === null), "earlier usage cannot be assigned to later output");
});

test("Codex legacy closing token counts link outputs but missing usage cannot bridge tool-result boundaries", () => {
  const source = codexResponse(0).filter((record) => record.type !== "token_usage_record");
  assert.equal(linkedCodex(source).activity.filter((item) => item.requestId).length, 2);
  const missingUsage = [...source.slice(0, -1), ...codexResponse(1).slice(1)];
  const history = linkedCodex(missingUsage);
  assert.equal(history.activity.filter((item) => item.requestId).length, 2);
});

test("Codex completed-message mirrors produce one linked reply with the recorded identity", () => {
  const records = codexResponse(0);
  records[1] = { timestamp: stamp(0), type: "event_msg", payload: { type: "item_completed", item: { type: "agent_message", id: "PRIVATE_MESSAGE", text: "PRIVATE_REPLY" } } };
  records.splice(2, 0, { timestamp: stamp(0), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "PRIVATE_REPLY" }] } });
  const history = linkedCodex(records);
  assert.equal(history.activity.filter((item) => item.tool === "Assistant replied").length, 1);
  assert.ok(history.activity.every((item) => item.requestId === history.requests[0].id));
});

test("Claude history retains complete requests and replies beyond live limits", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-claude-")); context.after(() => rm(root, { recursive: true, force: true }));
  const id = "history-claude"; const file = path.join(root, "projects", "x", `${id}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const records = Array.from({ length: 350 }, (_, index) => ({ type: "assistant", timestamp: stamp(index), message: { id: `reply-${index}`, model: "claude-test", usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: "text", text: "PRIVATE_REPLY".repeat(600) }] } }));
  await writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);
  const provider = createClaudeProvider({ homeDir: root, projectsRoot: path.join(root, "projects"), registryRoot: path.join(root, "registry"), tasksRoot: path.join(root, "tasks"), explicitSession: file, usageRequest: async () => { throw new Error("unused"); } });
  const summary = await provider.readSession(id);
  assert.ok(summary.usageSnapshots.length < 350, "ordinary live read populates a bounded tail cache first");
  const history = await provider.readSessionHistory(id);
  assert.equal(history.complete, true); assert.equal(history.requests.length, 350); assert.equal(history.activity.filter((item) => item.tool === "Assistant replied").length, 350);
  assert.ok(history.activity.find((item) => item.tool === "Assistant replied" && item.requestId === history.requests[0].id));
  assert.ok(history.activity.every((item) => item.agentId === "primary"));
  assert.equal(JSON.stringify(history).includes("PRIVATE_REPLY"), false);
  assert.deepEqual(await provider.readSessionHistory(id), history);
});

test("Codex history retains complete requests and replies beyond live limits", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-codex-")); context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "01", "01"); await mkdir(directory, { recursive: true });
  const id = "history-codex"; const file = path.join(directory, "rollout-history-codex.jsonl");
  const records = [{ timestamp: stamp(0), type: "session_meta", payload: { id, timestamp: stamp(0), cwd: "C:\\private", source: "cli" } }];
  for (let index = 0; index < 350; index += 1) records.push(...codexResponse(index));
  await writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`); await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id, thread_name: "History", updated_at: stamp(350) })}\n`);
  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false }); const history = await provider.readSessionHistory(id);
  assert.equal(history.complete, true); assert.equal(history.requests.length, 350); assert.equal(history.activity.filter((item) => item.tool === "Assistant replied").length, 350);
  assert.equal(history.activity.filter((item) => item.requestId).length, 700);
  assert.ok(history.requests.every((item) => item.issuedWork.reduce((sum, work) => sum + work.count, 0) === 1));
  const completeEvidence = await provider.readSession(id, { historical: false, completeStory: true });
  assert.doesNotThrow(() => parseProviderSessionEvidence(completeEvidence, id), "complete observer hydration must satisfy the strict publication contract");
  assert.equal(JSON.stringify(completeEvidence).includes("_historyAgentId"), false);
  const live = normalizedSessionHistory("codex", id, await provider.readSession(id, { historical: false }));
  assert.deepEqual(live.requests.map((item) => item.id), history.requests.map((item) => item.id));
  assert.equal(JSON.stringify(history).includes("PRIVATE_CALL"), false);
  assert.equal(JSON.stringify(history).includes("PRIVATE_REPLY"), false); assert.deepEqual(await provider.readSessionHistory(id), history);
});

test("history preserves explicit activity ownership when agent labels repeat", () => {
  const history = normalizedSessionHistory("claude", "same-label", { agents: [{ id: "agent-a", label: "Subagent", executionTasks: [] }, { id: "agent-b", label: "Subagent", executionTasks: [] }], usageSnapshots: [], toolCalls: [], activity: [{ id: "reply", timestamp: stamp(0), actor: "Subagent", tool: "Assistant replied", workKind: "report", detail: "", status: null, _historyAgentId: "agent-b" }] });
  assert.equal(history.activity[0].agentId, "agent-b");
});
