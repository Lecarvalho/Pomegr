import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCodexAgentTree,
  parseCodexAgentRecords,
} from "../monitor/providers/codex-agent-metadata.mjs";
import { classifyCodexApprovalAction } from "../monitor/providers/codex-review-actions.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import {
  assertNoPrivateFixtureSentinels,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

const AGENT_FIXTURES = [
  "agent-parent",
  "agent-completed",
  "agent-interrupted",
  "agent-resumed",
  "agent-nested",
  "agent-fork",
  "agent-unknown",
];

async function writeAgentFixtures(root) {
  const directory = path.join(root, "sessions", "2026", "08", "10");
  await mkdir(directory, { recursive: true });
  await Promise.all(AGENT_FIXTURES.map(async (name) => {
    const fixture = await readProviderFixture(`codex/${name}.jsonl`);
    await writeFile(
      path.join(directory, `rollout-${name}.jsonl`),
      fixture.replaceAll("PRIVATE_PATH_MUST_NOT_LEAK", "synthetic"),
      "utf8",
    );
  }));
  await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({
    id: "codex-agent-root",
    thread_name: "Agent metadata fixture",
    updated_at: "2026-08-10T16:00:12.300Z",
  })}\n`, "utf8");
}

test("uses the latest recognized turn context and keeps private settings fields parser-local", () => {
  const summary = parseCodexAgentRecords([
    {
      timestamp: "2026-08-10T12:00:00.000Z",
      type: "turn_context",
      payload: { model: "gpt-old", effort: "low", approval_policy: "never", sandbox_policy: { type: "read-only" } },
    },
    {
      timestamp: "2026-08-10T12:00:01.000Z",
      type: "turn_context",
      payload: {
        model: "gpt-latest",
        effort: "xhigh",
        approval_policy: "on-request",
        sandbox_policy: { type: "workspace-write", writable_roots: ["PRIVATE_PATH_MUST_NOT_LEAK"] },
        developer_instructions: "DEVELOPER_INSTRUCTIONS_MUST_NOT_LEAK",
      },
    },
  ], { localId: "runtime-thread" });

  assert.deepEqual(summary.runtime, {
    timestamp: "2026-08-10T12:00:01.000Z",
    model: "gpt-latest",
    effort: "xhigh",
    approvalPolicy: "on-request",
    sandboxLabel: "Workspace write",
  });
  assertNoPrivateFixtureSentinels(summary, "Codex runtime metadata");
});

test("keeps a child rollout bound to its first thread metadata when it embeds parent session metadata", () => {
  const child = parseCodexAgentRecords([
    {
      timestamp: "2026-08-16T20:49:15.625Z",
      type: "session_meta",
      payload: {
        id: "child-thread",
        session_id: "root-thread",
        parent_thread_id: "root-thread",
        source: { subagent: { thread_spawn: { parent_thread_id: "root-thread" } } },
      },
    },
    {
      timestamp: "2026-08-16T20:49:15.627Z",
      type: "session_meta",
      payload: { id: "root-thread", session_id: "root-thread", source: "vscode" },
    },
    {
      timestamp: "2026-08-16T20:49:16.000Z",
      type: "turn_context",
      payload: { model: "gpt-child", effort: "high" },
    },
  ], { localId: "child-thread" });
  const root = parseCodexAgentRecords([
    {
      timestamp: "2026-08-16T20:40:00.000Z",
      type: "session_meta",
      payload: { id: "root-thread", session_id: "root-thread", source: "vscode" },
    },
    {
      timestamp: "2026-08-16T20:40:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-root", effort: "xhigh" },
    },
  ], { localId: "root-thread" });

  assert.equal(child.localId, "child-thread");
  assert.equal(child.sessionId, "root-thread");
  assert.equal(child.parentThreadId, "root-thread");
  assert.equal(child.sourceKind, "subAgentThreadSpawn");

  const agents = buildCodexAgentTree({
    rootThreadId: "root-thread",
    threads: [
      { localId: "child-thread", sessionId: "root-thread", parentThreadId: "root-thread", createdAt: "2026-08-16T20:49:15.500Z" },
      { localId: "root-thread", sessionId: "root-thread", createdAt: "2026-08-16T20:40:00.000Z" },
    ],
    summaries: new Map([["child-thread", child], ["root-thread", root]]),
    historical: false,
  });

  assert.deepEqual(agents.map(({ id, parentId, model }) => ({ id, parentId, model })), [
    { id: "primary", parentId: null, model: "gpt-root" },
    { id: "agent-child-thread", parentId: "primary", model: "gpt-child" },
  ]);
});

test("reconciles task aliases with child agent paths without creating phantom agents", () => {
  const root = parseCodexAgentRecords([
    {
      timestamp: "2026-08-25T15:00:00.000Z",
      type: "session_meta",
      payload: { id: "alias-root", session_id: "alias-root", source: "vscode" },
    },
    {
      timestamp: "2026-08-25T15:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "spawn-alias-child",
        arguments: "{\"task_name\":\"catalogus_research\",\"message\":\"PROMPT_MUST_NOT_LEAK\"}",
      },
    },
    {
      timestamp: "2026-08-25T15:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "spawn-alias-child",
        output: "{\"task_name\":\"/root/catalogus_research\"}",
      },
    },
    {
      timestamp: "2026-08-25T15:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "interrupt_agent",
        call_id: "stop-alias-child",
        arguments: "{\"target\":\"catalogus_research\"}",
      },
    },
    {
      timestamp: "2026-08-25T15:00:04.100Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "stop-alias-child", output: "{\"previous_status\":\"running\"}" },
    },
    {
      timestamp: "2026-08-25T15:00:05.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "followup_task",
        call_id: "resume-alias-child",
        arguments: "{\"target\":\"catalogus_research\",\"message\":\"PROMPT_MUST_NOT_LEAK\"}",
      },
    },
    {
      timestamp: "2026-08-25T15:00:05.100Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "resume-alias-child", output: "" },
    },
  ], { localId: "alias-root" });
  const child = parseCodexAgentRecords([
    {
      timestamp: "2026-08-25T15:00:01.500Z",
      type: "session_meta",
      payload: {
        id: "alias-child-thread",
        session_id: "alias-root",
        parent_thread_id: "alias-root",
        agent_path: "/root/catalogus_research",
        agent_nickname: "Hooke",
        agent_role: "explorer",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "alias-root",
              agent_path: "/root/catalogus_research",
              agent_nickname: "Hooke",
              agent_role: "explorer",
            },
          },
        },
      },
    },
    {
      timestamp: "2026-08-25T15:00:03.000Z",
      type: "turn_context",
      payload: { model: "gpt-child", effort: "high" },
    },
  ], { localId: "alias-child-thread" });

  const agents = buildCodexAgentTree({
    rootThreadId: "alias-root",
    threads: [
      { localId: "alias-root", sessionId: "alias-root", createdAt: "2026-08-25T15:00:00.000Z" },
      {
        localId: "alias-child-thread",
        sessionId: "alias-root",
        parentThreadId: "alias-root",
        createdAt: "2026-08-25T15:00:01.500Z",
      },
    ],
    summaries: new Map([["alias-root", root], ["alias-child-thread", child]]),
    historical: false,
  });

  assert.deepEqual(agents.map(({ id, assignment, label, model, effort, status }) => ({ id, assignment, label, model, effort, status })), [
    { id: "primary", assignment: null, label: "Primary agent", model: "unknown", effort: "unspecified", status: "idle" },
    { id: "agent-alias-child-thread", assignment: "Catalogus research", label: "Hooke", model: "gpt-child", effort: "high", status: "active" },
  ]);
  assert.equal(agents.some((agent) => agent.id === "agent-catalogus_research"), false);
  assert.equal(agents.some((agent) => "agentPath" in agent || "agentReference" in agent), false);
  assertNoPrivateFixtureSentinels(agents, "Codex alias-reconciled agents");
});

test("hydrates a bounded live assignment after its spawn record leaves the ordinary state tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-assignment-tail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "25");
  await mkdir(directory, { recursive: true });
  const rootId = "live-assignment-root";
  const childId = "live-assignment-child";
  const rootRecords = [
    {
      timestamp: "2026-08-25T15:00:00.000Z",
      type: "session_meta",
      payload: { id: rootId, timestamp: "2026-08-25T15:00:00.000Z", cwd: root, source: "cli" },
    },
    {
      timestamp: "2026-08-25T15:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "spawn-live-child",
        arguments: "{\"task_name\":\"trace_cli_title\",\"message\":\"PROMPT_MUST_NOT_LEAK\"}",
      },
    },
    {
      timestamp: "2026-08-25T15:00:01.100Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "spawn-live-child", output: "{\"task_name\":\"/root/trace_cli_title\"}" },
    },
    { timestamp: "2026-08-25T15:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "x".repeat(2_000) } },
  ];
  const childRecords = [{
    timestamp: "2026-08-25T15:00:01.050Z",
    type: "session_meta",
    payload: {
      id: childId,
      session_id: rootId,
      parent_thread_id: rootId,
      agent_path: "/root/trace_cli_title",
      agent_nickname: "Erdos",
      timestamp: "2026-08-25T15:00:01.050Z",
      cwd: root,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId, agent_path: "/root/trace_cli_title", agent_nickname: "Erdos" } } },
    },
  }];
  await writeFile(path.join(directory, `rollout-2026-08-25T15-00-00-${rootId}.jsonl`), `${rootRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await writeFile(path.join(directory, `rollout-2026-08-25T15-00-01-${childId}.jsonl`), `${childRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({
    id: rootId,
    thread_name: "Live assignment fixture",
    updated_at: "2026-08-25T15:00:02.000Z",
  })}\n`, "utf8");

  const provider = createCodexProvider({
    codexHome: root,
    cacheMs: 0,
    scanLimit: 20,
    maximumStateTailBytes: 256,
    maximumTaskHistoryBytes: 8_192,
  });
  const evidence = await provider.readSession(rootId, { historical: false });
  const child = evidence.agents.find((agent) => agent.label === "Erdos");
  assert.equal(child.assignment, "Trace cli title");
  assertNoPrivateFixtureSentinels(evidence, "live hydrated Codex agent assignment");
});

