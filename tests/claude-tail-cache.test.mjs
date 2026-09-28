import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createClaudeTailCache,
  DEFAULT_TAIL_CACHE_MAX_BYTES,
  readJsonlTailCold,
} from "../monitor/providers/claude-tail-cache.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { readProviderFixture } from "./helpers/provider-fixtures.mjs";

/**
 * Independent, verbatim copy of the pre-cache readJsonlTail algorithm this suite validates
 * against. It shares no code with monitor/providers/claude-tail-cache.mjs, so it is ground truth
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
