import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSourceLedger } from "../monitor/providers/source-ledger.mjs";

function header(overrides = {}) {
  return {
    localId: "root",
    parentId: null,
    forkedFromId: null,
    groupId: null,
    archived: false,
    createdAt: "2026-09-27T10:00:00.000Z",
    lastRecordAt: null,
    ...overrides,
  };
}

async function tempFile(context, name, bytes = 32) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-source-ledger-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, name);
  await writeFile(file, "x".repeat(bytes));
  return file;
}

test("ingestHeaders indexes a header and family() resolves the lone root", async (context) => {
  const file = await tempFile(context, "root.jsonl");
  const ledger = createSourceLedger({ now: () => 1000 });
  ledger.ingestHeaders([{ file, header: header() }]);
  const family = ledger.family("root");
  assert.equal(family.length, 1);
  assert.equal(family[0].localId, "root");
  assert.equal(family[0].file, file);
  assert.equal(ledger.family("unknown-id"), null, "an unindexed identity is a miss, not an empty family");
});

test("family closure includes a child, a fork, and a member found only through an archived root", async (context) => {
  const rootFile = await tempFile(context, "root.jsonl");
  const childFile = await tempFile(context, "child.jsonl");
  const forkFile = await tempFile(context, "fork.jsonl");
  const archivedFile = await tempFile(context, "archived-grandchild.jsonl");
  const ledger = createSourceLedger({ now: () => 1000 });
  ledger.ingestHeaders([
    { file: rootFile, header: header({ localId: "root" }) },
    { file: childFile, header: header({ localId: "child", parentId: "root" }) },
    { file: forkFile, header: header({ localId: "fork", forkedFromId: "root" }) },
    // Only discoverable transitively, through the child, and stored under an archived root.
    { file: archivedFile, header: header({ localId: "archived-grandchild", parentId: "child", archived: true }) },
  ]);
  const family = ledger.family("root").map((member) => member.localId).sort();
  assert.deepEqual(family, ["archived-grandchild", "child", "fork", "root"]);
});

test("family closure follows a shared group id, but not a header's own default self-reference", async (context) => {
  const rootFile = await tempFile(context, "root.jsonl");
  const siblingFile = await tempFile(context, "sibling.jsonl");
  const unrelatedFile = await tempFile(context, "unrelated.jsonl");
  const ledger = createSourceLedger({ now: () => 1000 });
  ledger.ingestHeaders([
    { file: rootFile, header: header({ localId: "root" }) },
    { file: siblingFile, header: header({ localId: "sibling", groupId: "root" }) },
    { file: unrelatedFile, header: header({ localId: "unrelated" }) },
  ]);
  const family = ledger.family("root").map((member) => member.localId).sort();
  assert.deepEqual(family, ["root", "sibling"]);
});

test("family() rejects past 500 identities and retains no partial result", async () => {
  const ledger = createSourceLedger({ now: () => 1000 });
  const batch = [{ file: null, header: header({ localId: "root" }) }];
  for (let index = 0; index < 501; index += 1) {
    batch.push({ file: null, header: header({ localId: `child-${index}`, parentId: "root" }) });
  }
  ledger.ingestHeaders(batch);
  assert.throws(() => ledger.family("root"), /selected_family_limit/);
});

test("family() closes a deep chain in any ingestion order; only the identity bound rejects", async () => {
  const ledger = createSourceLedger({ now: () => 1000 });
  const chainLength = 40;
  const parentOf = (depth) => (depth === 0 ? "root" : `depth-${depth - 1}`);
  const batch = [{ file: null, header: header({ localId: "root" }) }];
  // Deepest first, so an insertion-order sweep would need one pass per link.
  for (let depth = chainLength - 1; depth >= 0; depth -= 1) {
    batch.push({ file: null, header: header({ localId: `depth-${depth}`, parentId: parentOf(depth) }) });
  }
  ledger.ingestHeaders(batch);
  assert.equal(ledger.family("root").length, chainLength + 1);
});

test("noticeSource parses an unknown file once and reports whether it is new", async (context) => {
  const file = await tempFile(context, "noticed.jsonl");
  let parses = 0;
  const ledger = createSourceLedger({
    now: () => 1000,
    parseHeader: () => { parses += 1; return header({ localId: "noticed" }); },
  });
  const first = ledger.noticeSource(file);
  assert.deepEqual(first, { localId: "noticed", isNew: true });
  const second = ledger.noticeSource(file);
  assert.deepEqual(second, { localId: "noticed", isNew: false });
  assert.equal(parses, 1, "a known file with the same filesystem identity is not parsed again");
  assert.ok(ledger.family("noticed"));
  fs.rmSync(file);
  fs.writeFileSync(file, "replacement");
  ledger.noticeSource(file);
  assert.equal(parses, 2, "a path replaced by a new file is parsed again");
});

