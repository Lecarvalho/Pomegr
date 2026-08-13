import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseCodexCanonicalExecutionTasks,
  parseCodexExecutionTaskRecords,
  parseCodexExecutionTaskStateRecords,
} from "../monitor/providers/codex-execution-tasks.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import {
  assertNoPrivateFixtureSentinels,
  monitorStateFromProviderEvidence,
} from "./helpers/provider-fixtures.mjs";

const record = (timestamp, type, payload) => ({ timestamp, type, payload });

test("retains bounded sanitized live task history and reconciles a completion after its start leaves the tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-task-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "12");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-task-cache.jsonl");
  const records = [record("2026-08-12T12:00:00.000Z", "session_meta", {
    id: "live-task-cache",
    session_id: "live-task-cache",
    source: "cli",
    cwd: "C:\\synthetic\\task-cache",
  })];
  for (let index = 0; index < 29; index += 1) {
    const id = `completed-${index}`;
    records.push(record(`2026-08-12T12:00:${String(index + 1).padStart(2, "0")}.000Z`, "response_item", {
      type: "function_call",
      name: "shell_command",
      call_id: id,
      arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK", description: `Completed ${index}` }),
    }));
    records.push(record(`2026-08-12T12:01:${String(index + 1).padStart(2, "0")}.000Z`, "response_item", {
      type: "function_call_output",
      call_id: id,
      status: "completed",
      exit_code: 0,
      output: "STDOUT_MUST_NOT_LEAK",
    }));
  }
  records.push(record("2026-08-12T12:02:00.000Z", "response_item", {
    type: "function_call",
    name: "shell_command",
    call_id: "cached-running",
    arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK", description: "Cached running task" }),
  }));
  await writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");

  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    maximumStateTailBytes: 16 * 1024,
  });
  const first = await provider.readSession("live-task-cache", { historical: false });
  assert.equal(first.agents[0].executionTasks.length, 30);
  assert.equal(first.agents[0].executionTasks.find((task) => task.id === "cached-running")?.status, "running");

  await appendFile(file, `${JSON.stringify(record("2026-08-12T12:03:00.000Z", "future_record", {
    private: `TOOL_OUTPUT_MUST_NOT_LEAK${"x".repeat(20_000)}`,
  }))}\n${JSON.stringify(record("2026-08-12T12:03:01.000Z", "response_item", {
    type: "function_call_output",
    call_id: "cached-running",
    status: "completed",
    exit_code: 0,
    output: "STDOUT_MUST_NOT_LEAK",
  }))}\n`, "utf8");

  const second = await provider.readSession("live-task-cache", { historical: false });
  const tasks = second.agents[0].executionTasks;
  assert.equal(tasks.length, 30);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 30);
  assert.equal(tasks.find((task) => task.id === "cached-running")?.status, "completed");
  assert.equal(provider.qaStats().liveExecutionTaskEntries, 1);
  assertNoPrivateFixtureSentinels(second, "cached live Codex execution tasks");

  const historical = await provider.readSession("live-task-cache", { historical: true });
  assert.equal(historical.agents[0].executionTasks.length, 30);
  assert.equal(historical.agents[0].executionTasks.find((task) => task.id === "cached-running")?.status, "completed");
  assertNoPrivateFixtureSentinels(historical, "authoritative historical Codex execution tasks");
});

