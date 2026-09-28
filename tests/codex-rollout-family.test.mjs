import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { readCodexLedgerHeader, resolveCodexRolloutFamily } from "../monitor/providers/codex-session-metadata.mjs";
import { createSourceLedger } from "../monitor/providers/source-ledger.mjs";

// Codex rollout-family resolution through the shared source ledger.
function writeLedgerRollout(file, id, options = {}) {
  return writeFile(file, `${JSON.stringify({
    type: "session_meta",
    timestamp: options.timestamp || "2026-09-27T10:00:00.000Z",
    payload: {
      id,
      source: options.source || "cli",
      cwd: "C:\\synthetic\\repo",
      ...(options.parentThreadId ? { parent_thread_id: options.parentThreadId } : {}),
    },
  })}\n`, "utf8");
}

test("readSession resolves an indexed rollout family without walking the rollout tree again", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-family-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-ledger-parent.jsonl"), "ledger-parent");
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-ledger-child.jsonl"), "ledger-child", {
    source: { subAgent: "review" }, parentThreadId: "ledger-parent", timestamp: "2026-09-27T10:00:01.000Z",
  });
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0 });
  // Seed the ledger with the full topology through the provider's own header enumeration.
  await provider.enumerateSessionHeaders({ async onBatch() { return true; } });
  let opendirCalls = 0;
  const originalOpendir = fsPromises.opendir.bind(fsPromises);
  context.mock.method(fsPromises, "opendir", (...args) => {
    opendirCalls += 1;
    return originalOpendir(...args);
  });
  const evidence = await provider.readSession("ledger-parent", { historical: true });
  assert.equal(evidence?.localId, "ledger-parent");
  assert.deepEqual(evidence.agents.map((agent) => agent.id).sort(), ["agent-ledger-child", "primary"]);
  assert.equal(opendirCalls, 0, "an indexed family must not walk the rollout tree again");
});

test("a child rollout created after its parent was indexed by the ledger is still found", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-late-child-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-late-parent.jsonl"), "late-parent");
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0 });
  await provider.enumerateSessionHeaders({ async onBatch() { return true; } });
  const firstRead = await provider.readSession("late-parent", { historical: true });
  assert.deepEqual(firstRead.agents.map((agent) => agent.id), ["primary"]);

  await writeLedgerRollout(path.join(sessionsRoot, "rollout-late-child.jsonl"), "late-child", {
    source: { subAgent: "review" }, parentThreadId: "late-parent", timestamp: "2026-09-27T10:00:01.000Z",
  });
  // No header pass runs in between: the read itself must find the new child.
  const secondRead = await provider.readSession("late-parent", { historical: true });
  assert.deepEqual(secondRead.agents.map((agent) => agent.id).sort(), ["agent-late-child", "primary"]);
});

test("an indexed family that would exceed the selection bound still rejects and never truncates silently", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-overflow-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-overflow-root.jsonl"), "overflow-root");
  for (let offset = 0; offset < 501; offset += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 501 - offset) }, (_, index) => writeLedgerRollout(
      path.join(sessionsRoot, `rollout-overflow-${offset + index}.jsonl`), `overflow-${offset + index}`,
      { source: "sub_agent", parentThreadId: "overflow-root" },
    )));
  }
  const provider = createCodexProvider({ codexHome: root, includeArchived: false, cacheMs: 0 });
  // Seed the ledger with the full over-sized family so the rejection below is
  // proven against the ledger's own closure bound, not the cold fallback walk.
  await provider.enumerateSessionHeaders({ async onBatch() { return true; } });
  await assert.rejects(provider.readSession("overflow-root", { historical: true }), /selected_family_limit/);
});

function ledgerFor(options = {}) {
  return createSourceLedger({ parseHeader: (file) => readCodexLedgerHeader(file), ...options });
}

function ingestFile(ledger, file, archived = false) {
  ledger.ingestHeaders([{ file, header: readCodexLedgerHeader(file, { archived }) }]);
}

