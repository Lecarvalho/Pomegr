import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionRegistryOwnerValidator, normalizeSessionRegistryEntry, preferredRegisteredSessionId, readSessionRegistry } from "../monitor/session-registry.mjs";

test("classifies only explicit user-attention waits as needing input", () => {
  const input = normalizeSessionRegistryEntry({
    sessionId: "session-input",
    status: "waiting",
    waitingFor: "input needed",
    statusUpdatedAt: 1_786_000_000_000,
  });
  const background = normalizeSessionRegistryEntry({
    sessionId: "session-background",
    status: "waiting",
    waitingFor: "background tasks",
    statusUpdatedAt: 1_786_000_000_001,
  });

  assert.equal(input.needsInput, true);
  assert.equal(background.needsInput, false);
  assert.equal(input.waitingFor, undefined);
});

test("prioritizes an input wait over newer active registry sessions", () => {
  const registry = new Map([
    ["newer-active", { status: "active", needsInput: false }],
    ["older-question", { status: "waiting", needsInput: true }],
  ]);

  assert.equal(
    preferredRegisteredSessionId(registry, ["newer-active", "older-question"]),
    "older-question",
  );
});

test("normalizes current Claude busy status and bounded owner identity", () => {
  const entry = normalizeSessionRegistryEntry({
    sessionId: "current-session",
    status: "busy",
    updatedAt: 1_786_000_000_000,
    pid: 4321,
    procStart: "134311256812861664",
  });

  assert.equal(entry.status, "active");
  assert.equal(entry.pid, 4321);
  assert.equal(entry.procStart, "134311256812861664");
  assert.equal(normalizeSessionRegistryEntry({
    sessionId: "invalid-owner",
    status: "idle",
    pid: "not-a-pid",
    procStart: "unsafe process start",
  }).pid, null);
});

test("validates registry owners by both PID and process-start identity with a bounded cache", () => {
  let checkedAt = 1_786_000_000_000;
  let calls = 0;
  const validate = createSessionRegistryOwnerValidator({
    now: () => checkedAt,
    cacheMs: 1_500,
    processIdentities(pids) {
      calls += 1;
      assert.deepEqual(pids, [42]);
      return new Map([[42, "owner-start"]]);
    },
  });
  const matching = { sessionId: "matching", pid: 42, procStart: "owner-start" };
  const reused = { sessionId: "reused", pid: 42, procStart: "older-start" };

  assert.deepEqual(validate([matching, reused]), new Map([
    ["matching", true],
    ["reused", false],
  ]));
  assert.equal(validate([matching, reused]).get("matching"), true);
  assert.equal(calls, 1);
  checkedAt += 1_501;
  validate([matching, reused]);
  assert.equal(calls, 2);
});

test("reads valid registry entries and ignores malformed files independently", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "valid.json"), JSON.stringify({
    sessionId: "live-session",
    status: "waiting",
    waitingFor: "permission needed",
    updatedAt: 1_786_000_000_000,
  }));
  await writeFile(path.join(root, "partial.json"), "{");
  await writeFile(path.join(root, "unsafe.json"), JSON.stringify({ sessionId: "../unsafe", status: "waiting", waitingFor: "input" }));

  const registry = readSessionRegistry(root);
  assert.equal(registry.size, 1);
  assert.equal(registry.get("live-session").needsInput, true);
});

test("exposes only validated owners, retires PID reuse, and tolerates unavailable inspection", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-registry-owner-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "owned.json"), JSON.stringify({
    sessionId: "owned-session",
    status: "busy",
    updatedAt: 1_786_000_000_000,
    pid: 42,
    procStart: "owner-start",
  }));

  const live = readSessionRegistry(root, {
    validateOwners: () => new Map([["owned-session", true]]),
  });
  const orphaned = readSessionRegistry(root, {
    validateOwners: () => new Map([["owned-session", false]]),
  });
  const unavailable = readSessionRegistry(root, {
    validateOwners: () => new Map(),
  });

  assert.equal(live.get("owned-session").status, "active");
  assert.deepEqual(live.get("owned-session").resourceOwner, {
    pid: 42,
    processStartIdentity: "owner-start",
  });
  assert.equal(orphaned.size, 0);
  assert.equal(unavailable.get("owned-session").status, "active");
  assert.equal(unavailable.get("owned-session").resourceOwner, undefined);
});
