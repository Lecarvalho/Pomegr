import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_BRIDGE_LEASE_MS, CODEX_ROLLOUT_APPROVAL_GRACE_MS, CODEX_ROLLOUT_LIVE_WINDOW_MS } from "../monitor/providers/codex-lifecycle-constants.mjs";
import { captureCodexLifecycleHook } from "../monitor/providers/codex-hook-lifecycle.mjs";
import { createCodexLivenessCoordinator } from "../monitor/providers/codex-liveness.mjs";
import { createCodexOwningRuntime, appServerLiveness } from "../monitor/providers/codex-owning-runtime.mjs";
import { observedCodexRolloutLifecycle, parseCodexRolloutLiveness } from "../monitor/providers/codex-rollout-lifecycle.mjs";
import { createCodexSourceRouter, codexInferenceEligible } from "../monitor/providers/codex-source-routing.mjs";

const START = Date.parse("2026-08-11T12:00:00.000Z");
const OWNER = { ownerPid: 4242, ownerStartedAt: "134000000000000000", startWatcher: false };

function lifecycleThread() {
  return [{ localId: "live-root", sessionId: "live-root", parentThreadId: null, sourceKind: "cli", updatedAt: new Date(START).toISOString(), runtimeStatus: null, rolloutFile: null }];
}

function lifecycleRecord(offset, type, payload) {
  return { timestamp: new Date(START + offset).toISOString(), type, payload };
}

test("Codex source routing keeps CLI and recorded vscode cold policies independent", () => {
  const sourceFor = createCodexSourceRouter(1);
  const cli = sourceFor("cli");
  const vscode = sourceFor("vscode");
  const unknown = sourceFor("unrecognized_origin");
  const rootThread = { parentThreadId: null };

  assert.equal(cli.coldCandidate(rootThread, () => false), false, "CLI requires its own active writer lock");
  assert.equal(cli.coldCandidate(rootThread, () => true), true);
  assert.equal(cli.coldCandidate(rootThread, () => true), false, "CLI consumes only its own bounded budget");
  assert.equal(vscode.coldCandidate(rootThread, () => false), true, "recorded vscode origin has an independent bounded policy");
  assert.equal(vscode.coldCandidate(rootThread, () => true), false, "vscode consumes only its own bounded budget");
  assert.equal(unknown.coldCandidate(rootThread, () => true), false, "unknown origins never inherit CLI or vscode cold rules");

  const pendingEdit = [lifecycleRecord(0, "response_item", {
    type: "custom_tool_call",
    name: "apply_patch",
    call_id: "edit-1",
  })];
  assert.equal(cli.infer(pendingEdit, { now: START + CODEX_ROLLOUT_APPROVAL_GRACE_MS }).needsInputKind, "pending_file_edit");
  assert.equal(vscode.infer(pendingEdit, { now: START + CODEX_ROLLOUT_APPROVAL_GRACE_MS }).needsInput, false);
  assert.equal(unknown.infer(pendingEdit, { now: START + CODEX_ROLLOUT_APPROVAL_GRACE_MS }).needsInput, false);
});

test("Codex timing inference requires affirmative unavailable-channel assessment", () => {
  assert.equal(codexInferenceEligible(), false);
  assert.equal(codexInferenceEligible({ owningRuntime: "not_integrated", hooks: "unsupported", structuredRollout: "unsupported" }), false);
  assert.equal(codexInferenceEligible({ owningRuntime: "failed", hooks: "unsupported", structuredRollout: "unsupported" }), false);
  assert.equal(codexInferenceEligible({ owningRuntime: "unsupported", hooks: "unsupported", structuredRollout: "unsupported" }), true);
});

test("Codex owning-runtime adapter allows only read observation and marks failed state unavailable", async () => {
  const requested = [];
  const runtime = createCodexOwningRuntime({
    async request(method) {
      requested.push(method);
      throw new Error("synthetic runtime failure");
    },
  });

  await assert.rejects(runtime.request("thread/start", { threadId: "private-thread" }), /Unsupported read-only Codex operation/);
  assert.deepEqual(requested, [], "mutation methods must not reach the supplied connection");
  await assert.rejects(runtime.request("thread/list", {}), /Codex runtime observation unavailable/);
  assert.deepEqual(requested, ["thread/list"]);
  assert.deepEqual(runtime.decorate({
    localId: "safe-thread",
    updatedAt: "2026-08-11T12:00:00.000Z",
    runtimeStatus: { type: "active", activeFlags: [] },
  }), {
    localId: "safe-thread",
    updatedAt: "2026-08-11T12:00:00.000Z",
    runtimeStatus: null,
    runtimeObservedAt: "2026-08-11T12:00:00.000Z",
    runtimeConfirmedAt: null,
    runtimeAvailability: "source_unavailable",
  });

  const absent = createCodexOwningRuntime(null).decorate({
    localId: "safe-thread",
    updatedAt: "2026-08-11T12:00:00.000Z",
    runtimeStatus: { type: "active", activeFlags: [] },
  });
  assert.equal(absent.runtimeAvailability, "source_not_integrated");
  assert.equal(absent.runtimeStatus, null);
});

