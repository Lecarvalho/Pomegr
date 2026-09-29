import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeAgentLifecycleReader } from "../../../../server/providers/claude/agent-lifecycle.mjs";
import { createClaudeActivityReader } from "../../../../server/providers/claude/activity-events.mjs";
import { FILE_SUFFIX_SAMPLE_BYTES, fileGeneration, readFileSuffixRaw } from "../../../../server/providers/claude/file-generation.mjs";
import { createReadGenerations, generationKey } from "../../../../server/providers/claude/read-generations.mjs";
import {
  createClaudeTailCache,
  DEFAULT_TAIL_CACHE_MAX_BYTES,
  readJsonlTailCold,
} from "../../../../server/providers/claude/tail-cache.mjs";
import { createClaudeProvider } from "../../../../server/providers/claude/index.mjs";
import { incrementalSourceDescriptor } from "../../../../server/providers/kernel/incremental-provider-observer.mjs";
import { readProviderFixture } from "../../../helpers/provider-fixtures.mjs";

/**
 * Independent, verbatim copy of the pre-cache readJsonlTail algorithm this suite validates
 * against. It shares no code with server/providers/claude/tail-cache.mjs, so it is ground truth
 * rather than the refactor checked against itself.
 */
function referenceReadJsonlTail(file, maxBytes) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  const bytes = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes)); }
  finally { fs.closeSync(fd); }
  let text = buffer.toString("utf8");
  if (stat.size > bytes) text = text.slice(text.indexOf("\n") + 1);
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-tail-cache-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Every complete-line boundary of `text` (mirroring `\r?\n`), each preceded by a mid-record
 * partial-write snapshot (half of that record's bytes, no terminator), plus the exact full text
 * as a final step regardless of whether it ends in a newline.
 */
function growthSteps(text) {
  const boundaries = [0];
  let searchFrom = 0;
  for (;;) {
    const index = text.indexOf("\n", searchFrom);
    if (index === -1) break;
    boundaries.push(index + 1);
    searchFrom = index + 1;
  }
  if (boundaries[boundaries.length - 1] !== text.length) boundaries.push(text.length);
  const steps = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const previous = boundaries[index - 1];
    const current = boundaries[index];
    const mid = previous + Math.floor((current - previous) / 2);
    if (mid > previous && mid < current) steps.push(text.slice(0, mid));
    steps.push(text.slice(0, current));
  }
  return steps.length ? steps : [text];
}

/** Grow `file` through every step of `text` (true appends, preserving file identity) and assert
 * the cache's output matches the independent cold reference at every boundary. */
async function assertGrowthMatchesReference(cache, file, text, maxBytes, label) {
  let written = "";
  for (const step of growthSteps(text)) {
    const delta = step.slice(written.length);
    if (delta.length) await appendFile(file, delta, "utf8");
    written = step;
    const cached = cache.read(file);
    const reference = referenceReadJsonlTail(file, maxBytes);
    assert.deepStrictEqual(cached, reference, `${label} at ${written.length} bytes (maxBytes=${maxBytes})`);
  }
}

function fixedLengthLine(index, targetLength) {
  const build = (padding) => JSON.stringify({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    i: index,
    message: { content: [{ type: "text", text: "x".repeat(Math.max(0, padding)) }] },
  });
  const base = build(0).length;
  const padding = Math.max(0, targetLength - 1 - base);
  return `${build(padding)}\n`;
}

for (const [name, fixture] of [
  ["session.jsonl (\\r\\n, multi-record)", "claude/session.jsonl"],
  ["subagent.jsonl (\\n, two records)", "claude/subagent.jsonl"],
  ["malformed.jsonl (invalid lines, no trailing newline)", "claude/malformed.jsonl"],
]) {
  test(`cached tail read matches the cold reference at every boundary of ${name} (whole-file window)`, async () => {
    await withTempDir(async (root) => {
      const text = await readProviderFixture(fixture);
      const file = path.join(root, "transcript.jsonl");
      const cache = createClaudeTailCache({ maxBytes: 1_000_000 });
      await assertGrowthMatchesReference(cache, file, text, 1_000_000, name);
    });
  });

  test(`cached tail read matches the cold reference at every boundary of ${name} (cropped window)`, async () => {
    await withTempDir(async (root) => {
      const text = await readProviderFixture(fixture);
      const file = path.join(root, "transcript.jsonl");
      // A window far smaller than the fixture forces repeated front-of-window
      // crops as the file grows, exercising the "drop through the first
      // newline in the window" rule many times over.
      const cache = createClaudeTailCache({ maxBytes: 96 });
      await assertGrowthMatchesReference(cache, file, text, 96, name);
    });
  });
}

