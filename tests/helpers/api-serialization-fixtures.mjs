import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMonitorServer } from "../../monitor/server.mjs";
import { createClaudeProvider } from "../../monitor/providers/claude.mjs";
import { createCodexProvider } from "../../monitor/providers/codex.mjs";
import { readProviderFixture } from "./provider-fixtures.mjs";

export const SAFE_CWD = "C:\\synthetic\\pomegr-api-fixture";
const PRIVATE_RESOURCE_PID = 987_654_321;
const PRIVATE_RESOURCE_START = "PROCESS_START_MUST_NOT_LEAK";

export function resourceUsageSamplerWithPrivateFields() {
  return {
    async sample() {},
    get() {
      return {
        status: "ready",
        reason: null,
        current: {
          cpuCores: 1.25,
          cpuMachinePercent: 15.625,
          memoryBytes: 2_048,
          readBytesPerSecond: 400,
          writeBytesPerSecond: 200,
          pid: PRIVATE_RESOURCE_PID,
          processStartIdentity: PRIVATE_RESOURCE_START,
          processName: "PROCESS_NAME_MUST_NOT_LEAK",
        },
        observedPeak: {
          memoryBytes: 4_096,
          pid: PRIVATE_RESOURCE_PID,
          processStartIdentity: PRIVATE_RESOURCE_START,
        },
        samples: [{
          timestamp: "2026-08-10T13:00:18.000Z",
          cpuCores: 1.25,
          cpuMachinePercent: 15.625,
          memoryBytes: 2_048,
          readBytesPerSecond: 400,
          writeBytesPerSecond: 200,
          command: "PROCESS_COMMAND_MUST_NOT_LEAK",
        }],
        intervalMs: 5_000,
      };
    },
  };
}

async function writeFixture(file, fixture, replacements = []) {
  let contents = await readProviderFixture(fixture);
  for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

export async function startSyntheticMonitor(context, options) {
  const server = createMonitorServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function codexAppThread() {
  return {
    id: "codex-fixture-parent",
    sessionId: "codex-fixture-parent",
    ephemeral: false,
    createdAt: Date.parse("2026-08-10T13:00:00.000Z") / 1_000,
    updatedAt: Date.parse("2026-08-10T13:00:17.000Z") / 1_000,
    source: "cli",
    cwd: SAFE_CWD,
    name: "Synthetic Codex API fixture",
    status: { type: "idle" },
    preview: "PROMPT_MUST_NOT_LEAK",
    authFile: "AUTH_FILE_MUST_NOT_LEAK",
    environment: { SECRET: "ENV_SECRET_MUST_NOT_LEAK" },
    turns: [{
      id: "turn-private",
      items: [
        { type: "userMessage", content: "PROMPT_MUST_NOT_LEAK" },
        { type: "agentMessage", content: "RESPONSE_MUST_NOT_LEAK" },
        { type: "futurePrivateItem", reasoning: "REASONING_MUST_NOT_LEAK" },
      ],
    }],
  };
}

function rateLimitsWithPrivateFields() {
  return {
    result: {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_786_363_200 },
          credits: { token: "OAUTH_TOKEN_MUST_NOT_LEAK" },
        },
      },
      authFile: "AUTH_FILE_MUST_NOT_LEAK",
      environmentSecret: "ENV_SECRET_MUST_NOT_LEAK",
      localPath: "PRIVATE_PATH_MUST_NOT_LEAK",
      account: "ACCOUNT_MUST_NOT_LEAK",
      workspace: "WORKSPACE_MUST_NOT_LEAK",
      plan: "PLAN_MUST_NOT_LEAK",
      credit: "CREDIT_MUST_NOT_LEAK",
      stderr: "STDERR_MUST_NOT_LEAK",
      rawRpcError: "RAW_RPC_MUST_NOT_LEAK",
    },
  };
}

