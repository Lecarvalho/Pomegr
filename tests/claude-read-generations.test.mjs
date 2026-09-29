import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClaudeAgentLifecycleReader } from "../monitor/providers/claude-agent-lifecycle.mjs";
import { createClaudeActivityReader } from "../monitor/providers/claude-activity-events.mjs";
import { FILE_SUFFIX_SAMPLE_BYTES, fileGeneration, readFileSuffixRaw } from "../monitor/providers/claude-file-generation.mjs";
import { createReadGenerations, generationKey } from "../monitor/providers/claude-read-generations.mjs";
import { createClaudeTailCache } from "../monitor/providers/claude-tail-cache.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { incrementalSourceDescriptor } from "../monitor/providers/incremental-provider-observer.mjs";
import { readProviderFixture } from "./helpers/provider-fixtures.mjs";

async function withTempDir(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-read-generations-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

function fixedLengthLine(seed, targetLength) {
  const build = (padding) => JSON.stringify({ type: "user", seed, message: { content: "x".repeat(Math.max(0, padding)) } });
  const base = build(0).length;
  const padding = Math.max(0, targetLength - 1 - base);
  return `${build(padding)}\n`;
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

test("readSession: cold vs warm evidence is identical with no change", async () => {
  await withTempDir(async (root) => {
    const fixture = await writeSessionFixture(root);
    const warmProvider = createClaudeProvider(providerOptions(fixture));
    await warmProvider.readSession(fixture.localId);
    await assertWarmMatchesCold(fixture, warmProvider, "no change");
  });
});

test("readSession: cold vs warm evidence is identical after an append", async () => {
  await withTempDir(async (root) => {
    const fixture = await writeSessionFixture(root);
    const warmProvider = createClaudeProvider(providerOptions(fixture));
    await warmProvider.readSession(fixture.localId);
    await appendFile(fixture.agentFileA, `${JSON.stringify({ type: "assistant", timestamp: "2026-08-10T12:05:00.000Z", message: { id: "appended-1", model: "claude-test", usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: "text", text: "appended" }] } })}\n`, "utf8");
    await assertWarmMatchesCold(fixture, warmProvider, "append");
  });
});

test("readSession: cold vs warm evidence is identical after an append of a partial line", async () => {
  await withTempDir(async (root) => {
    const fixture = await writeSessionFixture(root);
    const warmProvider = createClaudeProvider(providerOptions(fixture));
    await warmProvider.readSession(fixture.localId);
    await appendFile(fixture.mainFile, '{"type":"user","partial":true,"message":{"content":"unterminated', "utf8");
    // A file ending mid-record is a cold-start rule for the underlying incremental
    // readers, not a read-generations concern (a brand-new reader withholds any
    // candidate until it sees a complete trailing record, while an already-warm
    // reader keeps its last known-good result); only the warm side is meaningful
    // here, and it must not throw or corrupt state while the line is incomplete.
    assert.ok(await warmProvider.readSession(fixture.localId), "a warm read must tolerate an in-flight partial line");
    // Complete the record: both sides now see the same, fully written file.
    await appendFile(fixture.mainFile, '"}}\n', "utf8");
    await assertWarmMatchesCold(fixture, warmProvider, "partial-line append completed");
  });
});

test("readSession: cold vs warm evidence is identical after replacement with a different file of equal size", async () => {
  await withTempDir(async (root) => {
    const fixture = await writeSessionFixture(root);
    const warmProvider = createClaudeProvider(providerOptions(fixture));
    await warmProvider.readSession(fixture.localId);
    const before = fs.statSync(fixture.agentFileB).size;
    const replacement = fixedLengthLine("replacement", before);
    assert.equal(Buffer.byteLength(replacement, "utf8"), before, "the replacement must keep the exact byte length");
    await rm(fixture.agentFileB, { force: true });
    await writeFile(fixture.agentFileB, replacement, "utf8");
    await assertWarmMatchesCold(fixture, warmProvider, "same-size replacement");
  });
});

test("readSession: cold vs warm evidence is identical after truncation", async () => {
  await withTempDir(async (root) => {
    const fixture = await writeSessionFixture(root);
    const warmProvider = createClaudeProvider(providerOptions(fixture));
    await warmProvider.readSession(fixture.localId);
    // Truncate to exactly the first complete line, so the shrunken file still ends
    // on a clean record boundary; a cold-start reader's "wait for a complete final
    // record" rule (see the partial-line-append test) is a separate, unrelated
    // asymmetry, not what this truncation/shrink scenario is exercising.
    const original = fs.readFileSync(fixture.agentFileA);
    const firstNewline = original.indexOf(0x0a);
    assert.ok(firstNewline > 0 && firstNewline < original.length - 1, "the fixture must have more than one complete line to truncate");
    await truncate(fixture.agentFileA, firstNewline + 1);
    await assertWarmMatchesCold(fixture, warmProvider, "truncation");
  });
});

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

test("readSession: cold vs warm evidence is identical across tail-cache eviction", async () => {
  await withTempDir(async (root) => {
    const fixture = await writeSessionFixture(root);
    // A tiny per-cache entry budget forces the tail cache to evict an earlier
    // file's entry before all three transcripts in one readSession are read.
    const tinyTailCache = createClaudeTailCache({ maxBytes: 1_048_576, maxEntries: 2 });
    const warmProvider = createClaudeProvider(providerOptions(fixture, { tailCache: tinyTailCache }));
    await warmProvider.readSession(fixture.localId);
    await warmProvider.readSession(fixture.localId);
    assert.ok(tinyTailCache.size() <= 2, "the tiny cache must stay within its configured bound");
    // Compare against a normally-sized cold provider: eviction must never change the result.
    await assertWarmMatchesCold(fixture, warmProvider, "tail-cache eviction");
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
