import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildExecutionTasks, createExecutionTaskReader } from "../monitor/execution-tasks.mjs";
import { createClaudeToolCallEvidenceReader, mergeUpdatedAt } from "../monitor/providers/claude-tool-call-evidence.mjs";
import { createClaudeLiveUsageSnapshotReader } from "../monitor/providers/claude-live-usage-snapshots.mjs";
import { parseClaudeContextRecords } from "../monitor/providers/claude-context.mjs";
import { repositoryRelativePath } from "../monitor/repository-path.mjs";

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-warm-derivation-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* createExecutionTaskReader                                                  */
/* -------------------------------------------------------------------------- */

const bash = (id, timestamp, input = {}) => ({
  type: "assistant",
  timestamp,
  message: { content: [{ type: "tool_use", name: "Bash", id, input }] },
});

const shellResult = (id, timestamp, options = {}) => ({
  type: "user",
  timestamp,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: options.isError || false, content: "OUTPUT" }] },
  toolUseResult: { interrupted: options.interrupted || false, backgroundTaskId: options.backgroundTaskId },
});

test("execution task reader: cache hit matches buildExecutionTasks for an identical key", () => {
  const reader = createExecutionTaskReader({});
  const records = [bash("toolu_1", "2026-09-01T00:00:00.000Z", { description: "Run checks" }), shellResult("toolu_1", "2026-09-01T00:00:05.000Z")];
  const options = { historical: false, sessionUpdatedAt: null, taskSignals: new Map() };
  const first = reader.build("/fake/session.jsonl", "gen-1", records, options);
  const second = reader.build("/fake/session.jsonl", "gen-1", records, options);
  assert.deepStrictEqual(first, buildExecutionTasks(records, options));
  assert.deepStrictEqual(second, buildExecutionTasks(records, options));
});

test("execution task reader: a changed key reruns the record pass on the new records", () => {
  const reader = createExecutionTaskReader({});
  const before = [bash("toolu_1", "2026-09-01T00:00:00.000Z", { description: "First" })];
  const after = [bash("toolu_1", "2026-09-01T00:00:00.000Z", { description: "First" }), bash("toolu_2", "2026-09-01T00:01:00.000Z", { description: "Second" })];
  reader.build("/fake/session.jsonl", "gen-1", before, {});
  const second = reader.build("/fake/session.jsonl", "gen-2", after, {});
  assert.deepStrictEqual(second, buildExecutionTasks(after, {}));
  assert.equal(second.length, 2);
});

test("execution task reader: a null key never caches", () => {
  const reader = createExecutionTaskReader({});
  const recordsA = [bash("toolu_1", "2026-09-01T00:00:00.000Z", { description: "A" })];
  const recordsB = [bash("toolu_1", "2026-09-01T00:00:00.000Z", { description: "B" })];
  const first = reader.build("/fake/session.jsonl", null, recordsA, {});
  const second = reader.build("/fake/session.jsonl", null, recordsB, {});
  assert.deepStrictEqual(first, buildExecutionTasks(recordsA, {}));
  assert.deepStrictEqual(second, buildExecutionTasks(recordsB, {}));
  assert.notDeepStrictEqual(first, second);
});

test("execution task reader: the finish pass reruns on a cache hit when historical/sessionUpdatedAt/taskSignals change", () => {
  const reader = createExecutionTaskReader({});
  const records = [bash("toolu_stale", "2026-09-01T00:00:00.000Z", { description: "Still running" })];
  const first = reader.build("/fake/session.jsonl", "gen-1", records, { historical: true, sessionUpdatedAt: "2026-09-01T00:10:00.000Z" });
  const second = reader.build("/fake/session.jsonl", "gen-1", records, { historical: true, sessionUpdatedAt: "2026-09-01T00:20:00.000Z" });
  assert.deepStrictEqual(first, buildExecutionTasks(records, { historical: true, sessionUpdatedAt: "2026-09-01T00:10:00.000Z" }));
  assert.deepStrictEqual(second, buildExecutionTasks(records, { historical: true, sessionUpdatedAt: "2026-09-01T00:20:00.000Z" }));
  assert.notEqual(first[0].finishedAt, second[0].finishedAt);

  const signalsA = new Map([["toolu_stale", { label: "Reviewing", tone: "info", reportedAt: "2026-09-01T00:05:00.000Z" }]]);
  const signalsB = new Map([["toolu_stale", { label: "Approved", tone: "positive", reportedAt: "2026-09-01T00:06:00.000Z" }]]);
  const withSignalA = reader.build("/fake/session.jsonl", "gen-1", records, { taskSignals: signalsA });
  const withSignalB = reader.build("/fake/session.jsonl", "gen-1", records, { taskSignals: signalsB });
  assert.equal(withSignalA[0].signal.label, "Reviewing");
  assert.equal(withSignalB[0].signal.label, "Approved");
});

