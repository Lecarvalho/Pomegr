import assert from "node:assert/strict";
import test from "node:test";
import { aggregateCodexSessionLifecycle } from "../monitor/providers/codex-session-lifecycle.mjs";

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

test("no live actors remain unknown", () => {
  const root = actor({ liveStatus: "idle" });
  assert.deepEqual(aggregateCodexSessionLifecycle(root, [root]), {
    isLive: false, needsInput: false, activityStatus: "unknown",
  });
});

test("all potentially live actors inactive yields idle", () => {
  const root = actor({ liveStatus: "idle", livenessLive: true });
  const child = actor({ liveStatus: "stopped", livenessLive: true });
  assert.deepEqual(aggregateCodexSessionLifecycle(root, [root, child]), {
    isLive: true, needsInput: false, activityStatus: "idle",
  });
});
