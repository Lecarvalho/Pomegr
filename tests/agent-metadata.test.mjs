import assert from "node:assert/strict";
import test from "node:test";
import { agentTiming, applyWaitingStatus, buildAgentMetadata, fallbackAgentMetadata, isAgentTranscriptFinished, isRunningAgent } from "../monitor/agent-metadata.mjs";

function launchRecords(toolId, agentId, description) {
  return [
    {
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        id: toolId,
        name: "Agent",
        input: { description, subagent_type: "general-purpose" },
      }] },
    },
    {
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: toolId,
        content: [{ type: "text", text: `Agent launched successfully. agentId: ${agentId}` }],
      }] },
    },
  ];
}

test("records the transcript owner as the launched agent's parent", () => {
  const primaryLaunch = buildAgentMetadata(launchRecords("tool-1", "parent123", "Red-team slice"), "primary");
  const nestedLaunch = buildAgentMetadata(launchRecords("tool-2", "child456", "Security lens"), "agent-parent123");

  assert.deepEqual(primaryLaunch.get("parent123"), {
    description: "Red-team slice",
    kind: "general-purpose",
    parentId: "primary",
  });
  assert.deepEqual(nestedLaunch.get("child456"), {
    description: "Security lens",
    kind: "general-purpose",
    parentId: "agent-parent123",
  });
});

test("leaves the parent unresolved when launch metadata is unavailable", () => {
  const fallback = fallbackAgentMetadata([{ type: "user", message: { content: "You are the security reviewer for this task." } }]);
  assert.equal(fallback.parentId, null);
});

test("measures an agent's recorded wall time from its own timestamps", () => {
  const timing = agentTiming([
    { timestamp: "2026-08-05T12:00:00.000Z" },
    { message: { timestamp: "2026-08-05T12:03:05.000Z" } },
  ], "2026-08-05T12:10:00.000Z");

  assert.deepEqual(timing, {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:03:05.000Z",
    durationMs: 185_000,
  });
});

test("detects a finished subagent from the final transcript stop reason", () => {
  const final = { type: "assistant", message: { role: "assistant", stop_reason: "end_turn" } };
  assert.equal(isAgentTranscriptFinished([final]), true);
  assert.equal(isAgentTranscriptFinished([
    { type: "assistant", message: { role: "assistant", stop_reason: "stop_sequence" } },
    { type: "system", subtype: "turn_duration" },
  ]), true);
});

test("does not keep a resumed or tool-using subagent marked finished", () => {
  const final = { type: "assistant", message: { role: "assistant", stop_reason: "end_turn" } };
  assert.equal(isAgentTranscriptFinished([
    final,
    { type: "user", message: { role: "user", content: "Continue" } },
  ]), false);
  assert.equal(isAgentTranscriptFinished([
    { type: "assistant", message: { role: "assistant", stop_reason: "tool_use" } },
  ]), false);
});

test("propagates waiting status from an active descendant through its parents", () => {
  const agents = [
    { id: "primary", parentId: null, status: "idle" },
    { id: "parent", parentId: "primary", status: "idle" },
    { id: "child", parentId: "parent", status: "active" },
    { id: "finished", parentId: "primary", status: "finished" },
  ];

  applyWaitingStatus(agents);

  assert.equal(agents[0].status, "waiting");
  assert.equal(agents[1].status, "waiting");
  assert.equal(agents[2].status, "active");
  assert.equal(agents[3].status, "finished");
  assert.equal(agents.filter(isRunningAgent).length, 3);
});
