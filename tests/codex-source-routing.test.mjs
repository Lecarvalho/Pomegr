import assert from "node:assert/strict";
import fsPromises, { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexRolloutDiscovery, noticeCodexRolloutSource } from "../monitor/providers/codex-rollout-discovery.mjs";
import {
  codexHeaderToLedgerHeader,
  readCodexLedgerHeader,
  readCodexRolloutHeader,
  resolveCodexRolloutFamily,
} from "../monitor/providers/codex-session-metadata.mjs";
import { createSourceLedger } from "../monitor/providers/source-ledger.mjs";

// New-rollout routing (a watcher notification reaching the shared source ledger without a
// directory walk) and header record-time recency, for the Codex adapter.

async function temporaryRoot(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-source-routing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function ledgerFor(options = {}) {
  return createSourceLedger({ parseHeader: (file) => readCodexLedgerHeader(file), ...options });
}

async function writeRollout(file, id, records = [], options = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: options.metaTimestamp || "2026-09-27T10:00:00.000Z",
      payload: {
        id,
        session_id: id,
        timestamp: options.metaTimestamp || "2026-09-27T10:00:00.000Z",
        cwd: "C:\\synthetic\\repo",
        source: "cli",
      },
    }),
    ...records.map((record) => JSON.stringify(record)),
  ];
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  if (options.mtime) await utimes(file, options.mtime, options.mtime);
}

test("a filtered new-rollout notice reaches the ledger, so a later lookup finds it without walking the tree", async (context) => {
  const root = await temporaryRoot(context);
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const file = path.join(sessionsRoot, "rollout-new-session.jsonl");
  await writeRollout(file, "new-session");
  const discovery = createCodexRolloutDiscovery({ roots: [{ root: sessionsRoot, archived: false }], maximumFiles: 10 });
  context.after(() => discovery.close());
  const ledger = ledgerFor();

  const trusted = await noticeCodexRolloutSource(discovery, ledger, file);
  assert.equal(trusted, await fsPromises.realpath(file));
  assert.ok(ledger.locate("new-session"), "the noticed rollout is indexed in the ledger");

  let opendirCalls = 0;
  const originalOpendir = fsPromises.opendir.bind(fsPromises);
  context.mock.method(fsPromises, "opendir", (...args) => {
    opendirCalls += 1;
    return originalOpendir(...args);
  });
  const family = await resolveCodexRolloutFamily(ledger, [{ root: sessionsRoot, archived: false }], "new-session");
  assert.deepEqual(family.map((header) => header.localId), ["new-session"]);
  assert.equal(opendirCalls, 0, "a ledger-indexed session must not walk the rollout tree");
});

test("a rejected name never reaches the ledger", async (context) => {
  const root = await temporaryRoot(context);
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const file = path.join(sessionsRoot, "not-a-rollout.jsonl");
  await writeRollout(file, "wrong-name");
  const discovery = createCodexRolloutDiscovery({ roots: [{ root: sessionsRoot, archived: false }], maximumFiles: 10 });
  context.after(() => discovery.close());
  const ledger = ledgerFor();

  const trusted = await noticeCodexRolloutSource(discovery, ledger, file);
  assert.equal(trusted, null);
  assert.equal(ledger.locate("wrong-name"), null);
  assert.equal(ledger.stats().entries, 0);
});

test("an escaping realpath (a symlink/junction resolving outside the root) never reaches the ledger", async (context) => {
  const root = await temporaryRoot(context);
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const file = path.join(sessionsRoot, "rollout-escapes.jsonl");
  await writeRollout(file, "escapes");
  const outside = path.join(root, "..", "outside", "rollout-escapes.jsonl");
  const discovery = createCodexRolloutDiscovery({
    roots: [{ root: sessionsRoot, archived: false }],
    maximumFiles: 10,
    operations: {
      ...fsPromises,
      async realpath(value) {
        if (path.resolve(value) === path.resolve(file)) return outside;
        return fsPromises.realpath(value);
      },
    },
  });
  context.after(() => discovery.close());
  const ledger = ledgerFor();

  const trusted = await noticeCodexRolloutSource(discovery, ledger, file);
  assert.equal(trusted, null);
  assert.equal(ledger.locate("escapes"), null);
  assert.equal(ledger.stats().entries, 0);
});

test("a path outside every configured root never reaches the ledger", async (context) => {
  const root = await temporaryRoot(context);
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const outsideFile = path.join(root, "outside", "rollout-outside.jsonl");
  await writeRollout(outsideFile, "outside-root");
  const discovery = createCodexRolloutDiscovery({ roots: [{ root: sessionsRoot, archived: false }], maximumFiles: 10 });
  context.after(() => discovery.close());
  const ledger = ledgerFor();

  const trusted = await noticeCodexRolloutSource(discovery, ledger, outsideFile);
  assert.equal(trusted, null);
  assert.equal(ledger.locate("outside-root"), null);
  assert.equal(ledger.stats().entries, 0);
});

