import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../../../server/providers/claude/index.mjs";
import { createCodexProvider } from "../../../server/providers/codex/index.mjs";
import { normalizedSessionHistory } from "../../../server/providers/kernel/session-history.mjs";
import { buildRequestSnapshots } from "../../../server/normalize/request-snapshots.mjs";
import { parseProviderSessionEvidence } from "../../../server/providers/provider-contract.mjs";
import { parseCodexRequestActivityEvidence, stampCodexActivityRequestIds } from "../../../server/providers/codex/activity-correlation.mjs";

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

function stampedCodex(records, actorId = "primary", options = {}) {
  const parsed = parseCodexRequestActivityEvidence(records, { actor: { id: actorId, label: "Agent" }, actorId, sourceKey: actorId, unlimited: true, stableFallbackIdentity: true, ...options });
  const evidence = { agents: [{ id: actorId, label: "Agent" }], usageSnapshots: parsed.usageSnapshots, toolCalls: parsed.toolCalls, activity: [...parsed.replies, ...parsed.inputs] };
  stampCodexActivityRequestIds({ sessionId: "test", ...evidence, linkGroups: [parsed.links], unlimited: true });
  return evidence;
}

function linkedCodex(records, actorId = "primary") {
  return normalizedSessionHistory("codex", "test", stampedCodex(records, actorId));
}

const EXEC_USAGE = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2 };

/** Code-mode exec cells issued by one response: the request seal, `between`, nested completed items, outputs, then the receipt. */
function execCell(items, { ids = ["PRIVATE_CELL"], second = 1, usage = EXEC_USAGE, receipt = usage, between = [] } = {}) {
  const at = (type, payload) => ({ timestamp: stamp(second), type, payload });
  return [
    ...ids.map((id) => at("response_item", { type: "custom_tool_call", call_id: id, name: "exec", input: "PRIVATE_PROGRAM" })),
    at("token_usage_record", { response_id: `PRIVATE_RESPONSE-${second}`, usage }),
    ...between,
    ...items.map((item) => at("event_msg", { type: "item_completed", item })),
    ...ids.map((id) => at("response_item", { type: "custom_tool_call_output", call_id: id, output: "PRIVATE_OUTPUT" })),
    at("event_msg", { type: "token_count", info: { last_token_usage: receipt } }),
  ];
}

const patchItem = (status = "completed", count = 1) => ({ type: "FileChange", id: "PRIVATE_PATCH", status,
  changes: Object.fromEntries(Array.from({ length: count }, (_, index) => [`src/file-${index}.ts`, { type: "update" }])) });

test("three incremental calls remain stable before usage and enrich after separate results", () => {
  const records = [{ timestamp: stamp(0), type: "turn_context", payload: { turn_id: "PRIVATE_TURN", model: "gpt-6-astra" } }];
  const ids = [];
  for (let index = 1; index <= 3; index += 1) {
    records.push({ timestamp: stamp(index), type: "response_item", payload: {
      type: "function_call", call_id: `PRIVATE_CALL-${index}`, name: "exec_command", arguments: '{"cmd":"PRIVATE_COMMAND"}',
    } });
    const history = linkedCodex(records);
    assert.equal(history.requests.length, 0);
    assert.equal(history.activity.length, index);
    assert.ok(history.activity.every((row) => row.requestId === null && row.durationMs === null));
    assert.deepEqual(history.activity.slice(0, -1).map((row) => row.id), ids);
    ids.push(history.activity.at(-1).id);
  }
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 };
  records.push({ timestamp: stamp(4), type: "token_usage_record", payload: { usage } });
  records.push({ timestamp: stamp(4), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage } } });
  const linked = linkedCodex(records);
  assert.equal(linked.requests.length, 1);
  assert.deepEqual(linked.activity.map((row) => row.id), ids);
  assert.ok(linked.activity.every((row) => row.requestId === linked.requests[0].id && row.durationMs === null));
  for (let index = 1; index <= 3; index += 1) {
    records.push({ timestamp: stamp(index + 5), type: "response_item", payload: {
      type: "function_call_output", call_id: `PRIVATE_CALL-${index}`, output: "PRIVATE_OUTPUT",
    } });
    const enriched = linkedCodex(records);
    assert.deepEqual(enriched.activity.map((row) => row.id), ids);
    assert.equal(enriched.activity.filter((row) => row.durationMs !== null).length, index);
    assert.equal(enriched.activity[index - 1].durationMs, 5_000);
    assert.equal(JSON.stringify(enriched).includes("PRIVATE"), false);
  }
});

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