test("hydrates a primary model and effort after turn context leaves the live state tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-primary-runtime-tail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "25");
  await mkdir(directory, { recursive: true });
  const rootId = "live-primary-runtime";
  const records = [
    {
      timestamp: "2026-08-25T15:00:00.000Z",
      type: "session_meta",
      payload: { id: rootId, session_id: rootId, timestamp: "2026-08-25T15:00:00.000Z", cwd: root, source: "vscode" },
    },
    {
      timestamp: "2026-08-25T15:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-primary", effort: "high", developer_instructions: "DEVELOPER_INSTRUCTIONS_MUST_NOT_LEAK" },
    },
    { timestamp: "2026-08-25T15:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "x".repeat(2_000) } },
  ];
  await writeFile(path.join(directory, `rollout-2026-08-25T15-00-00-${rootId}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({
    id: rootId,
    thread_name: "Primary runtime fixture",
    updated_at: "2026-08-25T15:00:02.000Z",
  })}\n`, "utf8");

  const provider = createCodexProvider({
    codexHome: root,
    cacheMs: 0,
    scanLimit: 20,
    maximumStateTailBytes: 256,
    maximumTaskHistoryBytes: 8_192,
  });
  const evidence = await provider.readSession(rootId, { historical: false });
  const primary = evidence.agents.find((agent) => agent.id === "primary");
  assert.deepEqual({ model: primary.model, effort: primary.effort }, { model: "gpt-primary", effort: "high" });
  assertNoPrivateFixtureSentinels(evidence, "live hydrated Codex primary runtime");
});

