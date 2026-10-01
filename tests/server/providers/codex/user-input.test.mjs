import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexUserInputRecords } from "../../../../server/providers/codex/user-input.mjs";
import { parseCodexRequestActivityEvidence, stampCodexActivityRequestIds } from "../../../../server/providers/codex/activity-correlation.mjs";
import { createHistoryOwnershipProjection, normalizedSessionHistory } from "../../../../server/providers/kernel/session-history.mjs";

const at = (index) => new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString();
const input = (index, payload = {}) => ({ type: "event_msg", timestamp: at(index), payload: { type: "user_message", message: "PRIVATE_PROMPT", ...payload } });
const context = (turn = "PRIVATE_TURN") => ({ type: "turn_context", timestamp: at(0), payload: { turn_id: turn, model: "gpt-6" } });
const reply = { type: "event_msg", timestamp: at(2), payload: { type: "agent_message", id: "PRIVATE_REPLY_ID", message: "PRIVATE_REPLY" } };
const usage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 };
const seal = { type: "token_usage_record", timestamp: at(3), payload: { usage } };
const receipt = { type: "event_msg", timestamp: at(4), payload: { type: "token_count", info: { last_token_usage: usage } } };
const delivered = (index, content, overrides = {}) => ({ type: "event_msg", timestamp: at(index), payload: {
  type: "item_completed", item: { type: "UserMessage", id: `PRIVATE_INPUT-${index}`, content, ...overrides },
} });

function history(records) {
  const parsed = parseCodexRequestActivityEvidence(records, { actorId: "primary", sourceKey: "root", unlimited: true, stableFallbackIdentity: true });
  const evidence = { agents: [{ id: "primary", label: "Primary agent" }], usageSnapshots: parsed.usageSnapshots, toolCalls: parsed.toolCalls, activity: [...parsed.inputs, ...parsed.replies] };
  stampCodexActivityRequestIds({ sessionId: "input", ...evidence, linkGroups: [parsed.links], unlimited: true });
  const ownership = createHistoryOwnershipProjection();
  ownership.record("primary", evidence.activity);
  return normalizedSessionHistory("codex", "input", { ...evidence, activity: ownership.project(evidence.activity) });
}