test("a nested completion keeps the sealed exec request link and a nested file change never gains a request", () => {
  for (const [status, count] of [["completed", 1], ["failed", 74]]) {
    const evidence = stampedCodex(execCell([patchItem(status, count)]), "primary", { cwd: os.tmpdir() });
    const history = normalizedSessionHistory("codex", "test", evidence);
    const [cell, change] = ["Dynamic tool", "File change"].map((tool) => evidence.toolCalls.find((call) => call.tool === tool));
    assert.equal(history.requests.length, 1);
    assert.equal(cell.requestId, history.requests[0].id, `${status}: the wrapper keeps its recorded request`);
    assert.equal(change.requestId, null);
    assert.equal(change.mutation.scopes.length, count);
    assert.deepEqual(change.fileChanges, status === "completed" ? [{ path: "src/file-0.ts", kind: "edited", previousPath: null }] : null);
    assert.deepEqual(history.activity.filter((row) => row.tool === "File change").map((row) => row.requestId), [null]);
    assert.equal(JSON.stringify(history).includes("PRIVATE"), false);
  }
});

test("a file change completing late, from a yielded cell or amid open cells stays unassociated", () => {
  const next = { ...EXEC_USAGE, input_tokens: 12 };
  const wait = (type, payload) => ({ timestamp: stamp(2), type, payload });
  const scenarios = {
    // The later cell is the only open call, so only source order could tie the patch to it.
    late: [...execCell([]), ...execCell([patchItem()], { ids: ["PRIVATE_CELL-2"], second: 2, usage: next })],
    yielded: [...execCell([]),
      wait("response_item", { type: "function_call", call_id: "PRIVATE_WAIT", name: "wait", arguments: '{"cell_id":"PRIVATE_CELL"}' }),
      wait("token_usage_record", { response_id: "PRIVATE_RESPONSE-2", usage: next }),
      wait("event_msg", { type: "item_completed", item: patchItem() }),
      wait("response_item", { type: "function_call_output", call_id: "PRIVATE_WAIT", output: "PRIVATE_OUTPUT" }),
      wait("event_msg", { type: "token_count", info: { last_token_usage: next } })],
    open: execCell([patchItem()], { ids: ["PRIVATE_CELL-A", "PRIVATE_CELL-B"] }),
  };
  for (const [name, records] of Object.entries(scenarios)) {
    const evidence = stampedCodex(records, "primary", { cwd: os.tmpdir() });
    const requests = new Set(normalizedSessionHistory("codex", "test", evidence).requests.map((request) => request.id));
    const others = evidence.toolCalls.filter((call) => call.tool !== "File change");
    assert.equal(evidence.toolCalls.find((call) => call.tool === "File change").requestId, null, `${name}: no request from enclosure, order or time`);
    assert.ok(others.length >= 2 && others.every((call) => requests.has(call.requestId)), `${name}: the other calls keep their own requests`);
    assert.equal(new Set(others.map((call) => call.requestId)).size, name === "open" ? 1 : 2, `${name}: no cross-link between requests`);
  }
});

test("Codex nested file changes fail closed exactly like other outputs at mismatched usage, conflicts and boundaries", () => {
  const patch = [patchItem()];
  const unlinked = (records) => assert.ok(linkedCodex(records).activity.every((row) => row.requestId === null));
  unlinked(execCell(patch, { receipt: { ...EXEC_USAGE, input_tokens: 9 } }));
  for (const boundary of [
    { type: "turn_context", payload: {} },
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [] } },
  ]) unlinked(execCell(patch, { between: [{ timestamp: stamp(1), ...boundary }] }));
  const cell = execCell(patch);
  const history = linkedCodex(cell);
  assert.deepEqual(history.activity.map((row) => [row.tool, row.requestId === history.requests[0].id]).sort(), [["Dynamic tool", true], ["File change", false]].sort());
  assert.deepEqual(linkedCodex([...cell, ...cell, cell.at(-1)]), history, "repeated mirrors cannot inflate links");
  unlinked([...cell, ...execCell(patch, { usage: { ...EXEC_USAGE, input_tokens: 12 } })]);
});