test("header recency comes from record time and ignores a misleading file modification time", async (context) => {
  const root = await temporaryRoot(context);
  const file = path.join(root, "rollout-recency.jsonl");
  await writeRollout(file, "recency", [
    { timestamp: "2026-09-27T10:05:00.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
  ], {
    metaTimestamp: "2026-09-27T10:00:00.000Z",
    // A mtime far away from every record time; Codex does not advance it reliably.
    mtime: new Date("2020-01-01T00:00:00.000Z"),
  });

  const header = readCodexRolloutHeader(file);
  assert.equal(header.createdAt, "2026-09-27T10:00:00.000Z");
  assert.equal(header.updatedAt, "2026-09-27T10:05:00.000Z", "recency follows the newest record, not file mtime");

  const ledger = ledgerFor();
  ledger.ingestHeaders([{ file, header: codexHeaderToLedgerHeader(header) }]);
  assert.equal(ledger.recency("recency"), "2026-09-27T10:05:00.000Z");
});

test("header recency skips an incomplete trailing record left by a write still in flight", async (context) => {
  const root = await temporaryRoot(context);
  const file = path.join(root, "rollout-partial.jsonl");
  await writeRollout(file, "partial", [
    { timestamp: "2026-09-27T10:05:00.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
  ], { metaTimestamp: "2026-09-27T10:00:00.000Z" });
  // Simulate a write still in flight: a truncated trailing line with no terminating newline.
  await fsPromises.appendFile(file, '{"timestamp":"2026-09-27T10:10:00.000Z","type":"event_msg","payload":{"type":"user_mess');

  const header = readCodexRolloutHeader(file);
  assert.equal(header.updatedAt, "2026-09-27T10:05:00.000Z", "the truncated trailing record is skipped");
});

test("recency holds across a rollout rollover: a session continued in a new rollout file of the same family", async (context) => {
  const root = await temporaryRoot(context);
  const oldFile = path.join(root, "rollout-old.jsonl");
  const resumedFile = path.join(root, "rollout-old_resumed.jsonl");
  await writeRollout(oldFile, "rolled", [], {
    metaTimestamp: "2026-09-27T10:00:00.000Z",
    // Misleading mtimes: the old file looks newer by mtime than the resumed file.
    mtime: new Date("2026-09-27T23:00:00.000Z"),
  });
  await writeRollout(resumedFile, "rolled", [
    { timestamp: "2026-09-27T10:30:00.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
  ], {
    metaTimestamp: "2026-09-27T10:15:00.000Z",
    mtime: new Date("2026-09-27T09:00:00.000Z"),
  });

  // Ingestion order must not matter: the ledger keeps the newer record-time copy.
  for (const order of [[oldFile, resumedFile], [resumedFile, oldFile]]) {
    const ledger = ledgerFor();
    for (const file of order) ledger.ingestHeaders([{ file, header: codexHeaderToLedgerHeader(readCodexRolloutHeader(file)) }]);
    assert.equal(ledger.locate("rolled").file, resumedFile, `resumed file wins for order ${order.join(" -> ")}`);
    assert.equal(ledger.recency("rolled"), "2026-09-27T10:30:00.000Z", `recency reflects the resumed file for order ${order.join(" -> ")}`);
  }
});

test("a newest record larger than the tail window still gives record-time recency", async (context) => {
  const root = await temporaryRoot(context);
  const file = path.join(root, "rollout-large-last.jsonl");
  await writeRollout(file, "large-last", [
    { timestamp: "2026-09-27T11:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
    { timestamp: "2026-09-27T12:00:00.000Z", type: "compacted", payload: { padding: "x".repeat(200 * 1024) } },
  ], { mtime: new Date("2020-01-01T00:00:00.000Z") });
  assert.equal(readCodexRolloutHeader(file).updatedAt, "2026-09-27T12:00:00.000Z");
});

test("a newest record beyond the widened read falls back to the later of creation time and mtime", async (context) => {
  const root = await temporaryRoot(context);
  const file = path.join(root, "rollout-huge-last.jsonl");
  const mtime = new Date("2026-09-27T13:00:00.000Z");
  await writeRollout(file, "huge-last", [
    { timestamp: "2026-09-27T12:00:00.000Z", type: "compacted", payload: { padding: "x".repeat(1_200 * 1024) } },
  ], { mtime });
  assert.equal(readCodexRolloutHeader(file).updatedAt, mtime.toISOString());
});

test("header recency is re-read after an append and reused while the file is unchanged", async (context) => {
  const root = await temporaryRoot(context);
  const file = path.join(root, "rollout-cached.jsonl");
  await writeRollout(file, "cached", [
    { timestamp: "2026-09-27T11:00:00.000Z", type: "event_msg", payload: { padding: "x".repeat(80 * 1024) } },
  ]);
  const first = readCodexRolloutHeader(file);
  assert.equal(first.updatedAt, "2026-09-27T11:00:00.000Z");
  assert.equal(readCodexRolloutHeader(file).updatedAt, first.updatedAt);
  await fsPromises.appendFile(file, `${JSON.stringify({ timestamp: "2026-09-27T11:30:00.000Z", type: "event_msg", payload: {} })}\n`);
  assert.equal(readCodexRolloutHeader(file).updatedAt, "2026-09-27T11:30:00.000Z", "an append changes size and invalidates the cached answer");
});
