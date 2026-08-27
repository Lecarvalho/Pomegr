import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_ACTIVE_WINDOW_MS,
  CODEX_BRIDGE_LEASE_MS,
  CODEX_NEEDS_INPUT_MAX_MS,
  CODEX_ROLLOUT_APPROVAL_GRACE_MS,
  CODEX_ROLLOUT_LIVE_WINDOW_MS,
  captureCodexLifecycleHook,
  createCodexLivenessCoordinator,
  isActiveCodexWriterLock,
  parseCodexRolloutLiveness,
  processStartIdentity,
  renewCodexOwnerLease,
} from "../monitor/providers/codex-liveness.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";

const START = Date.parse("2026-08-11T12:00:00.000Z");
const OWNER = { ownerPid: 4242, ownerStartedAt: "134000000000000000", startWatcher: false };

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
  }, { root, now, ...(options.owner || OWNER) });
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-bridge-"));
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
    resourceOwner: {
      pid: OWNER.ownerPid,
      processStartIdentity: OWNER.ownerStartedAt,
    },
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-expiry-"));
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
  assert.equal(coordinator.observe(threads).sessions.get("live-root").resourceOwner, null, "stale bridge grace never preserves resource ownership");
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-priority-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  hook(root, START, "Stop");
  const coordinator = createCodexLivenessCoordinator({ root, now: () => START, cacheMs: 0 });
  const waiting = coordinator.observe([thread("live-root", {
    runtimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
  })]);
  assert.equal(waiting.threads[0].liveStatus, "needs_input");
  assert.equal(waiting.threads[0].liveness.source, "owning_app_server");
  assert.deepEqual(waiting.sessions.get("live-root").resourceOwner, {
    pid: OWNER.ownerPid,
    processStartIdentity: OWNER.ownerStartedAt,
  });

  const appOnly = createCodexLivenessCoordinator({
    root: path.join(root, "missing-app-only-bridge"),
    now: () => START,
    cacheMs: 0,
  }).observe([thread("app-only", { runtimeStatus: { type: "idle" } })]);
  assert.equal(appOnly.sessions.get("app-only").resourceOwner, null);

  const failed = coordinator.observe([thread("live-root", { runtimeStatus: { type: "systemError" } })]);
  assert.equal(failed.threads[0].liveStatus, "stopped");
  assert.equal(failed.sessions.get("live-root").isLive, true);
});

