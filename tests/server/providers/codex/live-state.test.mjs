import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../../../../server/providers/codex/index.mjs";
import { CODEX_ROLLOUT_RECORD_CACHE_MAX_BYTES, createCodexLiveState } from "../../../../server/providers/codex/live-state.mjs";
import { createCodexIncrementalObserver } from "../../../../server/providers/codex/observation.mjs";
import { assertNoPrivateFixtureSentinels } from "../../../helpers/provider-fixtures.mjs";

const AT = Date.parse("2026-08-11T18:00:00.000Z");
const KIB = 1024;
const iso = (offsetMs = 0) => new Date(AT + offsetMs).toISOString();
const line = (record) => `${JSON.stringify(record)}\n`;

async function tempRoot(context, prefix) {
  // Rollout discovery resolves real paths; keep fixture paths in the same form on Windows.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** One synthetic record whose serialized line is exactly `bytes` long. */
function sizedLine(bytes, marker = "x") {
  const empty = Buffer.byteLength(line({ type: "fixture", payload: "" }));
  assert.ok(bytes > empty, "fixture size must leave room for the record envelope");
  return line({ type: "fixture", payload: marker.repeat(bytes - empty) });
}

function sessionMeta(id, { parentThreadId = null } = {}) {
  return {
    timestamp: iso(),
    type: "session_meta",
    payload: {
      id,
      session_id: parentThreadId || id,
      ...(parentThreadId
        ? { parent_thread_id: parentThreadId, source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId } } } }
        : { source: "cli" }),
      cwd: "C:\\synthetic\\repo",
      timestamp: iso(),
    },
  };
}

async function writeRollout(directory, id, records, options = {}) {
  const file = path.join(directory, `rollout-${id}.jsonl`);
  const contents = [sessionMeta(id, options), ...records].map(line).join("");
  await writeFile(file, contents, "utf8");
  // Recency is record time; align the file time so liveness sees one consistent clock.
  await utimes(file, new Date(AT), new Date(AT));
  return { file, bytes: Buffer.byteLength(contents) };
}

function liveState(options = {}) {
  return createCodexLiveState({
    scanLimit: 64,
    maximumLiveTailBytes: 64 * KIB,
    maximumLiveTaskHistoryBytes: 64 * KIB,
    ...options,
  });
}

test("retained rollout record bytes stay under the bound across many files, least recently used first", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-record-bound-");
  const bound = 4 * 1000;
  const state = liveState({ maximumRetainedRecordBytes: bound });
  const files = [];
  for (let index = 0; index < 24; index += 1) {
    const file = path.join(root, `rollout-${index}.jsonl`);
    await writeFile(file, sizedLine(1000, String(index % 10)), "utf8");
    files.push(file);
    const { records } = await state.readRolloutRecords(file, true);
    assert.equal(records.length, 1);
    const stats = state.stats();
    assert.equal(stats.retainedRecordBytes, Math.min(index + 1, 4) * 1000);
    assert.ok(stats.retainedRecordBytes <= bound);
    assert.equal(stats.cacheEntries, Math.min(index + 1, 4));
  }
  assert.equal(state.stats().reads, 24);
  assert.equal(state.stats().bytes, 24_000);

  // The four newest files are retained; using the oldest of them keeps it ahead of the next eviction.
  await state.readRolloutRecords(files[20], true);
  assert.equal(state.stats().cacheHits, 1);
  const extra = path.join(root, "rollout-extra.jsonl");
  await writeFile(extra, sizedLine(1000), "utf8");
  await state.readRolloutRecords(extra, true);
  assert.equal(state.stats().reads, 25);
  await state.readRolloutRecords(files[20], true);
  assert.equal(state.stats().reads, 25, "the recently used file is still retained");
  await state.readRolloutRecords(files[21], true);
  assert.equal(state.stats().reads, 26, "the least recently used file was evicted and is read again");
  assert.ok(state.stats().retainedRecordBytes <= bound);
});