test("names Codex guardians and exposes only bounded normalized review decisions", () => {
  const guardian = parseCodexAgentRecords([
    {
      timestamp: "2026-08-25T15:25:12.547Z",
      type: "session_meta",
      payload: {
        id: "guardian-thread",
        session_id: "guardian-root",
        parent_thread_id: "guardian-root",
        source: { subagent: { other: "guardian" } },
      },
    },
    {
      timestamp: "2026-08-25T15:25:13.268Z",
      type: "turn_context",
      payload: { model: "codex-auto-review", effort: "low" },
    },
    {
      timestamp: "2026-08-25T15:25:13.300Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "guardian-turn-1" },
    },
    {
      timestamp: "2026-08-25T15:25:13.400Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `PRIVATE_PROMPT_MUST_NOT_LEAK\n${JSON.stringify({ command: ["npm", "test", "COMMAND_MUST_NOT_LEAK"], cwd: "PRIVATE_PATH_MUST_NOT_LEAK", justification: "APPROVAL_REASON_MUST_NOT_LEAK", sandbox_permissions: "require_escalated", tool: "exec_command", tty: false }, null, 2)}\n>>> end`,
      },
    },
    {
      timestamp: "2026-08-25T15:25:17.430Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "guardian-turn-1",
        completed_at: "2026-08-25T15:25:17.400Z",
        duration_ms: 4_250,
        last_agent_message: JSON.stringify({
          risk_level: "medium",
          user_authorization: "APPROVAL_REASON_MUST_NOT_LEAK",
          outcome: "allow",
          rationale: "REASONING_MUST_NOT_LEAK",
        }),
      },
    },
    {
      timestamp: "2026-08-25T15:28:20.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "guardian-turn-2" },
    },
    {
      timestamp: "2026-08-25T15:28:20.100Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `${JSON.stringify({ cwd: "PRIVATE_PATH_MUST_NOT_LEAK", files: ["PRIVATE_PATH_MUST_NOT_LEAK"], patch: "RESPONSE_MUST_NOT_LEAK", tool: "apply_patch" }, null, 2)}\n>>> end`,
      },
    },
    {
      timestamp: "2026-08-25T15:28:24.687Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "guardian-turn-2",
        completed_at: "2026-08-25T15:28:24.600Z",
        duration_ms: 875,
        last_agent_message: JSON.stringify({ outcome: "deny", risk_level: "COMMAND_MUST_NOT_LEAK", rationale: "RESPONSE_MUST_NOT_LEAK" }),
      },
    },
    {
      timestamp: "2026-08-25T15:28:25.000Z",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: JSON.stringify({ outcome: "future-value" }) },
    },
  ], { localId: "guardian-thread" });

  const agents = buildCodexAgentTree({
    rootThreadId: "guardian-root",
    threads: [
      { localId: "guardian-root", sessionId: "guardian-root", createdAt: "2026-08-25T15:20:00.000Z" },
      {
        localId: "guardian-thread",
        sessionId: "guardian-root",
        parentThreadId: "guardian-root",
        createdAt: "2026-08-25T15:25:12.547Z",
      },
    ],
    summaries: new Map([["guardian-thread", guardian]]),
    historical: true,
  });
  const reviewer = agents.find((agent) => agent.id === "agent-guardian-thread");

  assert.equal(reviewer.label, "Approval reviewer");
  assert.equal(reviewer.kind, "approval-reviewer");
  assert.deepEqual(reviewer.reviewDecisions, {
    total: 2,
    allowed: 1,
    denied: 1,
    items: [
      { action: "build_or_test", outcome: "allowed", risk: "medium", durationMs: 4_250, reviewedAt: "2026-08-25T15:25:17.400Z" },
      { action: "file_change", outcome: "denied", risk: "unknown", durationMs: 875, reviewedAt: "2026-08-25T15:28:24.600Z" },
    ],
    truncated: false,
  });
  assertNoPrivateFixtureSentinels(reviewer, "Codex approval reviewer");
  assert.doesNotMatch(JSON.stringify(reviewer), /provider_turn_id|risk_level|user_authorization|rationale/i);

  const bounded = parseCodexAgentRecords([
    {
      timestamp: "2026-08-25T15:00:00.000Z",
      type: "session_meta",
      payload: { id: "bounded-guardian", source: { subagent: { other: "guardian" } } },
    },
    ...Array.from({ length: 105 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 7, 25, 16, 0, index)).toISOString(),
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: JSON.stringify({ outcome: "allow" }) },
    })),
  ], { localId: "bounded-guardian" });
  assert.equal(bounded.reviewDecisions.total, 105);
  assert.equal(bounded.reviewDecisions.allowed, 105);
  assert.equal(bounded.reviewDecisions.denied, 0);
  assert.equal(bounded.reviewDecisions.items.length, 100);
  assert.equal(bounded.reviewDecisions.items.every((decision) => decision.action === "privileged_action"), true);
  assert.equal(bounded.reviewDecisions.truncated, true);
});

