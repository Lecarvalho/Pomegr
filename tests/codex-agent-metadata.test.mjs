import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCodexAgentTree,
  parseCodexAgentRecords,
} from "../monitor/providers/codex-agent-metadata.mjs";
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
