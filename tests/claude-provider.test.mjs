import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeFiveHourLimitRejections, createClaudeProvider } from "../monitor/providers/claude.mjs";
import {
  assertNoPrivateFixtureSentinels,
  monitorStateFromProviderEvidence,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

async function writeFixture(file, fixture, replacements = []) {
  let contents = await readProviderFixture(fixture);
  for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

async function writeRecords(file, records) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function taskCall(id, name, input) {
  return {
    type: "assistant",
    timestamp: "2026-08-12T14:00:00.000Z",
    message: { model: "claude-test", content: [{ type: "tool_use", id, name, input }] },
  };
}

function taskResult(id, toolUseResult, overrides = {}) {
  return {
    type: "user",
    timestamp: "2026-08-12T14:00:01.000Z",
    message: { content: [{
      type: "tool_result",
      tool_use_id: id,
      content: "TOOL_RESULT_PRIVATE_MUST_NOT_LEAK",
      ...overrides,
    }] },
    toolUseResult,
  };
}

function workflowLaunchRecord(runId, timestamp = "2026-08-15T18:00:00.000Z") {
  return {
    type: "user",
    timestamp,
    message: { content: [{
      type: "tool_result",
      tool_use_id: `launch-${runId}`,
      content: "WORKFLOW_PATH_MUST_NOT_LEAK",
      is_error: false,
    }] },
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      taskId: "PRIVATE_WORKFLOW_TASK_ID",
      workflowName: "fixture-workflow",
      runId,
      summary: "Implement and verify the fixture",
      transcriptDir: "WORKFLOW_PATH_MUST_NOT_LEAK",
      scriptPath: "WORKFLOW_PATH_MUST_NOT_LEAK",
    },
  };
}

function workflowWorkerRecords(messageId, timestamp = "2026-08-15T18:01:00.000Z") {
  return [
    { type: "user", timestamp, message: { content: "WORKFLOW_AGENT_PROMPT_MUST_NOT_LEAK" } },
    {
      type: "assistant",
      timestamp,
      message: {
        id: messageId,
        model: "claude-test",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 20 },
        content: [],
      },
    },
  ];
}

function workflowStopRecords(agentId, timestamp = "2026-08-15T18:01:20.000Z") {
  return [
    {
      type: "assistant",
      timestamp,
      message: { model: "claude-test", content: [{
        type: "tool_use",
        id: `stop-${agentId}`,
        name: "TaskStop",
        input: { task_id: agentId },
      }] },
    },
    {
      type: "user",
      timestamp,
      message: { content: [{
        type: "tool_result",
        tool_use_id: `stop-${agentId}`,
        content: "Agent stopped successfully",
        is_error: false,
      }] },
    },
  ];
}

test("Claude adapter keeps only the first structured five-hour rejection per reset window", () => {
  const events = claudeFiveHourLimitRejections([[
    { type: "assistant", timestamp: "2026-08-25T02:21:18.314Z", quotaLimits: { rateLimitType: "five_hour", status: "rejected", resetsAt: 1_787_634_600, private: "MUST_NOT_LEAK" } },
    { type: "assistant", timestamp: "2026-08-25T02:21:06.475Z", quotaLimits: { rateLimitType: "five_hour", status: "rejected", resetsAt: 1_787_634_600 } },
    { type: "assistant", timestamp: "2026-08-25T02:20:00.000Z", quotaLimits: { rateLimitType: "seven_day", status: "rejected", resetsAt: 1_787_634_600 } },
    { type: "assistant", timestamp: "2026-08-25T02:19:00.000Z", quotaLimits: { rateLimitType: "five_hour", status: "allowed", resetsAt: 1_787_634_600 } },
    { type: "assistant", timestamp: "invalid", quotaLimits: { rateLimitType: "five_hour", status: "rejected", resetsAt: "invalid" } },
  ]]);
  assert.deepEqual(events, [{ observedAt: "2026-08-25T02:21:06.475Z", resetsAt: "2026-08-25T05:10:00.000Z" }]);
  assert.equal(JSON.stringify(events).includes("MUST_NOT_LEAK"), false);
});