test("a rollout larger than the byte bound is returned to its caller and never retained", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-record-oversize-");
  const state = liveState({ maximumRetainedRecordBytes: 4 * 1000 });
  const small = path.join(root, "rollout-small.jsonl");
  const large = path.join(root, "rollout-large.jsonl");
  await writeFile(small, sizedLine(1000), "utf8");
  await writeFile(large, sizedLine(1000).repeat(5), "utf8");

  await state.readRolloutRecords(small, true);
  const first = await state.readRolloutRecords(large, true);
  assert.equal(first.records.length, 5);
  assert.ok(first.generation);
  assert.deepEqual(
    { entries: state.stats().cacheEntries, bytes: state.stats().retainedRecordBytes },
    { entries: 1, bytes: 1000 },
    "the oversized read neither enters the cache nor evicts what fits",
  );
  await state.readRolloutRecords(large, true);
  assert.equal(state.stats().reads, 3);
  await state.readRolloutRecords(small, true);
  assert.equal(state.stats().reads, 3);
  assert.equal(state.stats().cacheHits, 1);

  const unbounded = liveState();
  await unbounded.readRolloutRecords(large, true);
  assert.equal(unbounded.stats().retainedRecordBytes, 5000);
  assert.ok(CODEX_ROLLOUT_RECORD_CACHE_MAX_BYTES >= 5000);
  const none = liveState({ maximumRetainedRecordBytes: 0 });
  await none.readRolloutRecords(small, true);
  assert.equal(none.stats().cacheEntries, 0);
});

test("a rollout cache hit performs no read and still requires identity, size, modification time, and suffix", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-record-hit-");
  const file = path.join(root, "rollout-hit.jsonl");
  const stamp = new Date(AT);
  const write = async (target, marker) => {
    await writeFile(target, sizedLine(600, "a") + sizedLine(600, marker), "utf8");
    await utimes(target, stamp, stamp);
  };
  await write(file, "b");
  const state = liveState();

  const first = await state.readRolloutRecords(file, true);
  const hit = await state.readRolloutRecords(file, true);
  assert.equal(hit.records, first.records, "a hit hands back the retained records");
  assert.deepEqual(hit.generation, first.generation);
  assert.deepEqual(
    { reads: state.stats().reads, bytes: state.stats().bytes, hits: state.stats().cacheHits },
    { reads: 1, bytes: 1200, hits: 1 },
  );

  // A different read window of the same generation is a different entry.
  const tail = await state.readRolloutRecords(file, false, 700);
  assert.equal(tail.records.length, 1);
  assert.equal(state.stats().reads, 2);
  await state.readRolloutRecords(file, true);
  assert.equal(state.stats().reads, 3);

  // Same identity, size, and modification time, different bytes: only the suffix check can refuse it.
  const before = await stat(file);
  await write(file, "c");
  const rewritten = await stat(file);
  assert.deepEqual(
    { ino: rewritten.ino, size: rewritten.size, mtimeMs: rewritten.mtimeMs },
    { ino: before.ino, size: before.size, mtimeMs: before.mtimeMs },
  );
  const afterRewrite = await state.readRolloutRecords(file, true);
  assert.equal(state.stats().reads, 4);
  assert.equal(afterRewrite.records[1].payload[0], "c");
  assert.notEqual(afterRewrite.generation.suffixDigest, first.generation.suffixDigest);

  // Same bytes, different modification time.
  await utimes(file, new Date(AT + 5_000), new Date(AT + 5_000));
  await state.readRolloutRecords(file, true);
  assert.equal(state.stats().reads, 5);

  // Different size.
  await appendFile(file, sizedLine(100), "utf8");
  await utimes(file, new Date(AT + 5_000), new Date(AT + 5_000));
  const afterAppend = await state.readRolloutRecords(file, true);
  assert.equal(afterAppend.records.length, 3);
  assert.equal(state.stats().reads, 6);

  // Same bytes, size, and modification time in a different file at the same path.
  const current = await stat(file);
  const replacement = path.join(root, "rollout-replacement.jsonl");
  await writeFile(replacement, sizedLine(600, "a") + sizedLine(600, "c") + sizedLine(100), "utf8");
  await utimes(replacement, new Date(AT + 5_000), new Date(AT + 5_000));
  await rename(replacement, file);
  const replaced = await stat(file);
  assert.deepEqual({ size: replaced.size, mtimeMs: replaced.mtimeMs }, { size: current.size, mtimeMs: current.mtimeMs });
  assert.notEqual(replaced.ino, current.ino, "the fixture needs a filesystem that reports file identity");
  await state.readRolloutRecords(file, true);
  assert.equal(state.stats().reads, 7);
  assert.equal(state.stats().cacheHits, 1, "no changed generation was served from the cache");
});

