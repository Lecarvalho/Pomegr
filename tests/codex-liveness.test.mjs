import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_ACTIVE_WINDOW_MS,
  CODEX_BRIDGE_LEASE_MS,
  CODEX_NEEDS_INPUT_MAX_MS,
  CODEX_ROLLOUT_LIVE_WINDOW_MS,
  captureCodexLifecycleHook,
  createCodexLivenessCoordinator,
  parseCodexRolloutLiveness,
  processStartIdentity,
  renewCodexOwnerLease,
} from "../monitor/providers/codex-liveness.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";

const START = Date.parse("2026-08-11T12:00:00.000Z");
const OWNER = { ownerPid: 4242, ownerStartedAt: "owner-start-identity", startWatcher: false };

function thread(localId = "live-root", options = {}) {
  return {
    localId,
    sessionId: options.sessionId || localId,
    parentThreadId: options.parentThreadId || null,
    sourceKind: options.sourceKind || (options.parentThreadId ? "subAgentThreadSpawn" : "cli"),
    updatedAt: options.updatedAt || new Date(START).toISOString(),
    runtimeStatus: options.runtimeStatus || null,
    rolloutFile: options.rolloutFile || null,
  };
}

function hook(root, now, hook_event_name, options = {}) {
  return captureCodexLifecycleHook({
    session_id: options.sessionId || "live-root",
    hook_event_name,
    turn_id: options.turnId || "turn-1",
    agent_id: options.agentId,
    tool_name: options.toolName,
    prompt: "PROMPT_MUST_NOT_LEAK",
    tool_input: { command: "COMMAND_MUST_NOT_LEAK", question: "QUESTION_MUST_NOT_LEAK" },
    tool_response: "TOOL_OUTPUT_MUST_NOT_LEAK",
  }, { root, now, ...OWNER });
}

async function serializedFiles(root) {
  const contents = [];
  for (const directory of ["snapshots", "leases"]) {
    let files = [];
    try { files = await readdir(path.join(root, directory)); } catch { /* optional */ }
    for (const file of files) contents.push(await readFile(path.join(root, directory, file), "utf8"));
  }
  return contents.join("\n");
}

test("lifecycle bridge deterministically starts, waits, answers, idles, and closes without private hook fields", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-bridge-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = START;
  const coordinator = createCodexLivenessCoordinator({ root, now: () => now, cacheMs: 0 });
  const threads = [thread()];

  hook(root, now, "SessionStart");
  let observed = coordinator.observe(threads);
  assert.deepEqual(observed.sessions.get("live-root"), {
    isLive: true,
    needsInput: false,
    observedAt: new Date(now).toISOString(),
  });
  assert.equal(observed.threads[0].liveStatus, "idle");

  now += 1_000;
  hook(root, now, "UserPromptSubmit");
  assert.equal(coordinator.observe(threads).threads[0].liveStatus, "active");

  now += 1_000;
  hook(root, now, "PreToolUse", { toolName: "request_user_input" });
  observed = coordinator.observe(threads);
  assert.equal(observed.sessions.get("live-root").needsInput, true);
  assert.equal(observed.threads[0].liveStatus, "needs_input");

  now += 1_000;
  hook(root, now, "PostToolUse", { toolName: "request_user_input" });
  assert.equal(coordinator.observe(threads).threads[0].liveStatus, "active");

  now += 1_000;
  hook(root, now, "Stop");
  assert.equal(coordinator.observe(threads).threads[0].liveStatus, "idle");

  now += 1_000;
  hook(root, now, "SessionEnd");
  observed = coordinator.observe(threads);
  assert.equal(observed.sessions.get("live-root").isLive, false);
  assert.equal(observed.threads[0].suppressFallbackLive, true);

  assert.doesNotMatch(
    await serializedFiles(root),
    /PROMPT_MUST_NOT_LEAK|COMMAND_MUST_NOT_LEAK|QUESTION_MUST_NOT_LEAK|TOOL_OUTPUT_MUST_NOT_LEAK|tool_input|tool_response|prompt/,
  );
});

