import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCodexRolloutHeaderCache,
  enumerateCodexRolloutHeaders,
  readCodexRolloutHeader,
} from "../monitor/providers/codex-session-metadata.mjs";

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