test("normalized context outlives evicted and released rollout records and keeps its own file bound", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-record-context-");
  const state = liveState({ scanLimit: 3, maximumRetainedRecordBytes: 2 * 1000 });
  const files = [];
  for (const name of ["a", "b", "c", "d"]) {
    const file = path.join(root, `rollout-${name}.jsonl`);
    await writeFile(file, sizedLine(1000, name), "utf8");
    files.push(file);
  }
  const [fileA, fileB, fileC, fileD] = files;
  const snapshot = (id) => ({ dedupeId: id, actorId: "primary", timestamp: iso(1_000), contextTokens: 120 });
  const compaction = { actorId: "primary", timestamp: iso(2_000), trigger: "auto", preTokens: 215_025, inferred: true };
  const remember = async (file, id) => {
    const { generation } = await state.readRolloutRecords(file, false);
    state.mergeLiveContextEvidence(file, generation, { usageSnapshots: [snapshot(id)], compactions: [compaction] });
    return generation;
  };

  const generationA = await remember(fileA, "a");
  await remember(fileB, "b");
  await remember(fileC, "c");
  assert.equal(state.stats().cacheEntries, 2);
  assert.equal(state.stats().retainedRecordBytes, 2000);
  assert.equal(state.stats().reads, 3);
  // File A's records were evicted by bytes; its normalized context was not.
  assert.equal(state.hasLiveContextContinuity(fileA, generationA), true);
  assert.deepEqual(state.liveContextUsageCache.get(fileA).snapshots, [snapshot("a")]);
  assert.deepEqual(state.liveContextUsageCache.get(fileA).compactions, [compaction]);
  assert.deepEqual(
    state.mergeLiveContextEvidence(fileA, generationA, { usageSnapshots: [], compactions: [] }),
    { snapshots: [snapshot("a")], compactions: [compaction] },
    "an unchanged generation with no new records keeps the last known-good context",
  );

  // A settled session releases its family's records; context is untouched.
  state.releaseSettledRecords("settled", true, [fileB, fileC, undefined]);
  assert.equal(state.stats().cacheEntries, 0);
  assert.equal(state.stats().retainedRecordBytes, 0);
  assert.equal(state.stats().recordReleases, 2);
  assert.equal(state.stats().liveContextUsageEntries, 3);
  assert.deepEqual(state.liveContextUsageCache.get(fileB).snapshots, [snapshot("b")]);

  // Before any catalog pass only the reader's view exists: a live read keeps its records.
  await state.readRolloutRecords(fileB, false);
  state.releaseSettledRecords("unlisted", false, [fileB]);
  assert.equal(state.stats().cacheEntries, 1);
  // After a catalog pass, the sessions it lists as live keep theirs, even for a historical
  // read such as a complete-history replay; every other session releases, whatever the read.
  state.retainRecordsForSessions(["listed-live"]);
  state.releaseSettledRecords("listed-live", true, [fileB]);
  assert.equal(state.stats().cacheEntries, 1);
  state.releaseSettledRecords("unlisted", false, [fileB]);
  assert.equal(state.stats().cacheEntries, 0);
  assert.equal(state.stats().recordReleases, 3);

  // The context cache's own bound drops the least recently merged file, never a newer one.
  await remember(fileD, "d");
  assert.equal(state.stats().liveContextUsageEntries, 3);
  assert.equal(state.liveContextUsageCache.has(fileB), false);
  assert.equal(state.liveContextUsageCache.has(fileA), true, "file A was merged again above");
  assert.equal(state.liveContextUsageCache.has(fileD), true);
});