test("Codex owning-runtime confirmation tracks freshness without resetting stable state", async () => {
  let clock = START;
  let status = { type: "active", activeFlags: [] };
  let failRead = false;
  const connection = {
    async request(method) {
      if (method === "thread/list") return { data: [{ id: "runtime-thread", status }] };
      if (method === "thread/read") {
        if (failRead) throw new Error("synthetic read failure");
        return { thread: { id: "runtime-thread", status } };
      }
      return null;
    },
  };
  const runtime = createCodexOwningRuntime(connection, { now: () => clock });
  const metadata = () => ({
    localId: "runtime-thread",
    updatedAt: new Date(START - 1_000).toISOString(),
    runtimeStatus: status,
  });

  await runtime.request("thread/list", {});
  const listed = runtime.decorate(metadata());
  assert.equal(listed.runtimeObservedAt, new Date(START).toISOString());
  assert.equal(listed.runtimeConfirmedAt, new Date(START).toISOString());
  assert.deepEqual(listed.runtimeStatus, status);

  clock += 1_000;
  await runtime.request("thread/read", { threadId: "runtime-thread" });
  const reread = runtime.decorate(metadata());
  assert.equal(reread.runtimeObservedAt, new Date(START).toISOString(), "same state retains its observation timestamp");
  assert.equal(reread.runtimeConfirmedAt, new Date(START + 1_000).toISOString(), "every successful read advances confirmation freshness");

  clock += 1_000;
  status = { type: "idle" };
  await runtime.request("thread/list", {});
  const changed = runtime.decorate(metadata());
  assert.equal(changed.runtimeObservedAt, new Date(START + 2_000).toISOString());
  assert.equal(changed.runtimeConfirmedAt, new Date(START + 2_000).toISOString());
  assert.deepEqual(changed.runtimeStatus, status);

  failRead = true;
  await assert.rejects(runtime.request("thread/read", { threadId: "runtime-thread" }), /Codex runtime observation unavailable/);
  const failed = runtime.decorate(metadata());
  assert.equal(failed.runtimeStatus, null);
  assert.equal(failed.runtimeAvailability, "source_unavailable");

  clock += 1_000;
  failRead = false;
  await runtime.request("thread/read", { threadId: "runtime-thread" });
  const recovered = runtime.decorate(metadata());
  assert.deepEqual(recovered.runtimeStatus, status);
  assert.equal(recovered.runtimeAvailability, null);

  clock += CODEX_ROLLOUT_LIVE_WINDOW_MS + 1;
  const expired = runtime.decorate(metadata());
  assert.equal(expired.runtimeStatus, null);
  assert.equal(expired.runtimeAvailability, "observation_gap");
});

test("Codex owning-runtime rejects a future confirmation as an observation gap", async () => {
  let clock = START + 1_000;
  const runtime = createCodexOwningRuntime({
    async request() { return { data: [{ id: "future-thread", status: { type: "active", activeFlags: [] } }] }; },
  }, { now: () => clock });
  await runtime.request("thread/list", {});
  clock = START;
  const decorated = runtime.decorate({
    localId: "future-thread",
    updatedAt: new Date(START).toISOString(),
    runtimeStatus: { type: "active", activeFlags: [] },
  });
  assert.equal(decorated.runtimeStatus, null);
  assert.equal(decorated.runtimeAvailability, "observation_gap");
});

test("Codex owning-runtime liveness carries observed evidence and freshness", () => {
  assert.deepEqual(appServerLiveness({ type: "active", activeFlags: ["waitingOnApproval"] }, "2026-08-11T12:00:00.000Z"), {
    live: true,
    status: "needs_input",
    needsInput: true,
    source: "owning_app_server",
    observedAt: "2026-08-11T12:00:00.000Z",
    evidence: "observed",
    freshness: "current",
  });
});