test("a family read before startup enumeration reaches later dated directories still finds every child", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-partial-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  const oldDay = path.join(sessionsRoot, "2026", "08", "01");
  const rootDay = path.join(sessionsRoot, "2026", "09", "27");
  const laterDay = path.join(sessionsRoot, "2026", "09", "29");
  await Promise.all([oldDay, rootDay, laterDay].map((directory) => mkdir(directory, { recursive: true })));
  await writeLedgerRollout(path.join(oldDay, "rollout-unrelated.jsonl"), "unrelated", { timestamp: "2026-08-01T10:00:00.000Z" });
  const parentFile = path.join(rootDay, "rollout-partial-parent.jsonl");
  await writeLedgerRollout(parentFile, "partial-parent");
  await writeLedgerRollout(path.join(laterDay, "rollout-partial-child.jsonl"), "partial-child", {
    source: { subAgent: "review" }, parentThreadId: "partial-parent", timestamp: "2026-09-29T09:00:00.000Z",
  });
  await writeFile(path.join(laterDay, "rollout-partial-fork.jsonl"), `${JSON.stringify({
    type: "session_meta", timestamp: "2026-09-29T09:30:00.000Z",
    payload: { id: "partial-fork", source: "cli", cwd: "C:\\synthetic\\repo", forked_from_id: "partial-parent" },
  })}\n`, "utf8");
  const ledger = ledgerFor();
  ingestFile(ledger, parentFile); // only the root is indexed, as early in a startup scan
  const listed = [];
  const originalReaddir = fsPromises.readdir.bind(fsPromises);
  context.mock.method(fsPromises, "readdir", (directory, ...rest) => {
    listed.push(path.resolve(directory));
    return originalReaddir(directory, ...rest);
  });
  const family = await resolveCodexRolloutFamily(ledger, [{ root: sessionsRoot, archived: false }], "partial-parent");
  assert.deepEqual(family.map((header) => header.localId).sort(), ["partial-child", "partial-fork", "partial-parent"]);
  assert.equal(listed.includes(path.resolve(oldDay)), false, "dated directories older than the root are not listed");
});

test("a family member moved into the archive is found at its new path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-moved-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  const archivedRoot = path.join(root, "archived_sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(archivedRoot, { recursive: true });
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-mv-parent.jsonl"), "mv-parent");
  const childFile = path.join(sessionsRoot, "rollout-mv-child.jsonl");
  await writeLedgerRollout(childFile, "mv-child", {
    source: { subAgent: "review" }, parentThreadId: "mv-parent", timestamp: "2026-09-27T10:00:01.000Z",
  });
  const provider = createCodexProvider({ codexHome: root, includeArchived: true, cacheMs: 0 });
  await provider.enumerateSessionHeaders({ async onBatch() { return true; } });
  const first = await provider.readSession("mv-parent", { historical: true });
  assert.deepEqual(first.agents.map((agent) => agent.id).sort(), ["agent-mv-child", "primary"]);
  await fsPromises.rename(childFile, path.join(archivedRoot, "rollout-mv-child.jsonl"));
  const second = await provider.readSession("mv-parent", { historical: true });
  assert.deepEqual(second.agents.map((agent) => agent.id).sort(), ["agent-mv-child", "primary"]);
});

test("a family member evicted from a full ledger is found again from disk", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-evicted-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const parentFile = path.join(sessionsRoot, "rollout-ev-parent.jsonl");
  const childFile = path.join(sessionsRoot, "rollout-ev-child.jsonl");
  await writeLedgerRollout(parentFile, "ev-parent");
  await writeLedgerRollout(childFile, "ev-child", {
    source: { subAgent: "review" }, parentThreadId: "ev-parent", timestamp: "2026-09-27T10:00:01.000Z",
  });
  const ledger = ledgerFor({ maxEntries: 3 });
  ingestFile(ledger, childFile);
  ingestFile(ledger, parentFile);
  ledger.markLive(["ev-parent"]);
  for (let index = 0; index < 4; index += 1) {
    const other = path.join(sessionsRoot, `rollout-ev-other-${index}.jsonl`);
    await writeLedgerRollout(other, `ev-other-${index}`);
    ingestFile(ledger, other);
  }
  assert.equal(ledger.locate("ev-child"), null, "the child was evicted");
  const family = await resolveCodexRolloutFamily(ledger, [{ root: sessionsRoot, archived: false }], "ev-parent");
  assert.deepEqual(family.map((header) => header.localId).sort(), ["ev-child", "ev-parent"]);
});