test("commands and MCP calls inside one open exec cell still list under its request, unlike its file change", () => {
  const evidence = stampedCodex(execCell([
    { type: "CommandExecution", id: "PRIVATE_COMMAND", command: ["pwsh", "-Command", "npm run test"], status: "completed", exit_code: 0 },
    { type: "McpToolCall", id: "PRIVATE_MCP", server: "pomegr", tool: "report_session_signal", status: "completed" },
    patchItem(),
  ]));
  const history = normalizedSessionHistory("codex", "test", evidence);
  const request = history.requests[0].id;
  assert.deepEqual(Object.fromEntries(evidence.toolCalls.map((call) => [call.tool, call.requestId])), { "Dynamic tool": request, Shell: request, MCP: request, "File change": null });
  assert.deepEqual(history.requests[0].issuedWork.map((work) => work.kind).sort(), ["report", "test"], "the tally counts the command and the MCP call, never the file change");
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
  for (let index = 0; index < 350; index += 1) {
    const response = codexResponse(index);
    response.splice(1, 0, { timestamp: stamp(index), type: "event_msg", payload: { type: "user_message", message: "PRIVATE_PROMPT", local_images: ["PRIVATE_IMAGE_PATH"] } });
    records.push(...response);
  }
  await writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`); await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id, thread_name: "History", updated_at: stamp(350) })}\n`);
  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false }); const history = await provider.readSessionHistory(id);
  assert.equal(history.complete, true); assert.equal(history.requests.length, 350); assert.equal(history.activity.filter((item) => item.tool === "Assistant replied").length, 350);
  assert.equal(history.activity.filter((item) => item.requestId).length, 1050);
  assert.equal(history.activity.filter((item) => item.tool === "User input").length, 350);
  assert.ok(history.activity.filter((item) => item.tool === "User input").every((item) => item.agentId === "primary" && item.detail === "Text + Image" && !item.call));
  assert.ok(history.requests.every((item) => item.issuedWork.reduce((sum, work) => sum + work.count, 0) === 1));
  const completeEvidence = await provider.readSession(id, { historical: false, completeStory: true });
  assert.doesNotThrow(() => parseProviderSessionEvidence(completeEvidence, id), "complete observer hydration must satisfy the strict publication contract");
  assert.equal(JSON.stringify(completeEvidence).includes("_historyAgentId"), false);
  const live = normalizedSessionHistory("codex", id, await provider.readSession(id, { historical: false }));
  assert.deepEqual(live.requests.map((item) => item.id), history.requests.map((item) => item.id));
  assert.equal(JSON.stringify(history).includes("PRIVATE_CALL"), false);
  assert.equal(JSON.stringify(history).includes("PRIVATE_REPLY"), false);
  assert.equal(JSON.stringify(history).includes("PRIVATE_PROMPT"), false);
  assert.equal(JSON.stringify(history).includes("PRIVATE_IMAGE_PATH"), false);
  assert.deepEqual(await provider.readSessionHistory(id), history);
});

test("Codex observer history callbacks retain reply ownership without contaminating strict session evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-codex-observer-")); context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "01", "01"); await mkdir(directory, { recursive: true });
  const id = "observer-codex"; const file = path.join(directory, "rollout-observer-codex.jsonl");
  const records = [{ timestamp: stamp(0), type: "session_meta", payload: { id, timestamp: stamp(0), cwd: "C:\\private", source: "cli" } }, ...codexResponse(1)];
  await writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`); await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id, thread_name: "Observer", updated_at: stamp(1) })}\n`);
  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false });
  let activityHistory = null; let requestHistory = null;
  const evidence = await provider.readSession(id, {
    onHistoryActivity(value) { activityHistory = value; },
    onHistoryRequests(value) { requestHistory = value; },
  });
  assert.doesNotThrow(() => parseProviderSessionEvidence(evidence, id));
  assert.equal(JSON.stringify(evidence).includes("_historyAgentId"), false);
  assert.equal(activityHistory?.find((item) => item.tool === "Assistant replied")?.agentId, "primary");
  const requestReply = requestHistory?.activity.find((item) => item.tool === "Assistant replied");
  assert.equal(requestReply?.agentId, "primary");
  assert.equal(requestReply?.requestId, requestHistory?.requests[0]?.id);
});

