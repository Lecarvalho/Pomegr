import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionTasks } from "../monitor/execution-tasks.mjs";

const bash = (id, timestamp, input) => ({
  type: "assistant",
  timestamp,
  message: { content: [{ type: "tool_use", name: "Bash", id, input }] },
});

const result = (id, timestamp, options = {}) => ({
  type: "user",
  timestamp,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: options.isError || false, content: "PRIVATE COMMAND OUTPUT" }] },
  toolUseResult: { interrupted: options.interrupted || false, backgroundTaskId: options.backgroundTaskId },
});

test("tracks a background shell command until its completion notification", () => {
  const records = [
    bash("toolu_wait", "2026-08-05T23:14:02.000Z", {
      command: "PRIVATE SHELL COMMAND",
      description: "  Wait for   Codex round 5 ",
      run_in_background: true,
    }),
    result("toolu_wait", "2026-08-05T23:14:03.000Z", { backgroundTaskId: "bjy59kbpg" }),
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-08-05T23:21:05.000Z",
      content: '<task-notification><task-id>bjy59kbpg</task-id><tool-use-id>toolu_wait</tool-use-id><status>completed</status><summary>Background command "Wait for Codex round 5" completed (exit code 0)</summary></task-notification>',
    },
  ];

  assert.deepEqual(buildExecutionTasks(records), [{
    id: "toolu_wait",
    label: "Wait for Codex round 5",
    kind: "shell",
    status: "completed",
    background: true,
    backgroundId: "bjy59kbpg",
    startedAt: "2026-08-05T23:14:02.000Z",
    finishedAt: "2026-08-05T23:21:05.000Z",
    exitCode: 0,
  }]);
  assert.doesNotMatch(JSON.stringify(buildExecutionTasks(records)), /PRIVATE|command|output/i);
});

test("keeps an unnotified background command running", () => {
  const tasks = buildExecutionTasks([
    bash("toolu_running", "2026-08-05T23:14:02.000Z", { description: "Wait for review", run_in_background: true }),
    result("toolu_running", "2026-08-05T23:14:03.000Z", { backgroundTaskId: "safe123" }),
  ]);

  assert.equal(tasks[0].status, "running");
  assert.equal(tasks[0].finishedAt, null);
});

test("records foreground completion, failure, and interruption without output", () => {
  const tasks = buildExecutionTasks([
    bash("toolu_ok", "2026-08-05T12:00:00.000Z", { command: "secret", description: "Run checks" }),
    result("toolu_ok", "2026-08-05T12:00:05.000Z"),
    bash("toolu_bad", "2026-08-05T12:01:00.000Z", { command: "secret", description: "Publish changes" }),
    result("toolu_bad", "2026-08-05T12:01:02.000Z", { isError: true }),
    bash("toolu_stop", "2026-08-05T12:02:00.000Z", { command: "secret" }),
    result("toolu_stop", "2026-08-05T12:02:01.000Z", { interrupted: true }),
  ]);

  assert.deepEqual(tasks.map(({ label, status }) => ({ label, status })), [
    { label: "Shell command", status: "stopped" },
    { label: "Publish changes", status: "failed" },
    { label: "Run checks", status: "completed" },
  ]);
  assert.doesNotMatch(JSON.stringify(tasks), /secret|PRIVATE/);
});

test("marks incomplete commands stopped in historical sessions", () => {
  const tasks = buildExecutionTasks([
    bash("toolu_old", "2026-08-05T12:00:00.000Z", { description: "Old command" }),
  ], { historical: true, sessionUpdatedAt: "2026-08-05T12:05:00.000Z" });

  assert.equal(tasks[0].status, "stopped");
  assert.equal(tasks[0].finishedAt, "2026-08-05T12:05:00.000Z");
});

test("ignores unsafe tool identifiers and non-Bash tools", () => {
  assert.deepEqual(buildExecutionTasks([
    bash("../unsafe", "2026-08-05T12:00:00.000Z", { description: "Unsafe" }),
    { type: "assistant", timestamp: "2026-08-05T12:00:00.000Z", message: { content: [{ type: "tool_use", name: "Read", id: "toolu_read", input: { description: "Not a shell task" } }] } },
  ]), []);
});