test("execution task reader: mutating a returned task does not affect the next read", () => {
  const reader = createExecutionTaskReader({});
  const records = [bash("toolu_1", "2026-09-01T00:00:00.000Z", { description: "Run checks" }), shellResult("toolu_1", "2026-09-01T00:00:05.000Z")];
  const first = reader.build("/fake/session.jsonl", "gen-1", records, {});
  first[0].status = "tampered";
  first[0].label = "TAMPERED";
  first.push({ id: "fake", status: "tampered" });
  const second = reader.build("/fake/session.jsonl", "gen-1", records, {});
  assert.deepStrictEqual(second, buildExecutionTasks(records, {}));
});

test("execution task reader: bounds evict the least-recently-used file", () => {
  const reader = createExecutionTaskReader({ maxEntries: 2 });
  const originalA = [bash("toolu_a", "2026-09-01T00:00:00.000Z", { description: "A original" })];
  const changedA = [bash("toolu_a", "2026-09-01T00:00:00.000Z", { description: "A changed" })];
  reader.build("/fake/a.jsonl", "gen-a", originalA, {});
  reader.build("/fake/b.jsonl", "gen-b", [bash("toolu_b", "2026-09-01T00:00:00.000Z", { description: "B" })], {});
  reader.build("/fake/c.jsonl", "gen-c", [bash("toolu_c", "2026-09-01T00:00:00.000Z", { description: "C" })], {});
  // "a" was the least-recently-used file when "c" was added, so its entry should have been evicted;
  // re-reading it with the SAME key but different records must recompute rather than serve stale data.
  const result = reader.build("/fake/a.jsonl", "gen-a", changedA, {});
  assert.deepStrictEqual(result, buildExecutionTasks(changedA, {}));
});

test("execution task reader: pruneMissingFiles drops entries for deleted files", async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, "session.jsonl");
    await writeFile(file, "", "utf8");
    const reader = createExecutionTaskReader({});
    const before = [bash("toolu_1", "2026-09-01T00:00:00.000Z", { description: "Before" })];
    reader.build(file, "gen-1", before, {});
    await rm(file, { force: true });
    reader.pruneMissingFiles();
    const after = [bash("toolu_1", "2026-09-01T00:00:00.000Z", { description: "After" })];
    const result = reader.build(file, "gen-1", after, {});
    assert.deepStrictEqual(result, buildExecutionTasks(after, {}));
  });
});

/* -------------------------------------------------------------------------- */
/* createClaudeToolCallEvidenceReader                                         */
/* -------------------------------------------------------------------------- */

function toolUse(id, timestamp, tool, input = {}) {
  return { type: "assistant", timestamp, message: { content: [{ type: "tool_use", id, name: tool, input }] } };
}
function toolResult(id, timestamp, { isError = false, toolUseResult } = {}) {
  return {
    type: "user",
    timestamp,
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "RESULT" }] },
    toolUseResult,
  };
}
function userText(timestamp, text) {
  return { type: "user", timestamp, message: { content: text } };
}