test("cached tail read matches the cold reference across a real 2 MiB window boundary", async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, "large.jsonl");
    const maxBytes = DEFAULT_TAIL_CACHE_MAX_BYTES;
    const recordLength = 337; // Not a divisor of maxBytes, so crossings do not land on tidy offsets.
    const before = Math.floor(maxBytes / recordLength) - 5;
    let bulk = "";
    for (let index = 0; index < before; index += 1) bulk += fixedLengthLine(index, recordLength);
    await writeFile(file, bulk, "utf8");

    const cache = createClaudeTailCache({ maxBytes });
    assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes), "before crossing");

    for (let extra = 0; extra < 20; extra += 1) {
      const index = before + extra;
      const line = fixedLengthLine(index, recordLength);
      // A mid-record partial write exactly at the crossing zone.
      const half = line.slice(0, Math.floor(line.length / 2));
      await appendFile(file, half, "utf8");
      assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes), `partial write at record ${index}`);
      await appendFile(file, line.slice(half.length), "utf8");
      assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes), `complete record ${index}`);
    }
  });
});

test("cached tail read rebuilds cold on replacement, truncation, and a same-size rewrite", async () => {
  await withTempDir(async (root) => {
    const maxBytes = 4_096;
    const cache = createClaudeTailCache({ maxBytes });
    const file = path.join(root, "transcript.jsonl");

    await writeFile(file, `${JSON.stringify({ type: "user", uuid: "one", n: 1 })}\n${JSON.stringify({ type: "user", uuid: "two", n: 2 })}\n`, "utf8");
    assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes));

    // Replacement: a new file at the same path (different identity) with unrelated content.
    await rm(file, { force: true });
    await writeFile(file, `${JSON.stringify({ type: "user", uuid: "replaced", n: 99 })}\n`, "utf8");
    assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes));
    assert.deepStrictEqual(cache.read(file), [{ type: "user", uuid: "replaced", n: 99 }]);

    // Grow it, then truncate it (shrink while keeping the same identity/path).
    await appendFile(file, `${JSON.stringify({ type: "user", uuid: "grown", n: 100 })}\n`, "utf8");
    assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes));
    await writeFile(file, fixedLengthLine("short", 200), "utf8");
    assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes));

    // Same-size in-place rewrite: identical byte length, different content (suffix mismatch).
    const before = fs.statSync(file).size;
    const replacement = fixedLengthLine("same-size-replacement", before);
    assert.equal(Buffer.byteLength(replacement, "utf8"), before, "the rewrite must keep the exact byte length");
    await writeFile(file, replacement, "utf8");
    assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes));
  });
});

test("tail cache release and retain drop entries; a released file still reads correctly afterward", async () => {
  await withTempDir(async (root) => {
    const cache = createClaudeTailCache({ maxBytes: 4_096 });
    const fileA = path.join(root, "a.jsonl");
    const fileB = path.join(root, "b.jsonl");
    const fileC = path.join(root, "c.jsonl");
    await writeFile(fileA, `${JSON.stringify({ n: "a" })}\n`, "utf8");
    await writeFile(fileB, `${JSON.stringify({ n: "b" })}\n`, "utf8");
    await writeFile(fileC, `${JSON.stringify({ n: "c" })}\n`, "utf8");
    cache.read(fileA);
    cache.read(fileB);
    cache.read(fileC);
    assert.equal(cache.size(), 3);

    cache.release([fileB]);
    assert.equal(cache.size(), 2);
    // Releasing only drops the cache entry; the file itself still reads correctly (cold rebuild).
    assert.deepStrictEqual(cache.read(fileB), [{ n: "b" }]);
    assert.equal(cache.size(), 3);

    cache.retain(new Set([fileA]));
    assert.equal(cache.size(), 1);
    assert.deepStrictEqual(cache.read(fileC), [{ n: "c" }]);

    await rm(fileA, { force: true });
    cache.pruneMissingFiles();
    assert.deepStrictEqual(cache.read(fileA), []);
  });
});

