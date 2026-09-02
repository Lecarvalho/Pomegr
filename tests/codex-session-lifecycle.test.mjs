import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCodexSessionLifecycle } from "../monitor/providers/codex-session-lifecycle.mjs";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { CODEX_BRIDGE_LEASE_MS, captureCodexLifecycleHook, createCodexLivenessCoordinator, renewCodexOwnerLease } from "../monitor/providers/codex-liveness.mjs";

const START = Date.parse("2026-08-11T12:00:00.000Z");
const OWNER = { ownerPid: 4242, ownerStartedAt: "134000000000000000", startWatcher: false };

const actor = (overrides = {}) => ({ liveStatus: "unknown", livenessLive: false, ...overrides });

test("root unknown and idle child remain unknown", () => {
  const root = actor();
  const child = actor({ liveStatus: "idle", livenessLive: true });
  assert.deepEqual(aggregateCodexSessionLifecycle(root, [root, child]), {
    isLive: true, needsInput: false, activityStatus: "unknown",
  });
});

test("idle root and unknown live child remain unknown", () => {
  const root = actor({ liveStatus: "idle", livenessLive: true });
  const child = actor({ livenessLive: true });
  assert.equal(aggregateCodexSessionLifecycle(root, [root, child]).activityStatus, "unknown");
});

test("idle root ignores unknown nonlive historical child", () => {
  const root = actor({ liveStatus: "idle", livenessLive: true });
  const child = actor({ livenessLive: false });
  assert.deepEqual(aggregateCodexSessionLifecycle(root, [root, child]), {
    isLive: true, needsInput: false, activityStatus: "idle",
  });
});

test("active child wins over unknown root", () => {
  const root = actor();
  const child = actor({ liveStatus: "active", livenessLive: true });
  assert.equal(aggregateCodexSessionLifecycle(root, [root, child]).activityStatus, "working");
});

test("needs input wins over active and idle", () => {
  const root = actor({ liveStatus: "idle", livenessLive: true });
  const child = actor({ liveStatus: "needs_input", needsInput: true, livenessLive: true });
  assert.deepEqual(aggregateCodexSessionLifecycle(root, [root, child]), {
    isLive: true, needsInput: true, activityStatus: "needs_input",
  });
});

test("recorded idle survives the end of live presence", () => {
  const root = actor({ liveStatus: "idle" });
  assert.deepEqual(aggregateCodexSessionLifecycle(root, [root]), {
    isLive: false, needsInput: false, activityStatus: "idle",
  });
});

test("all potentially live actors inactive yields idle", () => {
  const root = actor({ liveStatus: "idle", livenessLive: true });
  const child = actor({ liveStatus: "stopped", livenessLive: true });
  assert.deepEqual(aggregateCodexSessionLifecycle(root, [root, child]), {
    isLive: true, needsInput: false, activityStatus: "idle",
  });
});

test("open requires confirmed presence, not just unresolved or uncertain liveness", () => {
  const root = actor({ livenessLive: true });
  assert.equal(aggregateCodexSessionLifecycle(root).activityStatus, "unknown");
  const open = { ...root, presenceConfirmed: true };
  assert.equal(aggregateCodexSessionLifecycle(open).activityStatus, "open");
  assert.equal(aggregateCodexSessionLifecycle({ ...open, liveStatus: "active" }).activityStatus, "working");
  assert.equal(aggregateCodexSessionLifecycle({ ...open, liveStatus: "idle" }).activityStatus, "open");
});

test("stopped stays distinct from idle and an unfinished child keeps a completed parent live", () => {
  const root = actor({ liveStatus: "stopped" });
  assert.deepEqual(aggregateCodexSessionLifecycle(root), {
    isLive: false, needsInput: false, activityStatus: "stopped",
  });
  const child = actor({ liveStatus: "active", livenessLive: true });
  assert.deepEqual(aggregateCodexSessionLifecycle(root, [root, child]), {
    isLive: true, needsInput: false, activityStatus: "working",
  });
});


