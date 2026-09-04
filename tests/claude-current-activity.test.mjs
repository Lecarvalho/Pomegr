import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLAUDE_CURRENT_ACTIVITY_MAX_LENGTH,
  createClaudeCurrentActivityReader,
  parseClaudeCurrentActivityRecords,
  parseClaudeCurrentActivityStateRecords,
} from "../monitor/providers/claude-current-activity.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { monitorStateFromProviderEvidence } from "./helpers/provider-fixtures.mjs";

const bashCall = (id, timestamp, description, overrides = {}) => ({
  type: "assistant",
  timestamp,
  uuid: `assistant-${id}`,
  message: {
    model: "claude-test",
    stop_reason: "tool_use",
    content: [{
      type: "tool_use",
      id,
      name: "Bash",
      input: {
        command: "PRIVATE_COMMAND_MUST_NOT_LEAK",
        description,
        ...overrides,
      },
    }],
  },
});

const toolResult = (id, timestamp) => ({
  type: "user",
  timestamp,
  uuid: `result-${id}`,
  message: { content: [{
    type: "tool_result",
    tool_use_id: id,
    content: "PRIVATE_TOOL_RESULT_MUST_NOT_LEAK",
  }] },
});

test("Claude activity uses only a pending native Bash description", () => {
  const activity = parseClaudeCurrentActivityRecords([
    { type: "user", timestamp: "2026-09-04T19:02:00.000Z", uuid: "prompt-1", message: { content: "PRIVATE_PROMPT_MUST_NOT_LEAK" } },
    {
      type: "assistant",
      timestamp: "2026-09-04T19:02:01.000Z",
      message: { content: [
        { type: "thinking", thinking: "PRIVATE_THINKING_MUST_NOT_LEAK" },
        { type: "tool_use", id: "agent-1", name: "Agent", input: { description: "PRIVATE_AGENT_DESCRIPTION_MUST_NOT_LEAK" } },
        { type: "tool_use", id: "signal-1", name: "mcp__pomegr__report_session_signal", input: { description: "PRIVATE_SIGNAL_DESCRIPTION_MUST_NOT_LEAK" } },
      ] },
    },
    bashCall("bash-1", "2026-09-04T19:02:02.000Z", "Read echo retry flow, usage sink, and Grafana dashboards"),
  ]);

  assert.deepEqual(activity, {
    label: "Read echo retry flow, usage sink, and Grafana dashboards",
    observedAt: "2026-09-04T19:02:02.000Z",
  });
  assert.doesNotMatch(JSON.stringify(activity), /PRIVATE_|command|thinking|signal|agent/iu);
});

test("Claude activity follows matching tool results, parallel calls, and turn boundaries", () => {
  const first = parseClaudeCurrentActivityStateRecords([
    bashCall("bash-1", "2026-09-04T19:02:01.000Z", "Read the provider adapter"),
    bashCall("bash-2", "2026-09-04T19:02:02.000Z", "Run the focused parser tests"),
    toolResult("bash-1", "2026-09-04T19:02:03.000Z"),
  ]);
  assert.equal(first.currentActivity.label, "Run the focused parser tests");

  const cleared = parseClaudeCurrentActivityStateRecords([
    toolResult("bash-2", "2026-09-04T19:02:04.000Z"),
  ], { existingState: first });
  assert.equal(cleared.currentActivity, null);

  const terminal = parseClaudeCurrentActivityStateRecords([
    bashCall("bash-3", "2026-09-04T19:02:05.000Z", "Verify the complete change"),
    { type: "assistant", timestamp: "2026-09-04T19:02:06.000Z", uuid: "answer-1", message: { stop_reason: "end_turn", content: [{ type: "text", text: "PRIVATE_RESPONSE_MUST_NOT_LEAK" }] } },
  ], { existingState: cleared });
  assert.equal(terminal.currentActivity, null);

  const nextTurn = parseClaudeCurrentActivityStateRecords([
    { type: "user", timestamp: "2026-09-04T19:02:07.000Z", uuid: "prompt-2", message: { content: [{ type: "text", text: "PRIVATE_SECOND_PROMPT_MUST_NOT_LEAK" }] } },
    bashCall("bash-4", "2026-09-04T19:02:08.000Z", "Inspect the next request"),
  ], { existingState: terminal });
  assert.equal(nextTurn.currentActivity.label, "Inspect the next request");
});

test("Claude activity rejects malformed sources, bounds Unicode, and omits historical state", () => {
  const long = "計画🔍".repeat(100);
  const activity = parseClaudeCurrentActivityRecords([
    bashCall("bash-invalid-time", "not-a-time", "PRIVATE_INVALID_TIME_MUST_NOT_LEAK"),
    bashCall("bash-multiline", "2026-09-04T19:02:01.000Z", "PRIVATE\nMULTILINE_MUST_NOT_LEAK"),
    bashCall("bash-long", "2026-09-04T19:02:02.000Z", long),
  ]);
  assert.equal([...activity.label].length, CLAUDE_CURRENT_ACTIVITY_MAX_LENGTH);
  assert.equal(activity.label.startsWith("計画🔍"), true);
  assert.equal(parseClaudeCurrentActivityRecords([
    bashCall("bash-history", "2026-09-04T19:02:03.000Z", "PRIVATE_HISTORY_MUST_NOT_LEAK"),
  ], { historical: true }), null);
  assert.equal(parseClaudeCurrentActivityRecords([
    bashCall("bash-idle", "2026-09-04T19:02:04.000Z", "PRIVATE_IDLE_MUST_NOT_LEAK"),
  ], { agentStatus: "idle" }), null);
});