test("an absent identity does not repeat the whole-tree walk until its miss expires", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-miss-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-present.jsonl"), "present");
  let clock = 1_000;
  const ledger = ledgerFor({ now: () => clock, missTtlMs: 60_000 });
  let walks = 0;
  const originalOpendir = fsPromises.opendir.bind(fsPromises);
  context.mock.method(fsPromises, "opendir", (...args) => {
    walks += 1;
    return originalOpendir(...args);
  });
  const roots = [{ root: sessionsRoot, archived: false }];
  assert.equal(await resolveCodexRolloutFamily(ledger, roots, "ghost-child"), null);
  const afterFirst = walks;
  assert.ok(afterFirst > 0);
  assert.equal(await resolveCodexRolloutFamily(ledger, roots, "ghost-child"), null);
  assert.equal(walks, afterFirst, "a remembered miss skips the walk");
  clock += 60_001;
  assert.equal(await resolveCodexRolloutFamily(ledger, roots, "ghost-child"), null);
  assert.ok(walks > afterFirst, "an expired miss walks again");
});

test("an identity present in both roots resolves to the copy the whole-tree walk chose", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-duplicate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  const archivedRoot = path.join(root, "archived_sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(archivedRoot, { recursive: true });
  const activeFile = path.join(sessionsRoot, "rollout-dup.jsonl");
  const archivedFile = path.join(archivedRoot, "rollout-dup.jsonl");
  await writeLedgerRollout(activeFile, "dup");
  await writeLedgerRollout(archivedFile, "dup");
  await utimes(archivedFile, new Date("2026-09-27T10:00:01Z"), new Date("2026-09-27T10:00:01Z"));
  await utimes(activeFile, new Date("2026-09-27T11:00:00Z"), new Date("2026-09-27T11:00:00Z"));
  const ledger = ledgerFor();
  ingestFile(ledger, activeFile);
  ingestFile(ledger, archivedFile, true); // archive roots enumerate last
  const roots = [{ root: sessionsRoot, archived: false }, { root: archivedRoot, archived: true }];
  const family = await resolveCodexRolloutFamily(ledger, roots, "dup");
  assert.deepEqual(family.map((header) => header.rolloutFile), [activeFile]);
});

test("a member path now carrying another identity falls back to the complete walk", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-replaced-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const parentFile = path.join(sessionsRoot, "rollout-rp-parent.jsonl");
  const childFile = path.join(sessionsRoot, "rollout-rp-child.jsonl");
  const child = { source: { subAgent: "review" }, parentThreadId: "rp-parent", timestamp: "2026-09-27T10:00:01.000Z" };
  await writeLedgerRollout(parentFile, "rp-parent");
  await writeLedgerRollout(childFile, "rp-child", child);
  const ledger = ledgerFor();
  ingestFile(ledger, parentFile);
  ingestFile(ledger, childFile);
  await writeLedgerRollout(childFile, "rp-stranger"); // same path, unrelated identity
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-rp-child-2.jsonl"), "rp-child", child);
  const family = await resolveCodexRolloutFamily(ledger, [{ root: sessionsRoot, archived: false }], "rp-parent");
  assert.deepEqual(family.map((header) => header.localId).sort(), ["rp-child", "rp-parent"]);
});

test("verifying a family never loses an indexed member to eviction by the files it reads", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-evict-verify-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const parentFile = path.join(sessionsRoot, "rollout-ev2-parent.jsonl");
  const childFile = path.join(sessionsRoot, "rollout-ev2-child.jsonl");
  await writeLedgerRollout(parentFile, "ev2-parent");
  await writeLedgerRollout(childFile, "ev2-child", {
    source: { subAgent: "review" }, parentThreadId: "ev2-parent", timestamp: "2026-09-27T10:00:01.000Z",
  });
  const ledger = ledgerFor({ maxEntries: 2 });
  ingestFile(ledger, childFile);
  ingestFile(ledger, parentFile);
  ledger.markLive(["ev2-parent"]);
  // Unindexed files read during verification push the indexed child to the eviction frontier.
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-ev2-new-a.jsonl"), "ev2-new-a");
  await writeLedgerRollout(path.join(sessionsRoot, "rollout-ev2-new-b.jsonl"), "ev2-new-b");
  const roots = [{ root: sessionsRoot, archived: false }];
  for (let read = 0; read < 2; read += 1) {
    const family = await resolveCodexRolloutFamily(ledger, roots, "ev2-parent");
    assert.deepEqual(family.map((header) => header.localId).sort(), ["ev2-child", "ev2-parent"]);
  }
});