test("invalidates live task history when a rollout is truncated, replaced, or deleted", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-task-generation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "12");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-task-generation.jsonl");
  const session = record("2026-08-12T12:00:00.000Z", "session_meta", {
    id: "live-task-generation",
    session_id: "live-task-generation",
    source: "cli",
    cwd: "C:\\synthetic\\task-generation",
  });
  const task = (id, timestamp) => record(timestamp, "response_item", {
    type: "function_call",
    name: "shell_command",
    call_id: id,
    arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK", description: id }),
  });
  const serialize = (records) => `${records.map(JSON.stringify).join("\n")}\n`;
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0 });

  await writeFile(file, serialize([
    session,
    task("before-truncate", "2026-08-12T12:00:01.000Z"),
    record("2026-08-12T12:00:02.000Z", "ignored", { padding: "x".repeat(4_000) }),
  ]), "utf8");
  const beforeTruncate = await provider.readSession("live-task-generation", { historical: false });
  assert.deepEqual(beforeTruncate.agents[0].executionTasks.map(({ id }) => id), ["before-truncate"]);

  await writeFile(file, serialize([session, task("after-truncate", "2026-08-12T12:01:00.000Z")]), "utf8");
  const afterTruncate = await provider.readSession("live-task-generation", { historical: false });
  assert.deepEqual(afterTruncate.agents[0].executionTasks.map(({ id }) => id), ["after-truncate"]);

  await rm(file);
  await writeFile(file, serialize([session, task("after-replacement", "2026-08-12T12:02:00.000Z")]), "utf8");
  const afterReplacement = await provider.readSession("live-task-generation", { historical: false });
  assert.deepEqual(afterReplacement.agents[0].executionTasks.map(({ id }) => id), ["after-replacement"]);
  assertNoPrivateFixtureSentinels(afterReplacement, "generation-scoped Codex execution tasks");

  await rm(file);
  assert.equal(await provider.readSession("live-task-generation", { historical: false }), null);
  assert.equal(provider.qaStats().liveExecutionTaskEntries, 0);
});

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
      aggregated_output: "Permission denied: TOOL_OUTPUT_MUST_NOT_LEAK",
      exit_code: 17,
    }),
    record("2026-08-10T13:00:04.500Z", "event_msg", {
      type: "exec_command_end",
      call_id: "command-failed",
      status: "completed",
      success: false,
      aggregated_output: "DUPLICATE_OUTPUT_MUST_NOT_LEAK",
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
  assert.deepEqual(tasks.map(({ id, label, status, exitCode, failureCause }) => ({ id, label, status, exitCode, failureCause })), [
    { id: "command-stopped", label: "Shell command", status: "stopped", exitCode: null, failureCause: null },
    { id: "command-failed", label: "Compile fixture", status: "failed", exitCode: 17, failureCause: "permission_denied" },
    { id: "command-ok", label: "Run checks", status: "completed", exitCode: 0, failureCause: null },
  ]);
  assertNoPrivateFixtureSentinels(tasks, "Codex foreground execution tasks");
  assert.doesNotMatch(JSON.stringify(tasks), /commandActions|parsed_cmd|aggregated_output|stdout|stderr|output/i);
});

test("maps current Codex exec cells to safe shell tasks without exposing cell source or output", () => {
  const records = [
    record("2026-08-11T15:00:00.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec-success",
      input: `const result = await tools.shell_command({ command: "COMMAND_MUST_NOT_LEAK" }); text(result);`,
      status: "completed",
    }),
    record("2026-08-11T15:00:02.000Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "exec-success",
      output: [
        { type: "input_text", text: "Script completed\nWall time: 0.1 seconds" },
        { type: "input_text", text: "Exit code: 0\nSTDOUT_MUST_NOT_LEAK" },
      ],
    }),
    record("2026-08-11T15:01:00.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec-failed",
      input: `const result = await tools.shell_command({ command: "COMMAND_MUST_NOT_LEAK" }); text(result);`,
    }),
    record("2026-08-11T15:01:01.000Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "exec-failed",
      output: [
        { type: "input_text", text: "Script failed\nWall time: 0.1 seconds" },
        { type: "input_text", text: "Script error:\nPermission denied: STDERR_MUST_NOT_LEAK" },
      ],
    }),
    record("2026-08-11T15:02:00.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec-without-shell",
      input: `const result = await tools.view_image({ path: "C:\\PRIVATE_PATH_MUST_NOT_LEAK" }); image(result.image_url);`,
    }),
    record("2026-08-11T15:03:00.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec-categorized",
      input: `const results = await Promise.all([
        tools.shell_command({ command: "npm.cmd test PRIVATE_ARGUMENT_MUST_NOT_LEAK" }),
        tools.shell_command({ command: "git diff -- PRIVATE_PATH_MUST_NOT_LEAK" }),
        tools.shell_command({ command: "node PRIVATE_SCRIPT_MUST_NOT_LEAK.mjs" }),
        tools.shell_command({ command: "gh pr view PRIVATE_ARGUMENT_MUST_NOT_LEAK" }),
        tools.shell_command({ command: "npm.cmd run PRIVATE_SCRIPT_MUST_NOT_LEAK" }),
        tools.shell_command({ command: "dotnet PRIVATE_ARGUMENT_MUST_NOT_LEAK" }),
      ]); results.forEach(text);`,
    }),
    record("2026-08-11T15:03:02.000Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "exec-categorized",
      output: [
        { type: "input_text", text: "Script completed\nWall time: 0.2 seconds" },
        { type: "input_text", text: "Exit code: 0\nTEST_OUTPUT_MUST_NOT_LEAK" },
        { type: "input_text", text: "Exit code: 0\nDIFF_MUST_NOT_LEAK" },
        { type: "input_text", text: "Exit code: 0\nNODE_OUTPUT_MUST_NOT_LEAK" },
        { type: "input_text", text: "Exit code: 0\nGITHUB_OUTPUT_MUST_NOT_LEAK" },
        { type: "input_text", text: "Exit code: 0\nSCRIPT_OUTPUT_MUST_NOT_LEAK" },
        { type: "input_text", text: "Exit code: 0\nDOTNET_OUTPUT_MUST_NOT_LEAK" },
      ],
    }),
  ];

  const tasks = parseCodexExecutionTaskRecords(records);
  assert.deepEqual(tasks.map(({ id, label, status, exitCode }) => ({ id, label, status, exitCode })), [
    { id: "exec-categorized-shell-1", label: "Run tests", status: "completed", exitCode: 0 },
    { id: "exec-categorized-shell-2", label: "Inspect Git changes", status: "completed", exitCode: 0 },
    { id: "exec-categorized-shell-3", label: "Run Node script", status: "completed", exitCode: 0 },
    { id: "exec-categorized-shell-4", label: "Inspect pull requests", status: "completed", exitCode: 0 },
    { id: "exec-categorized-shell-5", label: "Run project script", status: "completed", exitCode: 0 },
    { id: "exec-categorized-shell-6", label: "Run .NET tool", status: "completed", exitCode: 0 },
    { id: "exec-failed-shell-1", label: "Shell command", status: "failed", exitCode: null },
    { id: "exec-success-shell-1", label: "Shell command", status: "completed", exitCode: 0 },
  ]);
  assertNoPrivateFixtureSentinels(tasks, "current Codex exec-cell tasks");
  assert.equal(tasks.find((task) => task.id === "exec-failed-shell-1").failureCause, "permission_denied");
});

