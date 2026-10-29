import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOwnerProbeCounters, createSessionRegistryOwnerValidator, normalizeSessionRegistryEntry, OWNER_PROBE_COUNTERS, parseWindowsIdentities, preferredRegisteredSessionId, readSessionRegistry } from "../../../server/normalize/session-registry.mjs";

test("a Windows identity answer that lacks a requested pid is no answer, never an exit", () => {
  // The helper's timeout can cut it off as it finishes: success, with empty output.
  for (const output of ["", "  \r\n", null, undefined]) assert.equal(parseWindowsIdentities(output, [42]), null, JSON.stringify(output));
  assert.equal(parseWindowsIdentities('[{"pid":41,"procStart":"134361771552451534","gone":false}]', [41, 42]), null);
  assert.equal(parseWindowsIdentities("[]", [42]), null);
  assert.throws(() => parseWindowsIdentities('[{"pid":41,', [41]));
  const answered = parseWindowsIdentities(JSON.stringify([
    { pid: 41, procStart: "134361771552451534", gone: false },
    { pid: 42, procStart: null, gone: true },
    { pid: 43, procStart: null, gone: false },
  ]), [41, 42, 43]);
  assert.deepEqual([...answered], [[41, "134361771552451534"], [43, null]], "gone is absent, an inspection failure is unknown");
  assert.deepEqual([...parseWindowsIdentities('{"pid":42,"procStart":null,"gone":true}', [42])], []);
});

test("an identity helper that answers nothing leaves every owner unknown and cached validation intact", () => {
  let clock = 0;
  let identities = new Map([[42, "owner-start"]]);
  const validate = createSessionRegistryOwnerValidator({ now: () => clock, processIdentities: () => identities });
  const entries = [{ sessionId: "live", pid: 42, procStart: "owner-start" }];
  assert.deepEqual([...validate(entries)], [["live", true]]);
  clock += 10_000;
  identities = parseWindowsIdentities("", [42]);
  assert.deepEqual([...validate(entries)], [], "no answer is unknown, not false");
  identities = new Map([[42, "owner-start"]]);
  assert.deepEqual([...validate(entries)], [["live", true]]);
});

test("the owner validator counts each probe outcome and holds no process detail", () => {
  const counters = createOwnerProbeCounters();
  let clock = 0;
  let identities = new Map([[41, "start-41"], [42, "other-start"], [44, null]]);
  let exists = null;
  const validate = createSessionRegistryOwnerValidator({
    counters, now: () => clock, processIdentities: () => identities, processExists: () => exists,
  });
  const entries = [41, 42, 43, 44].map((pid) => ({ sessionId: `session-${pid}`, pid, procStart: `start-${pid}` }));
  assert.deepEqual([...validate(entries)], [["session-41", true], ["session-42", false], ["session-43", false]]);
  clock += 10_000;
  identities = null;
  validate(entries);
  exists = false;
  assert.equal(validate(entries).get("session-41"), false);
  counters.record("pid 42");
  counters.record("procStart");
  assert.deepEqual(counters.snapshot(), {
    probeAnswers: 1, probeNoAnswers: 2, ownersCurrent: 1, ownersReplaced: 1, ownersAbsent: 1, ownersUnknown: 1,
    ownersExited: 1, sessionsClosed: 0, sessionsReinstated: 0,
  });
  assert.deepEqual(Object.keys(counters.snapshot()), [...OWNER_PROBE_COUNTERS]);
  assert.doesNotMatch(JSON.stringify(counters.snapshot()), /start-|session-|4[1-4]/u);
});

test("the Windows identity helper answers for a live owner, a replaced one, and an absent one", { skip: process.platform !== "win32" }, () => {
  const counters = createOwnerProbeCounters();
  const validate = createSessionRegistryOwnerValidator({ counters });
  const result = validate([
    { sessionId: "replaced", pid: process.pid, procStart: "1" },
    { sessionId: "absent", pid: 2_147_483_646, procStart: "1" },
  ]);
  // A slow helper answers nothing, and then nothing is judged.
  if (counters.snapshot().probeAnswers === 0) { assert.equal(result.size, 0); return; }
  assert.deepEqual([...result], [["replaced", false], ["absent", false]]);
  assert.deepEqual([counters.snapshot().ownersReplaced, counters.snapshot().ownersAbsent], [1, 1]);
});

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
    processExists: () => null,
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

test("a registry procStart change for the same pid is re-probed immediately, not compared against a stale cache", () => {
  let checkedAt = 1_786_000_000_000;
  let calls = 0;
  const validate = createSessionRegistryOwnerValidator({
    now: () => checkedAt,
    processExists: () => null,
    processIdentities(pids) {
      calls += 1;
      return new Map(pids.map((pid) => [pid, `start-${pid}`]));
    },
  });
  const entry = { sessionId: "session", pid: 42, procStart: "start-42" };
  assert.equal(validate([entry]).get("session"), true);
  assert.equal(calls, 1);
  checkedAt += 1;
  assert.equal(validate([entry]).get("session"), true, "an unchanged identity reuses the cache");
  assert.equal(calls, 1);

  const replaced = { sessionId: "session", pid: 42, procStart: "start-99" };
  assert.equal(validate([replaced]).get("session"), false, "a changed procStart forces a fresh probe rather than a stale comparison");
  assert.equal(calls, 2);
});