async function buildToolCallFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-tool-call-evidence-"));
  const target = path.join(root, "file.txt");
  const records = [
    toolUse("write1", "2026-09-01T00:00:00.000Z", "Write", { file_path: target, content: "hi" }),
    toolResult("write1", "2026-09-01T00:00:01.000Z", { toolUseResult: { type: "create" } }),
    toolUse("edit1", "2026-09-01T00:01:00.000Z", "Edit", { file_path: target, old_string: "hi", new_string: "bye" }),
    toolResult("edit1", "2026-09-01T00:01:01.000Z", { toolUseResult: { type: "update" } }),
    toolUse("ask1", "2026-09-01T00:02:00.000Z", "AskUserQuestion", { question: "Continue?" }),
    { type: "user", timestamp: "2026-09-01T00:02:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: "ask1", is_error: false, content: "yes" }] } },
    userText("2026-09-01T00:02:10.000Z", "plain follow-up"),
    toolUse("bash1", "2026-09-01T00:03:00.000Z", "Bash", { command: "echo hi", description: "Echo" }),
    toolResult("bash1", "2026-09-01T00:03:01.000Z", {}),
    toolUse("noresult1", "2026-09-01T00:04:00.000Z", "Read", { file_path: path.join(root, "other.txt") }),
  ];
  return { root, target, records };
}

const primaryActor = { id: "primary", label: "Primary agent" };
const stat = { size: 4_096, mtimeMs: 1_000, mtime: new Date("2026-09-01T00:05:00.000Z") };

