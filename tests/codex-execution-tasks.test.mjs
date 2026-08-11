import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseCodexCanonicalExecutionTasks,
  parseCodexExecutionTaskRecords,
} from "../monitor/providers/codex-execution-tasks.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import {
  assertNoPrivateFixtureSentinels,
  monitorStateFromProviderEvidence,
} from "./helpers/provider-fixtures.mjs";

const record = (timestamp, type, payload) => ({ timestamp, type, payload });

test("maps foreground rollout success, failure, and interruption without command or output content", () => {
  const records = [
    record("2026-08-10T13:00:00.000Z", "response_item", {
      type: "function_call",
      name: "shell_command",
      call_id: "command-ok",
      arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK", description: "  Run   checks  " }),
    }),
    record("2026-08-10T13:00:02.000Z", "response_item", {
      type: "function_call_output",
      call_id: "command-ok",
      status: "completed",
      is_error: false,
      output: "STDOUT_MUST_NOT_LEAK STDERR_MUST_NOT_LEAK",
      exit_code: 0,
    }),
    record("2026-08-10T13:00:03.000Z", "event_msg", {
      type: "exec_command_begin",
      call_id: "command-failed",
      command: "COMMAND_MUST_NOT_LEAK",
      parsed_cmd: [{ cmd: "COMMAND_MUST_NOT_LEAK" }],
      description: "Compile fixture",
    }),
    record("2026-08-10T13:00:04.000Z", "event_msg", {
      type: "exec_command_end",
      call_id: "command-failed",
      status: "completed",
      success: false,
      aggregated_output: "TOOL_OUTPUT_MUST_NOT_LEAK",
      exit_code: 17,
    }),
    record("2026-08-10T13:00:05.000Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: "command-stopped",
      arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK" }),
    }),
    record("2026-08-10T13:00:06.000Z", "response_item", {
      type: "function_call_output",
      call_id: "command-stopped",
      status: "interrupted",
      output: "TOOL_OUTPUT_MUST_NOT_LEAK",
    }),
  ];

  const tasks = parseCodexExecutionTaskRecords(records);
  assert.deepEqual(tasks.map(({ id, label, status, exitCode }) => ({ id, label, status, exitCode })), [
    { id: "command-stopped", label: "Shell command", status: "stopped", exitCode: null },
    { id: "command-failed", label: "Compile fixture", status: "failed", exitCode: 17 },
    { id: "command-ok", label: "Run checks", status: "completed", exitCode: 0 },
  ]);
  assertNoPrivateFixtureSentinels(tasks, "Codex foreground execution tasks");
  assert.doesNotMatch(JSON.stringify(tasks), /commandActions|parsed_cmd|aggregated_output|stdout|stderr|output/i);
});

test("deduplicates canonical lifecycle events and exposes only safe background process IDs", () => {
  const started = {
    type: "commandExecution",
    id: "background-task",
    command: "COMMAND_MUST_NOT_LEAK",
    commandActions: [{ command: "COMMAND_MUST_NOT_LEAK" }],
    aggregatedOutput: "TOOL_OUTPUT_MUST_NOT_LEAK",
    cwd: "C:\\PRIVATE_PATH_MUST_NOT_LEAK",
    status: "inProgress",
    processId: "42",
    description: "Watch fixture",
  };
  const records = [
    record("2026-08-10T14:00:00.000Z", "item/started", { item: started }),
    record("2026-08-10T14:00:00.000Z", "item/started", { item: started }),
    record("2026-08-10T14:00:03.000Z", "item/completed", {
      item: { ...started, status: "completed", exitCode: 0, durationMs: 3000 },
    }),
    record("2026-08-10T14:01:00.000Z", "item/completed", {
      item: { ...started, id: "unsafe-process", processId: "../private", status: "failed", exitCode: 2 },
    }),
    record("2026-08-10T14:02:00.000Z", "item/started", {
      item: { ...started, id: "background-stopped", processId: "stop-process", status: "inProgress" },
    }),
    record("2026-08-10T14:02:02.000Z", "item/completed", {
      item: { ...started, id: "background-stopped", processId: "stop-process", status: "declined" },
    }),
    record("2026-08-10T14:03:00.000Z", "item/started", {
      item: { ...started, id: "background-failed", processId: "failed-process", status: "inProgress" },
    }),
    record("2026-08-10T14:03:01.000Z", "item/completed", {
      item: { ...started, id: "background-failed", processId: "failed-process", status: "failed", exitCode: 9 },
    }),
  ];
  const taskSignals = new Map([
    ["background-task", { label: "Starting", tone: "info", reportedAt: "2026-08-10T14:00:01.000Z" }],
    ["42", { label: "Ready", tone: "positive", reportedAt: "2026-08-10T14:00:02.000Z" }],
    ["unmatched-task", { label: "MCP_ARGUMENT_MUST_NOT_LEAK", tone: "negative", reportedAt: "2026-08-10T14:00:04.000Z" }],
  ]);

  const tasks = parseCodexExecutionTaskRecords(records, { taskSignals });
  const background = tasks.find((task) => task.id === "background-task");
  assert.equal(tasks.length, 4);
  assert.deepEqual(background, {
    id: "background-task",
    label: "Watch fixture",
    kind: "shell",
    status: "completed",
    background: true,
    backgroundId: "42",
    startedAt: "2026-08-10T14:00:00.000Z",
    finishedAt: "2026-08-10T14:00:03.000Z",
    exitCode: 0,
    signal: { label: "Ready", tone: "positive", reportedAt: "2026-08-10T14:00:02.000Z" },
  });
  assert.equal(tasks.find((task) => task.id === "unsafe-process").backgroundId, null);
  assert.equal(tasks.find((task) => task.id === "unsafe-process").status, "failed");
  assert.equal(tasks.find((task) => task.id === "background-stopped").status, "stopped");
  assert.equal(tasks.find((task) => task.id === "background-failed").status, "failed");
  assertNoPrivateFixtureSentinels(tasks, "Codex background execution tasks");
});