test("Claude adapter returns sanitized provider evidence without changing normalized features", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-provider-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const registryRoot = path.join(root, "registry");
  const tasksRoot = path.join(root, "tasks");
  const localId = "claude-fixture-parent";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const replacements = [["PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"]];
  await writeFixture(mainFile, "claude/session.jsonl", replacements);
  await writeFixture(
    path.join(projectsRoot, "fixture-project", localId, "subagents", "agent-child-fixture.jsonl"),
    "claude/subagent.jsonl",
    replacements,
  );
  await writeFixture(path.join(registryRoot, `${localId}.json`), "claude/registry.json");
  await writeFixture(path.join(tasksRoot, localId, "task-1.json"), "claude/task.json");

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot,
    tasksRoot,
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const catalog = await provider.listSessions();
  assert.deepEqual(catalog.map(({ localId: id, title, isLive, needsInput, activityStatus }) => ({ id, title, isLive, needsInput, activityStatus })), [{
    id: localId,
    title: "Synthetic provider fixture",
    isLive: true,
    needsInput: true,
    activityStatus: "needs_input",
  }]);

  const evidence = await provider.readSession(localId, { historical: false });
  assert.equal(evidence.localId, localId);
  assert.equal(evidence.historical, false);
  assert.equal(evidence.session.recordedGitBranch, "codex/synthetic-fixture");
  assert.equal(evidence.session.approvalMode.id, "accept_edits");
  assert.equal(evidence.session.contextMachinery.machineryTokens, 1600);
  assert.equal(evidence.session.summary.text, "Synthetic fixture is awaiting review.");
  assert.equal(evidence.session.signal, null);
  assert.deepEqual(evidence.session.pomegrPlugin, {
    status: "active",
    version: "0.4.1",
    policyStatus: "valid",
    policyVersion: 7,
    observedAt: "2026-08-10T12:00:00.500Z",
  });
  assert.equal(evidence.agents.length, 2);
  assert.equal(evidence.agents[0].status, "needs_input");
  assert.equal(evidence.agents[0].signal.label, "Reviewing");
  assert.equal(evidence.agents[0].executionTasks[0].status, "completed");
  assert.equal(evidence.usageSnapshots.length, 2);
  assert.equal(evidence.toolCalls.find((call) => call.id === "bash-1").detail, "Run synthetic checks");
  assert.equal(evidence.planTasks[0].subject, "Verify synthetic fixture");
  assert.equal(evidence.compactions[0].trigger, "auto");
  assertNoPrivateFixtureSentinels(evidence, "Claude adapter evidence");
});