test("noticeSource without a configured parseHeader degrades to null", () => {
  const ledger = createSourceLedger({ now: () => 1000 });
  assert.equal(ledger.noticeSource("/some/file.jsonl"), null);
});

test("recency advances from growth even while a pinned mtime never changes", async (context) => {
  const file = await tempFile(context, "growing.jsonl", 16);
  await new Promise((resolve) => { fs.utimes(file, new Date(0), new Date(0), () => resolve()); });
  let clock = 1000;
  const ledger = createSourceLedger({ now: () => clock });
  ledger.ingestHeaders([{ file, header: header({ localId: "growing" }) }]);
  const first = ledger.recency("growing");
  assert.equal(first, new Date(1000).toISOString());

  clock = 2000;
  await new Promise((resolve) => fs.appendFile(file, "more-bytes", resolve));
  await new Promise((resolve) => { fs.utimes(file, new Date(0), new Date(0), () => resolve()); });
  const statAfterGrowth = fs.statSync(file);
  assert.equal(statAfterGrowth.mtime.getTime(), 0, "mtime stays pinned to the file's creation time");
  ledger.ingestHeaders([{ file, header: header({ localId: "growing" }) }]);
  const second = ledger.recency("growing");
  assert.equal(second, new Date(2000).toISOString(), "recency follows the ledger's own growth observation, not mtime");
  assert.notEqual(second, first);
});

test("recency prefers a parsed record timestamp over a growth observation", async (context) => {
  const file = await tempFile(context, "recorded.jsonl");
  const ledger = createSourceLedger({ now: () => 1000 });
  ledger.ingestHeaders([{ file, header: header({ localId: "recorded", lastRecordAt: "2026-09-27T09:00:00.000Z" }) }]);
  assert.equal(ledger.recency("recorded"), "2026-09-27T09:00:00.000Z");
});

test("recency is null for an unindexed identity", () => {
  const ledger = createSourceLedger({ now: () => 1000 });
  assert.equal(ledger.recency("nothing-here"), null);
});

test("a rotated path detaches the stale identity so it no longer resolves to the reused file", async (context) => {
  const file = await tempFile(context, "rotated.jsonl", 8);
  const ledger = createSourceLedger({ now: () => 1000 });
  ledger.ingestHeaders([{ file, header: header({ localId: "old-owner" }) }]);
  assert.equal(ledger.family("old-owner")[0].file, file);

  await writeFile(file, "y".repeat(64));
  ledger.ingestHeaders([{ file, header: header({ localId: "new-owner" }) }]);
  assert.equal(ledger.family("new-owner")[0].file, file);
  assert.equal(ledger.family("old-owner")[0].file, null, "the old identity keeps its topology record but not the reused path");
});

test("LRU eviction removes the least recently touched non-live entries first and never a live one", () => {
  const ledger = createSourceLedger({ now: () => 1000, maxEntries: 3 });
  ledger.ingestHeaders([{ file: null, header: header({ localId: "a" }) }]);
  ledger.ingestHeaders([{ file: null, header: header({ localId: "b" }) }]);
  ledger.ingestHeaders([{ file: null, header: header({ localId: "c" }) }]);
  ledger.markLive(["a"]);
  // "b" is the least recently touched non-live entry once "d" pushes the ledger over capacity.
  ledger.ingestHeaders([{ file: null, header: header({ localId: "d" }) }]);
  assert.equal(ledger.family("a")?.length, 1, "the live entry survives eviction");
  assert.equal(ledger.family("b"), null, "the least recently touched non-live entry is evicted");
  assert.ok(ledger.family("c"));
  assert.ok(ledger.family("d"));
});

