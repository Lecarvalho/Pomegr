import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import {
  assertNoPrivateFixtureSentinels,
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
  assert.deepEqual(catalog.map(({ localId: id, title, isLive, needsInput }) => ({ id, title, isLive, needsInput })), [{
    id: localId,
    title: "Synthetic provider fixture",
    isLive: true,
    needsInput: true,
  }]);

  const evidence = await provider.readSession(localId, { historical: false });
  assert.equal(evidence.localId, localId);
  assert.equal(evidence.historical, false);
  assert.equal(evidence.session.recordedGitBranch, "codex/synthetic-fixture");
  assert.equal(evidence.session.approvalMode.id, "accept_edits");
  assert.equal(evidence.session.contextMachinery.machineryTokens, 1600);
  assert.equal(evidence.session.summary.text, "Synthetic fixture is awaiting review.");
  assert.equal(evidence.session.signal, null);
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
  assert.equal(Object.hasOwn(unavailable, "resourceOwner"), false);
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