test("one owner lease supports concurrent sessions while a stopped subagent becomes finished", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-concurrent-"));
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
  const waitingStatus = parseCodexRolloutLiveness(waiting, { now: START + 3_000 });
  assert.equal(waitingStatus.status, "needs_input");
  assert.equal(waitingStatus.needsInputKind, "user_input");
  const answered = [...waiting, record(4_000, "response_item", {
    type: "function_call_output",
    call_id: "request-1",
    output: "ANSWER_MUST_NOT_LEAK",
  })];
  assert.equal(parseCodexRolloutLiveness(answered, { now: START + 5_000 }).status, "active");
  assert.equal(parseCodexRolloutLiveness(answered, { now: START + 4_000 + CODEX_ROLLOUT_LIVE_WINDOW_MS + 1 }), null);

  const directPatch = [...progress, record(6_000, "response_item", {
    type: "custom_tool_call",
    name: "apply_patch",
    call_id: "patch-1",
    input: "PRIVATE_PATCH_MUST_NOT_LEAK",
  })];
  assert.equal(parseCodexRolloutLiveness(directPatch, {
    now: START + 6_000 + CODEX_ROLLOUT_APPROVAL_GRACE_MS - 1,
  }).status, "active");
  const pendingPatch = parseCodexRolloutLiveness(directPatch, {
    now: START + 6_000 + CODEX_ROLLOUT_APPROVAL_GRACE_MS,
  });
  assert.equal(pendingPatch.status, "needs_input");
  assert.equal(pendingPatch.needsInputKind, "pending_file_edit");
  assert.doesNotMatch(JSON.stringify(pendingPatch), /PRIVATE_PATCH_MUST_NOT_LEAK/);
  assert.equal(parseCodexRolloutLiveness(directPatch, {
    now: START + 6_000 + CODEX_ROLLOUT_LIVE_WINDOW_MS + 1,
  }).status, "needs_input");
  const patched = [...directPatch, record(7_000, "response_item", {
    type: "custom_tool_call_output",
    call_id: "patch-1",
    output: "PATCH_OUTPUT_MUST_NOT_LEAK",
  })];
  const completedPatch = parseCodexRolloutLiveness(patched, { now: START + 8_000 });
  assert.equal(completedPatch.status, "active");
  assert.doesNotMatch(JSON.stringify(completedPatch), /PRIVATE_PATCH_MUST_NOT_LEAK|PATCH_OUTPUT_MUST_NOT_LEAK/);
  const interruptedPatch = [...directPatch, record(7_000, "turn_completed", { status: "interrupted" })];
  assert.equal(parseCodexRolloutLiveness(interruptedPatch, { now: START + 8_000 }).status, "stopped");
  const supersededPatch = [
    ...directPatch,
    record(7_000, "turn_context", {}),
    record(7_001, "response_item", { type: "message", role: "user", content: [] }),
  ];
  assert.equal(parseCodexRolloutLiveness(supersededPatch, { now: START + 8_000 }).status, "active");

  const wrappedPatch = [...progress, record(9_000, "response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "wrapped-patch-1",
    input: "const result = await tools.apply_patch(\"PRIVATE_PATCH_MUST_NOT_LEAK\");",
  })];
  assert.equal(parseCodexRolloutLiveness(wrappedPatch, {
    now: START + 9_000 + CODEX_ROLLOUT_APPROVAL_GRACE_MS,
  }).status, "needs_input");
  const ordinaryExec = [...progress, record(10_000, "response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: "ordinary-exec-1",
    input: "await tools.exec_command({ cmd: 'PRIVATE_COMMAND_MUST_NOT_LEAK' });",
  })];
  assert.equal(parseCodexRolloutLiveness(ordinaryExec, {
    now: START + 10_000 + CODEX_ROLLOUT_APPROVAL_GRACE_MS,
  }).status, "active");

  const interrupted = [...progress, record(5_000, "turn_completed", { status: "interrupted" })];
  assert.equal(parseCodexRolloutLiveness(interrupted, { now: START + 6_000 }).status, "stopped");
  const systemError = [...progress, record(5_000, "turn_completed", { status: "failed" })];
  assert.equal(parseCodexRolloutLiveness(systemError, { now: START + 6_000 }).status, "stopped");
});

test("wrapped and Plan-mode final answers need confirmation until the user responds or the wait expires", () => {
  const record = (offset, type, payload = {}) => ({ timestamp: new Date(START + offset).toISOString(), type, payload });
  const wrappedPlan = [
    record(1_000, "response_item", {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "PREFACE_MUST_NOT_LEAK\n<proposed_plan>PROPOSED_PLAN_MUST_NOT_LEAK</proposed_plan>" }],
    }),
    record(1_001, "event_msg", { type: "task_complete" }),
  ];
  const waiting = parseCodexRolloutLiveness(wrappedPlan, { now: START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 1 });
  assert.equal(waiting.status, "needs_input");
  assert.equal(waiting.needsInput, true);

  const revisedPlan = [
    ...wrappedPlan,
    record(2_000, "turn_context", { collaboration_mode: { mode: "plan" } }),
    record(2_001, "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "REVISION_REQUEST_MUST_NOT_LEAK" }],
    }),
    record(3_000, "response_item", {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "PLAIN_PLAN_RESPONSE_MUST_NOT_LEAK" }],
    }),
    record(3_001, "event_msg", { type: "task_complete" }),
  ];
  assert.equal(parseCodexRolloutLiveness(revisedPlan, { now: START + 4_000 }).needsInput, true);

  const answered = [
    ...revisedPlan,
    record(4_000, "turn_context", { collaboration_mode: { mode: "default" } }),
    record(4_001, "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "ANSWER_MUST_NOT_LEAK" }],
    }),
  ];
  assert.equal(parseCodexRolloutLiveness(answered, { now: START + 5_000 }).needsInput, false);
  assert.equal(parseCodexRolloutLiveness(wrappedPlan, { now: START + 1_000 + CODEX_NEEDS_INPUT_MAX_MS + 1 }), null);

  const ordinaryFinal = [
    record(0, "turn_context", { collaboration_mode: { mode: "default" } }),
    record(1_000, "response_item", {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "ORDINARY_RESPONSE_MUST_NOT_LEAK" }],
    }),
  ];
  assert.equal(parseCodexRolloutLiveness(ordinaryFinal, { now: START + 2_000 }).needsInput, false);
});