test("stats() is a bounded-count diagnostic that never carries a path or header field", async (context) => {
  const file = await tempFile(context, "private" + String(Math.random()).slice(2) + ".jsonl");
  const ledger = createSourceLedger({ now: () => 1000 });
  ledger.ingestHeaders([{ file, header: header({ localId: "root" }) }]);
  const stats = ledger.stats();
  assert.deepEqual(Object.keys(stats).sort(), ["entries", "files", "headers", "live", "misses"]);
  assert.equal(typeof stats.entries, "number");
  assert.equal(typeof stats.files, "number");
  assert.equal(typeof stats.live, "number");
  const serialized = JSON.stringify(stats);
  assert.equal(serialized.includes(file), false);
  assert.doesNotMatch(serialized, /[\\/]/, "a bounded-count diagnostic must never contain a path separator");
});

test("cachedHeader() alone refreshes recency() from growth, with no separate re-ingest", async (context) => {
  const file = await tempFile(context, "touched-only.jsonl", 16);
  await new Promise((resolve) => { fs.utimes(file, new Date(0), new Date(0), () => resolve()); });
  let clock = 1000;
  const ledger = createSourceLedger({ now: () => clock });
  ledger.ingestHeaders([{ file, header: header({ localId: "touched-only" }) }]);
  assert.equal(ledger.recency("touched-only"), new Date(1000).toISOString());

  clock = 5000;
  await new Promise((resolve) => fs.appendFile(file, "more-bytes", resolve));
  // A caller that only ever calls cachedHeader() (as Codex's family listing does), never
  // ingestHeaders/noticeSource again, must still see recency() follow the growth.
  const cached = ledger.cachedHeader(file);
  assert.ok(cached, "the header is still valid: same identity, only larger");
  assert.equal(ledger.recency("touched-only"), new Date(5000).toISOString());
});

test("cachedHeader() costs exactly one statSync per call on a cache hit", async (context) => {
  const file = await tempFile(context, "one-stat.jsonl");
  const ledger = createSourceLedger({ now: () => 1000 });
  ledger.ingestHeaders([{ file, header: header({ localId: "one-stat" }) }]);
  let statCalls = 0;
  const realStatSync = fs.statSync;
  const spy = context.mock.method(fs, "statSync", (target, ...rest) => {
    statCalls += 1;
    return realStatSync(target, ...rest);
  });
  try {
    assert.ok(ledger.cachedHeader(file));
  } finally {
    spy.mock.restore();
  }
  assert.equal(statCalls, 1, "a cache hit must not stat the file more than once");
});

test("a file reached through an aliased directory (e.g. a junction) shares one identity with its real path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-source-ledger-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const realDir = path.join(root, "real");
  const aliasDir = path.join(root, "alias");
  fs.mkdirSync(realDir);
  const realFile = path.join(realDir, "aliased.jsonl");
  fs.writeFileSync(realFile, "x".repeat(16));
  try {
    fs.symlinkSync(realDir, aliasDir, "junction");
  } catch (error) {
    context.skip(`platform cannot create a directory junction/symlink here: ${error.code || error.message}`);
    return;
  }
  const aliasFile = path.join(aliasDir, "aliased.jsonl");
  assert.notEqual(aliasFile, realFile, "the two literal path strings must actually differ");

  const ledger = createSourceLedger({ now: () => 1000 });
  ledger.ingestHeaders([{ file: realFile, header: header({ localId: "aliased" }) }]);
  // The alias path resolves to the same physical file, so the ledger must recognize it as
  // already known (one statSync, no re-parse) rather than tracking a second identity.
  let parses = 0;
  const ledgerWithParse = createSourceLedger({ now: () => 1000, parseHeader: () => { parses += 1; return header({ localId: "aliased" }); } });
  ledgerWithParse.ingestHeaders([{ file: realFile, header: header({ localId: "aliased" }) }]);
  const first = ledgerWithParse.noticeSource(aliasFile);
  assert.deepEqual(first, { localId: "aliased", isNew: false }, "the alias path must resolve to the identity already indexed under the real path");
  assert.equal(parses, 0, "an aliased path already known under its real path is not re-parsed");
  assert.equal(ledger.cachedHeader(aliasFile)?.localId, "aliased", "cachedHeader also recognizes the alias");
});

test("closure depth does not depend on ingestion order", () => {
  const ledger = createSourceLedger({ now: () => 1000 });
  const chain = Array.from({ length: 18 }, (_, index) => header({
    localId: `link-${index}`,
    forkedFromId: index ? `link-${index - 1}` : null,
    createdAt: new Date(Date.UTC(2026, 8, 27, 10, index)).toISOString(),
  }));
  ledger.ingestHeaders(chain.reverse().map((item) => ({ file: null, header: item })));
  assert.equal(ledger.family("link-0").length, 18);
});
