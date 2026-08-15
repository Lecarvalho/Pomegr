import assert from "node:assert/strict";
import test from "node:test";
import { createResourceUsageSampler } from "../monitor/resource-usage.mjs";

const WINDOWS_FILETIME_EPOCH = 116_444_736_000_000_000n;
const OWNER_A = "2026-08-14T12:00:00.123Z";
const CHILD_A = "2026-08-14T12:00:01.000Z";
const CHILD_B = "2026-08-14T12:00:02.000Z";
const OWNER_B = "2026-08-14T12:00:03.000Z";
const NEW_OWNER = "2026-08-14T12:00:04.000Z";

function fileTime(timestamp) {
  return (WINDOWS_FILETIME_EPOCH + BigInt(Date.parse(timestamp)) * 10_000n).toString();
}

const target = (sessionId, pid, processStartIdentity, status = "available") => ({
  sessionId, pid, processStartIdentity, status,
});

const processRecord = (pid, parentPid, processStartIdentity, values = {}) => ({
  pid,
  parentPid,
  processStartIdentity,
  cpuTimeMs: values.cpuTimeMs ?? 0,
  memoryBytes: values.memoryBytes ?? 0,
  readBytes: values.readBytes ?? 0,
  writeBytes: values.writeBytes ?? 0,
});