test("proposed plan confirmation supplements an idle app-server status", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-plan-confirmation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout-plan.jsonl");
  await writeFile(rolloutFile, [
    JSON.stringify({
      timestamp: new Date(START).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "<proposed_plan>PRIVATE_PLAN_MUST_NOT_LEAK</proposed_plan>" }],
      },
    }),
    JSON.stringify({ timestamp: new Date(START + 1).toISOString(), type: "event_msg", payload: { type: "task_complete" } }),
  ].join("\n"), "utf8");
  const coordinator = createCodexLivenessCoordinator({
    root: path.join(root, "liveness"),
    now: () => START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 1,
    cacheMs: 0,
  });
  const observed = coordinator.observe([thread("plan-root", {
    runtimeStatus: { type: "idle" },
    rolloutFile,
  })]);
  assert.equal(observed.sessions.get("plan-root").needsInput, true);
  assert.equal(observed.threads[0].liveStatus, "needs_input");
  assert.equal(observed.threads[0].liveness.source, "rollout_activity_heuristic");

  const expired = createCodexLivenessCoordinator({
    root: path.join(root, "expired-liveness"),
    now: () => START + CODEX_NEEDS_INPUT_MAX_MS + 1,
    cacheMs: 0,
  });
  const stale = expired.observe([thread("plan-root", {
    runtimeStatus: { type: "idle" },
    rolloutFile,
  })]);
  assert.equal(stale.sessions.get("plan-root").needsInput, false);
  assert.equal(stale.threads[0].liveStatus, "idle");
  assert.equal(expired.stats().rolloutFiles, 0);
});

test("pending file edits never create rollout-only needs-input for Codex Desktop", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-app-idle-edit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout-pending-edit.jsonl");
  const now = START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 10_000;
  await writeFile(rolloutFile, [
    JSON.stringify({ timestamp: new Date(START - 1).toISOString(), type: "turn_context", payload: {} }),
    JSON.stringify({
      timestamp: new Date(now - CODEX_ROLLOUT_APPROVAL_GRACE_MS).toISOString(),
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "pending-app-patch",
        input: "const result = await tools.apply_patch(\"PRIVATE_PATCH_MUST_NOT_LEAK\");",
      },
    }),
  ].join("\n"), "utf8");
  const staleTime = new Date(START - CODEX_ROLLOUT_LIVE_WINDOW_MS - 1);
  await utimes(rolloutFile, staleTime, staleTime);

  const appObserved = createCodexLivenessCoordinator({
    root: path.join(root, "app-liveness"),
    now: () => now,
    cacheMs: 0,
  }).observe([thread("app-edit", {
    sourceKind: "vscode",
    runtimeStatus: { type: "idle" },
    rolloutFile,
  })]);
  assert.equal(appObserved.sessions.get("app-edit").needsInput, false);
  assert.equal(appObserved.threads[0].liveStatus, "idle");
  assert.equal(appObserved.threads[0].liveness.source, "owning_app_server");

  const coldObserved = createCodexLivenessCoordinator({
    root: path.join(root, "cold-liveness"),
    now: () => now,
    cacheMs: 0,
  }).observe([thread("cold-edit", {
    sourceKind: "vscode",
    updatedAt: staleTime.toISOString(),
    rolloutFile,
  })]);
  assert.equal(coldObserved.sessions.get("cold-edit").isLive, true);
  assert.equal(coldObserved.sessions.get("cold-edit").needsInput, false);
  assert.equal(coldObserved.threads[0].liveStatus, "active");
  assert.equal(coldObserved.threads[0].liveness.source, "rollout_activity_heuristic");

  const descendantObserved = createCodexLivenessCoordinator({
    root: path.join(root, "descendant-liveness"),
    now: () => now,
    cacheMs: 0,
  }).observe([
    thread("desktop-root", {
      sourceKind: "vscode",
      updatedAt: staleTime.toISOString(),
    }),
    thread("desktop-child", {
      sessionId: "desktop-root",
      parentThreadId: "desktop-root",
      sourceKind: "subAgentThreadSpawn",
      updatedAt: new Date(now).toISOString(),
      rolloutFile,
    }),
  ]);
  assert.equal(descendantObserved.sessions.get("desktop-root").isLive, true);
  assert.equal(descendantObserved.sessions.get("desktop-root").needsInput, false);
  assert.equal(descendantObserved.threads[1].liveStatus, "active");

  await appendFile(rolloutFile, `\n${JSON.stringify({
    timestamp: new Date(now - 1_000).toISOString(),
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input",
      call_id: "explicit-app-input",
      arguments: "PRIVATE_QUESTION_MUST_NOT_LEAK",
    },
  })}\n`, "utf8");
  const explicitObserved = createCodexLivenessCoordinator({
    root: path.join(root, "explicit-liveness"),
    now: () => now,
    cacheMs: 0,
  }).observe([thread("explicit-input", {
    sourceKind: "vscode",
    runtimeStatus: { type: "idle" },
    rolloutFile,
  })]);
  assert.equal(explicitObserved.sessions.get("explicit-input").needsInput, true);
  assert.equal(explicitObserved.threads[0].liveStatus, "needs_input");
  assert.equal(explicitObserved.threads[0].liveness.source, "rollout_activity_heuristic");
});

