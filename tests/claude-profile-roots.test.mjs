import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeProvider } from "../monitor/providers/claude.mjs";

async function writeRecords(file, records) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

test("Claude adapter keeps discovery, tasks, plugins, and native credentials inside the selected config profile", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-profile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const legacyRoot = path.join(homeDir, ".claude");
  const configRoot = path.join(root, "selected-profile");
  const cwd = path.join(root, "repository");
  const localId = "selected-profile-session";
  const mainFile = path.join(configRoot, "projects", "fixture-project", `${localId}.jsonl`);
  const install = path.join(configRoot, "plugins", "cache", "pomegr", "pomegr", "0.7.0");
  await Promise.all([
    mkdir(path.join(configRoot, "sessions"), { recursive: true }),
    mkdir(path.join(configRoot, "tasks", localId), { recursive: true }),
    mkdir(path.join(configRoot, "plugins"), { recursive: true }),
    mkdir(path.join(install, ".claude-plugin"), { recursive: true }),
  ]);
  await writeRecords(mainFile, [
    { type: "custom-title", customTitle: "Selected profile session", timestamp: "2026-09-08T12:00:00.000Z" },
    { type: "user", timestamp: "2026-09-08T12:00:01.000Z", cwd, message: { content: "SELECTED_PROMPT_MUST_NOT_LEAK" } },
  ]);
  await writeRecords(path.join(legacyRoot, "projects", "legacy-project", "legacy-session.jsonl"), [
    { type: "custom-title", customTitle: "LEGACY_PROFILE_MUST_NOT_LEAK", timestamp: "2026-09-08T12:00:00.000Z" },
  ]);
  await writeFile(path.join(configRoot, "sessions", `${localId}.json`), JSON.stringify({
    sessionId: localId, status: "active", updatedAt: "2026-09-08T12:00:02.000Z",
    entrypoint: "sdk-cli", bridgeSessionId: "session_selectedprofile", pid: 41, procStart: "selected-owner",
  }), "utf8");
  await writeFile(path.join(configRoot, "tasks", localId, "profile-task.json"), JSON.stringify({
    id: "profile-task", subject: "Use selected profile task store", status: "in_progress", blocks: [], blockedBy: [],
  }), "utf8");
  await writeFile(path.join(configRoot, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "SELECTED_PROFILE_TOKEN" } }), "utf8");
  await writeFile(path.join(legacyRoot, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "LEGACY_PROFILE_TOKEN" } }), "utf8");
  await writeFile(path.join(configRoot, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: { "pomegr@pomegr": { scope: "user", version: "0.7.0", installPath: install } },
  }), "utf8");
  await writeFile(path.join(install, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "pomegr", version: "0.7.0" }), "utf8");

  let statusRequests = 0;
  const provider = createClaudeProvider({
    homeDir,
    env: { CLAUDE_CONFIG_DIR: configRoot },
    now: () => Date.parse("2026-09-08T12:01:00.000Z"),
    registryProcessIdentities: () => new Map([[41, "selected-owner"]]),
    fetch: async (_url, request) => {
      statusRequests += 1;
      assert.equal(request.headers.Authorization, "Bearer SELECTED_PROFILE_TOKEN");
      return Response.json({ response_shape: { id: "session_selectedprofile", status: "active", worker_status: "idle" } });
    },
    usageRequest: async () => { throw new Error("not requested"); },
  });

  const catalog = await provider.listSessions();
  assert.deepEqual(catalog.map((session) => session.localId), [localId]);
  assert.equal(catalog[0].isLive, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statusRequests, 1);
  const evidence = await provider.readSession(localId);
  assert.deepEqual(evidence.planTasks, [{ id: "profile-task", subject: "Use selected profile task store", status: "in_progress", blocks: [], blockedBy: [] }]);
  assert.equal((await provider.readRepositoryPluginSetup({ cwd })).version, "0.7.0");
  assert.doesNotMatch(JSON.stringify({ catalog, evidence }), /LEGACY_PROFILE|SELECTED_PROFILE_TOKEN|session_selectedprofile/);
});

test("Claude adapter honors an explicit projects root while retaining the selected config registry and task roots", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-projects-root-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "selected-profile");
  const projectsRoot = path.join(root, "separate-projects");
  const localId = "override-projects-session";
  await Promise.all([
    mkdir(path.join(configRoot, "sessions"), { recursive: true }),
    mkdir(path.join(configRoot, "tasks", localId), { recursive: true }),
  ]);
  await writeRecords(path.join(configRoot, "projects", "default-project", "default-session.jsonl"), [
    { type: "custom-title", customTitle: "DEFAULT_PROJECTS_MUST_NOT_LEAK", timestamp: "2026-09-08T12:00:00.000Z" },
  ]);
  await writeRecords(path.join(projectsRoot, "override-project", `${localId}.jsonl`), [
    { type: "custom-title", customTitle: "Explicit projects root", timestamp: "2026-09-08T12:00:00.000Z" },
  ]);
  await writeFile(path.join(configRoot, "sessions", `${localId}.json`), JSON.stringify({
    sessionId: localId, status: "active", updatedAt: "2026-09-08T12:00:01.000Z",
  }), "utf8");
  await writeFile(path.join(configRoot, "tasks", localId, "task.json"), JSON.stringify({
    id: "task", subject: "Keep config-root task store", status: "completed", blocks: [], blockedBy: [],
  }), "utf8");

  const provider = createClaudeProvider({
    homeDir: path.join(root, "home"),
    env: { CLAUDE_CONFIG_DIR: configRoot, CLAUDE_PROJECTS_DIR: projectsRoot },
    now: () => Date.parse("2026-09-08T12:01:00.000Z"),
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const catalog = await provider.listSessions();
  assert.deepEqual(catalog.map((session) => session.localId), [localId]);
  const evidence = await provider.readSession(localId);
  assert.deepEqual(evidence.planTasks, [{ id: "task", subject: "Keep config-root task store", status: "completed", blocks: [], blockedBy: [] }]);
  assert.doesNotMatch(JSON.stringify({ catalog, evidence }), /DEFAULT_PROJECTS_MUST_NOT_LEAK|selected-profile|separate-projects/);
});