test("byte-driven eviction of a live rollout's records withdraws no served plan, runtime, task, or context state", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-record-evidence-");
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const tail = KIB;
  const early = [
    { timestamp: iso(1), type: "turn_context", payload: { model: "gpt-early", effort: "high" } },
    { timestamp: iso(2), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 4_321, output_tokens: 7 } } } },
  ];
  const plan = {
    timestamp: iso(3),
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec-plan",
      input: 'const result = await tools.update_plan({plan:[{step:"Keep the plan",status:"in_progress"},{step:"Verify eviction",status:"pending"}]}); text(result);',
    },
  };
  const planOffset = Buffer.byteLength([sessionMeta("evicted-root"), ...early].map(line).join(""));
  const target = await writeRollout(directory, "evicted-root", [...early, plan]);
  const growth = 1000;
  assert.ok(target.bytes <= tail, "the first read sees the whole rollout");
  assert.ok(growth <= tail, "the append is not a skipped gap");
  assert.ok(target.bytes + growth - tail > planOffset, "the append pushes every early record out of the tail");
  const others = [];
  for (const id of ["other-1", "other-2", "other-3"]) {
    others.push(await writeRollout(directory, id, [{ timestamp: iso(1), type: "future_record", payload: { padding: "x".repeat(700) } }]));
  }

  const bound = 2 * KIB;
  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    maximumStateTailBytes: tail,
    maximumTaskHistoryBytes: tail,
    maximumRetainedRecordBytes: bound,
  });
  const first = await provider.readSession("evicted-root", { historical: false });
  assert.deepEqual(first.planTasks.map(({ subject }) => subject), ["Keep the plan", "Verify eviction"]);
  assert.equal(first.agents[0].model, "gpt-early");
  assert.equal(first.usageSnapshots.length, 1);

  for (const id of ["other-1", "other-2", "other-3"]) {
    await provider.readSession(id, { historical: false });
    assert.ok(provider.qaStats().retainedRecordBytes <= bound);
  }
  const evicted = provider.qaStats();
  assert.equal(evicted.reads, 4);
  assert.equal(evicted.cacheEntries, 2, "the first rollout's records were evicted by bytes");
  assert.equal(evicted.retainedRecordBytes, others[1].bytes + others[2].bytes);
  assert.equal(evicted.livePlanTaskEntries, 4);
  assert.equal(evicted.liveContextUsageEntries, 4);
  assert.equal(evicted.liveExecutionTaskEntries, 4);
  assert.equal(evicted.liveCurrentActivityEntries, 4);
  assert.equal(evicted.liveApprovalModeEntries, 4);
  assert.equal(evicted.liveAgentRuntimeEntries, 4);

  await appendFile(target.file, sizedLine(growth), "utf8");
  const second = await provider.readSession("evicted-root", { historical: false });
  const after = provider.qaStats();
  assert.equal(after.reads, 5);
  assert.ok(after.bytes - evicted.bytes <= tail, "the appended rollout costs one bounded tail read");
  assert.deepEqual(second.planTasks, first.planTasks);
  assert.equal(second.agents[0].model, "gpt-early");
  assert.equal(second.agents[0].effort, "high");
  assert.deepEqual(second.usageSnapshots, first.usageSnapshots);
  // Withdrawn per-file state would have been rebuilt from a hydration read of the tail.
  assert.equal(after.taskHydrationReads, 0);
  assert.equal(after.approvalHydrationReads, 0);
  assertNoPrivateFixtureSentinels(second, "Codex evidence after record eviction");
});