test("a growing rollout stays live when Windows reports a stale modification time", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-stale-mtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout-growing.jsonl");
  await writeFile(rolloutFile, [
    JSON.stringify({ timestamp: new Date(START).toISOString(), type: "session_meta", payload: { id: "growing-root" } }),
    JSON.stringify({ timestamp: new Date(START + 1_000).toISOString(), type: "turn_context", payload: {} }),
  ].join("\n"), "utf8");

  let now = START + 1_000;
  const coordinator = createCodexLivenessCoordinator({ root, cacheMs: 0, now: () => now });
  const initialThread = thread("growing-root", {
    rolloutFile,
    updatedAt: new Date(START + 1_000).toISOString(),
  });
  assert.equal(coordinator.observe([initialThread]).sessions.get("growing-root").isLive, true);

  now = START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 10_000;
  await appendFile(rolloutFile, `\n${JSON.stringify({
    timestamp: new Date(now).toISOString(),
    type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", call_id: "fresh-exec", input: "PRIVATE_INPUT_MUST_NOT_LEAK" },
  })}\n`, "utf8");
  const staleTime = new Date(START);
  await utimes(rolloutFile, staleTime, staleTime);

  const observed = coordinator.observe([thread("growing-root", {
    rolloutFile,
    updatedAt: staleTime.toISOString(),
  })]);
  assert.equal(observed.sessions.get("growing-root").isLive, true);
  assert.equal(observed.sessions.get("growing-root").resourceOwner, null);
  assert.equal(observed.threads[0].liveStatus, "active");
  assert.equal(observed.threads[0].liveness.observedAt, new Date(now).toISOString());
});

test("cold Codex Desktop discovery reads a bounded stale-mtime rollout whose records are current", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-cold-desktop-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout-cold-plan.jsonl");
  const now = START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 10_000;
  await writeFile(rolloutFile, [
    JSON.stringify({ timestamp: new Date(now - 1_000).toISOString(), type: "turn_context", payload: { collaboration_mode: { mode: "plan" } } }),
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "COLD_PLAN_MUST_NOT_LEAK" }],
      },
    }),
  ].join("\n"), "utf8");
  const staleTime = new Date(START - CODEX_ROLLOUT_LIVE_WINDOW_MS - 1);
  await utimes(rolloutFile, staleTime, staleTime);

  const coordinator = createCodexLivenessCoordinator({
    root: path.join(root, "liveness"),
    now: () => now,
    cacheMs: 0,
  });
  const observed = coordinator.observe([thread("cold-desktop", {
    sourceKind: "vscode",
    updatedAt: staleTime.toISOString(),
    rolloutFile,
  })]);
  assert.equal(coordinator.stats().rolloutFiles, 1);
  assert.equal(observed.sessions.get("cold-desktop").needsInput, true);
  assert.equal(observed.threads[0].liveStatus, "needs_input");
});