export async function syntheticProviders(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-api-audit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const replacements = [["PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"]];
  // Replace public repository/memory paths, but retain tool-input privacy sentinels.
  const claudeReplacements = ["repo", "AGENTS.md"].map((leaf) => [`PRIVATE_PATH_MUST_NOT_LEAK\\\\${leaf}`, `synthetic-path\\\\${leaf}`]);
  const claudeRoot = path.join(root, "claude");
  const claudeId = "claude-fixture-parent";
  const claudeFile = path.join(claudeRoot, "projects", "fixture", `${claudeId}.jsonl`);
  const claudeChildFile = path.join(claudeRoot, "projects", "fixture", claudeId, "subagents", "agent-child-fixture.jsonl");
  await writeFixture(claudeFile, "claude/session.jsonl", claudeReplacements);
  await writeFixture(
    claudeChildFile,
    "claude/subagent.jsonl",
    claudeReplacements,
  );
  await writeFixture(path.join(claudeRoot, "registry", `${claudeId}.json`), "claude/registry.json");
  await writeFixture(path.join(claudeRoot, "tasks", claudeId, "task-1.json"), "claude/task.json");
  const workflowRunId = "wf_fixture-1";
  const workflowSessionRoot = path.join(claudeRoot, "projects", "fixture", claudeId);
  await mkdir(path.join(workflowSessionRoot, "subagents", "workflows", workflowRunId), { recursive: true });
  await appendFile(claudeFile, `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-10T13:00:19.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "private-launch", content: "WORKFLOW_PATH_MUST_NOT_LEAK" }] },
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      taskId: "PRIVATE_WORKFLOW_TASK_ID",
      workflowName: "fixture-workflow",
      runId: workflowRunId,
      summary: "Implement and verify the fixture",
      scriptPath: "WORKFLOW_PATH_MUST_NOT_LEAK",
    },
  })}\n`, "utf8");
  await appendFile(claudeFile, `${[
    {
      type: "assistant",
      timestamp: "2026-08-10T13:00:20.000Z",
      message: {
        content: [{
          type: "tool_use",
          name: "mcp__pomegr__report_session_progress",
          input: {
            phase: "implementing",
            percent: 42,
            remaining_minutes_min: 5,
            remaining_minutes_max: 10,
            confidence: "high",
          },
        }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-08-10T13:00:21.000Z",
      message: {
        content: [{
          type: "tool_use",
          name: "mcp__pomegr__report_session_progress",
          input: {
            phase: "complete",
            percent: 100,
            confidence: "high",
            private: "MCP_PROGRESS_PRIVATE_MUST_NOT_LEAK",
          },
        }],
      },
    },
  ].map(JSON.stringify).join("\n")}\n`, "utf8");
  await writeFile(
    path.join(workflowSessionRoot, "subagents", "workflows", workflowRunId, "agent-shared.jsonl"),
    `${JSON.stringify({ type: "user", timestamp: "2026-08-10T13:00:18.000Z", message: { content: "WORKFLOW_AGENT_PROMPT_MUST_NOT_LEAK" } })}\n`,
    "utf8",
  );
  await writeFixture(
    path.join(workflowSessionRoot, "subagents", "workflows", workflowRunId, "journal.jsonl"),
    "claude/workflow/journal.jsonl",
  );
  await writeFixture(
    path.join(workflowSessionRoot, "workflows", `${workflowRunId}.json`),
    "claude/workflow/completed.json",
  );
  const claude = createClaudeProvider({
    homeDir: claudeRoot,
    projectsRoot: path.join(claudeRoot, "projects"),
    registryRoot: path.join(claudeRoot, "registry"),
    tasksRoot: path.join(claudeRoot, "tasks"),
    explicitSession: claudeFile,
    usageRequest: async () => { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK AUTH_FILE_MUST_NOT_LEAK"); },
  });

  const codexRoot = path.join(root, "codex");
  const rolloutRoot = path.join(codexRoot, "sessions", "2026", "08", "10");
  const codexParentFile = path.join(rolloutRoot, "rollout-parent.jsonl");
  const codexChildFile = path.join(rolloutRoot, "rollout-child.jsonl");
  await writeFixture(codexParentFile, "codex/parent.jsonl", [...replacements, ["gpt-synthetic", "gpt-6-astra"]]);
  await writeFixture(codexChildFile, "codex/child.jsonl", [...replacements, ["gpt-synthetic", "gpt-5.6-luna"]]);
  await appendFile(codexParentFile, `${[
    {
      timestamp: "2026-08-10T13:00:20.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__pomegr__report_session_progress",
        call_id: "progress-valid",
        arguments: JSON.stringify({
          phase: "verifying",
          percent: 88,
          remaining_minutes_min: 1,
          remaining_minutes_max: 3,
          confidence: "medium",
        }),
      },
    },
    {
      timestamp: "2026-08-10T13:00:21.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "mcp__pomegr__report_session_progress",
        call_id: "progress-private",
        arguments: JSON.stringify({
          phase: "complete",
          percent: 100,
          confidence: "high",
          private: "MCP_PROGRESS_PRIVATE_MUST_NOT_LEAK",
        }),
      },
    },
  ].map(JSON.stringify).join("\n")}\n`, "utf8");
  const parent = codexAppThread();
  const codexTurnReads = [];
  const codex = createCodexProvider({
    codexHome: codexRoot,
    includeArchived: false,
    cacheMs: 0,
    appServer: {
      async listThreads() { return { data: [parent] }; },
      async readThread({ threadId, includeTurns }) {
        if (includeTurns) codexTurnReads.push(threadId);
        if (threadId !== parent.id) throw new Error("PRIVATE_PATH_MUST_NOT_LEAK");
        return { thread: parent };
      },
    },
    rateLimitsReader: { async readRateLimits() { return rateLimitsWithPrivateFields(); } },
  });
  return { claude, codex, codexTurnReads, transcriptPaths: { claudeChildFile, codexChildFile } };
}