test("explicit Codex turn boundaries are observed and become unknown after a quiet stale gap", () => {
  const start = {
    timestamp: new Date(START).toISOString(),
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-structured" },
  };
  const completed = {
    timestamp: new Date(START + 2_000).toISOString(),
    type: "turn_completed",
    payload: { turn_id: "turn-structured", status: "completed" },
  };
  const active = observedCodexRolloutLifecycle([start], { now: START + 1_000 });
  assert.equal(active.liveness.status, "active");
  assert.equal(active.liveness.evidence, "observed");

  const idle = observedCodexRolloutLifecycle([start, completed], { now: START + 3_000 });
  assert.equal(idle.liveness.status, "idle");
  assert.equal(idle.liveness.source, "structured_lifecycle");

  const stale = observedCodexRolloutLifecycle([start, completed], {
    now: START + 2_000 + CODEX_ROLLOUT_LIVE_WINDOW_MS + 1,
  });
  assert.deepEqual(stale.liveness, {
    live: false,
    status: "unknown",
    needsInput: false,
    source: "structured_lifecycle",
    observedAt: new Date(START + 2_000).toISOString(),
    evidence: "unavailable",
    freshness: "stale",
    reason: "observation_gap",
  });
});

test("same-turn context does not clear a still-pending structured user-input request", () => {
  const records = [
    {
      timestamp: new Date(START).toISOString(),
      type: "turn_context",
      payload: { turn_id: "turn-input" },
    },
    {
      timestamp: new Date(START + 1_000).toISOString(),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "input-1",
        turn_id: "turn-input",
      },
    },
    {
      timestamp: new Date(START + 2_000).toISOString(),
      type: "turn_context",
      payload: { turn_id: "turn-input" },
    },
  ];
  const liveness = parseCodexRolloutLiveness(records, { now: START + 3_000 });
  assert.equal(liveness.status, "needs_input");
  assert.equal(liveness.needsInputKind, "user_input");
});

test("an incomplete final rollout record remains unknown until its newline completes the boundary", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-tail-partial-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout.jsonl");
  const start = lifecycleRecord(0, "event_msg", { type: "task_started", turn_id: "turn-tail" });
  const end = lifecycleRecord(2_000, "turn_completed", { turn_id: "turn-tail", status: "completed" });
  await writeFile(rolloutFile, `${JSON.stringify(start)}\n`, "utf8");
  let now = START + 1_000;
  const coordinator = createCodexLivenessCoordinator({ root: path.join(root, "liveness"), now: () => now, cacheMs: 0 });
  const observe = () => coordinator.observe([{ localId: "tail-root", sessionId: "tail-root", parentThreadId: null, sourceKind: "cli", updatedAt: new Date(now).toISOString(), rolloutFile }]);
  assert.equal(observe().threads[0].liveStatus, "active");

  const encodedEnd = JSON.stringify(end);
  await appendFile(rolloutFile, encodedEnd.slice(0, -1), "utf8");
  now = START + 3_000;
  const partial = observe().threads[0];
  assert.equal(partial.liveStatus, "unknown");
  assert.equal(partial.liveness.evidence, "unavailable");

  await appendFile(rolloutFile, `${encodedEnd.at(-1)}\n`, "utf8");
  const recovered = observe().threads[0];
  assert.equal(recovered.liveStatus, "idle");
  assert.equal(recovered.liveness.evidence, "observed");
});

test("a malformed framed rollout record downgrades lifecycle evidence to unknown", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-tail-malformed-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout.jsonl");
  await writeFile(rolloutFile, `${JSON.stringify(lifecycleRecord(0, "event_msg", { type: "task_started", turn_id: "turn-malformed" }))}\n{"broken":}\n`, "utf8");
  const coordinator = createCodexLivenessCoordinator({ root: path.join(root, "liveness"), now: () => START + 1_000, cacheMs: 0 });
  const observed = coordinator.observe([{ localId: "malformed-root", sessionId: "malformed-root", parentThreadId: null, sourceKind: "cli", updatedAt: new Date(START).toISOString(), rolloutFile }]).threads[0];
  assert.equal(observed.liveStatus, "unknown");
  assert.equal(observed.liveness.evidence, "unavailable");
});

test("a discontinuous retained tail needs a new explicit boundary before lifecycle evidence recovers", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-tail-continuity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout.jsonl");
  await writeFile(rolloutFile, `${JSON.stringify(lifecycleRecord(0, "event_msg", { type: "task_started", turn_id: "turn-old" }))}\n`, "utf8");
  let now = START + 1_000;
  const coordinator = createCodexLivenessCoordinator({ root: path.join(root, "liveness"), now: () => now, cacheMs: 0, maximumTailBytes: 128 });
  const observe = () => coordinator.observe([{ localId: "continuity-root", sessionId: "continuity-root", parentThreadId: null, sourceKind: "cli", updatedAt: new Date(now).toISOString(), rolloutFile }]);
  assert.equal(observe().threads[0].liveStatus, "active");

  await appendFile(rolloutFile, `${JSON.stringify({ timestamp: new Date(START + 2_000).toISOString(), type: "event_msg", payload: { type: "noise", padding: "x".repeat(512) } })}\n`, "utf8");
  now = START + 3_000;
  assert.equal(observe().threads[0].liveStatus, "unknown", "an old boundary outside the retained tail must not stay authoritative");

  await appendFile(rolloutFile, `${JSON.stringify(lifecycleRecord(4_000, "event_msg", { type: "task_started", turn_id: "turn-new" }))}\n`, "utf8");
  now = START + 5_000;
  const recovered = observe().threads[0];
  assert.equal(recovered.liveStatus, "active");
  assert.equal(recovered.liveness.evidence, "observed");
});