test("tool-call evidence reader: cache hit matches the uncached (null key) computation", async () => {
  await withTempDir(async () => {
    const { root, records } = await buildToolCallFixture();
    try {
      const reader = createClaudeToolCallEvidenceReader({});
      const args = { file: "/fake/session.jsonl", records, actor: primaryActor, isMain: true, stat, cwd: root, forbiddenRoots: [], validatePath: repositoryRelativePath };
      const uncached = reader.read({ ...args, key: null });
      const first = reader.read({ ...args, key: "gen-1" });
      const second = reader.read({ ...args, key: "gen-1" });
      assert.deepStrictEqual(first, uncached);
      assert.deepStrictEqual(second, uncached);
      assert.equal(first.calls, 5);
      assert.equal(first.toolCalls.length, 5);
      // Write and Edit each produced a validated file change; Bash and the unresolved Read did not.
      const byId = Object.fromEntries(first.toolCalls.map((call) => [call.id === "write1" || call.id === "edit1" || call.id === "bash1" || call.id === "noresult1" ? call.id : call.id, call]));
      assert.ok(byId.write1?.fileChanges?.length === 1);
      assert.ok(byId.edit1?.fileChanges?.length === 1);
      assert.equal(byId.bash1.fileChanges, null);
      assert.equal(byId.noresult1.fileChanges, null);
      // The AskUserQuestion answer (delivered as a tool_result) and the plain follow-up both
      // resolve to "User input" activity because isMain is true.
      assert.equal(first.userInputActivity.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("tool-call evidence reader: a changed key reruns the record pass on the new records", async () => {
  const { root, records } = await buildToolCallFixture();
  try {
    const reader = createClaudeToolCallEvidenceReader({});
    const base = { file: "/fake/session.jsonl", actor: primaryActor, isMain: true, stat, cwd: root, forbiddenRoots: [], validatePath: repositoryRelativePath };
    reader.read({ ...base, key: "gen-1", records });
    const shrunk = records.slice(0, 2);
    const second = reader.read({ ...base, key: "gen-2", records: shrunk });
    assert.deepStrictEqual(second, reader.read({ ...base, key: null, records: shrunk }));
    assert.equal(second.calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool-call evidence reader: actor label changes flow through on a cache hit", async () => {
  const { root, records } = await buildToolCallFixture();
  try {
    const reader = createClaudeToolCallEvidenceReader({});
    const base = { file: "/fake/session.jsonl", key: "gen-1", records, isMain: true, stat, cwd: root, forbiddenRoots: [], validatePath: repositoryRelativePath };
    const first = reader.read({ ...base, actor: { id: "primary", label: "Primary agent" } });
    const relabeled = reader.read({ ...base, actor: { id: "primary", label: "Renamed agent" } });
    assert.equal(first.toolCalls[0].actor.label, "Primary agent");
    assert.equal(relabeled.toolCalls[0].actor.label, "Renamed agent");
    // Every other field is unaffected by the label-only change.
    assert.deepStrictEqual(
      relabeled.toolCalls.map(({ actor: _actor, ...rest }) => rest),
      first.toolCalls.map(({ actor: _actor, ...rest }) => rest),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool-call evidence reader: isMain changes the cache key and gates user-input activity", async () => {
  const { root, records } = await buildToolCallFixture();
  try {
    const reader = createClaudeToolCallEvidenceReader({});
    const base = { file: "/fake/session.jsonl", key: "gen-1", records, actor: primaryActor, stat, cwd: root, forbiddenRoots: [], validatePath: repositoryRelativePath };
    const asMain = reader.read({ ...base, isMain: true });
    const asChild = reader.read({ ...base, isMain: false });
    assert.equal(asMain.userInputActivity.length, 2);
    assert.equal(asChild.userInputActivity.length, 0);
    assert.deepStrictEqual(asChild, reader.read({ ...base, isMain: false, key: null }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool-call evidence reader: cwd and validator-answer changes always recompute fileChanges", async () => {
  const { root, records } = await buildToolCallFixture();
  try {
    const reader = createClaudeToolCallEvidenceReader({});
    const base = { file: "/fake/session.jsonl", key: "gen-1", records, actor: primaryActor, isMain: true, stat, validatePath: repositoryRelativePath };

    const inRoot = reader.read({ ...base, cwd: root, forbiddenRoots: [] });
    const writeCall = inRoot.toolCalls.find((call) => call.id === "write1");
    assert.ok(writeCall.fileChanges?.length === 1, "the target is inside cwd, so a change is recorded");

    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "pomegr-tool-call-evidence-other-"));
    try {
      const outsideCwd = reader.read({ ...base, cwd: elsewhere, forbiddenRoots: [] });
      const writeCallOutside = outsideCwd.toolCalls.find((call) => call.id === "write1");
      assert.equal(writeCallOutside.fileChanges, null, "the target is outside the new cwd");

      const forbidden = reader.read({ ...base, cwd: root, forbiddenRoots: [root] });
      const writeCallForbidden = forbidden.toolCalls.find((call) => call.id === "write1");
      assert.equal(writeCallForbidden.fileChanges, null, "the validator now forbids the whole root");

      // The cache entry (by key/actor/isMain) never changed across these calls, so this proves
      // fileChanges is recomputed on every read rather than reused from a cached call.
      assert.equal(inRoot.calls, outsideCwd.calls);
      assert.equal(inRoot.calls, forbidden.calls);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool-call evidence reader: mutating a returned tool call does not affect the next read", async () => {
  const { root, records } = await buildToolCallFixture();
  try {
    const reader = createClaudeToolCallEvidenceReader({});
    const args = { file: "/fake/session.jsonl", key: "gen-1", records, actor: primaryActor, isMain: true, stat, cwd: root, forbiddenRoots: [], validatePath: repositoryRelativePath };
    const first = reader.read(args);
    // Every returned tool call is documented as a fresh object (id, actor and all): mutating the
    // returned toolCalls array, or a call within it, must never reach the cached template.
    first.toolCalls[0].detail = "TAMPERED";
    first.toolCalls[0].fileChanges = null;
    first.toolCalls[0].actor.label = "TAMPERED";
    first.toolCalls.push({ id: "fake" });
    first.userInputActivity[0].requestId = "TAMPERED";
    first.userInputActivity[0].detail = "TAMPERED";
    const second = reader.read(args);
    const expected = reader.read({ ...args, key: null });
    assert.deepStrictEqual(second, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool-call evidence reader: bounds evict the least-recently-used file", () => {
  const reader = createClaudeToolCallEvidenceReader({ maxEntries: 2 });
  const stat0 = { size: 10, mtimeMs: 1, mtime: new Date(0) };
  const recordsFor = (label) => [toolUse("id1", "2026-09-01T00:00:00.000Z", "Bash", { command: label, description: label })];
  const args = (file, key, records) => ({ file, key, records, actor: primaryActor, isMain: true, stat: stat0, cwd: "/repo", forbiddenRoots: [], validatePath: () => null });

  reader.read(args("/fake/a.jsonl", "gen-a", recordsFor("A original")));
  reader.read(args("/fake/b.jsonl", "gen-b", recordsFor("B")));
  reader.read(args("/fake/c.jsonl", "gen-c", recordsFor("C")));
  const result = reader.read(args("/fake/a.jsonl", "gen-a", recordsFor("A changed")));
  assert.deepStrictEqual(result, reader.read(args("/fake/a.jsonl", null, recordsFor("A changed"))));
});

test("tool-call evidence reader: pruneMissingFiles drops entries for deleted files", async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, "session.jsonl");
    await writeFile(file, "", "utf8");
    const reader = createClaudeToolCallEvidenceReader({});
    const args = (records) => ({ file, key: "gen-1", records, actor: primaryActor, isMain: true, stat, cwd: root, forbiddenRoots: [], validatePath: repositoryRelativePath });
    reader.read(args([toolUse("id1", "2026-09-01T00:00:00.000Z", "Bash", { description: "Before" })]));
    await rm(file, { force: true });
    reader.pruneMissingFiles();
    const after = [toolUse("id1", "2026-09-01T00:00:00.000Z", "Bash", { description: "After" })];
    const result = reader.read(args(after));
    assert.deepStrictEqual(result, reader.read({ ...args(after), key: null }));
  });
});

/* -------------------------------------------------------------------------- */
/* mergeUpdatedAt: exact equivalence to the sequential fold                   */
/* -------------------------------------------------------------------------- */

/** Independent ground truth: the exact original per-record fold across every file, in order. */
function naiveUpdatedAtFold(fileRecordsList) {
  let updatedAt = null;
  for (const records of fileRecordsList) {
    for (const record of records) {
      const timestamp = record.timestamp || record.message?.timestamp;
      if (timestamp) {
        if (!updatedAt || new Date(timestamp) > new Date(updatedAt)) updatedAt = timestamp;
      }
    }
  }
  return updatedAt;
}

function updatedAtFor(records) {
  const reader = createClaudeToolCallEvidenceReader({});
  return reader.read({
    file: "/fake/any.jsonl", key: null, records, actor: primaryActor, isMain: false,
    stat, cwd: "/repo", forbiddenRoots: [], validatePath: () => null,
  }).updatedAt;
}

test("mergeUpdatedAt matches a sequential fold across multiple files, including the invalid-first case", () => {
  const fileA = [{ type: "assistant", timestamp: "not-a-real-date", message: {} }, { type: "assistant", timestamp: "2026-09-01T00:10:00.000Z", message: {} }];
  const fileB = [{ type: "assistant", timestamp: "2026-09-01T00:20:00.000Z", message: {} }];
  const folded = mergeUpdatedAt(mergeUpdatedAt(null, updatedAtFor(fileA)), updatedAtFor(fileB));
  assert.equal(folded, naiveUpdatedAtFold([fileA, fileB]));
  assert.equal(folded, "not-a-real-date", "the first truthy timestamp overall was invalid, so the fold sticks there");
});

test("mergeUpdatedAt matches a sequential fold for ordinary valid timestamps across files, including missing ones", () => {
  const fileA = [
    { type: "user", message: {} }, // no timestamp: ignored
    { type: "assistant", timestamp: "2026-09-01T00:05:00.000Z", message: {} },
    { type: "assistant", timestamp: "2026-09-01T00:15:00.000Z", message: {} },
  ];
  const fileB = [
    { type: "assistant", timestamp: "not-valid-either", message: {} }, // invalid, but global is already valid: ignored
    { type: "assistant", timestamp: "2026-09-01T00:10:00.000Z", message: {} }, // earlier than the running max: ignored
    { type: "assistant", timestamp: "2026-09-01T00:30:00.000Z", message: {} },
  ];
  const fileC = []; // no timestamps at all
  const folded = mergeUpdatedAt(mergeUpdatedAt(mergeUpdatedAt(null, updatedAtFor(fileA)), updatedAtFor(fileB)), updatedAtFor(fileC));
  assert.equal(folded, naiveUpdatedAtFold([fileA, fileB, fileC]));
  assert.equal(folded, "2026-09-01T00:30:00.000Z");
});

test("mergeUpdatedAt leaves the accumulator unchanged when a file has no truthy timestamps", () => {
  assert.equal(mergeUpdatedAt(null, { first: null, bestValid: null }), null);
  assert.equal(mergeUpdatedAt("2026-09-01T00:00:00.000Z", { first: null, bestValid: null }), "2026-09-01T00:00:00.000Z");
});

/* -------------------------------------------------------------------------- */
/* createClaudeLiveUsageSnapshotReader: historical caching                    */
/* -------------------------------------------------------------------------- */

function assistantUsage(id, timestamp, usage) {
  return { type: "assistant", timestamp, message: { id, model: "claude-test", usage, content: [] } };
}

function usageRecords(count, startSecond = 0) {
  return Array.from({ length: count }, (_, index) => assistantUsage(
    `req-${startSecond + index}`,
    `2026-09-01T00:00:${String(startSecond + index).padStart(2, "0")}.000Z`,
    { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ));
}

const historicalStat = { size: 512, mtimeMs: 2_000, mtime: new Date("2026-09-01T00:05:00.000Z") };
const historicalActor = { id: "primary", label: "Primary agent" };

function referenceHistoricalParse(records, actor, stat, sessionId, compactionTimestamps) {
  return parseClaudeContextRecords(records, {
    actorId: actor.id,
    sourceKey: actor.id,
    fallbackTimestamp: stat.mtime.toISOString(),
    completeHistory: true,
    expectedSessionId: sessionId,
    compactionTimestamps,
    includeToolUseIds: true,
    unlimited: false,
  });
}

test("live usage snapshot reader: historical cache hit matches the direct parse for an identical key", () => {
  const readerInstance = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: 10 * 1024 * 1024 });
  const records = usageRecords(3);
  const generation = { identity: "id-1", size: 111, mtimeMs: 222, suffixDigest: "digest-1" };
  const first = readerInstance.read("/fake/session.jsonl", records, historicalActor, historicalStat, true, "session-1", [], false, generation);
  const second = readerInstance.read("/fake/session.jsonl", records, historicalActor, historicalStat, true, "session-1", [], false, generation);
  const expected = referenceHistoricalParse(records, historicalActor, historicalStat, "session-1", []);
  assert.deepStrictEqual(first, expected);
  assert.deepStrictEqual(second, expected);
  assert.equal(second, first, "an exact key match serves the retained (shared-reference) array");
});

test("live usage snapshot reader: a changed generation, actor, session, compaction list, or completeHistory flag reparses", () => {
  const readerInstance = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: 10 * 1024 * 1024 });
  const records = usageRecords(2);
  const generation = { identity: "id-1", size: 111, mtimeMs: 222, suffixDigest: "digest-1" };
  const generation2 = { identity: "id-1", size: 333, mtimeMs: 444, suffixDigest: "digest-2" };
  const file = "/fake/session.jsonl";

  readerInstance.read(file, records, historicalActor, historicalStat, true, "session-1", [], false, generation);
  const changedGeneration = readerInstance.read(file, usageRecords(4), historicalActor, historicalStat, true, "session-1", [], false, generation2);
  assert.deepStrictEqual(changedGeneration, referenceHistoricalParse(usageRecords(4), historicalActor, historicalStat, "session-1", []));

  readerInstance.read(file, records, historicalActor, historicalStat, true, "session-1", [], false, generation);
  const changedActor = readerInstance.read(file, usageRecords(5), { id: "agent-child", label: "Child" }, historicalStat, true, "session-1", [], false, generation);
  assert.deepStrictEqual(changedActor, referenceHistoricalParse(usageRecords(5), { id: "agent-child", label: "Child" }, historicalStat, "session-1", []));

  readerInstance.read(file, records, historicalActor, historicalStat, true, "session-1", [], false, generation);
  const changedSession = readerInstance.read(file, usageRecords(6), historicalActor, historicalStat, true, "session-2", [], false, generation);
  assert.deepStrictEqual(changedSession, referenceHistoricalParse(usageRecords(6), historicalActor, historicalStat, "session-2", []));

  readerInstance.read(file, records, historicalActor, historicalStat, true, "session-1", [], false, generation);
  const changedCompactions = readerInstance.read(file, usageRecords(7), historicalActor, historicalStat, true, "session-1", ["2026-09-01T00:00:01.000Z"], false, generation);
  assert.deepStrictEqual(changedCompactions, referenceHistoricalParse(usageRecords(7), historicalActor, historicalStat, "session-1", ["2026-09-01T00:00:01.000Z"]));
});

test("live usage snapshot reader: historical bounds evict the least-recently-used file", () => {
  const readerInstance = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: 10 * 1024 * 1024, maxEntries: 2 });
  const generation = { identity: "id-1", size: 111, mtimeMs: 222, suffixDigest: "digest-1" };
  const read = (file, count) => readerInstance.read(file, usageRecords(count), historicalActor, historicalStat, true, "session-1", [], false, generation);
  read("/fake/a.jsonl", 1);
  read("/fake/b.jsonl", 1);
  read("/fake/c.jsonl", 1);
  const result = read("/fake/a.jsonl", 4);
  assert.deepStrictEqual(result, referenceHistoricalParse(usageRecords(4), historicalActor, historicalStat, "session-1", []));
});

test("live usage snapshot reader: pruneMissingFiles drops historical entries for deleted files", async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, "session.jsonl");
    await writeFile(file, "", "utf8");
    const readerInstance = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: 10 * 1024 * 1024 });
    const generation = { identity: "id-1", size: 111, mtimeMs: 222, suffixDigest: "digest-1" };
    readerInstance.read(file, usageRecords(1), historicalActor, historicalStat, true, "session-1", [], false, generation);
    await rm(file, { force: true });
    readerInstance.pruneMissingFiles();
    const result = readerInstance.read(file, usageRecords(2), historicalActor, historicalStat, true, "session-1", [], false, generation);
    assert.deepStrictEqual(result, referenceHistoricalParse(usageRecords(2), historicalActor, historicalStat, "session-1", []));
  });
});