test("cold Codex CLI discovery requires an actively held writer lock for stale approval metadata", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-cold-cli-approval-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout-cold-cli-approval.jsonl");
  const now = START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 10_000;
  await writeFile(rolloutFile, [
    JSON.stringify({ timestamp: new Date(START).toISOString(), type: "turn_context", payload: {} }),
    JSON.stringify({
      timestamp: new Date(now - CODEX_ROLLOUT_APPROVAL_GRACE_MS).toISOString(),
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "pending-cli-patch",
        input: "const result = await tools.apply_patch(\"PRIVATE_PATCH_MUST_NOT_LEAK\");",
      },
    }),
  ].join("\n"), "utf8");
  const staleTime = new Date(START - CODEX_ROLLOUT_LIVE_WINDOW_MS - 1);
  await utimes(rolloutFile, staleTime, staleTime);
  const writerLocksRoot = path.join(root, "thread-writer-locks");
  await mkdir(writerLocksRoot, { recursive: true });
  const writerLock = path.join(writerLocksRoot, "cold-cli.lock");
  await writeFile(writerLock, "", "utf8");

  const unlocked = createCodexLivenessCoordinator({
    root: path.join(root, "liveness"),
    writerLocksRoot,
    now: () => now,
    cacheMs: 0,
  });
  const stale = unlocked.observe([thread("cold-cli", {
    sourceKind: "cli",
    updatedAt: staleTime.toISOString(),
    rolloutFile,
  })]);
  assert.equal(unlocked.stats().rolloutFiles, 0);
  assert.equal(stale.sessions.get("cold-cli").needsInput, false);
  assert.equal(isActiveCodexWriterLock(writerLock, { platform: "win32" }), false);

  const activeLock = (file) => isActiveCodexWriterLock(file, {
    platform: "win32",
    statFileSync: () => ({ isFile: () => true }),
    openFileSync: () => {
      const error = new Error("synthetic Windows sharing violation");
      error.code = "EPERM";
      throw error;
    },
  });
  assert.equal(activeLock(writerLock), true);
  const coordinator = createCodexLivenessCoordinator({
    root: path.join(root, "active-liveness"),
    writerLocksRoot,
    writerLockIsActive: (file) => file === writerLock && activeLock(file),
    now: () => now,
    cacheMs: 0,
  });
  const observed = coordinator.observe([thread("cold-cli", {
    sourceKind: "cli",
    updatedAt: staleTime.toISOString(),
    rolloutFile,
  })]);
  assert.equal(coordinator.stats().rolloutFiles, 1);
  assert.equal(observed.sessions.get("cold-cli").needsInput, true);
  assert.equal(observed.threads[0].liveStatus, "needs_input");
});