test("hook lifecycle stays unknown without a native completion boundary", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-hook-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = START;
  const capture = (event, extra = {}) => captureCodexLifecycleHook({
    session_id: "live-root", hook_event_name: event, turn_id: "turn-1", tool_name: extra.toolName,
    prompt: "PROMPT_MUST_NOT_LEAK", tool_input: { command: "COMMAND_MUST_NOT_LEAK" },
  }, { root, now, ...OWNER });
  const coordinator = createCodexLivenessCoordinator({ root, now: () => now, cacheMs: 0 });
  capture("SessionStart");
  assert.equal(coordinator.observe(lifecycleThread()).threads[0].liveStatus, "unknown");
  now += 1_000;
  capture("UserPromptSubmit");
  assert.equal(coordinator.observe(lifecycleThread()).threads[0].liveStatus, "active");
  now += 1_000;
  capture("Stop");
  assert.equal(coordinator.observe(lifecycleThread()).threads[0].liveStatus, "unknown");
  now += 1_000;
  capture("SessionEnd");
  const ended = coordinator.observe(lifecycleThread());
  assert.equal(ended.sessions.get("live-root").activityStatus, "unknown");
  const files = await readdir(path.join(root, "snapshots"));
  const payload = await readFile(path.join(root, "snapshots", files[0]), "utf8");
  assert.doesNotMatch(payload, /PROMPT_MUST_NOT_LEAK|COMMAND_MUST_NOT_LEAK|tool_input|prompt/);
});

test("an explicit current owner identity cannot reuse a prior owner's live lease", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-hook-owner-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const initial = captureCodexLifecycleHook({
    session_id: "owner-root", hook_event_name: "PermissionRequest", turn_id: "turn-owner",
  }, { root, now: START, ...OWNER });
  const current = captureCodexLifecycleHook({
    session_id: "owner-root", hook_event_name: "SessionStart", turn_id: "turn-owner", source: "compact",
  }, {
    root,
    now: START + 1_000,
    env: { POMEGR_CODEX_OWNER_PID: "5151" },
    processStartIdentity: (pid) => pid === 5151 ? "515100000000000000" : null,
    startWatcher: false,
  });
  assert.equal(initial.lifecycle, "needs_input");
  assert.equal(current.ownerPid, 5151);
  assert.notEqual(current.bridgeInstance, initial.bridgeInstance);
  assert.equal(current.lifecycle, "unknown");
});

test("compact continuation preserves input only for the same owner, lease, and turn", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-hook-compact-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const prepare = (directory, now = START) => captureCodexLifecycleHook({
    session_id: "compact-root", hook_event_name: "PermissionRequest", turn_id: "turn-compact",
  }, { root: directory, now, ...OWNER });
  const compact = (directory, now, options = {}) => captureCodexLifecycleHook({
    session_id: "compact-root", hook_event_name: "SessionStart", source: "compact", ...options.input,
  }, { root: directory, now, ...(options.owner || OWNER) });

  prepare(root);
  const continued = compact(root, START + 1_000, { input: { turn_id: "turn-compact" } });
  assert.equal(continued.lifecycle, "needs_input");

  const missingTurnRoot = path.join(root, "missing-turn");
  prepare(missingTurnRoot);
  assert.equal(compact(missingTurnRoot, START + 1_000).lifecycle, "unknown");

  const newOwnerRoot = path.join(root, "new-owner");
  prepare(newOwnerRoot);
  assert.equal(compact(newOwnerRoot, START + 1_000, {
    input: { turn_id: "turn-compact" },
    owner: { ownerPid: 5152, ownerStartedAt: "515200000000000000", startWatcher: false },
  }).lifecycle, "unknown");

  const expiredLeaseRoot = path.join(root, "expired-lease");
  prepare(expiredLeaseRoot);
  assert.equal(compact(expiredLeaseRoot, START + CODEX_BRIDGE_LEASE_MS + 1, {
    input: { turn_id: "turn-compact" },
  }).lifecycle, "unknown");
});