test("aggregates an owner process tree and derives rates after the first sample", async () => {
  let now = Date.parse("2026-08-14T12:00:00.000Z");
  let reads = 0;
  const snapshots = [
    [
      processRecord(10, 1, fileTime(OWNER_A), { cpuTimeMs: 100, memoryBytes: 1_000, readBytes: 1_000, writeBytes: 500 }),
      processRecord(11, 10, fileTime(CHILD_A), { cpuTimeMs: 50, memoryBytes: 2_000, readBytes: 400, writeBytes: 200 }),
      processRecord(99, 1, fileTime(OWNER_B), { cpuTimeMs: 9_000, memoryBytes: 50_000, readBytes: 90_000, writeBytes: 90_000 }),
    ],
    [
      processRecord(10, 1, fileTime(OWNER_A), { cpuTimeMs: 150, memoryBytes: 1_500, readBytes: 1_300, writeBytes: 700 }),
      processRecord(11, 10, fileTime(CHILD_A), { cpuTimeMs: 100, memoryBytes: 2_500, readBytes: 600, writeBytes: 300 }),
    ],
  ];
  const sampler = createResourceUsageSampler({
    platform: "win32",
    now: () => now,
    intervalMs: 5_000,
    logicalProcessorCount: 4,
    readSnapshot: () => snapshots[reads++],
  });

  await sampler.sample([target("session-a", 10, OWNER_A)]);
  assert.deepEqual(sampler.get("session-a"), {
    status: "collecting",
    reason: null,
    current: {
      cpuCores: null,
      cpuMachinePercent: null,
      memoryBytes: 3_000,
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
    },
    observedPeak: { memoryBytes: 3_000 },
    samples: [{
      timestamp: "2026-08-14T12:00:00.000Z",
      cpuCores: null,
      cpuMachinePercent: null,
      memoryBytes: 3_000,
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
    }],
  });

  now += 5_000;
  await sampler.sample([target("session-a", 10, OWNER_A)]);
  const ready = sampler.get("session-a");
  assert.equal(ready.status, "ready");
  assert.equal(ready.current.cpuCores, 0.02);
  assert.equal(ready.current.cpuMachinePercent, 0.5);
  assert.equal(ready.current.memoryBytes, 4_000);
  assert.equal(ready.current.readBytesPerSecond, 100);
  assert.equal(ready.current.writeBytesPerSecond, 60);
  assert.deepEqual(ready.observedPeak, { memoryBytes: 4_000 });
  assert.equal(reads, 2);
  assert.doesNotMatch(JSON.stringify(ready), /session-a|processStart|parentPid|\"pid\"|command|path/i);
});

test("uses one due-gated global snapshot for multiple unique sessions", async () => {
  let now = 1_000;
  let reads = 0;
  const sampler = createResourceUsageSampler({
    platform: "win32",
    now: () => now,
    intervalMs: 5_000,
    readSnapshot: () => {
      reads += 1;
      return [processRecord(10, 1, fileTime(OWNER_A)), processRecord(20, 1, fileTime(OWNER_B))];
    },
  });

  await sampler.sample([target("a", 10, OWNER_A), target("b", 20, OWNER_B)]);
  now += 1_000;
  await sampler.sample([target("a", 10, OWNER_A), target("b", 20, OWNER_B)]);
  assert.equal(reads, 1);
  assert.equal(sampler.get("a").status, "collecting");
  assert.equal(sampler.get("b").status, "collecting");
});

test("coalesces concurrent async requests into one nonblocking snapshot", async () => {
  let reads = 0;
  let release;
  const pendingSnapshot = new Promise((resolve) => { release = resolve; });
  const sampler = createResourceUsageSampler({
    platform: "win32",
    now: () => 1_000,
    readSnapshot: async () => {
      reads += 1;
      return pendingSnapshot;
    },
  });

  const first = sampler.sample([target("a", 10, OWNER_A)]);
  const second = sampler.sample([target("a", 10, OWNER_A)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  release([processRecord(10, 1, fileTime(OWNER_A), { memoryBytes: 512 })]);
  await Promise.all([first, second]);
  assert.equal(sampler.get("a").current.memoryBytes, 512);
});

test("canonicalizes real Windows FileTime and legacy ISO owner identities", async () => {
  const sampler = createResourceUsageSampler({
    platform: "win32",
    now: () => 1_000,
    readSnapshot: () => [processRecord(10, 1, fileTime(OWNER_A), { memoryBytes: 256 })],
  });

  await sampler.sample([target("a", 10, "2026-08-14T12:00:00.1234567Z")]);
  assert.equal(sampler.get("a").reason, null);
  assert.equal(sampler.get("a").current.memoryBytes, 256);

  await sampler.sample([target("malformed", 10, "owner-start-identity")]);
  assert.equal(sampler.get("malformed").reason, "missing_owner");
});

test("handles missing, reused, explicit shared, duplicate, and overlapping owners", async (context) => {
  await context.test("fixed unavailable owner states", async () => {
    const sampler = createResourceUsageSampler({
      platform: "win32",
      now: () => 1_000,
      readSnapshot: () => [processRecord(10, 1, fileTime(NEW_OWNER))],
    });
    await sampler.sample([
      { sessionId: "missing", status: "missing" },
      { sessionId: "shared", status: "shared" },
      target("gone", 99, OWNER_A),
      target("reused", 10, OWNER_A),
    ]);
    assert.equal(sampler.get("missing").reason, "missing_owner");
    assert.equal(sampler.get("shared").reason, "shared_owner");
    assert.equal(sampler.get("gone").reason, "owner_not_found");
    assert.equal(sampler.get("reused").reason, "owner_identity_mismatch");
  });

  await context.test("duplicate and nested trees are not attributed twice", async () => {
    const sampler = createResourceUsageSampler({
      platform: "win32",
      now: () => 1_000,
      readSnapshot: () => [
        processRecord(10, 1, fileTime(OWNER_A)),
        processRecord(11, 10, fileTime(CHILD_A)),
      ],
    });
    await sampler.sample([
      target("same-a", 10, OWNER_A),
      target("same-b", 10, OWNER_A),
      target("parent", 10, OWNER_A),
      target("child", 11, CHILD_A),
    ]);
    for (const id of ["same-a", "same-b", "parent", "child"]) {
      assert.equal(sampler.get(id).reason, "shared_owner");
    }
  });
});

test("degrades unsupported platforms and snapshot failures without leaking errors", async () => {
  const unsupported = createResourceUsageSampler({ platform: "linux", readSnapshot: () => assert.fail("must not read") });
  await unsupported.sample([target("a", 10, OWNER_A)]);
  assert.deepEqual(unsupported.get("a"), {
    status: "unavailable",
    reason: "unsupported_platform",
    current: null,
    observedPeak: null,
    samples: [],
  });

  const failed = createResourceUsageSampler({
    platform: "win32",
    now: () => 1_000,
    readSnapshot: () => { throw new Error("PRIVATE_COMMAND_AND_PATH"); },
  });
  await failed.sample([target("a", 10, OWNER_A)]);
  const result = failed.get("a");
  assert.equal(result.reason, "collection_failed");
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].memoryBytes, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|COMMAND|PATH/);

  const timedOut = createResourceUsageSampler({
    platform: "win32",
    now: () => 2_000,
    collectionTimeoutMs: 5,
    readSnapshot: () => new Promise(() => {}),
  });
  await timedOut.sample([target("timeout", 10, OWNER_A)]);
  assert.equal(timedOut.get("timeout").reason, "collection_failed");
});

test("rejects stale parent edges left behind by PID reuse", async () => {
  const beforeOwner = "2026-08-14T11:59:59.000Z";
  const sampler = createResourceUsageSampler({
    platform: "win32",
    now: () => 1_000,
    readSnapshot: () => [
      processRecord(10, 1, fileTime(OWNER_A), { memoryBytes: 100 }),
      processRecord(11, 10, fileTime(beforeOwner), { memoryBytes: 10_000 }),
      processRecord(12, 10, fileTime(CHILD_A), { memoryBytes: 200 }),
    ],
  });

  await sampler.sample([target("a", 10, OWNER_A)]);
  assert.equal(sampler.get("a").current.memoryBytes, 300);
});

test("process churn and per-counter resets produce safe deltas and chart gaps", async () => {
  let now = 0;
  let index = 0;
  const snapshots = [
    [
      processRecord(10, 1, fileTime(OWNER_A), { cpuTimeMs: 100, memoryBytes: 100, readBytes: 100, writeBytes: 100 }),
      processRecord(11, 10, fileTime(CHILD_A), { cpuTimeMs: 100, memoryBytes: 100, readBytes: 100, writeBytes: 100 }),
    ],
    [
      processRecord(10, 1, fileTime(OWNER_A), { cpuTimeMs: 150, memoryBytes: 150, readBytes: 90, writeBytes: 150 }),
      processRecord(12, 10, fileTime(CHILD_B), { cpuTimeMs: 500, memoryBytes: 250, readBytes: 500, writeBytes: 500 }),
    ],
  ];
  const sampler = createResourceUsageSampler({
    platform: "win32",
    now: () => now,
    intervalMs: 1_000,
    readSnapshot: () => snapshots[index++],
  });
  await sampler.sample([target("a", 10, OWNER_A)]);
  now += 1_000;
  await sampler.sample([target("a", 10, OWNER_A)]);

  const current = sampler.get("a").current;
  assert.equal(current.cpuCores, 0.05);
  assert.equal(current.memoryBytes, 400);
  assert.equal(current.readBytesPerSecond, null);
  assert.equal(current.writeBytesPerSecond, 50);
  assert.equal(sampler.get("a").status, "collecting");
});

test("retains transient gaps, expires the rolling window, and resets when ownership changes", async () => {
  let now = 0;
  let mode = "ok";
  let cpu = 0;
  const sampler = createResourceUsageSampler({
    platform: "win32",
    now: () => now,
    intervalMs: 1_000,
    windowMs: 3_000,
    readSnapshot: () => {
      if (mode === "fail") throw new Error("temporary");
      cpu += 100;
      return [
        processRecord(10, 1, fileTime(OWNER_A), { cpuTimeMs: cpu, memoryBytes: 100 + now }),
        processRecord(20, 1, fileTime(OWNER_B), { cpuTimeMs: cpu, memoryBytes: 200 }),
      ];
    },
  });

  await sampler.sample([target("a", 10, OWNER_A)]);
  now = 1_000;
  mode = "fail";
  await sampler.sample([target("a", 10, OWNER_A)]);
  assert.deepEqual(sampler.get("a").samples.map((sample) => sample.memoryBytes), [100, null]);

  now = 5_000;
  mode = "ok";
  await sampler.sample([target("a", 10, OWNER_A)]);
  assert.deepEqual(sampler.get("a").samples.map((sample) => sample.memoryBytes), [5_100]);
  assert.equal(sampler.get("a").status, "collecting");

  now = 6_000;
  await sampler.sample([target("a", 20, OWNER_B)]);
  const changed = sampler.get("a");
  assert.equal(changed.samples.length, 1);
  assert.equal(changed.current.memoryBytes, 200);
  assert.deepEqual(changed.observedPeak, { memoryBytes: 200 });

  await sampler.sample([]);
  assert.equal(sampler.get("a"), null);
});
