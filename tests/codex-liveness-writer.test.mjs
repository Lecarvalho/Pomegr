import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_LIVENESS_MAX_OWNER_TAIL_BYTES,
  CODEX_LIVENESS_MAX_TAIL_BYTES,
  createCodexLivenessCoordinator,
} from "../monitor/providers/codex-liveness.mjs";
import { incrementalSourceDescriptor } from "../monitor/providers/incremental-provider-observer.mjs";
import { initialCodexRecordedLifecycle, reduceCodexRecordedLifecycle } from "../monitor/providers/codex-recorded-lifecycle.mjs";

// Owner-confirmed header scans and writer-lock release semantics, split from
// codex-liveness.test.mjs to keep both files under the architecture line limits.
const START = Date.parse("2026-08-11T12:00:00.000Z");

function boundary(offset, type = "task_complete", turnId = "backlogged-turn") {
  return { timestamp: new Date(START + offset).toISOString(), type: "event_msg", payload: { type, turn_id: turnId } };
}

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

test("confirmed native ownership gets a bounded deeper header scan for an explicit live turn", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-owner-header-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout.jsonl");
  const records = [boundary(0, "task_started", "owner-turn")];
  for (let index = 0; index < 300; index += 1) records.push({
    timestamp: new Date(START + 1_000).toISOString(),
    type: "event_msg",
    payload: { type: "unrecognized_noise", padding: "x".repeat(1_024) },
  });
  await writeFile(rolloutFile, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  const size = fs.statSync(rolloutFile).size;
  assert.equal(size > CODEX_LIVENESS_MAX_TAIL_BYTES, true);
  assert.equal(size < CODEX_LIVENESS_MAX_OWNER_TAIL_BYTES, true);
  const candidate = thread("owner-header-root", {
    rolloutFile,
    updatedAt: new Date(START + 2_000).toISOString(),
  });

  const ordinary = createCodexLivenessCoordinator({
    now: () => START + 2_000,
    cacheMs: 0,
  }).observe([candidate]);
  assert.equal(ordinary.sessions.get("owner-header-root").activityStatus, "unknown");

  const owner = createCodexLivenessCoordinator({
    now: () => START + 2_000,
    cacheMs: 0,
    currentWriterOwner: () => ({ pid: 4242, processStartIdentity: "134000000000000000" }),
  }).observe([candidate]);
  assert.equal(owner.threads[0].presenceConfirmed, true);
  assert.equal(owner.threads[0].liveness.source, "structured_lifecycle");
  assert.equal(owner.threads[0].liveness.evidence, "observed");
  assert.equal(owner.sessions.get("owner-header-root").activityStatus, "working");
  assert.equal(owner.sessions.get("owner-header-root").isLive, true);
  assert.equal(owner.threads[0].liveness.observedAt, new Date(START).toISOString());
});

test("confirmed native ownership plus fresh structured activity refines a boundaryless tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-owner-activity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rolloutFile = path.join(root, "rollout.jsonl");
  const records = [boundary(0, "task_started", "outside-tail")];
  for (let index = 0; index < 180; index += 1) records.push({
    timestamp: new Date(START + 1_000).toISOString(),
    type: "unrecognized_record",
    payload: { padding: "x".repeat(1_024) },
  });
  const activityAt = new Date(START + 2_000).toISOString();
  records.push({
    timestamp: activityAt,
    type: "response_item",
    payload: { type: "function_call", name: "exec", call_id: "fresh-tool" },
  });
  await writeFile(rolloutFile, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  assert.equal(fs.statSync(rolloutFile).size > CODEX_LIVENESS_MAX_TAIL_BYTES, true);
  const candidate = thread("owner-activity-root", {
    rolloutFile,
    updatedAt: activityAt,
  });
  const base = {
    now: () => START + 3_000,
    cacheMs: 0,
    maximumOwnerTailBytes: CODEX_LIVENESS_MAX_TAIL_BYTES,
  };

  const ordinary = createCodexLivenessCoordinator(base).observe([candidate]);
  assert.equal(ordinary.sessions.get("owner-activity-root").activityStatus, "unknown");

  const owner = createCodexLivenessCoordinator({
    ...base,
    currentWriterOwner: () => ({ pid: 4242, processStartIdentity: "134000000000000000" }),
  }).observe([candidate]);
  assert.equal(owner.threads[0].presenceConfirmed, true);
  assert.equal(owner.threads[0].liveness.source, "rollout_activity_heuristic");
  assert.equal(owner.threads[0].liveness.evidence, "inferred");
  assert.equal(owner.threads[0].liveness.observedAt, activityAt);
  assert.equal(owner.sessions.get("owner-activity-root").activityStatus, "working");
});

async function abandonedRollout(context, records) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-abandoned-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = {};
  for (const [name, items] of Object.entries(records)) {
    files[name] = path.join(root, `${name}.jsonl`);
    await writeFile(files[name], items.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  }
  return { root, files, sources: Object.entries(records).map(([name, items]) => ({
    file: files[name], generation: incrementalSourceDescriptor(files[name]), complete: true,
    state: items.reduce(reduceCodexRecordedLifecycle, initialCodexRecordedLifecycle()),
  })) };
}