test("Claude catalog keeps a custom session title after it moves outside the summary tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-title-tail-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "claude-title-tail";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const filler = (label) => ({
    type: "user",
    timestamp: "2026-08-12T14:00:00.000Z",
    message: { content: `${label}_PRIVATE_MUST_NOT_LEAK`.repeat(24_000) },
  });
  await writeRecords(mainFile, [
    { type: "ai-title", aiTitle: "Automatic title" },
    filler("BEFORE_RENAME"),
  ]);
  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });

  assert.equal((await provider.listSessions())[0].title, "Automatic title");

  await appendFile(mainFile, `${[
    { type: "custom-title", customTitle: "Durable custom title" },
    filler("AFTER_RENAME"),
    { type: "ai-title", aiTitle: "Stale automatic title" },
  ].map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const catalog = await provider.listSessions();
  assert.equal(catalog[0].title, "Durable custom title");
  assert.equal((await provider.readSession(localId)).session.title, "Durable custom title");
  assertNoPrivateFixtureSentinels(catalog, "Claude title catalog");
});

test("Claude live usage snapshots survive a moving transcript tail and reset on replacement", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-usage-rollover-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "claude-usage-rollover";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const usage = (id, timestamp, input) => ({
    type: "assistant",
    timestamp,
    message: {
      id,
      model: "claude-test",
      usage: {
        input_tokens: input,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [],
    },
  });
  const filler = (index) => ({
    type: "user",
    timestamp: new Date(Date.parse("2026-08-12T14:00:00.000Z") + index * 1_000).toISOString(),
    message: { content: "TAIL_FILLER_".repeat(25_000) },
  });
  await writeRecords(mainFile, [
    usage("before-rollover", "2026-08-12T14:00:00.000Z", 100),
    ...Array.from({ length: 5 }, (_, index) => filler(index + 1)),
  ]);
  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });

  const before = await provider.readSession(localId);
  assert.deepEqual(before.usageSnapshots.map(({ dedupeId }) => dedupeId), ["primary:message:before-rollover"]);

  await appendFile(mainFile, `${Array.from({ length: 3 }, (_, index) => JSON.stringify(filler(index + 40))).join("\n")}\n`, "utf8");
  await appendFile(mainFile, `${JSON.stringify(usage("after-rollover", "2026-08-12T15:00:00.000Z", 200))}\n`, "utf8");
  const afterAppend = await provider.readSession(localId);
  assert.deepEqual(afterAppend.usageSnapshots.map(({ dedupeId }) => dedupeId), [
    "primary:message:before-rollover",
    "primary:message:after-rollover",
  ]);

  await writeRecords(mainFile, [usage("replacement", "2026-08-12T16:00:00.000Z", 300)]);
  const afterReplacement = await provider.readSession(localId);
  assert.deepEqual(afterReplacement.usageSnapshots.map(({ dedupeId }) => dedupeId), ["primary:message:replacement"]);

  await rm(mainFile);
  assert.equal(await provider.readSession(localId), null);
});

test("Claude adapter rejects unsafe session IDs and degrades missing sessions independently", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot: path.join(root, "projects"),
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    usageRequest: async () => { throw new Error("not requested"); },
  });
  assert.equal(await provider.readSession("../private", { historical: true }), null);
  assert.equal(await provider.readSession("missing", { historical: true }), null);
  assert.deepEqual(await provider.listSessions(), []);
});

test("Claude adapter discovers live workflow workers without treating journals as agents", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-live-workflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "workflow-live";
  const runIds = ["wf_fixture-1", "wf_fixture-2"];
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await writeRecords(mainFile, [
    { type: "user", timestamp: "2026-08-15T18:00:00.000Z", cwd: root, message: { content: "PROMPT_MUST_NOT_LEAK" } },
    workflowLaunchRecord(runIds[0]),
    workflowLaunchRecord(runIds[1], "2026-08-15T18:00:10.000Z"),
    ...workflowStopRecords("shared"),
  ]);
  const workflowRoot = path.join(projectsRoot, "fixture-project", localId, "subagents", "workflows");
  const workerFiles = runIds.map((runId) => path.join(workflowRoot, runId, "agent-shared.jsonl"));
  await writeRecords(workerFiles[0], workflowWorkerRecords("same-provider-message"));
  await writeRecords(workerFiles[1], workflowWorkerRecords("same-provider-message", "2026-08-15T18:01:10.000Z"));
  await writeFixture(path.join(workflowRoot, runIds[0], "journal.jsonl"), "claude/workflow/journal.jsonl");
  await Promise.all(workerFiles.map((file) => utimes(file, new Date("2026-08-15T18:01:30.000Z"), new Date("2026-08-15T18:01:30.000Z"))));

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    now: () => Date.parse("2026-08-15T18:02:00.000Z"),
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId);
  assert.equal(provider.capabilities.workflows, true);
  assert.equal(provider.capabilities.cacheWriteUsage, true);
  assert.equal(evidence.agents.length, 3);
  assert.equal(evidence.agents.some((agent) => agent.id.includes("journal")), false);
  assert.equal(new Set(evidence.agents.map((agent) => agent.id)).size, 3);
  assert.equal(new Set(evidence.usageSnapshots.map((snapshot) => snapshot.dedupeId)).size, 2);
  assert.equal(evidence.agents.filter((agent) => agent.workflowId).some((agent) => agent.status === "stopped"), false);
  assert.deepEqual(evidence.workflows.map(({ id, status, metadataStatus, agentIds, phases }) => ({ id, status, metadataStatus, agentIds, phases })), [
    { id: runIds[0], status: "running", metadataStatus: "pending", agentIds: [`workflow-${runIds[0]}-agent-shared`], phases: [] },
    { id: runIds[1], status: "running", metadataStatus: "pending", agentIds: [`workflow-${runIds[1]}-agent-shared`], phases: [] },
  ]);
  const workflowAgents = evidence.agents.filter((agent) => agent.workflowId);
  assert.equal(workflowAgents.every((agent) => agent.parentId === "primary"), true);
  assert.equal(workflowAgents.every((agent) => agent.label === "Worker 1"), true);
  assert.deepEqual(workflowAgents.map(({ workflowOrder, workflowState }) => ({ workflowOrder, workflowState })), [
    { workflowOrder: 0, workflowState: "running" },
    { workflowOrder: 0, workflowState: "unknown" },
  ]);
  const state = monitorStateFromProviderEvidence("claude", evidence);
  assert.equal(state.metrics.agents, 3);
  assert.equal(state.metrics.tokens.allAgents, 70);
  assert.deepEqual(state.workflows, evidence.workflows);
  assertNoPrivateFixtureSentinels(evidence, "live Claude workflow evidence");
});

test("Claude adapter maps a stopped workflow worker by its provider-local agent ID", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-stopped-workflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "workflow-stopped";
  const runId = "wf_fixture-1";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await writeRecords(mainFile, [
    workflowLaunchRecord(runId),
    ...workflowStopRecords("shared"),
  ]);
  const workerFile = path.join(
    projectsRoot,
    "fixture-project",
    localId,
    "subagents",
    "workflows",
    runId,
    "agent-shared.jsonl",
  );
  await writeRecords(workerFile, workflowWorkerRecords("worker-one"));
  const journalFile = path.join(path.dirname(workerFile), "journal.jsonl");
  await writeRecords(journalFile, [{
    type: "started",
    agentId: "shared",
    key: "WORKFLOW_PATH_MUST_NOT_LEAK",
  }]);
  await utimes(workerFile, new Date("2026-08-15T18:01:30.000Z"), new Date("2026-08-15T18:01:30.000Z"));

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    now: () => Date.parse("2026-08-15T18:02:00.000Z"),
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId);
  const worker = evidence.agents.find((agent) => agent.workflowId === runId);
  assert.equal(worker.status, "stopped");
  assert.equal(worker.workflowState, "unknown");
  assert.equal(worker.lastSeen, "2026-08-15T18:01:20.000Z");
  assert.equal(evidence.workflows[0].status, "unknown");
  assert.equal(evidence.workflows[0].metadataStatus, "unavailable");
});

test("Claude adapter orders live workflow workers from bounded journal lifecycle evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-journal-workflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "workflow-journal";
  const runId = "wf_fixture-journal";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const runRoot = path.join(projectsRoot, "fixture-project", localId, "subagents", "workflows", runId);
  await writeRecords(mainFile, [workflowLaunchRecord(runId)]);

  const workerSpecs = [
    ["abcdef-one", "2026-08-15T18:01:40.000Z"],
    ["abcdef-two", "2026-08-15T18:01:30.000Z"],
    ["delta-1", "2026-08-15T18:01:10.000Z"],
    ["gamma-1", "2026-08-15T18:01:20.000Z"],
  ];
  for (const [agentId, timestamp] of workerSpecs) {
    const file = path.join(runRoot, `agent-${agentId}.jsonl`);
    await writeRecords(file, workflowWorkerRecords(`worker-${agentId}`, timestamp));
    await utimes(file, new Date("2026-08-15T18:01:50.000Z"), new Date("2026-08-15T18:01:50.000Z"));
  }
  await writeRecords(path.join(runRoot, "agent-abcdef-one.jsonl"), [{
    type: "user",
    timestamp: "2026-08-15T18:01:40.000Z",
    message: { content: "WORKFLOW_AGENT_PROMPT_MUST_NOT_LEAK" },
  }]);
  await utimes(
    path.join(runRoot, "agent-abcdef-one.jsonl"),
    new Date("2026-08-15T18:01:50.000Z"),
    new Date("2026-08-15T18:01:50.000Z"),
  );
  await writeRecords(path.join(runRoot, "agent-abcdef-one.meta.json"), [{
    agentType: "workflow-subagent",
    spawnDepth: 1,
    model: "opus",
    description: "WORKFLOW_AGENT_PROMPT_MUST_NOT_LEAK",
    toolUseId: "PRIVATE_WORKFLOW_TASK_ID",
  }]);

  const journalLines = [
    JSON.stringify({ type: "started", agentId: "abcdef-two", key: "WORKFLOW_PATH_MUST_NOT_LEAK" }),
    JSON.stringify({ type: "started", agentId: "abcdef-two", duplicate: true }),
    JSON.stringify({ type: "ignored", agentId: "abcdef-one", result: "WORKFLOW_JOURNAL_RESULT_MUST_NOT_LEAK" }),
    JSON.stringify({ type: "started", agentId: "not-discovered", result: "WORKFLOW_JOURNAL_RESULT_MUST_NOT_LEAK" }),
    JSON.stringify({ type: "result", agentId: "abcdef-two", result: { private: "WORKFLOW_JOURNAL_RESULT_MUST_NOT_LEAK" } }),
    JSON.stringify({ type: "started", agentId: "abcdef-one", key: "WORKFLOW_PATH_MUST_NOT_LEAK" }),
    JSON.stringify({ type: "result", agentId: "delta-1", result: "WORKFLOW_JOURNAL_RESULT_MUST_NOT_LEAK" }),
    JSON.stringify({ type: "result", agentId: "gamma-1", result: `WORKFLOW_JOURNAL_RESULT_MUST_NOT_LEAK${"x".repeat(17 * 1024)}` }),
    "{malformed WORKFLOW_JOURNAL_RESULT_MUST_NOT_LEAK",
  ];
  await writeFile(path.join(runRoot, "journal.jsonl"), `${journalLines.join("\n")}\n`, "utf8");

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    now: () => Date.parse("2026-08-15T18:02:00.000Z"),
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId);
  const workflow = evidence.workflows[0];
  assert.equal(workflow.metadataStatus, "pending");
  assert.deepEqual(workflow.agentIds, [
    `workflow-${runId}-agent-abcdef-two`,
    `workflow-${runId}-agent-abcdef-one`,
    `workflow-${runId}-agent-delta-1`,
    `workflow-${runId}-agent-gamma-1`,
  ]);
  const agentsById = new Map(evidence.agents.filter((agent) => agent.workflowId === runId).map((agent) => [agent.id, agent]));
  assert.deepEqual(workflow.agentIds.map((id) => agentsById.get(id).workflowOrder), [0, 1, 2, 3]);
  assert.deepEqual(workflow.agentIds.map((id) => agentsById.get(id).workflowState), ["done", "running", "done", "unknown"]);
  assert.equal(agentsById.get(`workflow-${runId}-agent-abcdef-two`).status, "finished");
  assert.equal(agentsById.get(`workflow-${runId}-agent-delta-1`).status, "finished");
  assert.equal(new Set(workflow.agentIds.map((id) => agentsById.get(id).label)).size, 4);
  assert.equal(agentsById.get(`workflow-${runId}-agent-abcdef-one`).kind, "workflow-subagent");
  assert.equal(agentsById.get(`workflow-${runId}-agent-abcdef-one`).model, "opus");
  const state = monitorStateFromProviderEvidence("claude", evidence);
  assertNoPrivateFixtureSentinels(evidence, "live workflow journal evidence");
  assertNoPrivateFixtureSentinels(state, "serialized live workflow journal state");
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_WORKFLOW_TASK_ID|not-discovered|duplicate/);
});

test("Claude adapter allowlists completed workflow phases and worker linkage", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-completed-workflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "workflow-completed";
  const runId = "wf_fixture-1";
  const sessionRoot = path.join(projectsRoot, "fixture-project", localId);
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await writeRecords(mainFile, [
    { type: "user", timestamp: "2026-08-15T18:00:00.000Z", cwd: root, message: { content: "PROMPT_MUST_NOT_LEAK" } },
    workflowLaunchRecord(runId),
  ]);
  await writeRecords(path.join(sessionRoot, "subagents", "workflows", runId, "agent-shared.jsonl"), workflowWorkerRecords("worker-one"));
  await writeRecords(path.join(sessionRoot, "subagents", "workflows", runId, "agent-reviewer.jsonl"), workflowWorkerRecords("worker-two", "2026-08-15T18:04:00.000Z"));
  await writeFixture(path.join(sessionRoot, "subagents", "workflows", runId, "journal.jsonl"), "claude/workflow/journal.jsonl");
  await writeFixture(path.join(sessionRoot, "workflows", `${runId}.json`), "claude/workflow/completed.json");
  await writeFixture(path.join(sessionRoot, "workflows", "scripts", "private.js"), "claude/workflow/script.js");

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId);
  assert.deepEqual(evidence.workflows, [{
    id: runId,
    name: "fixture-workflow",
    summary: "Implement and verify the fixture",
    status: "completed",
    metadataStatus: "ready",
    startedAt: "2026-08-15T18:00:00.000Z",
    updatedAt: "2026-08-15T18:05:00.000Z",
    durationMs: 300_000,
    agentIds: [`workflow-${runId}-agent-shared`, `workflow-${runId}-agent-reviewer`],
    phases: [
      { id: `${runId}-phase-1`, label: "Implement", agentIds: [`workflow-${runId}-agent-shared`] },
      { id: `${runId}-phase-2`, label: "Review", agentIds: [`workflow-${runId}-agent-reviewer`] },
    ],
  }]);
  const workflowAgents = evidence.agents.filter((agent) => agent.workflowId === runId);
  assert.deepEqual(workflowAgents.map(({ label, workflowPhaseId, workflowOrder, workflowState }) => ({ label, workflowPhaseId, workflowOrder, workflowState })), [
    { label: "review:backend", workflowPhaseId: `${runId}-phase-2`, workflowOrder: 1, workflowState: "error" },
    { label: "impl:backend", workflowPhaseId: `${runId}-phase-1`, workflowOrder: 0, workflowState: "done" },
  ]);
  assert.deepEqual(workflowAgents.map((agent) => agent.status), ["finished", "finished"]);
  assertNoPrivateFixtureSentinels(evidence, "completed Claude workflow evidence");
  assert.doesNotMatch(JSON.stringify(evidence), /totalTokens|totalToolCalls|taskId|scriptPath|promptPreview|resultPreview|journal|PRIVATE_WORKFLOW_TASK_ID/);
});

test("Claude adapter accepts finite epoch-millisecond workflow timestamps", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-epoch-workflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "workflow-epoch";
  const runId = "wf_fixture-epoch";
  const sessionRoot = path.join(projectsRoot, "fixture-project", localId);
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await writeRecords(mainFile, [workflowLaunchRecord(runId)]);
  await writeRecords(
    path.join(sessionRoot, "subagents", "workflows", runId, "agent-epoch-worker.jsonl"),
    workflowWorkerRecords("epoch-worker"),
  );
  await mkdir(path.join(sessionRoot, "workflows"), { recursive: true });
  await writeFile(path.join(sessionRoot, "workflows", `${runId}.json`), JSON.stringify({
    runId,
    status: "completed",
    workflowName: "epoch-workflow",
    startTime: Date.parse("2026-08-15T18:00:00.000Z"),
    timestamp: Date.parse("2026-08-15T18:05:00.000Z"),
    workflowProgress: [{
      type: "workflow_agent",
      agentId: "epoch-worker",
      label: "epoch:worker",
      state: "done",
    }],
  }), "utf8");

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId);
  assert.equal(evidence.workflows[0].startedAt, "2026-08-15T18:00:00.000Z");
  assert.equal(evidence.workflows[0].updatedAt, "2026-08-15T18:05:00.000Z");
  assert.equal(evidence.workflows[0].durationMs, 300_000);
  assert.equal(evidence.workflows[0].metadataStatus, "ready");
});

test("Claude adapter never marks incomplete historical or malformed workflows as running", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-unknown-workflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const registryRoot = path.join(root, "registry");
  const localId = "workflow-unknown";
  const runId = "wf_fixture-1";
  const sessionRoot = path.join(projectsRoot, "fixture-project", localId);
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await mkdir(registryRoot, { recursive: true });
  await writeRecords(mainFile, [
    { type: "user", timestamp: "2026-08-10T18:00:00.000Z", cwd: root, message: { content: "PROMPT_MUST_NOT_LEAK" } },
    workflowLaunchRecord(runId, "2026-08-10T18:00:01.000Z"),
  ]);
  const workerFile = path.join(sessionRoot, "subagents", "workflows", runId, "agent-shared.jsonl");
  await writeRecords(workerFile, workflowWorkerRecords("worker-one", "2026-08-10T18:01:00.000Z"));
  const journalFile = path.join(path.dirname(workerFile), "journal.jsonl");
  await writeRecords(journalFile, [{
    type: "started",
    agentId: "shared",
    key: "WORKFLOW_PATH_MUST_NOT_LEAK",
  }]);
  await mkdir(path.join(sessionRoot, "workflows"), { recursive: true });
  await writeFile(path.join(sessionRoot, "workflows", `${runId}.json`), "{malformed WORKFLOW_SCRIPT_MUST_NOT_LEAK", "utf8");
  await utimes(mainFile, new Date("2026-08-10T18:01:00.000Z"), new Date("2026-08-10T18:01:00.000Z"));
  await utimes(workerFile, new Date("2026-08-10T18:01:00.000Z"), new Date("2026-08-10T18:01:00.000Z"));
  await utimes(journalFile, new Date("2026-08-10T18:01:00.000Z"), new Date("2026-08-10T18:01:00.000Z"));

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot,
    tasksRoot: path.join(root, "tasks"),
    now: () => Date.parse("2026-08-15T18:00:00.000Z"),
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId, { historical: true });
  assert.equal(evidence.historical, true);
  assert.equal(evidence.workflows[0].status, "unknown");
  assert.equal(evidence.workflows[0].metadataStatus, "unavailable");
  assert.equal(evidence.agents.find((agent) => agent.workflowId === runId).workflowState, "unknown");
  assert.deepEqual(evidence.workflows[0].phases, []);
  assertNoPrivateFixtureSentinels(evidence, "unknown historical Claude workflow evidence");
});

test("Claude adapter ignores oversized completion manifests while retaining live worker evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-oversized-workflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "workflow-oversized";
  const runId = "wf_fixture-1";
  const sessionRoot = path.join(projectsRoot, "fixture-project", localId);
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await writeRecords(mainFile, [workflowLaunchRecord(runId)]);
  const workerFile = path.join(sessionRoot, "subagents", "workflows", runId, "agent-shared.jsonl");
  await writeRecords(workerFile, workflowWorkerRecords("worker-one"));
  await mkdir(path.join(sessionRoot, "workflows"), { recursive: true });
  await writeFile(path.join(sessionRoot, "workflows", `${runId}.json`), JSON.stringify({
    runId,
    status: "completed",
    workflowName: "OVERSIZED_NAME_MUST_NOT_APPEAR",
    phases: [{ title: "OVERSIZED_PHASE_MUST_NOT_APPEAR" }],
    script: `WORKFLOW_SCRIPT_MUST_NOT_LEAK${"x".repeat(600 * 1024)}`,
  }), "utf8");
  await utimes(workerFile, new Date("2026-08-15T18:01:30.000Z"), new Date("2026-08-15T18:01:30.000Z"));

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot: path.join(root, "tasks"),
    explicitSession: mainFile,
    now: () => Date.parse("2026-08-15T18:02:00.000Z"),
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId);
  assert.equal(evidence.workflows[0].status, "running");
  assert.equal(evidence.workflows[0].name, "fixture-workflow");
  assert.deepEqual(evidence.workflows[0].phases, []);
  assert.doesNotMatch(JSON.stringify(evidence), /OVERSIZED_|WORKFLOW_SCRIPT_MUST_NOT_LEAK/);
});

test("Claude adapter exposes a resource owner only for a verified live registry owner", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-resource-owner-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const registryRoot = path.join(root, "registry");
  const localId = "owned-session";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const owner = { pid: 4242, procStart: "verified-owner-start" };
  await writeRecords(mainFile, [
    { type: "user", timestamp: "2026-08-14T12:00:00.000Z", cwd: root, message: { content: "PRIVATE_PROMPT_MUST_NOT_LEAK" } },
  ]);
  await mkdir(registryRoot, { recursive: true });
  await writeFile(path.join(registryRoot, `${localId}.json`), JSON.stringify({
    sessionId: localId,
    status: "active",
    updatedAt: Date.parse("2026-08-14T12:00:01.000Z"),
    ...owner,
  }), "utf8");

  const providerOptions = {
    homeDir: root,
    projectsRoot,
    registryRoot,
    tasksRoot: path.join(root, "tasks"),
    usageRequest: async () => { throw new Error("not requested"); },
  };
  const verifiedProvider = createClaudeProvider({
    ...providerOptions,
    registryProcessIdentities: () => new Map([[owner.pid, owner.procStart]]),
  });
  assert.deepEqual((await verifiedProvider.listSessions()).map(({ localId: id, isLive, resourceOwner }) => ({ id, isLive, resourceOwner })), [{
    id: localId,
    isLive: true,
    resourceOwner: { pid: owner.pid, processStartIdentity: owner.procStart },
  }]);

  const unavailableProvider = createClaudeProvider({
    ...providerOptions,
    registryProcessIdentities: () => null,
  });
  const unavailable = (await unavailableProvider.listSessions())[0];
  assert.equal(unavailable.isLive, true);
  assert.equal(unavailable.activityStatus, "working");
  assert.equal(Object.hasOwn(unavailable, "resourceOwner"), false);

  await writeFile(path.join(registryRoot, `${localId}.json`), JSON.stringify({
    sessionId: localId,
    status: "idle",
    updatedAt: Date.parse("2026-08-14T12:00:02.000Z"),
    ...owner,
  }), "utf8");
  const idleProvider = createClaudeProvider({
    ...providerOptions,
    registryProcessIdentities: () => new Map([[owner.pid, owner.procStart]]),
  });
  assert.equal((await idleProvider.listSessions())[0].activityStatus, "open");
});

test("Claude adapter retires a stale registry file whose owner process exited", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-orphaned-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const registryRoot = path.join(root, "registry");
  const localId = "orphaned-session";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const startedAt = "2026-08-10T15:44:00.000Z";
  const updatedAt = "2026-08-10T16:36:00.000Z";
  await writeRecords(mainFile, [
    { type: "user", timestamp: startedAt, cwd: root, message: { content: "PRIVATE_PROMPT_MUST_NOT_LEAK" } },
    { type: "assistant", timestamp: updatedAt, message: { model: "claude-test", content: [] } },
  ]);
  await utimes(mainFile, new Date(updatedAt), new Date(updatedAt));
  await mkdir(registryRoot, { recursive: true });
  await writeFile(path.join(registryRoot, `${localId}.json`), JSON.stringify({
    sessionId: localId,
    status: "idle",
    updatedAt: Date.parse(updatedAt),
    pid: 4242,
    procStart: "owner-that-exited",
  }));

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot,
    tasksRoot: path.join(root, "tasks"),
    registryProcessIdentities: () => new Map(),
    usageRequest: async () => { throw new Error("not requested"); },
  });

  const catalog = await provider.listSessions();
  assert.equal(catalog[0].isLive, false);
  assert.equal(catalog[0].activityStatus, "idle");
  assert.equal(Object.hasOwn(catalog[0], "resourceOwner"), false);
  const evidence = await provider.readSession(localId, { historical: true });
  assert.equal(evidence.historical, true);
  assert.equal(Date.parse(evidence.session.updatedAt) - Date.parse(evidence.session.startedAt), 52 * 60_000);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_PROMPT_MUST_NOT_LEAK|owner-that-exited|4242/);
});

test("Claude adapter reconstructs cleaned-up task stores from successful transcript lifecycle records", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-transcript-tasks-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const tasksRoot = path.join(root, "tasks");
  const localId = "claude-cleaned-tasks";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await mkdir(path.join(tasksRoot, localId), { recursive: true });
  await writeFile(path.join(tasksRoot, localId, ".highwatermark"), "2", "utf8");
  await writeRecords(mainFile, [
    taskCall("create-1", "TaskCreate", {
      subject: "  Build   the safe fallback  ",
      description: "DESCRIPTION_PRIVATE_MUST_NOT_LEAK",
      activeForm: "ACTIVE_FORM_PRIVATE_MUST_NOT_LEAK",
      blockedBy: ["task-0", "bad dependency PRIVATE_MUST_NOT_LEAK"],
    }),
    taskResult("create-1", { task: { id: "1", subject: "Build the safe fallback" } }),
    taskCall("create-2", "TaskCreate", { subject: "Verify cleanup retention" }),
    taskResult("create-2", { task: { id: "2", subject: "Verify cleanup retention" } }),
    taskCall("update-1", "TaskUpdate", {
      taskId: "1",
      status: "completed",
      description: "UPDATED_DESCRIPTION_PRIVATE_MUST_NOT_LEAK",
      addBlocks: ["2", "bad dependency"],
    }),
    taskResult("update-1", {
      success: true,
      taskId: "1",
      updatedFields: ["status", "description", "addBlocks"],
      private: "RESULT_OBJECT_PRIVATE_MUST_NOT_LEAK",
    }),
    taskCall("failed-update", "TaskUpdate", { taskId: "2", status: "completed" }),
    taskResult("failed-update", { success: false, taskId: "2", private: "FAILED_UPDATE_PRIVATE_MUST_NOT_LEAK" }),
    taskCall("unknown-update", "TaskUpdate", { taskId: "2", status: "archived" }),
    taskResult("unknown-update", { success: true, taskId: "2" }),
    taskCall("failed-create", "TaskCreate", { subject: "Failed task must not appear" }),
    taskResult("failed-create", { error: "PRIVATE_FAILURE" }, { is_error: true }),
    taskCall("unmatched-create", "TaskCreate", { subject: "Unmatched task must not appear" }),
    taskCall("unknown-tool", "TaskDelete", { taskId: "1", subject: "Unknown task must not appear" }),
    taskResult("unknown-tool", { success: true, taskId: "1" }),
    taskCall("malformed-create", "TaskCreate", { subject: "Malformed ID must not appear" }),
    taskResult("malformed-create", { task: { id: "../private", subject: "Malformed ID must not appear" } }),
  ]);

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot,
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId);
  assert.deepEqual(evidence.planTasks, [
    { id: "1", subject: "Build the safe fallback", status: "completed", blocks: ["2"], blockedBy: ["task-0"] },
    { id: "2", subject: "Verify cleanup retention", status: "pending", blocks: [], blockedBy: [] },
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_MUST_NOT_LEAK|PRIVATE_FAILURE/);
  assert.doesNotMatch(JSON.stringify(evidence.planTasks), /description|activeForm|updatedFields|private/);
});

test("Claude structured task store remains authoritative over transcript reconstruction", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-task-precedence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const tasksRoot = path.join(root, "tasks");
  const localId = "claude-task-precedence";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  await writeRecords(mainFile, [
    taskCall("create-1", "TaskCreate", { subject: "Transcript fallback" }),
    taskResult("create-1", { task: { id: "1", subject: "Transcript fallback" } }),
  ]);
  await mkdir(path.join(tasksRoot, localId), { recursive: true });
  await writeFile(path.join(tasksRoot, localId, "store-task.json"), JSON.stringify({
    id: "store-task",
    subject: "Structured store wins",
    status: "in_progress",
    blocks: [],
    blockedBy: [],
  }), "utf8");

  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    registryRoot: path.join(root, "registry"),
    tasksRoot,
    explicitSession: mainFile,
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const evidence = await provider.readSession(localId);
  assert.deepEqual(evidence.planTasks, [{
    id: "store-task",
    subject: "Structured store wins",
    status: "in_progress",
    blocks: [],
    blockedBy: [],
  }]);
});

test("provider-neutral monitor contains no Claude roots, credentials, endpoints, or transcript schema checks", async () => {
  const source = await readFile(new URL("../monitor/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CLAUDE_|\.claude|anthropic|oauth|credentials/i);
  assert.doesNotMatch(source, /record\.type|message\?*\.content|tool_use|compact_boundary/);
});