test("bridge lease and needs-input expiry clear stale state deterministically", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-expiry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = START;
  hook(root, now, "PermissionRequest");
  const threads = [thread()];
  const coordinator = createCodexLivenessCoordinator({ root, now: () => now, cacheMs: 0 });
  assert.equal(coordinator.observe(threads).sessions.get("live-root").needsInput, true);

  now += CODEX_BRIDGE_LEASE_MS - 1;
  assert.equal(coordinator.observe(threads).sessions.get("live-root").isLive, true);
  now += 2;
  assert.equal(coordinator.observe(threads).sessions.get("live-root").isLive, true, "first failed lease poll receives shutdown grace");
  assert.equal(coordinator.observe(threads).sessions.get("live-root").isLive, false, "second failed lease poll clears liveness");

  now = START;
  hook(root, now, "PermissionRequest");
  now += CODEX_NEEDS_INPUT_MAX_MS + 1;
  assert.equal(renewCodexOwnerLease({
    root,
    now,
    ownerPid: OWNER.ownerPid,
    ownerStartedAt: OWNER.ownerStartedAt,
    bridgeInstance: JSON.parse((await serializedFiles(root)).split("\n").find((line) => line.includes("bridgeInstance"))).bridgeInstance,
    processStartIdentity: () => OWNER.ownerStartedAt,
  }), true);
  const freshCoordinator = createCodexLivenessCoordinator({ root, now: () => now, cacheMs: 0 });
  const expiredPrompt = freshCoordinator.observe(threads);
  assert.equal(expiredPrompt.sessions.get("live-root").isLive, true);
  assert.equal(expiredPrompt.sessions.get("live-root").needsInput, false);
  assert.equal(expiredPrompt.threads[0].liveStatus, "idle");
});

test("owning app-server status outranks bridge state and maps waiting and system errors", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-priority-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  hook(root, START, "Stop");
  const coordinator = createCodexLivenessCoordinator({ root, now: () => START, cacheMs: 0 });
  const waiting = coordinator.observe([thread("live-root", {
    runtimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
  })]);
  assert.equal(waiting.threads[0].liveStatus, "needs_input");
  assert.equal(waiting.threads[0].liveness.source, "owning_app_server");

  const failed = coordinator.observe([thread("live-root", { runtimeStatus: { type: "systemError" } })]);
  assert.equal(failed.threads[0].liveStatus, "stopped");
  assert.equal(failed.sessions.get("live-root").isLive, true);
});

test("one owner lease supports concurrent sessions while a stopped subagent becomes finished", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-concurrent-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = START;
  hook(root, now, "SessionStart", { sessionId: "session-a" });
  hook(root, now, "SessionStart", { sessionId: "session-b" });
  hook(root, now, "SubagentStart", { sessionId: "session-b", agentId: "child-b" });
  now += 1_000;
  hook(root, now, "SubagentStop", { sessionId: "session-b", agentId: "child-b" });
  hook(root, now, "SessionEnd", { sessionId: "session-a" });
  const coordinator = createCodexLivenessCoordinator({ root, now: () => now, cacheMs: 0 });
  const observed = coordinator.observe([
    thread("session-a"),
    thread("session-b"),
    thread("child-b", { sessionId: "session-b", parentThreadId: "session-b" }),
  ]);
  assert.equal(observed.sessions.get("session-a").isLive, false);
  assert.equal(observed.sessions.get("session-b").isLive, true);
  assert.equal(observed.threads.find((item) => item.localId === "child-b").liveStatus, "finished");
  assert.equal((await readdir(path.join(root, "leases"))).length, 1);
});

test("bounded rollout heuristic transitions active, idle, needs-input, answered, and stale", () => {
  const record = (offset, type, payload = {}) => ({ timestamp: new Date(START + offset).toISOString(), type, payload });
  const progress = [record(0, "session_meta", { id: "live-root" }), record(1_000, "turn_context", {})];
  assert.equal(parseCodexRolloutLiveness(progress, { now: START + 1_000 + CODEX_ACTIVE_WINDOW_MS }).status, "active");
  assert.equal(parseCodexRolloutLiveness(progress, { now: START + 1_001 + CODEX_ACTIVE_WINDOW_MS }).status, "idle");

  const waiting = [...progress, record(2_000, "response_item", {
    type: "function_call",
    name: "request_user_input",
    call_id: "request-1",
    arguments: "QUESTION_MUST_NOT_LEAK",
  })];
  assert.equal(parseCodexRolloutLiveness(waiting, { now: START + 3_000 }).status, "needs_input");
  const answered = [...waiting, record(4_000, "response_item", {
    type: "function_call_output",
    call_id: "request-1",
    output: "ANSWER_MUST_NOT_LEAK",
  })];
  assert.equal(parseCodexRolloutLiveness(answered, { now: START + 5_000 }).status, "active");
  assert.equal(parseCodexRolloutLiveness(answered, { now: START + 4_000 + CODEX_ROLLOUT_LIVE_WINDOW_MS + 1 }), null);

  const interrupted = [...progress, record(5_000, "turn_completed", { status: "interrupted" })];
  assert.equal(parseCodexRolloutLiveness(interrupted, { now: START + 6_000 }).status, "stopped");
  const systemError = [...progress, record(5_000, "turn_completed", { status: "failed" })];
  assert.equal(parseCodexRolloutLiveness(systemError, { now: START + 6_000 }).status, "stopped");
});