test("confirmed presence keeps a completed turn open until the owner leaves", () => {
  const root = actor({ liveStatus: "idle", livenessLive: true, presenceConfirmed: true });
  assert.deepEqual(aggregateCodexSessionLifecycle(root), {
    isLive: true, needsInput: false, activityStatus: "open",
  });
  assert.deepEqual(aggregateCodexSessionLifecycle({ ...root, livenessLive: false, presenceConfirmed: false }), {
    isLive: false, needsInput: false, activityStatus: "idle",
  });
  const child = actor({ liveStatus: "active", livenessLive: true });
  assert.equal(aggregateCodexSessionLifecycle(root, [root, child]).activityStatus, "working");
  assert.equal(aggregateCodexSessionLifecycle(root, [root, { ...child, liveStatus: "needs_input" }]).activityStatus, "needs_input");
  assert.equal(aggregateCodexSessionLifecycle({ ...root, liveStatus: "stopped" }).activityStatus, "stopped");
});

test("owning runtime keeps old completed sessions Open until they are unloaded", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-open-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = START + 60 * 60_000;
  const primary = { id: "open-runtime", sessionId: "open-runtime", parentThreadId: null,
    ephemeral: false, createdAt: START / 1_000, updatedAt: START / 1_000,
    source: "cli", cwd: "C:/synthetic/repo", name: "Open runtime", status: { type: "idle" }, turns: [] };
  const appServer = {
    async listThreads() { return { data: [primary] }; },
    async readThread() { return { thread: primary }; },
  };
  const provider = createCodexProvider({ codexHome: root, livenessRoot: path.join(root, "liveness"), appServer, includeArchived: false, cacheMs: 0, now: () => now });
  const open = (await provider.listSessions())[0];
  assert.equal(open.isLive, true);
  assert.equal(open.activityStatus, "open");
  now += 60 * 60_000;
  const stillOpen = (await provider.listSessions())[0];
  assert.equal(stillOpen.isLive, true);
  assert.equal(stillOpen.activityStatus, "open");
  assert.equal(stillOpen.updatedAt, open.updatedAt, "observing presence must not invent recent activity");
  primary.status = { type: "notLoaded" };
  const unloaded = (await provider.listSessions())[0];
  assert.equal(unloaded.isLive, false);
  assert.notEqual(unloaded.activityStatus, "open");
});

test("a renewed owner lease keeps a completed rollout Open without extending its activity time", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-open-lease-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = captureCodexLifecycleHook({ session_id: "live-root", hook_event_name: "SessionStart", turn_id: "turn-1" }, { root, now: START, ...OWNER });
  const rolloutFile = path.join(root, "rollout-open.jsonl");
  const completedAt = new Date(START + 1_000).toISOString();
  await writeFile(rolloutFile, [
    { timestamp: new Date(START).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { timestamp: completedAt, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ].map(JSON.stringify).join("\n") + "\n");
  let now = START + 2_000;
  const coordinator = createCodexLivenessCoordinator({ root, now: () => now, cacheMs: 0 });
  const threads = [{ localId: "live-root", sessionId: "live-root", parentThreadId: null, sourceKind: "cli", updatedAt: new Date(START).toISOString(), rolloutFile }];
  assert.equal(coordinator.observe(threads).sessions.get("live-root").activityStatus, "open");
  now += 2 * 60 * 60_000;
  assert.equal(renewCodexOwnerLease({ root, now, ownerPid: OWNER.ownerPid, ownerStartedAt: OWNER.ownerStartedAt,
    bridgeInstance: snapshot.bridgeInstance, processStartIdentity: () => OWNER.ownerStartedAt }), true);
  const observed = coordinator.observe(threads);
  assert.equal(observed.sessions.get("live-root").isLive, true);
  assert.equal(observed.sessions.get("live-root").activityStatus, "open");
  assert.equal(observed.threads[0].liveStatus, "idle");
  assert.equal(observed.threads[0].liveness.observedAt, completedAt);
  // Keep polling across expiry rather than simulating repeated monitor sleep.
  for (let tick = 0; tick < 6; tick += 1) {
    now += CODEX_BRIDGE_LEASE_MS / 2;
    coordinator.observe(threads);
  }
  const expired = coordinator.observe(threads);
  assert.equal(expired.sessions.get("live-root").isLive, false);
  assert.equal(expired.sessions.get("live-root").activityStatus, "idle");
});