test("Claude reader does not resurrect lifecycle-cleared activity without a newer Bash call", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-activity-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  await writeFile(file, `${JSON.stringify(bashCall("bash-old", "2026-09-04T19:02:01.000Z", "Old pending activity"))}\n`, "utf8");
  const reader = createClaudeCurrentActivityReader();
  assert.equal((await reader.read(file, { agentStatus: "active" })).label, "Old pending activity");
  assert.equal(await reader.read(file, { agentStatus: "idle" }), null);
  assert.equal(await reader.read(file, { agentStatus: "active" }), null);
  await appendFile(file, `${JSON.stringify({ type: "attachment", timestamp: "2026-09-04T19:02:02.000Z" })}\n`, "utf8");
  assert.equal(await reader.read(file, { agentStatus: "active" }), null);
  await appendFile(file, `${JSON.stringify(bashCall("bash-new", "2026-09-04T19:02:03.000Z", "New pending activity"))}\n`, "utf8");
  assert.equal((await reader.read(file, { agentStatus: "active" })).label, "New pending activity");

  await writeFile(file, `${JSON.stringify(bashCall("bash-replacement", "2026-09-04T19:02:04.000Z", "Replacement activity"))}\n{"type":"attachment"`, "utf8");
  assert.equal(await reader.read(file, { agentStatus: "active" }), null);
  await appendFile(file, "}\n", "utf8");
  assert.equal((await reader.read(file, { agentStatus: "active" })).label, "Replacement activity");
});

test("Claude reader withholds cold activity until the source ends on a complete record", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-activity-partial-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  await writeFile(file, `${JSON.stringify(bashCall("bash-cold", "2026-09-04T19:02:01.000Z", "Cold activity"))}\n{"type":"attachment"`, "utf8");
  const reader = createClaudeCurrentActivityReader();
  assert.equal(await reader.read(file, { agentStatus: "active" }), null);
  await appendFile(file, "}\n", "utf8");
  assert.equal((await reader.read(file, { agentStatus: "active" })).label, "Cold activity");
});

test("Claude provider carries pending activity across its bounded tail and publishes validated primary liveness", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-current-activity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const registryRoot = path.join(root, "registry");
  const localId = "claude-current-activity";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const registryFile = path.join(registryRoot, `${localId}.json`);
  const now = Date.parse("2026-09-04T19:02:10.000Z");
  await mkdir(path.dirname(mainFile), { recursive: true });
  await mkdir(registryRoot, { recursive: true });
  await writeFile(mainFile, `${[
    { type: "user", timestamp: "2026-09-04T19:02:00.000Z", uuid: "prompt-1", cwd: "C:\\synthetic\\pomegr", message: { content: "PRIVATE_PROMPT_MUST_NOT_LEAK" } },
    bashCall("bash-live", "2026-09-04T19:02:01.000Z", "Read the current execution path"),
    {
      type: "attachment",
      timestamp: "2026-09-04T19:02:02.000Z",
      attachment: { content: "PRIVATE_ATTACHMENT_MUST_NOT_LEAK".repeat(120_000) },
    },
  ].map(JSON.stringify).join("\n")}\n`, "utf8");
  await utimes(mainFile, new Date(now), new Date(now));
  await writeFile(registryFile, JSON.stringify({
    sessionId: localId,
    status: "busy",
    updatedAt: now,
    pid: 42,
    procStart: "owner-start",
  }), "utf8");
  await utimes(registryFile, new Date(now), new Date(now));

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot,
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    now: () => now,
    registryProcessIdentities: () => new Map([[42, "owner-start"]]),
    registryProcessExists: () => true,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  let evidence = await provider.readSession(localId);
  let state = monitorStateFromProviderEvidence("claude", evidence);
  assert.deepEqual(state.agents[0].currentActivity, {
    label: "Read the current execution path",
    observedAt: "2026-09-04T19:02:01.000Z",
  });
  assert.deepEqual(state.agents[0].liveness, {
    source: "lifecycle_bridge",
    observedAt: "2026-09-04T19:02:10.000Z",
    evidence: "observed",
    freshness: "current",
  });

  await appendFile(mainFile, `${JSON.stringify({
    type: "attachment",
    timestamp: "2026-09-04T19:02:02.500Z",
    attachment: { kind: "PRIVATE_UNRELATED_ATTACHMENT_MUST_NOT_LEAK" },
  })}\n`, "utf8");
  evidence = await provider.readSession(localId);
  state = monitorStateFromProviderEvidence("claude", evidence);
  assert.equal(state.agents[0].currentActivity.label, "Read the current execution path");
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_COMMAND|PRIVATE_ATTACHMENT|PRIVATE_PROMPT/);

  await appendFile(mainFile, `${JSON.stringify(toolResult("bash-live", "2026-09-04T19:02:03.000Z"))}\n`, "utf8");
  evidence = await provider.readSession(localId);
  assert.equal(monitorStateFromProviderEvidence("claude", evidence).agents[0].currentActivity, undefined);
});