test("liveness scans one recent pending rollout while skipping five hundred provably stale rollouts", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-window-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const recentFile = path.join(root, "rollout-recent-pending.jsonl");
  await writeFile(recentFile, [
    JSON.stringify({ timestamp: new Date(START).toISOString(), type: "session_meta", payload: { id: "recent-pending" } }),
    JSON.stringify({
      timestamp: new Date(START + 1_000).toISOString(),
      type: "response_item",
      payload: { type: "function_call", name: "request_user_input", call_id: "pending-input" },
    }),
  ].join("\n"), "utf8");
  const staleUpdatedAt = new Date(START - CODEX_ROLLOUT_LIVE_WINDOW_MS - 1).toISOString();
  const stale = await Promise.all(Array.from({ length: 500 }, async (_, index) => {
    const rolloutFile = path.join(root, `rollout-stale-${index}.jsonl`);
    await writeFile(rolloutFile, JSON.stringify({
      timestamp: staleUpdatedAt,
      type: "session_meta",
      payload: { id: `stale-${index}` },
    }), "utf8");
    return thread(`stale-${index}`, { updatedAt: staleUpdatedAt, rolloutFile });
  }));
  const coordinator = createCodexLivenessCoordinator({
    root: path.join(root, "liveness"),
    now: () => START + 2_000,
    cacheMs: 0,
  });
  const observed = coordinator.observe([
    ...stale,
    thread("recent-pending", { updatedAt: new Date(START + 1_000).toISOString(), rolloutFile: recentFile }),
  ]);
  assert.equal(coordinator.stats().rolloutFiles, 1);
  assert.equal(observed.sessions.get("recent-pending").needsInput, true);
});

test("authoritative app-server and lifecycle bridge state avoid rollout tail reads", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-authoritative-live-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout-unused.jsonl");
  await writeFile(rolloutFile, JSON.stringify({
    timestamp: new Date(START).toISOString(),
    type: "session_meta",
    payload: { id: "unused" },
  }), "utf8");
  const livenessRoot = path.join(root, "liveness");
  hook(livenessRoot, START, "PermissionRequest", { sessionId: "bridge-root" });
  const coordinator = createCodexLivenessCoordinator({
    root: livenessRoot,
    now: () => START + 1_000,
    cacheMs: 0,
  });
  const observed = coordinator.observe([
    thread("app-root", { runtimeStatus: { type: "idle" }, rolloutFile }),
    thread("bridge-root", { rolloutFile }),
  ]);
  assert.equal(coordinator.stats().rolloutFiles, 0);
  assert.equal(observed.threads.find((item) => item.localId === "app-root").liveness.source, "owning_app_server");
  assert.equal(observed.threads.find((item) => item.localId === "bridge-root").liveness.source, "lifecycle_bridge");
});

test("future-dated rollout metadata is scanned and record timestamps decide liveness", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-clock-skew-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout-future.jsonl");
  const future = new Date(START + 60_000).toISOString();
  await writeFile(rolloutFile, JSON.stringify({
    timestamp: future,
    type: "session_meta",
    payload: { id: "future-root" },
  }), "utf8");
  const coordinator = createCodexLivenessCoordinator({
    root: path.join(root, "liveness"),
    now: () => START,
    cacheMs: 0,
  });
  const observed = coordinator.observe([thread("future-root", { updatedAt: future, rolloutFile })]);
  assert.equal(coordinator.stats().rolloutFiles, 1);
  assert.equal(observed.sessions.get("future-root").isLive, false);
});

test("Windows owner identity binds a lease to process creation time", { skip: process.platform !== "win32" }, () => {
  assert.match(processStartIdentity(process.pid), /^\d{4}-\d{2}-\d{2}T/);
});

test("the inert hook command accepts Windows lifecycle JSON and persists only its allowlist", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-hook-command-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.resolve("scripts/codex-lifecycle-bridge.mjs")], {
    input: JSON.stringify({
      session_id: "command-smoke",
      hook_event_name: "SessionEnd",
      reason: "PRIVATE_REASON_MUST_NOT_LEAK",
      cwd: "PRIVATE_PATH_MUST_NOT_LEAK",
      transcript_path: "PRIVATE_TRANSCRIPT_MUST_NOT_LEAK",
    }),
    encoding: "utf8",
    env: { ...process.env, THREADLIGHT_CODEX_LIVENESS_DIR: root },
    windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "{}\n");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(await serializedFiles(root), /PRIVATE_|reason|cwd|transcript/i);
});

test("archived threads never become live from current app-server or rollout evidence", () => {
  const coordinator = createCodexLivenessCoordinator({ root: path.join(os.tmpdir(), "missing-threadlight-liveness"), now: () => START, cacheMs: 0 });
  const archived = coordinator.observe([{ ...thread("archived-root", { runtimeStatus: { type: "active", activeFlags: [] } }), archived: true }]);
  assert.equal(archived.sessions.get("archived-root").isLive, false);
  assert.equal(archived.threads[0].liveness, null);
});