test("live usage snapshot reader: unlimited reads never use or populate the historical cache", () => {
  const readerInstance = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: 10 * 1024 * 1024 });
  const generation = { identity: "id-1", size: 111, mtimeMs: 222, suffixDigest: "digest-1" };
  const records = usageRecords(2);
  const unlimitedResult = readerInstance.read("/fake/session.jsonl", records, historicalActor, historicalStat, true, "session-1", [], true, generation);
  const differentRecords = usageRecords(9);
  const secondUnlimited = readerInstance.read("/fake/session.jsonl", differentRecords, historicalActor, historicalStat, true, "session-1", [], true, generation);
  assert.deepStrictEqual(unlimitedResult, parseClaudeContextRecords(records, {
    actorId: historicalActor.id, sourceKey: historicalActor.id, fallbackTimestamp: historicalStat.mtime.toISOString(),
    completeHistory: true, expectedSessionId: "session-1", compactionTimestamps: [], includeToolUseIds: true, unlimited: true,
  }));
  assert.notDeepStrictEqual(secondUnlimited, unlimitedResult);
});

test("live usage snapshot reader: no generation degrades to an uncached parse", () => {
  const readerInstance = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: 10 * 1024 * 1024 });
  const records = usageRecords(1);
  const result = readerInstance.read("/fake/session.jsonl", records, historicalActor, historicalStat, true, "session-1", [], false, null);
  assert.deepStrictEqual(result, referenceHistoricalParse(records, historicalActor, historicalStat, "session-1", []));
});

test("every per-file cache prunes through a caller-supplied existence check", () => {
  const records = [bash("t1", "2026-09-01T00:00:00.000Z", { description: "Echo" })];
  const tasks = createExecutionTaskReader({});
  const toolCalls = createClaudeToolCallEvidenceReader({});
  const usage = createClaudeLiveUsageSnapshotReader({ maximumBytesPerFile: 1_024 });
  tasks.build("/fake/a.jsonl", "gen-1", records, {});
  toolCalls.read({ file: "/fake/a.jsonl", key: "gen-1", records, actor: primaryActor, isMain: true, stat, cwd: "/fake", forbiddenRoots: [], validatePath: repositoryRelativePath });
  const asked = [];
  const exists = (file) => { asked.push(file); return false; };
  for (const cache of [tasks, toolCalls, usage]) cache.pruneMissingFiles(exists);
  assert.deepStrictEqual(asked, ["/fake/a.jsonl", "/fake/a.jsonl"]);
  // Pruned: a second prune asks about nothing.
  asked.length = 0;
  for (const cache of [tasks, toolCalls, usage]) cache.pruneMissingFiles(exists);
  assert.deepStrictEqual(asked, []);
});