test("tail cache bounds retained bytes to the configured budget, evicting least-recently-used files first", async () => {
  await withTempDir(async (root) => {
    // Each file's window is ~1 KiB; a 2.5 KiB budget can hold about two of them.
    const maxBytes = 4_096;
    const cache = createClaudeTailCache({ maxBytes, budgetBytes: 2_560, maxEntries: 100 });
    const files = ["a", "b", "c"].map((name) => path.join(root, `${name}.jsonl`));
    for (const file of files) {
      const line = `${JSON.stringify({ filler: "x".repeat(1_000) })}\n`;
      await writeFile(file, line, "utf8");
    }

    cache.read(files[0]);
    cache.read(files[1]);
    assert.equal(cache.size(), 2, "two ~1 KiB windows fit the 2.5 KiB budget");
    cache.read(files[2]);
    assert.equal(cache.size(), 2, "a third window evicts the least-recently-used entry");

    // Re-reading the oldest (evicted) file must still be correct, just cold.
    assert.deepStrictEqual(cache.read(files[0]), referenceReadJsonlTail(files[0], maxBytes));
  });
});

test("tail cache bounds the number of distinct cached files independently of their size", async () => {
  await withTempDir(async (root) => {
    const cache = createClaudeTailCache({ maxBytes: 4_096, budgetBytes: Infinity, maxEntries: 3 });
    const files = [];
    for (let index = 0; index < 6; index += 1) {
      const file = path.join(root, `f${index}.jsonl`);
      await writeFile(file, `${JSON.stringify({ index })}\n`, "utf8");
      files.push(file);
      cache.read(file);
    }
    assert.equal(cache.size(), 3);
    // The three most recently read files stayed cached; correctness is unaffected either way.
    for (const file of files) assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, 4_096));
  });
});

test("readJsonlTailCold matches the independent reference for the catalog-summary window", async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, "catalog.jsonl");
    const text = await readProviderFixture("claude/session.jsonl");
    await writeFile(file, text, "utf8");
    const maxBytes = 256 * 1024;
    assert.deepStrictEqual(readJsonlTailCold(file, maxBytes), referenceReadJsonlTail(file, maxBytes));
    assert.deepStrictEqual(readJsonlTailCold(file), referenceReadJsonlTail(file, DEFAULT_TAIL_CACHE_MAX_BYTES));
  });
});

/** Recursively freeze an object graph so any in-place write throws in strict mode. */
function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

test("readSession completes and matches a cold read even when every cached record is deep-frozen (mutation audit)", async () => {
  await withTempDir(async (root) => {
    const projectsRoot = path.join(root, "projects");
    const registryRoot = path.join(root, "registry");
    const tasksRoot = path.join(root, "tasks");
    const localId = "claude-tail-cache-mutation-audit";
    const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
    const agentFile = path.join(projectsRoot, "fixture-project", localId, "subagents", "agent-child-fixture.jsonl");
    await mkdir(path.dirname(mainFile), { recursive: true });
    await mkdir(path.dirname(agentFile), { recursive: true });
    await writeFile(mainFile, (await readProviderFixture("claude/session.jsonl")).replaceAll("PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"), "utf8");
    await writeFile(agentFile, (await readProviderFixture("claude/subagent.jsonl")).replaceAll("PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"), "utf8");

    const baselineProvider = createClaudeProvider({
      homeDir: root, projectsRoot, registryRoot, tasksRoot,
      explicitSession: mainFile, usageRequest: async () => { throw new Error("not requested"); },
    });
    const baseline = await baselineProvider.readSession(localId);
    assert.ok(baseline, "the baseline read must succeed");

    const frozenTailCache = createClaudeTailCache({ maxBytes: DEFAULT_TAIL_CACHE_MAX_BYTES });
    for (const file of [mainFile, agentFile]) {
      for (const record of frozenTailCache.read(file)) deepFreeze(record);
    }
    const frozenProvider = createClaudeProvider({
      homeDir: root, projectsRoot, registryRoot, tasksRoot,
      explicitSession: mainFile, usageRequest: async () => { throw new Error("not requested"); },
      tailCache: frozenTailCache,
    });
    // If any consumer of recordsByFile/mainRecords ever wrote to a cached
    // record, this would throw a TypeError (strict-mode assignment to a
    // frozen object) instead of returning normally.
    const withFrozenRecords = await frozenProvider.readSession(localId);
    assert.deepStrictEqual(withFrozenRecords, baseline);
  });
});

