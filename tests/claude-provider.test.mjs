import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("Claude adapter returns sanitized provider evidence without changing normalized features", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-claude-provider-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-claude-missing-"));
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

test("provider-neutral monitor contains no Claude roots, credentials, endpoints, or transcript schema checks", async () => {
  const source = await readFile(new URL("../monitor/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CLAUDE_|\.claude|anthropic|oauth|credentials/i);
  assert.doesNotMatch(source, /record\.type|message\?*\.content|tool_use|compact_boundary/);
});
