import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createIncrementalJsonlIngestor } from "../monitor/providers/incremental-jsonl-ingestor.mjs";
import { createCodexIncrementalObserver, mergeCodexObservationEvidence } from "../monitor/providers/codex-observation.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { incrementalSourceSetDescriptor } from "../monitor/providers/incremental-provider-observer.mjs";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";
import { OBSERVATION_WORKING_SET_MS } from "../monitor/observation-working-set.mjs";
import { assertNoPrivateFixtureSentinels, readProviderFixture } from "./helpers/provider-fixtures.mjs";

function sourceReader(buffers) {
  return async (offset, bytes, source) => buffers.get(source.identity).subarray(offset, offset + bytes);
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observer state");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function watchHarness() {
  const listeners = [];
  return {
    watch(_target, options, callback) {
      listeners.push(typeof options === "function" ? options : callback);
      return { close() {} };
    },
    emit(eventType, filename, index = 0) {
      listeners[index]?.(eventType, filename);
    },
  };
}

async function writeProviderFixture(file, fixture, replacements = []) {
  let contents = await readProviderFixture(fixture);
  for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

test("incremental provider framing consumes multi-chunk growth and parses each complete record once", async () => {
  const sources = new Map([["one", Buffer.from('{"id":"a"}\n')]]);
  const published = [];
  let parsed = 0;
  const ingestor = createIncrementalJsonlIngestor({
    readChunk: sourceReader(sources),
    parseRecord: (line) => {
      parsed += 1;
      return JSON.parse(line.toString("utf8"));
    },
    initialState: () => [],
    reduce: (state, record) => [...state, record.id],
    chunkBytes: 5,
    maximumFragmentBytes: 20,
  });
  await ingestor.observe({ identity: "one", size: sources.get("one").length }, (candidate) => published.push(candidate));
  assert.deepEqual(published, [["a"]]);
  sources.set("one", Buffer.from('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n'));
  await ingestor.observe({ identity: "one", size: sources.get("one").length }, (candidate) => published.push(candidate));
  assert.deepEqual(published.at(-1), ["a", "b", "c"]);
  assert.equal(parsed, 3);
  assert.equal(ingestor.snapshot().completeOffset, sources.get("one").length);

  const partial = Buffer.from('{"id":"x"}\n{"id":"y"');
  sources.set("two", partial);
  await ingestor.observe({ identity: "two", size: partial.length }, (candidate, meta) => published.push({ candidate, meta }));
  assert.deepEqual(published.at(-1), ["a", "b", "c"]);
  const completed = Buffer.from('{"id":"x"}\n{"id":"y"}\n');
  sources.set("two", completed);
  await ingestor.observe({ identity: "two", size: completed.length }, (candidate) => published.push(candidate));
  assert.deepEqual(published.at(-1), ["x", "y"]);
  assert.equal(parsed, 5);
});

test("incremental framing yields between bounded chunks so serving can run", async () => {
  const source = Buffer.from('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
  let yields = 0;
  const ingestor = createIncrementalJsonlIngestor({
    readChunk: async (offset, bytes) => source.subarray(offset, offset + bytes),
    parseRecord: (line) => JSON.parse(line.toString("utf8")),
    initialState: () => [],
    reduce: (state, record) => [...state, record.id],
    chunkBytes: 5,
    maximumFragmentBytes: 20,
    async yieldControl() { yields += 1; },
  });
  await ingestor.observe({ identity: "cooperative", size: source.length }, () => {});
  assert.equal(yields, Math.ceil(source.length / 5));
});

test("queued hydration yields before provider work begins", async (context) => {
  let releaseYield;
  let acquisitions = 0;
  const controller = new AbortController();
  const observer = createNormalizedPollingObserver({
    list: async () => [],
    ingest: async () => {
      acquisitions += 1;
      return null;
    },
    intervalMs: 60_000,
    yieldControl: () => new Promise((resolve) => { releaseYield = resolve; }),
  });
  context.after(() => controller.abort());
  await observer.start({
    publishCatalog() {},
    publishSession() {},
    invalidateSession() {},
  }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));

  const hydration = observer.hydrate("one");
  assert.equal(acquisitions, 0);
  assert.equal(typeof releaseYield, "function");
  releaseYield();
  await hydration;
  assert.equal(acquisitions, 1);
});

test("provider observers report bounded phase timings without session identity", async (context) => {
  let clock = 0;
  const controller = new AbortController();
  const observer = createNormalizedPollingObserver({
    async list() { clock += 5; return []; },
    async prepare() { clock += 7; return new Map(); },
    async ingest() { clock += 11; return { session: { title: "PRIVATE_TITLE_MUST_NOT_LEAK" } }; },
    intervalMs: 60_000,
    monotonicNow: () => clock,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  await waitFor(() => observer.diagnostics().timings.catalogDiscovery.sampleCount === 1);
  assert.equal(await observer.hydrate("private-session-id"), true);

  const diagnostics = observer.diagnostics();
  assert.equal(diagnostics.hydrationConcurrency, 2);
  assert.equal(diagnostics.timings.catalogDiscovery.lastMs, 5);
  assert.equal(diagnostics.timings.preparation.lastMs, 7);
  assert.equal(diagnostics.timings.acquisitionNormalization.lastMs, 11);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_TITLE|private-session-id/);
});

test("source queue timing uses the monotonic clock across a wall-clock regression", async (context) => {
  let wallClock = 50_000;
  let monotonicClock = 100;
  const controller = new AbortController();
  const watcher = watchHarness();
  const observer = createNormalizedPollingObserver({
    list: async () => [],
    ingest: async () => null,
    routeSourceEvent: () => ({ catalog: false, sessionIds: ["one"] }),
    watchTargets: ["synthetic-root"],
    watchSource: watcher.watch,
    intervalMs: 60_000,
    now: () => { wallClock -= 10_000; return wallClock; },
    monotonicNow: () => { const value = monotonicClock; monotonicClock += 5; return value; },
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);
  watcher.emit("change", "one.jsonl");
  await waitFor(() => observer.diagnostics().sourceEventQueueSamples === 1);

  assert.equal(observer.diagnostics().timings.queueWait.lastMs, 5);
});

test("source events publish a fresh catalog without waiting for slow hydration", async (context) => {
  const controller = new AbortController();
  const watcher = watchHarness();
  const releaseSlow = deferred();
  let slowStarted = false;
  let entries = [{ localId: "one", isLive: true }];
  const catalogs = [];
  const listOptions = [];
  const observer = createNormalizedPollingObserver({
    list: async (options) => {
      listOptions.push(options);
      return entries;
    },
    ingest: async (localSessionId) => {
      if (localSessionId === "one" && !slowStarted) {
        slowStarted = true;
        await releaseSlow.promise;
      }
      return null;
    },
    routeSourceEvent: () => ({ catalog: true, sessionIds: [] }),
    watchTargets: ["synthetic-root"],
    watchSource: watcher.watch,
    intervalMs: 60_000,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({
    publishCatalog(value) { catalogs.push(value.map((entry) => entry.localId)); },
    publishSession() {},
    invalidateSession() {},
  }, controller.signal);
  await waitFor(() => slowStarted && catalogs.length === 1);

  entries = [...entries, { localId: "two", isLive: true }];
  watcher.emit("rename", "two.jsonl");
  await waitFor(() => catalogs.some((catalog) => catalog.includes("two")));

  assert.equal(listOptions.some((options) => options?.fresh === true), true);
  assert.equal(observer.diagnostics().activeHydrations >= 1, true);
  releaseSlow.resolve();
});

test("session events run different sessions in parallel and coalesce a dirty in-flight session", async (context) => {
  const controller = new AbortController();
  const watcher = watchHarness();
  const releaseA = deferred();
  const releaseB = deferred();
  const attempts = new Map();
  const active = new Set();
  let maximumActive = 0;
  const observer = createNormalizedPollingObserver({
    list: async () => [],
    ingest: async (localSessionId) => {
      assert.equal(active.has(localSessionId), false, "one session must never acquire concurrently with itself");
      active.add(localSessionId);
      maximumActive = Math.max(maximumActive, active.size);
      const attempt = (attempts.get(localSessionId) || 0) + 1;
      attempts.set(localSessionId, attempt);
      if (localSessionId === "a" && attempt === 1) await releaseA.promise;
      if (localSessionId === "b" && attempt === 1) await releaseB.promise;
      active.delete(localSessionId);
      return null;
    },
    routeSourceEvent: ({ filename }) => ({ catalog: false, sessionIds: [filename.slice(0, -6)] }),
    watchTargets: ["synthetic-root"],
    watchSource: watcher.watch,
    concurrency: 2,
    intervalMs: 60_000,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, controller.signal);

  watcher.emit("change", "a.jsonl");
  await waitFor(() => attempts.get("a") === 1);
  watcher.emit("change", "a.jsonl");
  watcher.emit("change", "a.jsonl");
  watcher.emit("change", "a.jsonl");
  watcher.emit("change", "b.jsonl");
  await waitFor(() => attempts.get("b") === 1);
  assert.equal(maximumActive, 2);

  releaseA.resolve();
  releaseB.resolve();
  await waitFor(() => attempts.get("a") === 2 && active.size === 0);
  assert.equal(attempts.get("a"), 2);
  assert.equal(attempts.get("b"), 1);
  assert.equal(observer.diagnostics().hydrationDirtyAgain, 1);
  assert.equal(observer.diagnostics().hydrationsCoalesced >= 2, true);
  assert.equal(observer.diagnostics().sourceEventQueueSamples >= 2, true);
  assert.equal(observer.diagnostics().sourceEventQueueDelayAverageMs >= 0, true);
});

test("Claude source notifications route a subagent append directly to its root session", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-source-event-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  const localId = "claude-event-root";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const childFile = path.join(projectsRoot, "fixture-project", localId, "subagents", "agent-child.jsonl");
  await writeProviderFixture(mainFile, "claude/session.jsonl", [["PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"]]);
  await writeProviderFixture(childFile, "claude/subagent.jsonl", [["PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"]]);
  let watcher;
  const provider = createClaudeProvider({
    homeDir: root,
    projectsRoot,
    explicitSession: mainFile,
    observerIntervalMs: 60_000,
    observerWatchSource(_target, options, callback) {
      watcher = typeof options === "function" ? options : callback;
      return { close() {} };
    },
    usageRequest: async () => { throw new Error("not requested"); },
  });
  const observer = provider.createObserver();
  const controller = new AbortController();
  context.after(() => controller.abort());
  const published = [];
  await observer.start({
    publishCatalog() {},
    publishSession(sessionId, candidate) { published.push({ sessionId, candidate }); },
    invalidateSession() {},
  }, controller.signal);
  await waitFor(() => published.length === 1 && typeof watcher === "function");

  await appendFile(childFile, `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-29T18:00:00.000Z",
    message: { id: "child-event", model: "claude-test", content: [] },
  })}\n`, "utf8");
  watcher("change", path.relative(projectsRoot, childFile));
  await waitFor(() => published.length >= 2);

  assert.equal(published.at(-1).sessionId, localId);
  assert.equal(observer.diagnostics().routedSourceEvents >= 1, true);
  assertNoPrivateFixtureSentinels(published.at(-1).candidate, "Claude event-driven candidate");
});

test("one reconciliation prepares shared source topology once for every session", async (context) => {
  const observedAt = "2026-08-28T12:00:00.000Z";
  const controller = new AbortController();
  const prepared = new Map([["one", { source: "one" }], ["two", { source: "two" }]]);
  const observed = [];
  let prepareCalls = 0;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const observer = createNormalizedPollingObserver({
    list: async () => [{ localId: "one", updatedAt: observedAt }, { localId: "two", updatedAt: observedAt }],
    now: () => Date.parse(observedAt),
    async prepare(entries) {
      prepareCalls += 1;
      assert.deepEqual(entries.map((entry) => entry.localId), ["one", "two"]);
      return prepared;
    },
    ingest: async (localSessionId, _publisher, sourceMap) => {
      observed.push([localSessionId, sourceMap.get(localSessionId).source]);
      if (observed.length === 2) finish();
      return null;
    },
    intervalMs: 60_000,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({
    publishCatalog() {},
    publishSession() {},
    invalidateSession() {},
  }, controller.signal);
  await finished;
  assert.equal(prepareCalls, 1);
  assert.deepEqual(observed.sort(), [["one", "one"], ["two", "two"]]);
});

test("startup hydrates only the seven-day working set while old catalog rows remain lazy-loadable", async (context) => {
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const entries = [
    { localId: "live-old", isLive: true, updatedAt: "2020-01-01T00:00:00.000Z" },
    { localId: "needs-input-old", needsInput: true, updatedAt: "2020-01-01T00:00:00.000Z" },
    { localId: "boundary", updatedAt: new Date(nowMs - OBSERVATION_WORKING_SET_MS).toISOString() },
    { localId: "stale", updatedAt: new Date(nowMs - OBSERVATION_WORKING_SET_MS - 1).toISOString() },
    { localId: "invalid", updatedAt: "not-a-timestamp" },
  ];
  const controller = new AbortController();
  const preparedBatches = [];
  const acquired = [];
  let catalog = [];
  let finishStartup;
  const startupFinished = new Promise((resolve) => { finishStartup = resolve; });
  const observer = createNormalizedPollingObserver({
    list: async () => entries,
    now: () => nowMs,
    async prepare(batch) {
      preparedBatches.push(batch.map((entry) => entry.localId));
      return new Map(batch.map((entry) => [entry.localId, entry]));
    },
    ingest: async (localSessionId) => {
      acquired.push(localSessionId);
      if (acquired.length === 3) finishStartup();
      return null;
    },
    intervalMs: 60_000,
    async yieldControl() {},
  });
  context.after(() => controller.abort());
  await observer.start({
    publishCatalog(entriesValue) { catalog = entriesValue; },
    publishSession() {},
    invalidateSession() {},
  }, controller.signal);
  await startupFinished;

  assert.deepEqual(catalog.map((entry) => entry.localId), entries.map((entry) => entry.localId));
  assert.deepEqual(preparedBatches[0], ["live-old", "needs-input-old", "boundary"]);
  assert.deepEqual(acquired, ["live-old", "needs-input-old", "boundary"]);

  await observer.hydrate("stale");
  assert.deepEqual(preparedBatches[1], ["stale"]);
  assert.equal(acquired.at(-1), "stale");
  assert.equal(acquired.includes("invalid"), false);
});

test("replacement staging never mixes source generations and deterministic reducers retain stronger evidence", async () => {
  const sources = new Map([["old", Buffer.from('{"id":"same","strength":1}\n{"id":"same","strength":3}\n{"id":"same","strength":1}\n')]]);
  const commits = [];
  const ingestor = createIncrementalJsonlIngestor({
    readChunk: sourceReader(sources),
    parseRecord: (line) => JSON.parse(line.toString("utf8")),
    initialState: () => new Map(),
    reduce: (state, record) => {
      const next = new Map(state);
      const previous = next.get(record.id);
      if (!previous || record.strength >= previous.strength) next.set(record.id, record);
      return next;
    },
    chunkBytes: 7,
    maximumFragmentBytes: 28,
  });
  await ingestor.observe({ identity: "old", size: sources.get("old").length }, (candidate, meta) => commits.push({ candidate, meta }));
  assert.equal(commits.at(-1).candidate.get("same").strength, 3);

  sources.set("old", Buffer.from('{"id":"new","strength":2}\n'));
  await ingestor.observe(
    { identity: "old", size: sources.get("old").length },
    (candidate, meta) => commits.push({ candidate, meta }),
  );
  assert.deepEqual([...commits.at(-1).candidate.keys()], ["new"]);
  assert.equal(commits.at(-1).meta.replacement, true);
});

test("a restarted ingestor resumes from the checkpointed complete-record offset", async () => {
  const sources = new Map([["session", Buffer.from('{"id":"a"}\n{"id":"b"}\n')]]);
  const reads = [];
  const create = () => createIncrementalJsonlIngestor({
    readChunk: async (offset, bytes, source) => {
      reads.push(offset);
      return sources.get(source.identity).subarray(offset, offset + bytes);
    },
    parseRecord: (line) => JSON.parse(line.toString("utf8")),
    initialState: () => [],
    reduce: (state, record) => [...state, record.id],
    chunkBytes: 4,
    maximumFragmentBytes: 16,
  });
  const first = create();
  await first.observe({ identity: "session", size: sources.get("session").length }, () => {});
  const checkpoint = first.snapshot();
  const restarted = create();
  assert.equal(restarted.restore({ identity: checkpoint.identity, completeOffset: checkpoint.completeOffset }), true);
  sources.set("session", Buffer.from('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n'));
  reads.length = 0;
  const commits = [];
  await restarted.observe({ identity: "session", size: sources.get("session").length }, (candidate, meta) => commits.push({ candidate, meta }));
  assert.equal(reads[0], checkpoint.completeOffset);
  assert.deepEqual(commits[0].candidate, ["c"]);
  assert.equal(commits[0].meta.completeOffset, sources.get("session").length);
});

test("a failed publication remains retryable without another source append", async () => {
  const source = Buffer.from('{"id":"a"}\n');
  let attempts = 0;
  const ingestor = createIncrementalJsonlIngestor({
    readChunk: async (offset, bytes) => source.subarray(offset, offset + bytes),
    parseRecord: (line) => JSON.parse(line.toString("utf8")),
    initialState: () => [],
    reduce: (state, record) => [...state, record.id],
  });
  await assert.rejects(() => ingestor.observe({ identity: "retry", size: source.length }, () => {
    attempts += 1;
    throw new Error("temporary normalization failure");
  }));
  const published = [];
  await ingestor.observe({ identity: "retry", size: source.length }, (candidate) => {
    attempts += 1;
    published.push(candidate);
  });
  assert.equal(attempts, 2);
  assert.deepEqual(published, [["a"]]);
});

test("Codex delta merging accepts an explicit empty plan and never downgrades compaction evidence", () => {
  const base = {
    session: { pomegrPlugin: null },
    agents: [{ id: "agent-noether", label: "Noether", assignment: "Agent identity history", skills: [], toolCalls: 0 }],
    usageSnapshots: [], toolCalls: [], activity: [], pullRequestCreations: [],
    planTasks: [{ id: "old", subject: "Old plan", status: "in_progress", blocks: [], blockedBy: [] }],
    compactions: [{ actorId: "primary", timestamp: "2026-08-28T10:00:00.000Z", trigger: "auto", preTokens: 200_000 }],
    efficiencyRuleEvidence: { repetition: false },
  };
  const merged = mergeCodexObservationEvidence(base, {
    ...base,
    agents: [{ ...base.agents[0], assignment: null }],
    planTasks: [],
    compactions: [{ actorId: "primary", timestamp: "2026-08-28T10:00:00.000Z", trigger: "auto", preTokens: null }],
  });
  assert.deepEqual(merged.planTasks, []);
  assert.equal(merged.compactions[0].preTokens, 200_000);
  assert.equal(merged.agents[0].assignment, "Agent identity history");
});

test("Codex observation retains the complete story while a child source advances independently", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-observation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rootFile = path.join(directory, "root.jsonl");
  const childFile = path.join(directory, "child.jsonl");
  await writeFile(rootFile, '{"compaction":"root-old","timestamp":"2026-08-28T10:00:00.000Z"}\n', "utf8");
  await writeFile(childFile, '{"compaction":"child-old","timestamp":"2026-08-28T10:01:00.000Z"}\n', "utf8");
  const metadata = [
    { localId: "root", sessionId: "root", rolloutFile: rootFile },
    { localId: "child", sessionId: "root", parentThreadId: "root", rolloutFile: childFile },
  ];
  const reads = [];
  const published = [];
  let watcher;
  let notify;
  let nextPublication = new Promise((resolve) => { notify = resolve; });
  const evidence = (compactions) => ({
    localId: "root",
    historical: false,
    session: { updatedAt: compactions.at(-1)?.timestamp || "2026-08-28T10:00:00.000Z" },
    agents: [{ id: "primary", skills: [], toolCalls: 0 }],
    workflows: [], usageSnapshots: [], toolCalls: [], activity: [], planTasks: [],
    compactions,
    efficiencyRuleEvidence: { repetition: false, concurrentMutation: false, unsharedContext: false, healthyFallback: false, cacheUsageClassification: false },
    pullRequestCreations: [],
  });
  const readRecords = async (file) => (await import("node:fs/promises")).readFile(file, "utf8")
    .then((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  const observer = createCodexIncrementalObserver({
    list: async () => [{ localId: "root", isLive: true, updatedAt: "2026-08-28T10:01:00.000Z" }],
    discoveredMetadata: async () => metadata,
    transcriptPathsBySessionId: new Map(),
    watchTargets: [directory],
    catalogWatchTargets: [],
    watchSource(_target, options, callback) {
      watcher = typeof options === "function" ? options : callback;
      return { close() {} };
    },
    intervalMs: 60_000,
    async yieldControl() {},
    readEvidence: async (_localId, options) => {
      reads.push(options);
      const all = [...await readRecords(rootFile), ...await readRecords(childFile)]
        .map((item) => ({ actorId: item.compaction.startsWith("child") ? "agent-child" : "primary", timestamp: item.timestamp, trigger: "auto", preTokens: null }));
      return evidence(options.completeStory ? all : all.slice(-1));
    },
  });
  const controller = new AbortController();
  context.after(() => controller.abort());
  await observer.start({
    publishCatalog() {},
    publishSession(_id, candidate) { published.push(candidate); notify(); },
    invalidateSession() {},
  }, controller.signal);
  await nextPublication;
  assert.equal(reads[0].completeStory, true);
  assert.equal(published[0].compactions.length, 2);

  nextPublication = new Promise((resolve) => { notify = resolve; });
  await appendFile(childFile, '{"compaction":"child-new","timestamp":"2026-08-28T10:02:00.000Z"}\n', "utf8");
  watcher("change", path.relative(directory, childFile));
  await nextPublication;
  assert.equal(reads.at(-1).completeStory, false);
  assert.deepEqual([...reads.at(-1).incrementalRecordsByFile.keys()], [childFile]);
  assert.deepEqual(published.at(-1).compactions.map((item) => item.timestamp), [
    "2026-08-28T10:00:00.000Z",
    "2026-08-28T10:01:00.000Z",
    "2026-08-28T10:02:00.000Z",
  ]);
  assert.equal(published.at(-1).observationSource.completeOffset, Buffer.byteLength(await (await import("node:fs/promises")).readFile(rootFile, "utf8")) + Buffer.byteLength(await (await import("node:fs/promises")).readFile(childFile, "utf8")));
  assert.equal(observer.diagnostics().routedSourceEvents >= 1, true);

  const beforePartial = published.length;
  await appendFile(childFile, '{"compaction":"child-partial"', "utf8");
  assert.equal(await observer.hydrate("root"), false);
  assert.equal(published.length, beforePartial);
  await appendFile(childFile, ',"timestamp":"2026-08-28T10:03:00.000Z"}\n', "utf8");
  nextPublication = new Promise((resolve) => { notify = resolve; });
  await observer.hydrate("root");
  await nextPublication;
  assert.equal(published.at(-1).compactions.length, 4);

  const beforeReplacement = published.length;
  await writeFile(childFile, '{"compaction":"child-replaced"', "utf8");
  assert.equal(await observer.hydrate("root"), false);
  await appendFile(rootFile, '{"compaction":"root-new","timestamp":"2026-08-28T10:04:00.000Z"}\n', "utf8");
  assert.equal(await observer.hydrate("root"), false);
  assert.equal(published.length, beforeReplacement);
  await appendFile(childFile, ',"timestamp":"2026-08-28T10:05:00.000Z"}\n', "utf8");
  nextPublication = new Promise((resolve) => { notify = resolve; });
  await observer.hydrate("root");
  await nextPublication;
  assert.equal(reads.at(-1).completeStory, true);
  assert.deepEqual(published.at(-1).compactions.map((item) => item.timestamp), [
    "2026-08-28T10:00:00.000Z",
    "2026-08-28T10:04:00.000Z",
    "2026-08-28T10:05:00.000Z",
  ]);
});

test("a child transcript change updates its session source fingerprint without advancing the primary cursor", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-provider-source-set-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary.jsonl");
  const child = path.join(root, "child.jsonl");
  await writeFile(primary, '{"id":"primary"}\n', "utf8");
  await writeFile(child, '{"id":"child"}\n', "utf8");
  const before = incrementalSourceSetDescriptor([primary, child], primary);
  await appendFile(child, '{"id":"child-append"}\n', "utf8");
  const after = incrementalSourceSetDescriptor([primary, child], primary);
  assert.equal(after.size, before.size);
  assert.notEqual(after.identity, before.identity);
});