test("marks unmatched historical commands stopped at the recorded session end", () => {
  const tasks = parseCodexExecutionTaskRecords([
    record("2026-08-10T15:00:00.000Z", "response_item", {
      type: "function_call",
      name: "shell_command",
      call_id: "missing-completion",
      arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK", description: "Long-running fixture" }),
    }),
  ], { historical: true, sessionUpdatedAt: "2026-08-10T15:05:00.000Z" });

  assert.equal(tasks[0].status, "stopped");
  assert.equal(tasks[0].finishedAt, "2026-08-10T15:05:00.000Z");
  assertNoPrivateFixtureSentinels(tasks, "historical Codex execution tasks");
});

test("maps canonical command items with authoritative status and bounded descriptions", () => {
  const turns = [{
    id: "turn-commands",
    status: "completed",
    startedAt: Date.parse("2026-08-10T16:00:00.000Z") / 1000,
    completedAt: Date.parse("2026-08-10T16:00:05.000Z") / 1000,
    items: [
      { id: "canonical-ok", type: "commandExecution", command: "COMMAND_MUST_NOT_LEAK", commandActions: [], status: "completed", exitCode: 0, durationMs: 1000, description: ` ${"x".repeat(200)} ` },
      { id: "canonical-failed", type: "commandExecution", command: "COMMAND_MUST_NOT_LEAK", aggregatedOutput: "STDERR_MUST_NOT_LEAK", status: "failed", exitCode: 1 },
      { id: "canonical-declined", type: "commandExecution", command: "COMMAND_MUST_NOT_LEAK", status: "declined" },
      { id: "future-item", type: "futurePrivateItem", content: "TOOL_OUTPUT_MUST_NOT_LEAK" },
    ],
  }];

  const tasks = parseCodexCanonicalExecutionTasks(turns);
  assert.equal(tasks.find((task) => task.id === "canonical-ok").label.length, 160);
  assert.equal(tasks.find((task) => task.id === "canonical-ok").status, "completed");
  assert.equal(tasks.find((task) => task.id === "canonical-ok").startedAt, "2026-08-10T16:00:04.000Z");
  assert.equal(tasks.find((task) => task.id === "canonical-failed").status, "failed");
  assert.equal(tasks.find((task) => task.id === "canonical-declined").status, "stopped");
  assertNoPrivateFixtureSentinels(tasks, "canonical Codex execution tasks");
});

test("provider keeps primary compatibility tasks consistent with per-agent task lists", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-execution-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const startedAt = Date.parse("2026-08-10T17:00:00.000Z") / 1000;
  const completedAt = Date.parse("2026-08-10T17:00:04.000Z") / 1000;
  const commandTurn = (id, description, processId = null) => ({
    id: `turn-${id}`,
    status: "completed",
    startedAt,
    completedAt,
    items: [{
      id,
      type: "commandExecution",
      command: "COMMAND_MUST_NOT_LEAK",
      commandActions: [{ command: "COMMAND_MUST_NOT_LEAK" }],
      aggregatedOutput: "STDOUT_MUST_NOT_LEAK STDERR_MUST_NOT_LEAK",
      cwd: "C:\\PRIVATE_PATH_MUST_NOT_LEAK",
      status: "completed",
      exitCode: 0,
      processId,
      description,
    }],
  });
  const appThread = (id, options = {}) => ({
    id,
    sessionId: "root-thread",
    parentThreadId: options.parentThreadId ?? null,
    ephemeral: false,
    createdAt: startedAt,
    updatedAt: completedAt,
    source: options.source || "cli",
    cwd: "C:\\synthetic\\threadlight",
    gitInfo: { branch: "codex/execution" },
    name: options.name || "Execution fixture",
    status: { type: "notLoaded" },
    turns: options.turns || [],
  });
  const parent = appThread("root-thread", { turns: [commandTurn("primary-command", "Primary checks")] });
  const child = appThread("child-thread", {
    parentThreadId: "root-thread",
    source: { subAgent: "review" },
    turns: [commandTurn("child-command", "Child checks", "child-process")],
  });
  const appServer = {
    async listThreads() { return { data: [parent, child] }; },
    async readThread({ threadId, includeTurns }) {
      const thread = threadId === parent.id ? parent : threadId === child.id ? child : null;
      return thread ? { thread: { ...thread, turns: includeTurns ? thread.turns : [] } } : null;
    },
  };

  const evidence = await createCodexProvider({ codexHome: root, appServer, cacheMs: 0, includeArchived: false })
    .readSession("root-thread", { historical: true });
  const primary = evidence.agents.find((agent) => agent.id === "primary");
  const subagent = evidence.agents.find((agent) => agent.id === "agent-child-thread");
  const state = monitorStateFromProviderEvidence("codex", evidence);

  assert.deepEqual(primary.executionTasks.map((task) => task.id), ["primary-command"]);
  assert.deepEqual(subagent.executionTasks.map((task) => task.id), ["child-command"]);
  assert.deepEqual(state.executionTasks, primary.executionTasks);
  assert.deepEqual(state.agents.find((agent) => agent.id === "agent-child-thread").executionTasks, subagent.executionTasks);
  assertNoPrivateFixtureSentinels(evidence, "Codex provider execution evidence");
  assertNoPrivateFixtureSentinels(state, "Codex execution MonitorState");
});