test("classifies the final structured approval request into a bounded action enum", () => {
  const envelope = (request) => `PRIVATE_PROMPT_MUST_NOT_LEAK\n${JSON.stringify(request, null, 2)}\n>>> end`;
  const exec = (command, justification = "") => envelope({ command, cwd: "PRIVATE_PATH_MUST_NOT_LEAK", justification, sandbox_permissions: "require_escalated", tool: "exec_command", tty: false });

  assert.equal(classifyCodexApprovalAction(exec(["npm", "run", "build"])), "build_or_test");
  assert.equal(classifyCodexApprovalAction(exec(["powershell", "restart-pomegr.ps1"])), "local_process");
  assert.equal(classifyCodexApprovalAction(exec(["npm", "ci"])), "dependency_change");
  assert.equal(classifyCodexApprovalAction(exec(["git", "push"])), "version_control");
  assert.equal(classifyCodexApprovalAction(exec(["curl", "https://example.invalid/private"])), "network_access");
  assert.equal(classifyCodexApprovalAction(exec(["Remove-Item", "PRIVATE_PATH_MUST_NOT_LEAK"])), "filesystem_action");
  assert.equal(classifyCodexApprovalAction(exec(["echo", "COMMAND_MUST_NOT_LEAK"])), "shell_command");
  assert.equal(classifyCodexApprovalAction(envelope({ patch: "RESPONSE_MUST_NOT_LEAK", tool: "apply_patch" })), "file_change");
  assert.equal(classifyCodexApprovalAction(envelope({ tool: "web__run" })), "network_access");
  assert.equal(classifyCodexApprovalAction(envelope({ tool: "mcp__node_repl__js" })), "browser_interaction");
  assert.equal(classifyCodexApprovalAction("malformed PRIVATE_PROMPT_MUST_NOT_LEAK"), "privileged_action");
});