test("a cheap liveness check ends a cached positive owner's validity before the revalidation interval elapses", () => {
  let checkedAt = 1_786_000_000_000;
  let calls = 0;
  let alive = true;
  const validate = createSessionRegistryOwnerValidator({
    now: () => checkedAt,
    cacheMs: 30_000,
    processExists: () => (alive ? null : false),
    processIdentities(pids) {
      calls += 1;
      return new Map(pids.map((pid) => [pid, "owner-start"]));
    },
  });
  const entry = { sessionId: "session", pid: 42, procStart: "owner-start" };
  assert.equal(validate([entry]).get("session"), true);
  assert.equal(calls, 1);

  checkedAt += 1_000; // still well inside the revalidation interval
  alive = false;
  assert.equal(validate([entry]).get("session"), false, "a definite exit ends validity without waiting for the interval");
  assert.equal(calls, 1, "the cheap liveness check never spawns a process");
});

test("stale owners refresh asynchronously: reads never spawn synchronously, and a changed identity lands within the stale bound", async () => {
  let checkedAt = 1_786_000_000_000;
  let syncCalls = 0;
  let asyncCalls = 0;
  let ownerStart = "owner-start";
  const validate = createSessionRegistryOwnerValidator({
    now: () => checkedAt,
    processExists: () => null,
    processIdentities(pids) {
      syncCalls += 1;
      return new Map(pids.map((pid) => [pid, ownerStart]));
    },
    async processIdentitiesAsync(pids) {
      asyncCalls += 1;
      return new Map(pids.map((pid) => [pid, ownerStart]));
    },
  });
  const entries = Array.from({ length: 5 }, (_, index) => ({ sessionId: `session-${index}`, pid: 100 + index, procStart: "owner-start" }));
  validate(entries);
  assert.equal(syncCalls, 1);
  for (let read = 0; read < 20; read += 1) {
    checkedAt += 100;
    assert.equal(validate(entries).get("session-0"), true);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(syncCalls, 1, "no read past the fresh window spawns synchronously while an async refresh is possible");
  assert.equal(asyncCalls, 1, "one background refresh covers every stale owner");

  ownerStart = "reused-pid-start";
  checkedAt += 2_000;
  assert.equal(validate(entries).get("session-0"), true, "the last answer is served while the refresh runs");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(validate(entries).get("session-0"), false, "a reused pid is retired as soon as the refresh answers");
  assert.equal(syncCalls, 1);
});

test("an owner whose refresh has not answered within the stale bound of its start is re-probed synchronously", () => {
  let checkedAt = 1_786_000_000_000;
  let syncCalls = 0;
  const validate = createSessionRegistryOwnerValidator({
    now: () => checkedAt,
    processExists: () => null,
    processIdentities(pids) {
      syncCalls += 1;
      return new Map(pids.map((pid) => [pid, syncCalls === 1 ? "owner-start" : "other-start"]));
    },
    processIdentitiesAsync: () => new Promise(() => {}),
  });
  const entries = [{ sessionId: "session-a", pid: 100, procStart: "owner-start" }];
  assert.equal(validate(entries).get("session-a"), true);
  checkedAt += 3_000;
  assert.equal(validate(entries).get("session-a"), true);
  assert.equal(syncCalls, 1);
  checkedAt += 3_000;
  assert.equal(validate(entries).get("session-a"), true, "a refresh that started 3 s ago may still answer");
  assert.equal(syncCalls, 1);
  checkedAt += 2_100;
  assert.equal(validate(entries).get("session-a"), false, "past the stale bound of the refresh the answer comes from a fresh probe");
  assert.equal(syncCalls, 2);
});

test("a read long after the last one re-confirms a still-running owner asynchronously, never with a synchronous probe", async () => {
  let checkedAt = 1_786_000_000_000;
  let syncCalls = 0;
  let asyncCalls = 0;
  let ownerStart = "owner-start";
  const validate = createSessionRegistryOwnerValidator({
    now: () => checkedAt,
    processExists: () => true,
    processIdentities(pids) {
      syncCalls += 1;
      return new Map(pids.map((pid) => [pid, ownerStart]));
    },
    async processIdentitiesAsync(pids) {
      asyncCalls += 1;
      return new Map(pids.map((pid) => [pid, ownerStart]));
    },
  });
  const entries = [{ sessionId: "session-a", pid: 100, procStart: "owner-start" }];
  assert.equal(validate(entries).get("session-a"), true);
  assert.equal(syncCalls, 1, "a first check still probes synchronously");
  checkedAt += 20_000;
  assert.equal(validate(entries).get("session-a"), true, "the last answer is served while the refresh runs");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(syncCalls, 1);
  assert.equal(asyncCalls, 1);

  ownerStart = "reused-pid-start";
  checkedAt += 20_000;
  assert.equal(validate(entries).get("session-a"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(validate(entries).get("session-a"), false, "a reused pid is retired as soon as the refresh answers");
  assert.equal(syncCalls, 1);
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
  await writeFile(path.join(root, "unsafe.json"), JSON.stringify({ sessionId: "../../../unsafe", status: "waiting", waitingFor: "input" }));

  const registry = readSessionRegistry(root);
  assert.equal(registry.size, 1);
  assert.equal(registry.get("live-session").needsInput, true);
});

test("owner inspection distinguishes absent processes from individual permission failures", () => {
  const validate = createSessionRegistryOwnerValidator({
    processIdentities: () => new Map([[41, null], [43, "new-start"]]),
  });
  const result = validate([41, 42, 43].map((pid) => ({ sessionId: `session-${pid}`, pid, procStart: "old-start" })));
  assert.equal(result.has("session-41"), false, "unknown start identity is not proof of exit");
  assert.equal(result.get("session-42"), false, "absent process is definite exit");
  assert.equal(result.get("session-43"), false, "reused PID is not the registered owner");
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