test("an abandoned unresolved turn is never live when no writer holds its lock", async (context) => {
  const start = boundary(0, "task_started", "killed-turn");
  const call = { timestamp: new Date(START + 500).toISOString(), type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", call_id: "killed-call", input: "PRIVATE_INPUT_MUST_NOT_LEAK", turn_id: "killed-turn" } };
  const { files, sources } = await abandonedRollout(context, { killed: [start, call] });
  const threads = [thread("killed-root", { rolloutFile: files.killed })];
  let lock = "released"; let owner = null;
  // A fresh coordinator is a monitor restart: the first observation after full
  // acquisition must already exclude the abandoned turn, never flash it as live.
  const coordinator = createCodexLivenessCoordinator({ now: () => START + 4 * 60 * 60_000, cacheMs: 0,
    currentWriterOwner: () => owner, writerLockState: () => lock });
  coordinator.observeLifecycleSources(sources);
  const released = coordinator.observe(threads);
  const session = released.sessions.get("killed-root");
  assert.deepEqual([session.isLive, session.needsInput, session.activityStatus], [false, false, "unknown"]);
  assert.equal(session.observedAt, call.timestamp, "a released lock never renews the recorded timestamp");
  assert.equal(released.threads[0].liveStatus, "unknown");
  assert.deepEqual(released.threads[0].liveness, { source: "structured_lifecycle", observedAt: call.timestamp,
    evidence: "unavailable", freshness: "stale", reason: "writer_released" });
  assert.doesNotMatch(JSON.stringify(released), /PRIVATE_INPUT/);

  lock = "held";
  assert.equal(coordinator.observe(threads).sessions.get("killed-root").activityStatus, "working",
    "a held lock keeps unresolved work live through silence");
  lock = "unavailable";
  assert.equal(coordinator.observe(threads).sessions.get("killed-root").activityStatus, "working",
    "an unreadable lock is not evidence of release");
  lock = "released"; owner = { pid: 4242, processStartIdentity: "134000000000000000" };
  assert.equal(coordinator.observe(threads).sessions.get("killed-root").isLive, true, "a confirmed owner outranks the lock read");
});

test("the native lock read applies only on Windows with a provider lock directory", async (context) => {
  const { root, files, sources } = await abandonedRollout(context, { killed: [boundary(0, "task_started", "killed-turn")] });
  const threads = [thread("killed-root", { rolloutFile: files.killed })];
  const locksRoot = path.join(root, "thread-writer-locks");
  const statusFor = (platform, readWriterLock = () => ({ state: "missing" })) => {
    const coordinator = createCodexLivenessCoordinator({ now: () => START + 60 * 60_000, cacheMs: 0,
      writerLocksRoot: locksRoot, platform, readWriterLock });
    coordinator.observeLifecycleSources(sources);
    return coordinator.observe(threads).sessions.get("killed-root").activityStatus;
  };
  assert.equal(statusFor("win32"), "working", "without the lock directory there is no release evidence");
  await mkdir(locksRoot);
  assert.equal(statusFor("win32"), "unknown");
  assert.equal(statusFor("win32", () => ({ state: "unlocked", identity: "x" })), "unknown");
  assert.equal(statusFor("win32", () => ({ state: "held", identity: "x" })), "working");
  assert.equal(statusFor("win32", () => ({ state: "unavailable" })), "working");
  assert.equal(statusFor("linux"), "working", "other platforms do not inherit Windows lock semantics");
});

test("a released child stays live while its root lock is held and an unanswered wait clears only with both released", async (context) => {
  const rootRecords = [boundary(0, "task_started", "root-turn"), { timestamp: new Date(START + 1_000).toISOString(), type: "response_item",
    payload: { type: "function_call", name: "request_user_input", call_id: "pending", turn_id: "root-turn" } }];
  const { files, sources } = await abandonedRollout(context, {
    root: rootRecords, child: [boundary(500, "task_started", "child-turn")] });
  const locks = new Map([["family-root", "held"], ["family-child", "released"]]);
  const coordinator = createCodexLivenessCoordinator({ now: () => START + 2 * 60 * 60_000, cacheMs: 0,
    writerLockState: (localId) => locks.get(localId) || "unavailable" });
  coordinator.observeLifecycleSources(sources);
  const threads = [thread("family-root", { rolloutFile: files.root }),
    thread("family-child", { parentThreadId: "family-root", sessionId: "family-root", rolloutFile: files.child })];
  const held = coordinator.observe(threads);
  assert.equal(held.threads.find((item) => item.localId === "family-child").livenessLive, true);
  assert.equal(held.sessions.get("family-root").needsInput, true);
  locks.set("family-root", "released");
  const family = coordinator.observe(threads);
  const session = family.sessions.get("family-root");
  assert.deepEqual([session.isLive, session.needsInput, session.activityStatus], [false, false, "unknown"]);
  assert.deepEqual(family.threads.map((item) => item.liveness.reason), ["writer_released", "writer_released"]);
});