test("a settled session keeps no parsed records once its evidence is built, and a replay reads each rollout once", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-record-settled-");
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const finished = { timestamp: iso(5), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } };
  const padding = { timestamp: iso(4), type: "future_record", payload: { padding: "x".repeat(3_000) } };
  const rootRollout = await writeRollout(directory, "settled-root", [padding, finished]);
  const childRollout = await writeRollout(directory, "settled-child", [padding, finished], { parentThreadId: "settled-root" });
  const familyBytes = rootRollout.bytes + childRollout.bytes;
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0, now: () => AT + 24 * 60 * 60_000 });
  const catalog = await provider.listSessions();
  assert.deepEqual(catalog.map(({ localId, isLive }) => ({ localId, isLive })), [{ localId: "settled-root", isLive: false }]);
  provider.qaStats(true);

  const evidence = await provider.readSession("settled-root", { historical: true, completeStory: true });
  assert.equal(evidence.agents.length, 2);
  assert.deepEqual(
    (({ reads, bytes, cacheEntries, retainedRecordBytes, recordReleases }) => ({ reads, bytes, cacheEntries, retainedRecordBytes, recordReleases }))(provider.qaStats()),
    { reads: 2, bytes: familyBytes, cacheEntries: 0, retainedRecordBytes: 0, recordReleases: 2 },
  );

  // The complete-history replay is the one path that parses a settled rollout again:
  // exactly one read of each file per replay, and nothing retained afterwards.
  const history = await provider.readSessionHistory("settled-root");
  assert.equal(history.complete, true);
  const replayed = provider.qaStats();
  assert.deepEqual(
    { reads: replayed.reads, bytes: replayed.bytes, hits: replayed.cacheHits, entries: replayed.cacheEntries, retained: replayed.retainedRecordBytes },
    { reads: 4, bytes: 2 * familyBytes, hits: 0, entries: 0, retained: 0 },
  );

  // The observer reads a session outside its bounded list as live. The catalog pass above
  // does not list this one as live, so that read keeps nothing either.
  await provider.readSession("settled-root", { historical: false, completeStory: true });
  assert.equal(provider.qaStats().reads, 6);
  assert.equal(provider.qaStats().cacheEntries, 0);
  assert.equal(provider.qaStats().retainedRecordBytes, 0);
});