test("readSession returns identical evidence from a cold provider and a warm provider after live appends", async () => {
  await withTempDir(async (root) => {
    const projectsRoot = path.join(root, "projects");
    const registryRoot = path.join(root, "registry");
    const tasksRoot = path.join(root, "tasks");
    const localId = "claude-tail-cache-cold-warm";
    const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
    await mkdir(path.dirname(mainFile), { recursive: true });
    const sessionText = (await readProviderFixture("claude/session.jsonl")).replaceAll("PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path");
    const steps = growthSteps(sessionText);
    await writeFile(mainFile, steps[0], "utf8");

    const providerOptions = {
      homeDir: root, projectsRoot, registryRoot, tasksRoot,
      explicitSession: mainFile, usageRequest: async () => { throw new Error("not requested"); },
    };
    // A warm provider reads through every append (exercising the tail cache's
    // append path record by record, including mid-record partial writes),
    // while a cold provider is never instantiated until the file reaches its
    // final state. Both must resolve to the exact same normalized evidence.
    const warmProvider = createClaudeProvider(providerOptions);
    let written = steps[0];
    for (const step of steps) {
      const delta = step.slice(written.length);
      if (delta.length) await appendFile(mainFile, delta, "utf8");
      written = step;
      await warmProvider.readSession(localId);
    }

    const warm = await warmProvider.readSession(localId);
    const cold = await createClaudeProvider(providerOptions).readSession(localId);
    assert.deepStrictEqual(warm, cold);
  });
});