test("keeps bounded approval categories when a live guardian request leaves the ordinary state tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-review-tail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "25");
  await mkdir(directory, { recursive: true });
  const rootId = "01a03983-665a-7a43-a008-6aa1f1d6ec91";
  const childId = "01a03986-8514-7d73-9267-f425f160cdb7";
  const rootRecords = [{
    timestamp: "2026-08-25T15:00:00.000Z",
    type: "session_meta",
    payload: { id: rootId, timestamp: "2026-08-25T15:00:00.000Z", cwd: root, source: "cli" },
  }];
  const childRecords = [
    {
      timestamp: "2026-08-25T15:00:01.000Z",
      type: "session_meta",
      payload: { id: childId, session_id: rootId, parent_thread_id: rootId, timestamp: "2026-08-25T15:00:01.000Z", cwd: root, source: { subagent: { other: "guardian" } } },
    },
    { timestamp: "2026-08-25T15:00:02.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "review-turn" } },
    {
      timestamp: "2026-08-25T15:00:02.100Z",
      type: "event_msg",
      payload: { type: "user_message", message: `${JSON.stringify({ command: ["powershell", "restart-pomegr.ps1", "COMMAND_MUST_NOT_LEAK"], cwd: "PRIVATE_PATH_MUST_NOT_LEAK", justification: "Restart the local server", sandbox_permissions: "require_escalated", tool: "exec_command", tty: false }, null, 2)}\n>>> end` },
    },
    {
      timestamp: "2026-08-25T15:00:05.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "review-turn", completed_at: "2026-08-25T15:00:05.000Z", duration_ms: 2_900, last_agent_message: JSON.stringify({ risk_level: "medium", user_authorization: "high", outcome: "allow", rationale: "REASONING_MUST_NOT_LEAK" }) },
    },
    { timestamp: "2026-08-25T15:00:06.000Z", type: "event_msg", payload: { type: "agent_message", message: "x".repeat(2_000) } },
  ];
  await writeFile(path.join(directory, `rollout-2026-08-25T15-00-00-${rootId}.jsonl`), `${rootRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await writeFile(path.join(directory, `rollout-2026-08-25T15-00-01-${childId}.jsonl`), `${childRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, scanLimit: 20, maximumStateTailBytes: 256, maximumTaskHistoryBytes: 8_192 });
  const evidence = await provider.readSession(rootId, { historical: false });
  const reviewer = evidence.agents.find((agent) => agent.label === "Approval reviewer");
  assert.equal(reviewer.reviewDecisions.items[0].action, "local_process");
  assertNoPrivateFixtureSentinels(reviewer, "live hydrated Codex approval category");
});