test("a live session's family keeps its records under the bound, so a replay rereads only the appended rollout", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-record-live-");
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const padding = { timestamp: iso(1), type: "future_record", payload: { padding: "x".repeat(3_000) } };
  const started = { timestamp: iso(2), type: "event_msg", payload: { type: "task_started", turn_id: "turn-live" } };
  const finished = { timestamp: iso(3), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-child" } };
  const rootRollout = await writeRollout(directory, "live-root", [padding, started]);
  const childRollout = await writeRollout(directory, "live-child", [padding, finished], { parentThreadId: "live-root" });
  let now = AT + 60_000;
  const provider = createCodexProvider({
    codexHome: root, includeArchived: false, cacheMs: 0, now: () => now,
    writerPresence: { async refresh() {}, current() { return null; }, close() {} },
  });
  assert.equal((await provider.listSessions()).find((row) => row.localId === "live-root")?.isLive, true);
  provider.qaStats(true);

  await provider.readSession("live-root", { historical: false, completeStory: true });
  const built = provider.qaStats();
  assert.equal(built.reads, 2);
  assert.equal(built.cacheEntries, 2);
  assert.equal(built.retainedRecordBytes, rootRollout.bytes + childRollout.bytes);
  assert.ok(built.retainedRecordBytes <= CODEX_ROLLOUT_RECORD_CACHE_MAX_BYTES);

  // A replay of the same generation parses nothing.
  assert.equal((await provider.readSessionHistory("live-root")).complete, true);
  assert.equal(provider.qaStats().reads, 2);
  assert.equal(provider.qaStats().cacheHits, 2);

  // After an append the changed rollout is read once from the start, as before this cache was
  // bounded (its size is part of the cache key); the unchanged child is not read again.
  const appended = line({ timestamp: iso(4), type: "future_record", payload: { padding: "y".repeat(500) } });
  await appendFile(rootRollout.file, appended, "utf8");
  await utimes(rootRollout.file, new Date(AT), new Date(AT));
  await provider.readSessionHistory("live-root");
  const replayed = provider.qaStats();
  assert.equal(replayed.reads, 3);
  assert.equal(replayed.bytes - built.bytes, rootRollout.bytes + Buffer.byteLength(appended));
  assert.equal(replayed.cacheHits, 3);
  assert.equal(replayed.recordReleases, 0);

  // Once the catalog no longer lists the session as live, the next read releases the whole
  // family, including the child whose records it reused.
  await appendFile(rootRollout.file, line({ timestamp: iso(5), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-live" } }), "utf8");
  await utimes(rootRollout.file, new Date(AT), new Date(AT));
  now = AT + 24 * 60 * 60_000;
  assert.equal((await provider.listSessions({ fresh: true })).find((row) => row.localId === "live-root")?.isLive, false);
  await provider.readSession("live-root", { historical: true });
  const settled = provider.qaStats();
  assert.equal(settled.reads, 4);
  assert.equal(settled.cacheEntries, 0);
  assert.equal(settled.retainedRecordBytes, 0);
  assert.equal(settled.recordReleases, 2);
});

test("appends to an observed live rollout are ingested as deltas and never reread from the start", async (context) => {
  const root = await tempRoot(context, "pomegr-codex-record-observer-");
  const directory = path.join(root, "sessions");
  await mkdir(directory);
  const rootId = "observed-root";
  const childId = "observed-child";
  const record = (type, payload) => line({ type, timestamp: iso(), payload });
  const rootFile = path.join(directory, "rollout-root.jsonl");
  const childFile = path.join(directory, "rollout-child.jsonl");
  const padding = record("event_msg", { type: "agent_message", message: "RESPONSE_MUST_NOT_LEAK" }).repeat(30);
  await writeFile(rootFile, record("session_meta", { id: rootId, cwd: root, source: "vscode" }) + padding);
  await writeFile(childFile, record("session_meta", {
    id: childId, parent_thread_id: rootId, cwd: root, source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
  }) + padding);
  const provider = createCodexProvider({
    codexHome: root, cacheMs: 0, includeArchived: false,
    writerPresence: { async refresh() {}, current() { return null; }, close() {} },
  });
  let isLive = true;
  const published = [];
  const reads = [];
  const observer = createCodexIncrementalObserver({
    list: async () => [{ localId: rootId, isLive, activityStatus: isLive ? "working" : "idle" }],
    discoveredMetadata: async () => [
      { localId: rootId, sessionId: rootId, rolloutFile: rootFile },
      { localId: childId, parentThreadId: rootId, rolloutFile: childFile },
    ],
    readEvidence: async (id, options) => {
      reads.push(options);
      return provider.readSession(id, options);
    },
    transcriptPathsBySessionId: new Map(), intervalMs: 60_000,
    watchTargets: [directory], watchSource() { return { close() {} }; },
  });
  const controller = new AbortController();
  context.after(() => controller.abort());
  await observer.start({
    publishCatalog() {}, publishSession(_id, candidate) { published.push(candidate); }, invalidateSession() {},
  }, controller.signal);
  for (let attempt = 0; attempt < 10_000 && !published.length; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.length, 1);

  // The initial complete build reads each rollout once and, for a live session, keeps the records.
  const built = provider.qaStats(true);
  assert.equal(built.reads, 2);
  assert.equal(built.cacheEntries, 2);
  assert.equal(reads.at(-1).completeStory, true);

  for (let index = 0; index < 5; index += 1) {
    await appendFile(rootFile, record("event_msg", { type: "agent_message", message: `RESPONSE_MUST_NOT_LEAK ${index}` }));
    await observer.hydrate(rootId);
    assert.equal(reads.at(-1).completeStory, false);
  }
  assert.equal(reads.length, 6);
  const appended = provider.qaStats();
  assert.deepEqual(
    { reads: appended.reads, bytes: appended.bytes, taskHydrationReads: appended.taskHydrationReads },
    { reads: 0, bytes: 0, taskHydrationReads: 0 },
    "five appends parsed only their own deltas",
  );

  // When the session settles, the next evidence build releases the records the live build kept.
  isLive = false;
  await observer.refresh({ sessionIds: [rootId] });
  await observer.hydrate(rootId);
  assert.equal(reads.at(-1).historical, true);
  const settled = provider.qaStats();
  assert.deepEqual(
    { reads: settled.reads, cacheEntries: settled.cacheEntries, retainedRecordBytes: settled.retainedRecordBytes, recordReleases: settled.recordReleases },
    { reads: 0, cacheEntries: 0, retainedRecordBytes: 0, recordReleases: 2 },
  );
  assertNoPrivateFixtureSentinels(published.at(-1), "observed Codex evidence after record release");
});