test("header parsing during verification yields to the event loop", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-yield-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const parentFile = path.join(sessionsRoot, "rollout-yield-parent.jsonl");
  await writeLedgerRollout(parentFile, "yield-parent");
  for (let index = 0; index < 200; index += 1) {
    await writeLedgerRollout(path.join(sessionsRoot, `rollout-yield-${index}.jsonl`), `yield-${index}`);
  }
  const ledger = ledgerFor();
  ingestFile(ledger, parentFile);
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 0);
  try {
    await resolveCodexRolloutFamily(ledger, [{ root: sessionsRoot, archived: false }], "yield-parent");
  } finally {
    clearInterval(interval);
  }
  assert.ok(ticks > 0, "timers ran while 200 unindexed headers were parsed");
});

test("an unreadable root is not remembered as missing", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-unreadable-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const parentFile = path.join(sessionsRoot, "rollout-ur-parent.jsonl");
  await writeLedgerRollout(parentFile, "ur-parent");
  const ledger = ledgerFor();
  ingestFile(ledger, parentFile);
  const roots = [{ root: sessionsRoot, archived: false }];
  await rm(parentFile);
  await mkdir(parentFile); // the path exists but cannot be read as a rollout
  assert.equal(await resolveCodexRolloutFamily(ledger, roots, "ur-parent"), null);
  assert.equal(ledger.recentMiss("ur-parent"), false);
  await rm(parentFile, { recursive: true });
  await writeLedgerRollout(parentFile, "ur-parent");
  const family = await resolveCodexRolloutFamily(ledger, roots, "ur-parent");
  assert.deepEqual(family.map((header) => header.localId), ["ur-parent"]);
});

test("an indexed path rewritten in place by a smaller family member is parsed again", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-rewrite-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const parentFile = path.join(sessionsRoot, "rollout-rw-parent.jsonl");
  const reusedFile = path.join(sessionsRoot, "rollout-rw-reused.jsonl");
  await writeLedgerRollout(parentFile, "rw-parent");
  await writeFile(reusedFile, `${JSON.stringify({
    type: "session_meta", timestamp: "2026-09-27T09:00:00.000Z",
    payload: { id: "rw-unrelated", source: "cli", cwd: "C:\\synthetic\\repo", padding: "x".repeat(4_096) },
  })}\n`, "utf8");
  const ledger = ledgerFor();
  ingestFile(ledger, parentFile);
  ingestFile(ledger, reusedFile);
  await writeLedgerRollout(reusedFile, "rw-child", {
    source: { subAgent: "review" }, parentThreadId: "rw-parent", timestamp: "2026-09-27T10:00:01.000Z",
  });
  const family = await resolveCodexRolloutFamily(ledger, [{ root: sessionsRoot, archived: false }], "rw-parent");
  assert.deepEqual(family.map((header) => header.localId).sort(), ["rw-child", "rw-parent"]);
});

test("a root that joins another thread's group also finds older group siblings", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-ledger-group-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  const olderDay = path.join(sessionsRoot, "2026", "09", "20");
  const rootDay = path.join(sessionsRoot, "2026", "09", "27");
  await mkdir(olderDay, { recursive: true });
  await mkdir(rootDay, { recursive: true });
  const meta = (id, sessionId, timestamp) => `${JSON.stringify({
    type: "session_meta", timestamp,
    payload: { id, session_id: sessionId, source: "cli", cwd: "C:\\synthetic\\repo" },
  })}\n`;
  await writeFile(path.join(olderDay, "rollout-grp-sibling.jsonl"), meta("grp-sibling", "grp-origin", "2026-09-20T10:00:00.000Z"), "utf8");
  const rootFile = path.join(rootDay, "rollout-grp-root.jsonl");
  await writeFile(rootFile, meta("grp-root", "grp-origin", "2026-09-27T10:00:00.000Z"), "utf8");
  const ledger = ledgerFor();
  ingestFile(ledger, rootFile);
  const family = await resolveCodexRolloutFamily(ledger, [{ root: sessionsRoot, archived: false }], "grp-root");
  assert.deepEqual(family.map((header) => header.localId).sort(), ["grp-root", "grp-sibling"]);
});