test("Codex user deliveries expose only fixed content kinds, preserve repeats, and ignore user-role mirrors", () => {
  const records = [input(1), input(2, { images: ["PRIVATE_IMAGE"] }), input(3, { message: "", local_images: ["PRIVATE_PATH"] }),
    { type: "response_item", timestamp: at(1), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_PROMPT" }] } }];
  const events = parseCodexUserInputRecords(records);
  assert.deepEqual(events.map((row) => [row.actor, row.tool, row.workKind, row.detail]), [
    ["User", "User input", "input", "Text"], ["User", "User input", "input", "Text + Image"], ["User", "User input", "input", "Image"],
  ]);
  assert.equal(new Set(events.map((row) => row.id)).size, 3);
  assert.deepEqual(parseCodexUserInputRecords([...records, ...records]), events);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|images|message|content/u);
  const sameTime = [input(1), input(1, { message: "PRIVATE_OTHER_PROMPT" }), input(1, { local_images: ["PRIVATE_ATTACHMENT"] })];
  const distinct = parseCodexUserInputRecords(sameTime);
  assert.equal(distinct.length, 3);
  assert.deepEqual(parseCodexUserInputRecords([...sameTime, ...sameTime]), distinct);
  for (const record of sameTime) assert.ok(distinct.some((row) => row.id === parseCodexUserInputRecords([record])[0].id));
  assert.doesNotMatch(JSON.stringify(distinct), /PRIVATE/u);
});

test("Codex input omits synthetic, empty, untimed, delegated and approval-review deliveries", () => {
  for (const record of [input(1, { synthetic: true }), input(1, { message: "" }), { ...input(1), timestamp: undefined },
    { ...input(1), timestamp: "invalid" }, { ...input(1), synthetic: true }]) {
    assert.deepEqual(parseCodexUserInputRecords([record], { fallbackTimestamp: at(1) }), []);
  }
  assert.deepEqual(parseCodexUserInputRecords([input(1)], { actor: { id: "agent-child", label: "Builder" } }), []);
  assert.deepEqual(parseCodexUserInputRecords([input(1)], { userInputEnabled: false }), []);
  const records = Array.from({ length: 300 }, (_, index) => input(index));
  assert.equal(parseCodexUserInputRecords(records).length, 256);
  assert.equal(parseCodexUserInputRecords(records, { unlimited: true }).length, 300);
});

test("Codex desktop completed UserMessage items normalize once without exposing context or attachments", () => {
  const records = [
    { type: "response_item", timestamp: at(0), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_CONTEXT" }] } },
    delivered(1, [{ type: "text", text: "PRIVATE_PROMPT" }]),
    delivered(2, [{ type: "text", text: "PRIVATE_PROMPT" }, { type: "local_image", path: "PRIVATE_IMAGE_PATH" }]),
    delivered(3, [{ type: "image", url: "PRIVATE_URL" }]),
    delivered(4, [{ type: "text", text: "PRIVATE_SYNTHETIC" }], { synthetic: true }),
    { ...delivered(5, [{ type: "text", text: "PRIVATE_UNTIMED" }]), timestamp: undefined },
  ];
  const events = parseCodexUserInputRecords(records);
  assert.deepEqual(events.map((event) => event.detail), ["Text", "Text + Image", "Image"]);
  assert.deepEqual(parseCodexUserInputRecords([...records, ...records]), events);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|path|content|url/u);
  const linked = history([context(), records[0], records[1], reply, seal, receipt]);
  assert.equal(linked.activity.filter((row) => row.tool === "User input").length, 1);
  assert.equal(linked.activity.find((row) => row.tool === "User input").requestId, linked.requests[0].id);
});

test("a completed patch inside an exec cell does not discard the sealed wrapper request link", () => {
  const call = { type: "response_item", timestamp: at(1), payload: { type: "custom_tool_call", call_id: "PRIVATE_EXEC", name: "exec", input: "PRIVATE_COMMAND" } };
  const patch = { type: "event_msg", timestamp: at(3), payload: { type: "item_completed", item: {
    type: "FileChange", id: "PRIVATE_PATCH", status: "completed", changes: { "src/example.mjs": { type: "update" } },
  } } };
  const result = { type: "response_item", timestamp: at(4), payload: { type: "custom_tool_call_output", call_id: "PRIVATE_EXEC", output: "PRIVATE_OUTPUT" } };
  const parsed = history([context(), delivered(0, [{ type: "text", text: "PRIVATE_PROMPT" }]), call, seal, patch, result, receipt]);
  const wrapper = parsed.activity.find((row) => row.tool === "Dynamic tool");
  assert.equal(wrapper.requestId, parsed.requests[0].id);
  assert.equal(parsed.activity.find((row) => row.tool === "User input").requestId, parsed.requests[0].id);
  assert.equal(parsed.activity.find((row) => row.tool === "File change").requestId, null, "completion alone cannot establish the nested patch's request attribution");
  assert.deepEqual(parsed.requests[0].issuedWork, [{ kind: "integration", count: 1 }]);
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE/u);
});

test("Codex input links only to the first response request and stays outside tool counts", () => {
  const records = [context(), input(1), context(), reply, seal, receipt];
  const result = history(records);
  const row = result.activity.find((item) => item.tool === "User input");
  assert.equal(row.requestId, result.requests[0].id);
  assert.equal(row.agentId, "primary");
  assert.equal(row.call, false);
  assert.equal(row.durationMs, null);
  assert.deepEqual(result.requests[0].issuedWork, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
  const next = { ...receipt, timestamp: at(6), payload: { ...receipt.payload, info: { last_token_usage: { ...usage, input_tokens: 200 } } } };
  const grown = history([...records, { ...reply, timestamp: at(5), payload: { ...reply.payload, id: "PRIVATE_SECOND_REPLY" } }, next]);
  assert.equal(grown.activity.find((item) => item.tool === "User input").requestId, result.requests[0].id);
});

test("Codex input request association fails closed across missing/mismatched usage and boundaries", () => {
  const sequences = [
    [context(), input(1), reply, seal],
    [context(), input(1), reply, seal, { ...receipt, payload: { type: "token_count", info: { last_token_usage: { ...usage, input_tokens: 200 } } } }],
    [context(), input(1), receipt],
    ...[context("different"), { ...context(), synthetic: true }, { type: "turn_completed", timestamp: at(2), payload: {} },
      { type: "compacted", timestamp: at(2), payload: {} }, { type: "event_msg", timestamp: at(2), payload: { type: "task_complete" } },
      { type: "response_item", timestamp: at(2), payload: { type: "message", role: "user", content: [] } }]
      .map((boundary) => [context(), input(1), boundary, reply, seal, receipt]),
  ];
  for (const records of sequences) assert.equal(history(records).activity.find((row) => row.tool === "User input").requestId, null);
});