test("a trailing fragment exactly one window wide leaves no stale cached record", async () => {
  await withTempDir(async (root) => {
    const maxBytes = 64;
    for (const fragment of [`"${"x".repeat(maxBytes - 2)}"`, `{"partial":"${"y".repeat(maxBytes - 12)}`]) {
      const file = path.join(root, `exact-${fragment.length}-${fragment[0] === "{" ? "open" : "string"}.jsonl`);
      await writeFile(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`);
      const cache = createClaudeTailCache({ maxBytes });
      cache.read(file);
      assert.equal(Buffer.byteLength(fragment), maxBytes);
      await appendFile(file, fragment);
      assert.deepStrictEqual(cache.read(file), referenceReadJsonlTail(file, maxBytes));
    }
  });
});

/** Count real fs.statSync/fs.openSync calls that target `files`, while still delegating to the
 * real implementation so behavior is unaffected. Restore in a `finally` at the call site. */
function countFileIo(context, files) {
  const targets = new Set(files);
  const counts = { stat: new Map(), open: new Map() };
  const realStat = fs.statSync;
  const realOpen = fs.openSync;
  const statSpy = context.mock.method(fs, "statSync", (target, ...rest) => {
    if (targets.has(target)) counts.stat.set(target, (counts.stat.get(target) || 0) + 1);
    return realStat(target, ...rest);
  });
  const openSpy = context.mock.method(fs, "openSync", (target, ...rest) => {
    if (targets.has(target)) counts.open.set(target, (counts.open.get(target) || 0) + 1);
    return realOpen(target, ...rest);
  });
  return { counts, restore: () => { statSpy.mock.restore(); openSpy.mock.restore(); } };
}

// ---------------------------------------------------------------------------
// createReadGenerations(): the shared per-readSession stat/suffix memoizer.
// ---------------------------------------------------------------------------

test("createReadGenerations stats and suffix-reads a file at most once per instance, memoizing null too", async (context) => {
  await withTempDir(async (root) => {
    const file = path.join(root, "transcript.jsonl");
    await writeFile(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`, "utf8");
    const missing = path.join(root, "missing.jsonl");

    // Reference values computed before any mock is installed.
    const expectedGeneration = fileGeneration(file, fs.statSync(file));
    const expectedDescriptor = incrementalSourceDescriptor(file, false);
    const expectedHistoricalDescriptor = incrementalSourceDescriptor(file, true);

    const { counts, restore } = countFileIo(context, [file, missing]);
    try {
      const generations = createReadGenerations();
      const stat1 = generations.stat(file);
      const gen1 = generations.generation(file);
      const desc1 = generations.descriptor(file);
      const desc1Historical = generations.descriptor(file, true);
      // Repeated calls, including a second historical value, must reuse the same reads.
      assert.deepStrictEqual(generations.stat(file), stat1);
      assert.deepStrictEqual(generations.generation(file), gen1);
      assert.deepStrictEqual(generations.descriptor(file), desc1);
      assert.deepStrictEqual(generations.descriptor(file, true), desc1Historical);

      assert.deepStrictEqual(gen1, expectedGeneration);
      assert.deepStrictEqual(desc1, expectedDescriptor);
      assert.deepStrictEqual(desc1Historical, expectedHistoricalDescriptor);
      assert.equal(desc1.historical, false);
      assert.equal(desc1Historical.historical, true);

      assert.equal(counts.stat.get(file), 1, "the file must be stat'd at most once regardless of how many readers ask");
      assert.equal(counts.open.get(file), 1, "the 256-byte suffix must be read at most once regardless of how many readers ask");

      // A missing file: null is memoized too, and the failed stat is never retried.
      assert.equal(generations.stat(missing), null);
      assert.equal(generations.generation(missing), null);
      assert.equal(generations.descriptor(missing), null);
      assert.equal(generations.stat(missing), null);
      assert.equal(counts.stat.get(missing), 1, "a missing file must be stat'd once and the null result memoized");
      assert.equal(counts.open.has(missing), false, "a missing file is never opened");
    } finally {
      restore();
    }
  });
});

test("generationKey formats identity|size|mtimeMs|suffixDigest and is null for no generation", async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, "transcript.jsonl");
    await writeFile(file, `${JSON.stringify({ n: 1 })}\n`, "utf8");
    const generation = fileGeneration(file, fs.statSync(file));
    assert.equal(generationKey(generation), `${generation.identity}|${generation.size}|${generation.mtimeMs}|${generation.suffixDigest}`);
    assert.equal(generationKey(null), null);
  });
});

// ---------------------------------------------------------------------------
// incrementalSourceDescriptor(file, historical, precomputed): optional reuse.
// ---------------------------------------------------------------------------