test("Codex early, late, and replay history preserve duplicate child-label reply ownership", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-codex-duplicate-labels-")); context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "01", "01"); await mkdir(directory, { recursive: true });
  const id = "duplicate-root"; const childA = "duplicate-child-a"; const childB = "duplicate-child-b";
  const record = (threadId, payload) => ({ timestamp: stamp(1), type: "session_meta", payload: { id: threadId, timestamp: stamp(1), cwd: "C:\\private", source: threadId === id ? "cli" : "sub_agent", ...(payload || {}) } });
  const write = async (name, rows) => writeFile(path.join(directory, `rollout-${name}.jsonl`), `${rows.map(JSON.stringify).join("\n")}\n`);
  await write("root", [record(id)]);
  await write("child-a", [record(childA, { session_id: id, parent_thread_id: id, agent_nickname: "Same child" }), ...codexResponse(2)]);
  await write("child-b", [record(childB, { session_id: id, parent_thread_id: id, agent_nickname: "Same child" }), ...codexResponse(3)]);
  await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id, thread_name: "Duplicate children", updated_at: stamp(3) })}\n`);
  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, includeArchived: false });
  let early = null; let late = null;
  const evidence = await provider.readSession(id, {
    historical: true,
    completeStory: true,
    onHistoryActivity(value) { early = value; },
    onHistoryRequests(value) { late = value; },
  });
  assert.doesNotThrow(() => parseProviderSessionEvidence(evidence, id));
  const replies = (history) => (Array.isArray(history) ? history : history.activity).filter((item) => item.tool === "Assistant replied")
    .map((item) => ({ id: item.id, agentId: item.agentId })).sort((left, right) => left.agentId.localeCompare(right.agentId));
  const expected = ["agent-duplicate-child-a", "agent-duplicate-child-b"];
  assert.deepEqual(replies(early).map((item) => item.agentId), expected);
  assert.deepEqual(replies(late), replies(early));
  assert.deepEqual(replies(await provider.readSessionHistory(id)), replies(late));
});

test("history preserves explicit activity ownership when agent labels repeat", () => {
  const history = normalizedSessionHistory("claude", "same-label", { agents: [{ id: "agent-a", label: "Subagent", executionTasks: [] }, { id: "agent-b", label: "Subagent", executionTasks: [] }], usageSnapshots: [], toolCalls: [], activity: [{ id: "reply", timestamp: stamp(0), actor: "Subagent", tool: "Assistant replied", workKind: "report", detail: "", status: null, _historyAgentId: "agent-b" }] });
  assert.equal(history.activity[0].agentId, "agent-b");
});

test("history requests carry each request's bounded recorded model while the state feed never does", () => {
  const usage = (index, model) => ({ actorId: "primary", dedupeId: `PRIVATE_DEDUPE-${index}`, timestamp: stamp(index), input: 2, cacheWrite: 0, cacheRead: 3, output: 1, model });
  const evidence = { agents: [{ id: "primary", label: "Agent", executionTasks: [] }], toolCalls: [], activity: [],
    usageSnapshots: [usage(0, "claude-opus-5"), usage(1, "claude-sonnet-5"), usage(2, "<synthetic>"), usage(3, "")] };
  const history = normalizedSessionHistory("claude", "models", evidence);
  assert.deepEqual(history.requests.map((request) => request.model), ["claude-opus-5", "claude-sonnet-5", null, null]);
  assert.equal(JSON.stringify(history).includes("PRIVATE"), false);
  const feed = buildRequestSnapshots({ sessionId: "claude:models", agents: evidence.agents, usageSnapshots: evidence.usageSnapshots });
  assert.ok(feed.items.every((item) => !Object.hasOwn(item, "model")));
});

test("history rows mark only recorded tool calls as calls", () => {
  const at = "2026-09-12T01:00:00.000Z";
  const history = normalizedSessionHistory("claude", "call-marker", {
    agents: [{ id: "primary", label: "Primary agent", executionTasks: [{ id: "task-1", status: "failed", label: "npm test", workKind: "test", startedAt: at, finishedAt: at, exitCode: 1 }] }],
    usageSnapshots: [],
    toolCalls: [
      { id: "tool-1", timestamp: at, actor: "Primary agent", tool: "Bash", workKind: "test", detail: "npm test", status: "failed" },
      { id: "cell-1", timestamp: at, actor: "Primary agent", tool: "Dynamic tool", workKind: "integration", detail: "exec", status: "completed", wrapper: true },
    ],
    activity: [{ id: "input-1", timestamp: at, actor: "User", tool: "User input", workKind: "input", detail: "Text", status: null }],
  });
  assert.deepEqual(history.activity.map((row) => [row.tool, row.call]).sort(), [["Bash", true], ["Dynamic tool", false], ["Shell failed", false], ["User input", false]]);
});