function appThread(id, options = {}) {
  return {
    id,
    sessionId: options.sessionId || id,
    parentThreadId: options.parentThreadId || null,
    ephemeral: false,
    createdAt: START / 1_000,
    updatedAt: (START + 1_000) / 1_000,
    source: options.source || "cli",
    cwd: "C:\\synthetic\\repo",
    name: options.name || "Live fixture",
    status: options.status || { type: "idle" },
    turns: [],
  };
}

test("active descendants keep the session live and propagate waiting through the agent tree", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-tree-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const primary = appThread("app-root");
  const child = appThread("app-child", {
    sessionId: "app-root",
    parentThreadId: "app-root",
    source: { subAgent: { thread_spawn: { parent_thread_id: "app-root" } } },
    status: { type: "active", activeFlags: [] },
  });
  const appServer = {
    async listThreads() { return { data: [primary, child] }; },
    async readThread({ threadId, includeTurns }) {
      const value = threadId === "app-root" ? primary : child;
      return { thread: { ...value, ...(includeTurns ? { turns: [] } : {}) } };
    },
  };
  const provider = createCodexProvider({ codexHome: root, livenessRoot: path.join(root, "liveness"), appServer, includeArchived: false, cacheMs: 0, now: () => START + 2_000 });
  const catalog = await provider.listSessions();
  assert.deepEqual(catalog.map(({ localId, isLive, needsInput }) => ({ localId, isLive, needsInput })), [
    { localId: "app-root", isLive: true, needsInput: false },
  ]);
  const evidence = await provider.readSession("app-root", { historical: false });
  assert.equal(evidence.historical, false);
  assert.equal(evidence.agents.find((agent) => agent.id === "primary").status, "waiting");
  assert.equal(evidence.agents.find((agent) => agent.id === "agent-app-child").status, "active");
});

test("historical reads discard current app-server liveness", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-history-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const active = appThread("history-root", { status: { type: "active", activeFlags: ["waitingOnUserInput"] } });
  const appServer = {
    async listThreads() { return { data: [active] }; },
    async readThread() { return { thread: active }; },
  };
  const provider = createCodexProvider({ codexHome: root, livenessRoot: path.join(root, "liveness"), appServer, includeArchived: false, cacheMs: 0, now: () => START + 2_000 });
  const evidence = await provider.readSession("history-root", { historical: true });
  assert.equal(evidence.historical, true);
  assert.equal(evidence.agents[0].status, "idle");
  assert.equal(evidence.agents[0].liveness, null);
});

test("automatic selection stops preferring an expired needs-input bridge and rollout polling stays bounded and cached", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-bounds-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(sessions, { recursive: true });
  const rolloutFiles = [];
  for (let index = 0; index < 4; index += 1) {
    const file = path.join(sessions, `rollout-session-${index}.jsonl`);
    const lines = [JSON.stringify({
      timestamp: new Date(START).toISOString(),
      type: "session_meta",
      payload: { id: `session-${index}`, cwd: "C:\\synthetic\\repo", source: "cli" },
    })];
    for (let line = 0; line < 300; line += 1) lines.push(JSON.stringify({
      timestamp: new Date(START + 1_000).toISOString(),
      type: "turn_context",
      payload: { padding: "x".repeat(100) },
    }));
    await writeFile(file, `${lines.join("\n")}\n{`, "utf8");
    rolloutFiles.push(file);
  }
  let now = START + 2_000;
  const coordinator = createCodexLivenessCoordinator({ root: path.join(root, "liveness"), now: () => now, cacheMs: 0, maximumTailBytes: 4_096 });
  const threads = rolloutFiles.map((rolloutFile, index) => thread(`session-${index}`, { rolloutFile }));
  coordinator.observe(threads);
  const first = coordinator.stats();
  assert.equal(first.rolloutFiles, 4);
  assert.equal(first.rolloutBytes <= 4 * 4_096, true);
  coordinator.observe([...threads]);
  const second = coordinator.stats();
  assert.equal(second.rolloutFiles, 0);
  assert.equal(second.cachedRollouts, 4);

  hook(path.join(root, "liveness"), now, "PermissionRequest", { sessionId: "session-0" });
  const provider = createCodexProvider({ codexHome: root, livenessRoot: path.join(root, "liveness"), cacheMs: 0, now: () => now, maximumTailBytes: 4_096 });
  const registry = createProviderRegistry([provider]);
  assert.equal((await registry.readSession()).sessionId, "codex:session-0");
  now += CODEX_ROLLOUT_LIVE_WINDOW_MS + 1;
  await provider.listSessions();
  for (let poll = 0; poll < 3; poll += 1) {
    now += 15_000;
    await provider.listSessions();
  }
  const catalog = await registry.listSessions();
  assert.equal(catalog.find((item) => item.id === "codex:session-0").needsInput, false);
});