test("incrementalSourceDescriptor with a precomputed stat+suffix matches the uncomputed result and performs no file I/O", async (context) => {
  await withTempDir(async (root) => {
    const file = path.join(root, "descriptor.jsonl");
    await writeFile(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`, "utf8");
    const baselineLive = incrementalSourceDescriptor(file, false);
    const baselineHistorical = incrementalSourceDescriptor(file, true);
    assert.ok(baselineLive, "the baseline descriptor must resolve");

    const stat = fs.statSync(file);
    const suffix = readFileSuffixRaw(file, stat.size, FILE_SUFFIX_SAMPLE_BYTES);

    const { counts, restore } = countFileIo(context, [file]);
    try {
      assert.deepStrictEqual(incrementalSourceDescriptor(file, false, { stat, suffix }), baselineLive);
      assert.deepStrictEqual(incrementalSourceDescriptor(file, true, { stat, suffix }), baselineHistorical);
      assert.equal(counts.stat.has(file), false, "a precomputed stat must not be re-read");
      assert.equal(counts.open.has(file), false, "a precomputed suffix must not be re-read");
    } finally {
      restore();
    }

    // Every existing (non-precomputed) call shape keeps behaving exactly as before.
    assert.deepStrictEqual(incrementalSourceDescriptor(file), baselineLive);
    assert.deepStrictEqual(incrementalSourceDescriptor(file, false, undefined), baselineLive);
    assert.equal(incrementalSourceDescriptor(path.join(root, "missing.jsonl"), false), null);
  });
});

// ---------------------------------------------------------------------------
// Per-reader precomputed acceptance: tail cache, activity events, agent lifecycle.
// ---------------------------------------------------------------------------

test("claude tail cache read(file, precomputed) skips its own stat/generation check on an unchanged file", async (context) => {
  await withTempDir(async (root) => {
    const file = path.join(root, "transcript.jsonl");
    await writeFile(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`, "utf8");
    const cache = createClaudeTailCache({ maxBytes: 4_096 });
    const first = cache.read(file); // cold build, unmocked

    const stat = fs.statSync(file);
    const generation = fileGeneration(file, stat);
    const { counts, restore } = countFileIo(context, [file]);
    try {
      const second = cache.read(file, { stat, generation });
      assert.deepStrictEqual(second, first);
      assert.equal(counts.stat.has(file), false, "an unchanged precomputed read must not stat the file again");
      assert.equal(counts.open.has(file), false, "an unchanged precomputed read must not open the file again");
    } finally {
      restore();
    }

    // Without precomputed values the same unchanged file is still checked directly (baseline).
    const baseline = countFileIo(context, [file]);
    try {
      assert.deepStrictEqual(cache.read(file), first);
      assert.ok(baseline.counts.stat.get(file) >= 1, "without precomputed values the cache still checks the file itself");
    } finally {
      baseline.restore();
    }

    // A precomputed null stat behaves like a missing file.
    assert.deepStrictEqual(cache.read(path.join(root, "never-created.jsonl"), { stat: null, generation: null }), []);
  });
});

test("claude activity reader accepts a precomputed descriptor and skips its own generation check on an unchanged file", async (context) => {
  await withTempDir(async (root) => {
    const file = path.join(root, "agent.jsonl");
    const record = { type: "assistant", timestamp: "2026-08-10T12:00:00.000Z", message: { model: "claude-test", content: [{ type: "text", text: "hi" }] } };
    await writeFile(file, `${JSON.stringify(record)}\n`, "utf8");
    const actor = { id: "primary", label: "Primary agent" };
    const read = createClaudeActivityReader();
    const first = await read(file, actor); // cold, unmocked

    const descriptor = incrementalSourceDescriptor(file);
    const { counts, restore } = countFileIo(context, [file]);
    try {
      const second = await read(file, actor, descriptor);
      assert.deepStrictEqual(second, first);
      assert.equal(counts.stat.has(file), false);
      assert.equal(counts.open.has(file), false);
    } finally {
      restore();
    }
  });
});