test("orders Codex sibling agents by stable creation time with the newest first", () => {
  const threads = [
    { localId: "old-child", sessionId: "root-thread", parentThreadId: "root-thread", createdAt: "2026-08-16T20:41:00.000Z" },
    { localId: "root-thread", sessionId: "root-thread", createdAt: "2026-08-16T20:40:00.000Z" },
    { localId: "new-child", sessionId: "root-thread", parentThreadId: "root-thread", createdAt: "2026-08-16T20:43:00.000Z" },
    { localId: "middle-child", sessionId: "root-thread", parentThreadId: "root-thread", createdAt: "2026-08-16T20:42:00.000Z" },
  ];

  const first = buildCodexAgentTree({ rootThreadId: "root-thread", threads, historical: false });
  const refreshed = buildCodexAgentTree({ rootThreadId: "root-thread", threads: [...threads].reverse(), historical: false });

  assert.deepEqual(first.map(({ id }) => id), [
    "primary",
    "agent-new-child",
    "agent-middle-child",
    "agent-old-child",
  ]);
  assert.deepEqual(refreshed.map(({ id }) => id), first.map(({ id }) => id));
});

test("builds a deterministic primary/subagent tree across completion, interruption, resume, fork, and missing rollout", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-agents-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeAgentFixtures(root);
  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, scanLimit: 30 });

  const evidence = await provider.readSession("codex-agent-root", { historical: true });
  assert.equal(evidence.session.startedAt, "2026-08-10T16:00:00.000Z");
  assert.equal(evidence.session.updatedAt, "2026-08-10T16:00:12.300Z");
  const firstOrder = evidence.agents.map((agent) => agent.id);
  const secondOrder = (await provider.readSession("codex-agent-root", { historical: true })).agents.map((agent) => agent.id);
  assert.deepEqual(secondOrder, firstOrder);

  const agents = new Map(evidence.agents.map((agent) => [agent.id, agent]));
  assert.deepEqual(
    [...agents.values()].map(({ id, parentId }) => ({ id, parentId })),
    firstOrder.map((id) => ({ id, parentId: agents.get(id).parentId })),
  );
  assert.equal(agents.get("primary").model, "gpt-latest");
  assert.equal(agents.get("primary").effort, "xhigh");
  assert.equal(agents.get("primary").status, "idle");
  assert.equal(agents.get("agent-codex-agent-completed").parentId, "primary");
  assert.equal(agents.get("agent-codex-agent-completed").label, "Delta");
  assert.equal(agents.get("agent-codex-agent-completed").kind, "reviewer");
  assert.equal(agents.get("agent-codex-agent-completed").model, "gpt-child-latest");
  assert.equal(agents.get("agent-codex-agent-completed").status, "finished");
  assert.equal(agents.get("agent-codex-agent-interrupted").status, "stopped");
  assert.equal(agents.get("agent-codex-agent-resumed").model, "gpt-after-resume");
  assert.equal(agents.get("agent-codex-agent-resumed").status, "finished");
  assert.equal(agents.get("agent-codex-agent-nested").parentId, "agent-codex-agent-completed");
  assert.equal(agents.get("agent-codex-agent-fork").parentId, "primary");
  assert.equal(agents.get("agent-codex-agent-fork").kind, "fork");
  assert.equal(agents.get("agent-codex-agent-missing").label, "Unnamed subagent");
  assert.equal(agents.get("agent-codex-agent-missing").status, "stopped");
  assert.equal(agents.get("agent-codex-agent-unknown").label, "Unnamed subagent");
  assert.equal(agents.get("agent-codex-agent-unknown").kind, "subagent");
  assert.equal(agents.get("agent-codex-agent-unknown").effort, "unspecified");
  assert.equal(agents.get("agent-codex-agent-resumed").durationMs, 7_200);
  assertNoPrivateFixtureSentinels(evidence, "Codex agent evidence");
  assert.doesNotMatch(JSON.stringify(evidence), /instructions|writable_roots|prompt|message/);
});