test("cold Desktop discovery cannot consume the actively locked CLI rollout budget", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-cold-cli-budget-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const now = START + CODEX_ROLLOUT_LIVE_WINDOW_MS + 10_000;
  const staleTime = new Date(START - CODEX_ROLLOUT_LIVE_WINDOW_MS - 1);
  const desktopThreads = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const rolloutFile = path.join(root, `rollout-desktop-${index}.jsonl`);
    await writeFile(rolloutFile, JSON.stringify({
      timestamp: new Date(now).toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: `desktop-${index}`, input: "PRIVATE_INPUT_MUST_NOT_LEAK" },
    }), "utf8");
    await utimes(rolloutFile, staleTime, staleTime);
    return thread(`desktop-${index}`, {
      sourceKind: "vscode",
      updatedAt: staleTime.toISOString(),
      rolloutFile,
    });
  }));
  const cliRolloutFile = path.join(root, "rollout-locked-cli.jsonl");
  await writeFile(cliRolloutFile, JSON.stringify({
    timestamp: new Date(now - CODEX_ROLLOUT_APPROVAL_GRACE_MS).toISOString(),
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "locked-cli-patch",
      input: "const result = await tools.apply_patch(\"PRIVATE_PATCH_MUST_NOT_LEAK\");",
    },
  }), "utf8");
  await utimes(cliRolloutFile, staleTime, staleTime);
  const coordinator = createCodexLivenessCoordinator({
    root: path.join(root, "liveness"),
    writerLocksRoot: path.join(root, "thread-writer-locks"),
    writerLockIsActive: (file) => file.endsWith("locked-cli.lock"),
    now: () => now,
    cacheMs: 0,
  });
  const cliThread = thread("locked-cli", {
    sourceKind: "cli",
    updatedAt: staleTime.toISOString(),
    rolloutFile: cliRolloutFile,
  });

  const observed = coordinator.observe([...desktopThreads, cliThread]);
  assert.equal(coordinator.stats().rolloutFiles, 17);
  assert.equal(observed.sessions.get("locked-cli").needsInput, true);
  assert.equal(observed.threads.at(-1).liveStatus, "needs_input");
});

test("liveness scans one recent pending rollout while skipping five hundred provably stale rollouts", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-window-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-authoritative-live-"));
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
    thread("app-root", { runtimeStatus: { type: "active" }, rolloutFile }),
    thread("bridge-root", { rolloutFile }),
  ]);
  assert.equal(coordinator.stats().rolloutFiles, 0);
  assert.equal(observed.threads.find((item) => item.localId === "app-root").liveness.source, "owning_app_server");
  assert.equal(observed.threads.find((item) => item.localId === "bridge-root").liveness.source, "lifecycle_bridge");
});

test("conflicting current bridge owners keep a live session resource-ownerless", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-conflicting-owners-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  hook(root, START, "SessionStart", { sessionId: "conflict-root" });
  hook(root, START, "SubagentStart", {
    sessionId: "conflict-root",
    agentId: "conflict-child",
    owner: { ownerPid: 4343, ownerStartedAt: "134000000000000001", startWatcher: false },
  });
  const coordinator = createCodexLivenessCoordinator({ root, now: () => START + 1_000, cacheMs: 0 });
  const observed = coordinator.observe([
    thread("conflict-root"),
    thread("conflict-child", { sessionId: "conflict-root", parentThreadId: "conflict-root" }),
  ]);
  assert.deepEqual(observed.sessions.get("conflict-root"), {
    isLive: true,
    needsInput: false,
    observedAt: new Date(START).toISOString(),
    resourceOwner: null,
  });
});

test("future-dated rollout metadata is scanned and record timestamps decide liveness", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-clock-skew-"));
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
  const identity = processStartIdentity(process.pid);
  assert.match(identity, /^\d{17,20}$/);
  assert.equal(BigInt(identity) > 0n, true);
});

test("process start identities accept the sampler format and reject unsafe values", () => {
  assert.equal(processStartIdentity(4242, { processStartIdentity: () => OWNER.ownerStartedAt }), OWNER.ownerStartedAt);
  assert.equal(processStartIdentity(4242, { processStartIdentity: () => "../../unsafe" }), null);
});

test("the inert hook command accepts Windows lifecycle JSON and persists only its allowlist", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-hook-command-"));
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
    env: { ...process.env, POMEGR_CODEX_LIVENESS_DIR: root },
    windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "{}\n");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(await serializedFiles(root), /PRIVATE_|reason|cwd|transcript/i);
});

test("archived threads never become live from current app-server or rollout evidence", () => {
  const coordinator = createCodexLivenessCoordinator({ root: path.join(os.tmpdir(), "missing-pomegr-liveness"), now: () => START, cacheMs: 0 });
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-tree-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-history-"));
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-bounds-"));
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
  assert.deepEqual((await provider.listSessions()).find((item) => item.localId === "session-0")?.resourceOwner, {
    pid: OWNER.ownerPid,
    processStartIdentity: OWNER.ownerStartedAt,
  });
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