test("reconciles exec-cell completion from sanitized cached task identities", () => {
  const startedState = parseCodexExecutionTaskStateRecords([record("2026-08-12T13:00:00.000Z", "response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "exec-cached",
    input: `const results = await Promise.all([
      tools.shell_command({ command: "COMMAND_MUST_NOT_LEAK" }),
      tools.shell_command({ command: "COMMAND_MUST_NOT_LEAK" }),
    ]); results.forEach(text);`,
  })]);
  const completedState = parseCodexExecutionTaskStateRecords([record("2026-08-12T13:00:02.000Z", "response_item", {
    type: "custom_tool_call_output",
    call_id: "exec-cached",
    output: [
      { type: "input_text", text: "Script completed" },
      { type: "input_text", text: "Exit code: 0\nSTDOUT_MUST_NOT_LEAK" },
      { type: "input_text", text: "Exit code: 0\nSTDOUT_MUST_NOT_LEAK" },
    ],
  })], { existingState: startedState });
  const started = startedState.tasks;
  const completed = completedState.tasks;

  assert.equal(started.length, 2);
  assert.equal(completed.length, 2);
  assert.equal(new Set(completed.map((task) => task.id)).size, 2);
  assert.equal(completed.every((task) => task.status === "completed"), true);
  assertNoPrivateFixtureSentinels(completed, "cached Codex exec-cell tasks");
});

test("does not classify ordinary function calls as exec-cell tasks from their ID suffix", () => {
  for (const id of ["ordinary-shell-1", `ordinary-shell-${"9".repeat(100)}`]) {
    const started = parseCodexExecutionTaskStateRecords([record("2026-08-12T13:10:00.000Z", "response_item", {
      type: "function_call",
      name: "shell_command",
      call_id: id,
      arguments: JSON.stringify({ command: "COMMAND_MUST_NOT_LEAK", description: "Ordinary function call" }),
    })]);
    const completed = parseCodexExecutionTaskStateRecords([record("2026-08-12T13:10:01.000Z", "response_item", {
      type: "function_call_output",
      call_id: id,
      status: "completed",
      exit_code: 0,
      output: "STDOUT_MUST_NOT_LEAK",
    })], { existingState: started });

    assert.deepEqual(started.execCellLinks, []);
    assert.equal(completed.tasks.length, 1);
    assert.equal(completed.tasks[0].id, id);
    assert.equal(completed.tasks[0].status, "completed");
    assert.deepEqual(completed.execCellLinks, []);
    assertNoPrivateFixtureSentinels(completed, "collision-proof cached Codex function task");
  }
});

test("uses a fixed description for a single exec-cell shell command passed by shorthand", () => {
  const tasks = parseCodexExecutionTaskRecords([
    record("2026-08-11T15:10:00.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec-shorthand",
      input: `const command = "git status --short PRIVATE_PATH_MUST_NOT_LEAK";
        const result = await tools.shell_command({ command, timeout_ms: 1000 }); text(result);`,
    }),
  ], { historical: true, sessionUpdatedAt: "2026-08-11T15:10:01.000Z" });

  assert.equal(tasks[0].label, "Inspect Git status");
  assertNoPrivateFixtureSentinels(tasks, "Codex shorthand shell description");
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
    failureCause: null,
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
  assert.equal(tasks.find((task) => task.id === "canonical-failed").failureCause, "non_zero_exit");
  assert.equal(tasks.find((task) => task.id === "canonical-declined").status, "stopped");
  assertNoPrivateFixtureSentinels(tasks, "canonical Codex execution tasks");
});

test("provider keeps primary compatibility tasks consistent with per-agent task lists", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-execution-"));
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
    cwd: "C:\\synthetic\\pomegr",
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
