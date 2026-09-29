import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexRolloutDiscovery } from "../../../../server/providers/codex/rollout-discovery.mjs";
import {
  createCodexRolloutHeaderCache,
  enumerateCodexRolloutHeaders,
  readCodexRolloutHeader,
} from "../../../../server/providers/codex/session-metadata.mjs";

const BASE = Date.parse("2026-09-04T12:00:00.000Z");

async function rollout(root, name, id, timestamp = BASE) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    type: "session_meta",
    timestamp: new Date(timestamp).toISOString(),
    payload: { id, session_id: id, timestamp: new Date(timestamp).toISOString(), cwd: "C:\\synthetic\\repo", source: "cli" },
  })}\n`, "utf8");
  await utimes(file, new Date(timestamp), new Date(timestamp));
  return file;
}

async function temporaryRoot(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-rollout-discovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("advances beyond the first filename batch and admits an older resumed filename with a newer modification time", async (context) => {
  const root = await temporaryRoot(context);
  for (let index = 0; index < 4; index += 1) {
    await rollout(root, `rollout-z-${index}.jsonl`, `old-${index}`, BASE + index * 1_000);
  }
  await rollout(root, "rollout-a-resumed.jsonl", "resumed", BASE + 60_000);
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root, archived: false }],
    maximumFiles: 2,
    scanBatchFiles: 2,
    advanceIntervalMs: 0,
    rescanIntervalMs: 60_000,
  });

  await discovery.read();
  await discovery.read();
  const recovered = await discovery.read();

  assert.equal(recovered.some((row) => row.localId === "resumed"), true);
  assert.equal(discovery.stats().cachedHeaders <= 2, true);
  discovery.close();
});

test("coalesces a direct watcher hint and handles it before the background cursor", async (context) => {
  const root = await temporaryRoot(context);
  await rollout(root, "rollout-z-background.jsonl", "background", BASE);
  const direct = await rollout(root, "rollout-a-direct.jsonl", "direct", BASE + 1_000);
  let headerReads = 0;
  const headerOrder = [];
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root, archived: false }],
    maximumFiles: 4,
    scanBatchFiles: 1,
    advanceIntervalMs: 60_000,
    readHeader(file, options) {
      headerReads += 1;
      headerOrder.push(file);
      return {
        localId: path.basename(file).includes("direct") ? "direct" : "background",
        updatedAt: new Date(BASE).toISOString(),
        archived: options.archived,
        rolloutFile: file,
      };
    },
  });
  discovery.notice(direct);
  discovery.notice(direct);
  discovery.notice(direct);
  assert.equal(discovery.stats().queuedHints, 1);

  const rows = await discovery.read({ fresh: true });
  assert.equal(rows.some((row) => row.localId === "direct"), true);
  // The trusted header reader receives the canonical path, even for an aliased hint.
  assert.equal(headerOrder[0], await fs.promises.realpath(direct));
  assert.equal(discovery.stats().scannedEntries <= 1, true, "an exact hint skips the separate fresh recent-tree pass");
  assert.equal(discovery.stats().acceptedHints, 1);
  assert.equal(headerReads >= 1, true);
  discovery.close();
});

test("bounds cached headers and cursor work while yielding through a scan batch", async (context) => {
  const root = await temporaryRoot(context);
  for (let index = 0; index < 12; index += 1) await rollout(root, `rollout-${String(index).padStart(2, "0")}.jsonl`, `id-${index}`, BASE + index);
  let yields = 0;
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root }],
    maximumFiles: 3,
    scanBatchFiles: 3,
    yieldEvery: 1,
    advanceIntervalMs: 0,
    yieldControl: async () => { yields += 1; },
  });

  await discovery.read();
  await discovery.read();
  const stats = discovery.stats();

  assert.equal(stats.cachedHeaders <= 3, true);
  assert.equal(stats.scannedFiles <= 6, true);
  assert.equal(stats.cursorDirectories <= 6, true);
  assert.equal(stats.yielded, yields);
  assert.doesNotMatch(JSON.stringify(stats), /rollout-|\\synthetic|[A-Z]:\\/i);
  discovery.close();
});

test("retains a last-known-good header when a changed source has a transient header failure", async (context) => {
  const root = await temporaryRoot(context);
  const file = await rollout(root, "rollout-transient.jsonl", "stable", BASE);
  let fail = false;
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root }],
    maximumFiles: 4,
    advanceIntervalMs: 0,
    readHeader(candidate) {
      if (fail) throw new Error("temporary sharing violation");
      return { localId: "stable", updatedAt: new Date(BASE).toISOString(), rolloutFile: candidate };
    },
  });
  assert.equal((await discovery.read()).length, 1);
  fail = true;
  await writeFile(file, "\n", { flag: "a" });
  await utimes(file, new Date(BASE + 2_000), new Date(BASE + 2_000));

  const retained = await discovery.read();
  assert.deepEqual(retained.map((row) => row.localId), ["stable"]);
  assert.equal(discovery.stats().transientFailures, 1);
  discovery.close();
});

test("evicts a confirmed deleted cached source without retaining a stale row", async (context) => {
  const root = await temporaryRoot(context);
  const file = await rollout(root, "rollout-deleted.jsonl", "deleted", BASE);
  const discovery = createCodexRolloutDiscovery({ roots: [{ root }], maximumFiles: 4, advanceIntervalMs: 60_000 });
  assert.equal((await discovery.read()).length, 1);
  await rm(file);

  assert.deepEqual(await discovery.read(), []);
  assert.equal(discovery.stats().cachedHeaders, 0);
  discovery.close();
});

test("rejects traversal hints and symlink-escape realpaths before header inspection", async (context) => {
  const root = await temporaryRoot(context);
  const candidate = await rollout(root, "rollout-inside.jsonl", "inside", BASE);
  const outside = path.join(root, "..", "outside", "rollout-escape.jsonl");
  let headerReads = 0;
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root }],
    maximumFiles: 4,
    advanceIntervalMs: 60_000,
    operations: {
      ...fs,
      async realpath(value) {
        if (path.resolve(value) === path.resolve(candidate)) return outside;
        return fs.promises.realpath(value);
      },
    },
    readHeader() { headerReads += 1; return null; },
  });
  discovery.notice(path.join(root, "..", "outside", "rollout-traversal.jsonl"));
  discovery.notice(candidate);
  await discovery.read();

  assert.equal(headerReads, 0);
  assert.equal(discovery.stats().rejectedHints >= 2, true);
  discovery.close();
});

test("trustedRolloutPath resolves a valid rollout path and rejects a bad name, an escaping realpath, and an outside-root path", async (context) => {
  const root = await temporaryRoot(context);
  const candidate = await rollout(root, "rollout-inside.jsonl", "inside", BASE);
  const escaping = await rollout(root, "rollout-escapes.jsonl", "escapes", BASE);
  const outside = path.join(root, "..", "outside", "rollout-escape.jsonl");
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root }],
    maximumFiles: 4,
    advanceIntervalMs: 60_000,
    operations: {
      ...fs,
      async realpath(value) {
        if (path.resolve(value) === path.resolve(escaping)) return outside;
        return fs.promises.realpath(value);
      },
    },
  });

  assert.equal(await discovery.trustedRolloutPath(candidate), await fs.promises.realpath(candidate));
  assert.equal(await discovery.trustedRolloutPath(path.join(root, "not-a-rollout.jsonl")), null);
  assert.equal(await discovery.trustedRolloutPath(escaping), null, "a symlink/junction realpath outside the root is rejected");
  assert.equal(await discovery.trustedRolloutPath(path.join(root, "..", "outside", "rollout-traversal.jsonl")), null);
  discovery.close();
});

function meta(id, timestamp = "2026-09-01T10:00:00.000Z") {
  return JSON.stringify({ type: "session_meta", timestamp, payload: { id, cwd: path.join("work", "repo"), source: "cli", timestamp } });
}
function record(timestamp) {
  return JSON.stringify({ type: "event_msg", timestamp, payload: { type: "token_count" } });
}

function fixture(context) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-codex-headers-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, "sessions");
  const archived = path.join(home, "archived_sessions");
  const day = path.join(sessions, "2026", "09", "01");
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  const file = (name, root = day) => path.join(root, `rollout-${name}.jsonl`);
  fs.writeFileSync(file("one"), `${meta("one")}\n${record("2026-09-01T10:05:00.000Z")}\n`);
  fs.writeFileSync(file("two"), `${meta("two")}\n`);
  fs.writeFileSync(file("old", archived), `${meta("old", "2026-08-01T10:00:00.000Z")}\n`);
  fs.writeFileSync(file("broken"), "{\"type\":\"event_msg\"}\n");
  fs.writeFileSync(file("empty"), "");
  return { roots: [{ root: sessions, archived: false }, { root: archived, archived: true }], file, archived };
}

async function enumerate(roots, headerCache) {
  const batches = [];
  const headers = [];
  const result = await enumerateCodexRolloutHeaders(roots, {
    headerCache,
    onBatch(batch) { batches.push(batch); return true; },
    onHeader(header) { headers.push(header); },
  });
  return { result, batches, headers };
}

function countingOpens(context) {
  const original = fs.promises.open;
  const counter = { opens: 0 };
  fs.promises.open = (...args) => { counter.opens += 1; return original.apply(fs.promises, args); };
  context.after(() => { fs.promises.open = original; });
  return counter;
}

/** Cached output equals an uncached pass and every header equals the synchronous reader. */
async function assertEquivalent(roots, cache, message) {
  const cached = await enumerate(roots, cache);
  const uncached = await enumerate(roots);
  assert.deepStrictEqual(cached, uncached, message);
  for (const header of cached.headers) {
    assert.deepStrictEqual(header, readCodexRolloutHeader(header.rolloutFile, { archived: header.archived }), `${message}: sync reader`);
  }
  return cached;
}

test("the header cache reuses unchanged rollouts and follows appends, truncation, replacement, deletion, and renames", async (context) => {
  const { roots, file } = fixture(context);
  const cache = createCodexRolloutHeaderCache({ settleMs: -60_000 });
  const counter = countingOpens(context);
  const first = await assertEquivalent(roots, cache, "initial tree");
  assert.equal(first.result.complete, true, "small files without a session header are explicit non-candidates");
  assert.deepEqual(first.headers.map(({ localId }) => localId).sort(), ["old", "one", "two"]);
  assert.equal(cache.size(), 5, "headers and invalid classifications are cached");

  counter.opens = 0;
  await enumerate(roots, cache);
  assert.equal(counter.opens, 0, "unchanged rollouts, valid or invalid, are never reopened");

  fs.appendFileSync(file("two"), `${record("2026-09-01T11:00:00.000Z")}\n`);
  counter.opens = 0;
  const appended = await enumerate(roots, cache);
  assert.equal(counter.opens, 1, "only the appended rollout is read again");
  assert.equal(appended.headers.find(({ localId }) => localId === "two").updatedAt, "2026-09-01T11:00:00.000Z");
  await assertEquivalent(roots, cache, "appended rollout");

  fs.truncateSync(file("one"), Buffer.byteLength(`${meta("one")}\n`));
  await assertEquivalent(roots, cache, "truncated rollout");

  const replacement = `${file("two")}.tmp`;
  fs.writeFileSync(replacement, `${meta("two", "2026-09-01T12:00:00.000Z")}\n${record("2026-09-01T12:30:00.000Z")}\n`);
  fs.renameSync(replacement, file("two"));
  await assertEquivalent(roots, cache, "replaced rollout");

  fs.writeFileSync(file("broken"), `${meta("broken")}\n`);
  await assertEquivalent(roots, cache, "repaired header");

  fs.rmSync(file("empty"));
  fs.renameSync(file("one"), file("moved"));
  const moved = await assertEquivalent(roots, cache, "deleted and renamed rollouts");
  assert.equal(moved.headers.some(({ rolloutFile }) => rolloutFile === file("one")), false);
  assert.equal(cache.size(), 4, "a complete pass drops entries for files that disappeared");
});

test("an unreadable-looking header still degrades completeness and is not cached", async (context) => {
  const { roots, file } = fixture(context);
  // Larger than the 64 KiB header window with no session_meta: possibly mid-write.
  fs.writeFileSync(file("large"), `${record("2026-09-01T10:00:00.000Z")}\n`.repeat(2_000));
  const cache = createCodexRolloutHeaderCache({ settleMs: -60_000 });
  const counter = countingOpens(context);
  const first = await assertEquivalent(roots, cache, "inconclusive header");
  assert.equal(first.result.complete, false);
  counter.opens = 0;
  await enumerate(roots, cache);
  assert.ok(counter.opens >= 1, "an inconclusive header is read again on the next pass");
});

test("a rollout changed inside the settle window is read again", async (context) => {
  const { roots } = fixture(context);
  const cache = createCodexRolloutHeaderCache();
  const counter = countingOpens(context);
  await assertEquivalent(roots, cache, "recent files");
  assert.equal(cache.size(), 0, "files written moments ago are not trusted by generation yet");
  counter.opens = 0;
  await enumerate(roots, cache);
  assert.equal(counter.opens, 5);
});