test("maps recognized app-server runtime states without treating unknown metadata as live", () => {
  const threads = [
    {
      localId: "runtime-root",
      sessionId: "runtime-root",
      sourceKind: "cli",
      createdAt: "2026-08-10T17:00:00.000Z",
      updatedAt: "2026-08-10T17:00:02.000Z",
      runtimeStatus: { type: "active", activeFlags: [] },
    },
    {
      localId: "runtime-idle-child",
      sessionId: "runtime-root",
      parentThreadId: "runtime-root",
      sourceKind: "subAgentThreadSpawn",
      createdAt: "2026-08-10T17:00:01.000Z",
      updatedAt: "2026-08-10T17:00:02.000Z",
      runtimeStatus: { type: "idle" },
    },
    {
      localId: "runtime-unknown-child",
      sessionId: "runtime-root",
      parentThreadId: "runtime-root",
      sourceKind: "future-kind",
      createdAt: "2026-08-10T17:00:01.000Z",
      updatedAt: "2026-08-10T17:00:02.000Z",
      runtimeStatus: { type: "future-status" },
      agentNickname: "",
      agentRole: "",
    },
  ];

  const agents = buildCodexAgentTree({ rootThreadId: "runtime-root", threads, historical: false });
  assert.equal(agents.find((agent) => agent.id === "primary").status, "active");
  assert.equal(agents.find((agent) => agent.id === "agent-runtime-idle-child").status, "idle");
  const unknown = agents.find((agent) => agent.id === "agent-runtime-unknown-child");
  assert.equal(unknown.status, "idle");
  assert.equal(unknown.label, "Unnamed subagent");
  assert.equal(unknown.kind, "subagent");
});

test("does not attach collaboration records from another Codex session tree", () => {
  const unrelated = parseCodexAgentRecords([
    {
      timestamp: "2026-08-10T18:00:00.000Z",
      type: "session_meta",
      payload: { id: "other-root", session_id: "other-root", source: "cli" },
    },
    {
      timestamp: "2026-08-10T18:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "other-spawn",
        arguments: "{\"task_name\":\"private-other-child\"}",
      },
    },
    {
      timestamp: "2026-08-10T18:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "other-spawn", output: "{\"agent_id\":\"other-child\"}" },
    },
  ]);
  const agents = buildCodexAgentTree({
    rootThreadId: "selected-root",
    threads: [
      { localId: "selected-root", sessionId: "selected-root", sourceKind: "cli" },
      { localId: "other-root", sessionId: "other-root", sourceKind: "cli" },
    ],
    summaries: new Map([["other-root", unrelated]]),
    historical: true,
  });

  assert.deepEqual(agents.map((agent) => agent.id), ["primary"]);
});


test("incremental approval reviews preserve stronger metadata and upgrade replayed decisions", () => {
  const fallback = { localId: "guardian-retention", approvalReviewer: true };
  const request = [
    { type: "event_msg", timestamp: "2026-09-02T12:00:00.000Z", payload: { type: "task_started", turn_id: "review-turn" } },
    { type: "event_msg", timestamp: "2026-09-02T12:00:00.100Z", payload: {
      type: "user_message", message: JSON.stringify({ tool: "exec_command", command: ["npm", "test"], cwd: "PRIVATE_PATH_MUST_NOT_LEAK" }) + "\n>>> end",
    } },
  ];
  const completed = { type: "event_msg", timestamp: "2026-09-02T12:00:02.000Z", payload: {
    type: "task_complete", turn_id: "review-turn", duration_ms: 2_000,
    last_agent_message: JSON.stringify({ outcome: "allow", risk_level: "low", rationale: "REASONING_MUST_NOT_LEAK" }),
  } };
  const initial = parseCodexAgentRecords([...request, completed], fallback).reviewDecisions;
  const before = structuredClone(initial);
  assert.equal(initial.items[0].action, "build_or_test");
  const replay = { ...completed, payload: { ...completed.payload, duration_ms: null, last_agent_message: JSON.stringify({ outcome: "allow" }) } };
  const retained = parseCodexAgentRecords([replay], fallback, initial).reviewDecisions;
  assert.deepEqual(retained, before, "lookbehind missing the request must not downgrade known metadata");
  assert.deepEqual(initial, before, "merging does not mutate the committed feed");
  assert.deepEqual(parseCodexAgentRecords([], fallback, retained).reviewDecisions, before);

  const incomplete = parseCodexAgentRecords([replay], fallback).reviewDecisions;
  assert.equal(incomplete.items[0].action, "privileged_action");
  const upgraded = parseCodexAgentRecords([...request, completed], fallback, incomplete).reviewDecisions;
  assert.deepEqual(upgraded, before, "a stronger replay upgrades the same decision without increasing totals");
  assertNoPrivateFixtureSentinels(upgraded, "retained review metadata");
});