test("claude agent lifecycle reader accepts a precomputed descriptor and skips its own generation check on an unchanged file", async (context) => {
  await withTempDir(async (root) => {
    const file = path.join(root, "agent.jsonl");
    const record = { type: "user", timestamp: "2026-08-10T12:00:00.000Z", message: { content: "hi" } };
    await writeFile(file, `${JSON.stringify(record)}\n`, "utf8");
    const read = createClaudeAgentLifecycleReader();
    const first = await read(file); // cold, unmocked

    const descriptor = incrementalSourceDescriptor(file);
    const { counts, restore } = countFileIo(context, [file]);
    try {
      const second = await read(file, descriptor);
      assert.deepStrictEqual(second, first);
      assert.equal(counts.stat.has(file), false);
      assert.equal(counts.open.has(file), false);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// readSession() end to end: a synthetic session (main + 2 agents), cold vs warm
// equivalence across every required mutation, and the shared generation check's
// opens/stats budget.
// ---------------------------------------------------------------------------

async function writeSessionFixture(root) {
  const projectsRoot = path.join(root, "projects");
  const registryRoot = path.join(root, "registry");
  const tasksRoot = path.join(root, "tasks");
  const localId = "read-generations-fixture";
  const mainFile = path.join(projectsRoot, "fixture-project", `${localId}.jsonl`);
  const agentDir = path.join(projectsRoot, "fixture-project", localId, "subagents");
  const agentFileA = path.join(agentDir, "agent-alpha.jsonl");
  const agentFileB = path.join(agentDir, "agent-beta.jsonl");
  await mkdir(path.dirname(mainFile), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(registryRoot, { recursive: true });
  await mkdir(path.join(tasksRoot, localId), { recursive: true });

  const replacements = [["PRIVATE_PATH_MUST_NOT_LEAK", "synthetic-path"]];
  let session = await readProviderFixture("claude/session.jsonl");
  let subagent = await readProviderFixture("claude/subagent.jsonl");
  for (const [from, to] of replacements) {
    session = session.replaceAll(from, to);
    subagent = subagent.replaceAll(from, to);
  }
  await writeFile(mainFile, session, "utf8");
  await writeFile(agentFileA, subagent, "utf8");
  await writeFile(agentFileB, subagent, "utf8");
  // A stored plan task keeps readSession from falling back to scanning the main
  // transcript for tasks, which would add an unrelated stat call of its own.
  await writeFile(path.join(tasksRoot, localId, "task-1.json"), await readProviderFixture("claude/task.json"), "utf8");

  return { root, projectsRoot, registryRoot, tasksRoot, localId, mainFile, agentFileA, agentFileB };
}

function providerOptions(fixture, extra = {}) {
  return {
    homeDir: fixture.root,
    projectsRoot: fixture.projectsRoot,
    registryRoot: fixture.registryRoot,
    tasksRoot: fixture.tasksRoot,
    usageRequest: async () => { throw new Error("not requested"); },
    ...extra,
  };
}

async function assertWarmMatchesCold(fixture, warmProvider, label, extraColdOptions = {}) {
  const warm = await warmProvider.readSession(fixture.localId);
  const cold = await createClaudeProvider(providerOptions(fixture, extraColdOptions)).readSession(fixture.localId);
  assert.deepStrictEqual(warm, cold, label);
  return warm;
}

test("readSession: cold vs warm evidence is identical after an agent file is deleted", async () => {
  await withTempDir(async (root) => {
    const fixture = await writeSessionFixture(root);
    const warmProvider = createClaudeProvider(providerOptions(fixture));
    await warmProvider.readSession(fixture.localId);
    await rm(fixture.agentFileB, { force: true });
    const warm = await assertWarmMatchesCold(fixture, warmProvider, "agent file deleted");
    assert.equal(warm.agents.some((agent) => agent.id === "agent-beta"), false);
  });
});

test("readSession opens each transcript file's suffix at most once per warm read for the shared generation check", async (context) => {
  await withTempDir(async (root) => {
    const fixture = await writeSessionFixture(root);
    const settleTime = new Date("2026-08-10T12:05:00.000Z");
    for (const file of [fixture.mainFile, fixture.agentFileA, fixture.agentFileB]) await utimes(file, settleTime, settleTime);
    // Comfortably beyond the live window and stable regardless of real wall-clock
    // drift during the test, so the session resolves as historical throughout.
    const provider = createClaudeProvider(providerOptions(fixture, { now: () => Date.now() + 100 * 24 * 60 * 60 * 1000 }));
    const first = await provider.readSession(fixture.localId);
    assert.equal(first.historical, true);
    await provider.readSession(fixture.localId);

    const { counts, restore } = countFileIo(context, [fixture.mainFile, fixture.agentFileA, fixture.agentFileB]);
    try {
      await provider.readSession(fixture.localId);
      for (const file of [fixture.mainFile, fixture.agentFileA, fixture.agentFileB]) {
        // The shared read-generations cache contributes exactly one open per file for
        // its own generation check. A handful of other, unrelated readers (recorded
        // session-work-start tracking on the main file, and the not-yet-wired historical
        // usage-snapshot cache on every file -- both outside this change's scope) add a
        // few more; a regression that reintroduces separate per-reader generation checks
        // in the tail cache, activity, or agent-lifecycle readers would push these counts
        // well past this budget.
        const budget = file === fixture.mainFile ? 4 : 2;
        assert.ok((counts.open.get(file) || 0) <= budget, `${path.basename(file)} opened ${counts.open.get(file) || 0} times, expected <= ${budget}`);
      }
    } finally {
      restore();
    }
  });
});
