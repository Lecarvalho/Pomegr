import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openMonitorStore } from "../monitor/monitor-store.mjs";
import { createFileChangeIndexContributor } from "../monitor/file-change-index.mjs";
import { createFileHistorySource, attachFileHistory } from "../monitor/file-history-domain.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";

// --- shared store scaffolding, mirroring tests/resource-domain.test.mjs ---

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-file-history-domain-"));
  const closers = [];
  t.after(async () => {
    for (const closer of closers) {
      try { await closer(); } catch { /* best-effort cleanup */ }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return { directory, onClose: (closer) => closers.push(closer) };
}

async function openStore(t) {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  return store;
}

/** A valid-shaped `repo-<24 hex>` identity for a small integer, so every domain-source test
 * exercises the same `REPOSITORY_ID_PATTERN` gate the real request-handler route enforces. */
function repoId(n) {
  return `repo-${String(n).padStart(24, "0")}`;
}

/** A controllable monitorStoreRuntime stand-in that runs every registered contributor, in
 * registration order, on runCycle() -- like the real monitor-store-runtime.mjs. */
function createStubRuntime({ store = null, storageReadiness = "ready" } = {}) {
  const contributors = [];
  let afterCheckpointWriteCalls = 0;
  const runtime = Object.freeze({
    registerContributor: (registered) => { contributors.push(registered); },
    store: () => store,
    serveStorage: () => ({ snapshot: { value: { readiness: storageReadiness } } }),
    afterCheckpointWrite: () => { afterCheckpointWriteCalls += 1; },
  });
  return {
    runtime,
    async runCycle(cycleStore = store, options = {}) {
      for (const contributor of contributors) await contributor.onCheckpoint(cycleStore, options);
    },
    afterCheckpointWriteCalls: () => afterCheckpointWriteCalls,
    setStore: (next) => { store = next; },
    setStorageReadiness: (value) => { storageReadiness = value; },
  };
}

// --- synthetic checkpoint evidence, mirroring tests/file-change-index.test.mjs ---

function toolCall({ timestamp, actorId = "agent-1", fileChanges }) {
  return { timestamp, actor: { id: actorId }, fileChanges };
}
function snapshot({ providerId = "claude", localSessionId, cwd, toolCalls }) {
  return { providerId, localSessionId, evidence: { session: { cwd }, toolCalls } };
}
function stubResolver(repositoryId, root) {
  return async () => ({ repositoryId, root });
}

// --- raw-row helpers for scenarios the tool-call pipeline cannot express directly ---

function insertFile(store, { id, repositoryId, path: currentPath, deletedAt = null, firstSeenAt = 0 }) {
  store.database.prepare("INSERT INTO files (id, repository_id, current_path, first_seen_at, deleted_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, repositoryId, currentPath, firstSeenAt, deletedAt);
}
function insertChange(store, { fileId, sessionId = null, agentId = null, kind, observedAt }) {
  store.database.prepare("INSERT INTO file_changes (file_id, session_id, agent_id, kind, observed_at, request_number) VALUES (?, ?, ?, ?, ?, NULL)")
    .run(fileId, sessionId, agentId, kind, observedAt);
}

async function buildSource(store, overrides = {}) {
  const stub = createStubRuntime({ store });
  const source = createFileHistorySource({
    monitorStoreRuntime: stub.runtime,
    demandedSessionIds: () => [],
    onSessionChange: () => {},
    catalog: () => [],
    ...overrides,
  });
  return { stub, source };
}

// --- construction guards ---

test("createFileHistorySource requires a real monitor store runtime and demand/change hooks", () => {
  assert.throws(() => createFileHistorySource({}), TypeError);
  assert.throws(() => createFileHistorySource({ monitorStoreRuntime: {} }), TypeError);
  const stub = createStubRuntime();
  assert.throws(() => createFileHistorySource({ monitorStoreRuntime: stub.runtime }), TypeError);
});

// --- sessionFiles: grouping, counts, created vs edited kind ---

test("sessionFiles groups file_changes by file: newest kind, change count, newest time, newest-file-first", async (t) => {
  const store = await openStore(t);
  const root = (await temporaryDirectory(t)).directory;
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repoId(1), root), checkpointStore: null });
  const snap = snapshot({
    localSessionId: "session-1", cwd: root,
    toolCalls: [
      toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [{ path: "a.txt", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T10:01:00.000Z", fileChanges: [{ path: "a.txt", kind: "edited" }] }),
      toolCall({ timestamp: "2026-09-22T10:02:00.000Z", fileChanges: [{ path: "a.txt", kind: "edited" }] }),
      toolCall({ timestamp: "2026-09-22T10:03:00.000Z", fileChanges: [{ path: "b.txt", kind: "created" }] }),
    ],
  });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snap] });

  const changed = [];
  const { stub, source } = await buildSource(store, { demandedSessionIds: () => ["claude:session-1"], onSessionChange: (id) => changed.push(id) });
  assert.deepEqual(source.sessionFiles("claude:session-1"), { readiness: "loading", files: [], truncated: false });
  await stub.runCycle();

  const block = source.sessionFiles("claude:session-1");
  assert.equal(block.readiness, "ready");
  assert.equal(block.truncated, false);
  assert.deepEqual(block.files.map((file) => file.path), ["b.txt", "a.txt"], "newest-changed file first");
  const a = block.files.find((file) => file.path === "a.txt");
  assert.equal(a.kind, "edited", "newest kind wins, not the creation kind");
  assert.equal(a.changeCount, 3);
  assert.match(a.fileId, /^f\d+$/);
  assert.equal(a.lastObservedAt, "2026-09-22T10:02:00.000Z");
  const b = block.files.find((file) => file.path === "b.txt");
  assert.equal(b.kind, "created");
  assert.equal(b.changeCount, 1);
  assert.deepEqual(changed, ["claude:session-1"]);

  // A second cycle over unchanged data does not re-notify.
  await stub.runCycle();
  assert.deepEqual(changed, ["claude:session-1"]);
});

// --- repositoryFiles: distinct folder rollups, never sums ---

test("repositoryFiles: distinct-session folder rollups (never a per-file sum), deleted flag, folders vs historicalFolders", async (t) => {
  const store = await openStore(t);
  const root = (await temporaryDirectory(t)).directory;
  const repositoryId = repoId(2);
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });
  // session-1 touches two files under app/components in one session: a distinct-session
  // rollup must count "app" and "app/components" once for session-1, not twice.
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snapshot({
    localSessionId: "session-1", cwd: root,
    toolCalls: [toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [
      { path: "app/components/A.tsx", kind: "created" },
      { path: "app/components/B.tsx", kind: "created" },
    ] })],
  })] });
  await contributor.onCheckpoint(store, { now: 2, snapshots: [snapshot({
    localSessionId: "session-2", cwd: root,
    toolCalls: [
      toolCall({ timestamp: "2026-09-22T10:05:00.000Z", fileChanges: [{ path: "app/components/A.tsx", kind: "edited" }] }),
      toolCall({ timestamp: "2026-09-22T10:06:00.000Z", fileChanges: [{ path: "app/deleted.tsx", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T10:07:00.000Z", fileChanges: [{ path: "app/deleted.tsx", kind: "deleted" }] }),
    ],
  })] });

  const { stub, source } = await buildSource(store);
  assert.deepEqual(source.repositoryFiles(repositoryId), { kind: "files", revision: 0, readiness: "loading", repositoryId, files: [], folders: [], historicalFolders: [], truncated: false });
  await stub.runCycle();

  const listing = source.repositoryFiles(repositoryId);
  assert.equal(listing.readiness, "ready");
  assert.ok(listing.revision >= 1);
  const byPath = Object.fromEntries(listing.files.map((file) => [file.path, file]));
  assert.equal(byPath["app/components/A.tsx"].sessionCount, 2, "session-1 and session-2 both touched A.tsx");
  assert.equal(byPath["app/components/B.tsx"].sessionCount, 1, "only session-1 touched B.tsx");
  assert.equal(byPath["app/deleted.tsx"].deleted, true);
  assert.equal(byPath["app/components/A.tsx"].deleted, false);

  const folderCount = (folders, folderPath) => folders.find((folder) => folder.path === folderPath)?.sessionCount ?? null;
  assert.equal(folderCount(listing.folders, "app/components"), 2, "distinct sessions {1,2}, never the per-file sum 2+1=3");
  assert.equal(folderCount(listing.folders, "app"), 2, "app/deleted.tsx excluded from the non-deleted rollup, but session-1/2 still both touched app/components");
  assert.equal(folderCount(listing.historicalFolders, "app"), 2, "app/deleted.tsx is also under session-2, already counted");

  // repositoryFiles() self-queues; never touches SQLite again once the block is committed.
  const guarded = { get database() { throw new Error("repositoryFiles() must not read SQLite once cached"); } };
  stub.setStore(guarded);
  assert.deepEqual(source.repositoryFiles(repositoryId).files.map((f) => f.path).sort(), listing.files.map((f) => f.path).sort());
});

// --- fileHistory: moved file, old-path deep link, pathAtTime ---

test("fileHistory: an old path deep-links to the moved file; pathAtTime reflects history correctly", async (t) => {
  const store = await openStore(t);
  const root = (await temporaryDirectory(t)).directory;
  const repositoryId = repoId(3);
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snapshot({
    localSessionId: "session-1", cwd: root,
    toolCalls: [toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [{ path: "old.txt", kind: "created" }] })],
  })] });
  await contributor.onCheckpoint(store, { now: 2, snapshots: [snapshot({
    localSessionId: "session-2", cwd: root,
    toolCalls: [toolCall({ timestamp: "2026-09-22T10:05:00.000Z", fileChanges: [{ path: "new.txt", previousPath: "old.txt", kind: "moved" }] })],
  })] });
  await contributor.onCheckpoint(store, { now: 3, snapshots: [snapshot({
    localSessionId: "session-3", cwd: root,
    toolCalls: [toolCall({ timestamp: "2026-09-22T10:10:00.000Z", fileChanges: [{ path: "new.txt", kind: "edited" }] })],
  })] });

  const { stub, source } = await buildSource(store);
  source.fileHistory(repositoryId, { path: "old.txt" }); // self-queues; the first read is "loading"
  await stub.runCycle();

  const byPath = source.fileHistory(repositoryId, { path: "old.txt" });
  assert.equal(byPath.readiness, "ready");
  assert.equal(byPath.path, "new.txt", "resolves to the current path");
  assert.match(byPath.fileId, /^f\d+$/);
  assert.equal(byPath.sessions.length, 3);
  assert.deepEqual(byPath.sessions.map((s) => s.sessionId), ["claude:session-3", "claude:session-2", "claude:session-1"], "newest session first");

  source.fileHistory(repositoryId, { fileId: byPath.fileId }); // a distinct key from the path lookup; self-queues
  await stub.runCycle();
  const byId = source.fileHistory(repositoryId, { fileId: byPath.fileId });
  assert.deepEqual(byId.sessions, byPath.sessions, "the same file resolved by ID matches the path lookup");

  const created = byPath.sessions.find((s) => s.sessionId === "claude:session-1");
  assert.equal(created.kind, "created");
  assert.equal(created.pathAtTime, "old.txt", "the creating session's own path was old.txt, which differs from the current path");

  const moved = byPath.sessions.find((s) => s.sessionId === "claude:session-2");
  assert.equal(moved.kind, "moved");
  assert.equal(moved.pathAtTime, null, "at the instant of its own move the new path is already the valid one");

  const edited = byPath.sessions.find((s) => s.sessionId === "claude:session-3");
  assert.equal(edited.kind, "edited");
  assert.equal(edited.pathAtTime, null, "no further move happened; the current path was already valid");

  source.fileHistory(repositoryId, { path: "never/existed.txt" }); // self-queues a distinct key
  await stub.runCycle();
  const unmatched = source.fileHistory(repositoryId, { path: "never/existed.txt" });
  assert.deepEqual(unmatched, { kind: "history", revision: 1, readiness: "ready", repositoryId, fileId: null, path: "never/existed.txt", sessions: [], unattributedChanges: 0, truncated: false });
});

// --- fileHistory: an unattributed (session-less) change never becomes a phantom session ---

test("fileHistory: a change with no session counts only toward unattributedChanges, never a session entry", async (t) => {
  const store = await openStore(t);
  const repositoryId = repoId(4);
  insertFile(store, { id: 1, repositoryId, path: "renamed.txt" });
  insertChange(store, { fileId: 1, sessionId: "claude:session-1", agentId: "agent-1", kind: "created", observedAt: 1_000 });
  // Represents a Git-only-observed continuity event: no session, no agent -- established
  // path/file continuity only, per AGENTS.md's "File-change history" bullet.
  insertChange(store, { fileId: 1, sessionId: null, agentId: null, kind: "moved", observedAt: 2_000 });

  const { stub, source } = await buildSource(store);
  source.fileHistory(repositoryId, { path: "renamed.txt" }); // self-queues; the first read is "loading"
  await stub.runCycle();

  const history = source.fileHistory(repositoryId, { path: "renamed.txt" });
  assert.equal(history.readiness, "ready");
  assert.equal(history.sessions.length, 1);
  assert.equal(history.sessions[0].sessionId, "claude:session-1");
  assert.equal(history.unattributedChanges, 1);
});

// --- unsafe/corrupted rows are dropped, never served ---

test("unsafe stored paths are dropped from sessionFiles, repositoryFiles, and fileHistory", async (t) => {
  const store = await openStore(t);
  const repositoryId = repoId(5);
  insertFile(store, { id: 1, repositoryId, path: "../escape.txt" });
  insertChange(store, { fileId: 1, sessionId: "claude:session-1", agentId: "agent-1", kind: "created", observedAt: 1_000 });
  insertFile(store, { id: 2, repositoryId, path: "safe.txt" });
  insertChange(store, { fileId: 2, sessionId: "claude:session-1", agentId: "agent-1", kind: "created", observedAt: 2_000 });

  const { stub, source } = await buildSource(store, { demandedSessionIds: () => ["claude:session-1"] });
  source.repositoryFiles(repositoryId); // self-queues; the first read is "loading"
  source.fileHistory(repositoryId, { fileId: "f1" }); // self-queues a distinct key
  await stub.runCycle();

  const sessionBlock = source.sessionFiles("claude:session-1");
  assert.deepEqual(sessionBlock.files.map((f) => f.path), ["safe.txt"], "the unsafe path is dropped, the safe one is kept");

  const listing = source.repositoryFiles(repositoryId);
  assert.equal(listing.readiness, "ready");
  assert.deepEqual(listing.files.map((f) => f.path), ["safe.txt"]);

  const byId = source.fileHistory(repositoryId, { fileId: "f1" });
  assert.equal(byId.readiness, "ready");
  assert.equal(byId.fileId, null, "a corrupted stored path resolves like no match at all");
});

// --- readiness: unavailable / rebuilding / loading / ready, never a synchronous SQLite read ---

test("readiness: unavailable when the store is null, rebuilding when storage readiness is rebuilding, loading before the first fill", async () => {
  const repositoryId = repoId(6);
  const unavailable = await buildSource(null);
  assert.equal(unavailable.source.sessionFiles("any").readiness, "unavailable");
  assert.equal(unavailable.source.repositoryFiles(repositoryId).readiness, "unavailable");
  assert.equal(unavailable.source.fileHistory(repositoryId, { path: "a.txt" }).readiness, "unavailable");

  const guardedStore = {};
  Object.defineProperty(guardedStore, "database", { get() { throw new Error("must not read SQLite"); } });
  const stub = createStubRuntime({ store: guardedStore, storageReadiness: "rebuilding" });
  const source = createFileHistorySource({ monitorStoreRuntime: stub.runtime, demandedSessionIds: () => [], onSessionChange: () => {} });
  assert.equal(source.sessionFiles("any").readiness, "rebuilding");
  assert.equal(source.repositoryFiles(repositoryId).readiness, "rebuilding");
  assert.equal(source.fileHistory(repositoryId, { path: "a.txt" }).readiness, "rebuilding");

  stub.setStorageReadiness("ready");
  assert.equal(source.repositoryFiles(repositoryId).readiness, "loading", "no block yet, but no longer rebuilding");
});

test("requestSessionFiles: nudges afterCheckpointWrite once per session (coalesced) and stops once a block exists", async (t) => {
  const store = await openStore(t);
  const { stub, source } = await buildSource(store, { demandedSessionIds: () => ["claude:s1"] });
  source.requestSessionFiles("claude:s1");
  source.requestSessionFiles("claude:s1");
  assert.equal(stub.afterCheckpointWriteCalls(), 1);
  await stub.runCycle();
  assert.equal(source.sessionFiles("claude:s1").readiness, "ready");
  source.requestSessionFiles("claude:s1");
  assert.equal(stub.afterCheckpointWriteCalls(), 1, "a session with a block never nudges again");
});

test("requestSessionFiles: an explicitly requested retained session is hydrated ahead of the 32-session cycle bound", async (t) => {
  const store = await openStore(t);
  const repositoryId = repoId(11);
  for (let index = 1; index <= 40; index += 1) {
    insertFile(store, { id: index, repositoryId, path: `f${index}.txt` });
    insertChange(store, { fileId: index, sessionId: `claude:s${index}`, agentId: "agent-1", kind: "created", observedAt: index });
  }
  const retained = Array.from({ length: 40 }, (_value, index) => `claude:s${index + 1}`);
  const { stub, source } = await buildSource(store, { demandedSessionIds: () => retained });

  source.requestSessionFiles("claude:s40");
  await stub.runCycle();

  assert.equal(source.sessionFiles("claude:s40").readiness, "ready");
  assert.equal(source.sessionFiles("claude:s32").readiness, "loading", "the requested session takes one of the bounded hydration slots");
});

test("requestSessionFiles: more than 32 explicit requests stay queued until every session is hydrated", async (t) => {
  const store = await openStore(t);
  const repositoryId = repoId(13);
  const retained = Array.from({ length: 40 }, (_value, index) => `claude:queued-${index + 1}`);
  for (let index = 1; index <= 40; index += 1) {
    insertFile(store, { id: index, repositoryId, path: `queued-${index}.txt` });
    insertChange(store, { fileId: index, sessionId: retained[index - 1], agentId: "agent-1", kind: "created", observedAt: index });
  }
  const { stub, source } = await buildSource(store, { demandedSessionIds: () => retained });
  for (const sessionId of retained) source.requestSessionFiles(sessionId);

  const nudgesBeforeFirstCycle = stub.afterCheckpointWriteCalls();
  await stub.runCycle();
  assert.equal(source.sessionFiles(retained[31]).readiness, "ready");
  assert.equal(source.sessionFiles(retained[32]).readiness, "loading");
  assert.equal(
    stub.afterCheckpointWriteCalls(),
    nudgesBeforeFirstCycle + 1,
    "the remaining explicit requests schedule their own next checkpoint after the coalesced first cycle",
  );

  await stub.runCycle();
  for (const sessionId of retained) assert.equal(source.sessionFiles(sessionId).readiness, "ready", sessionId);
});

test("fileHistory: SQL aggregation retains older sessions and full edit counts beyond 20,000 changes", async (t) => {
  const store = await openStore(t);
  const repositoryId = repoId(12);
  insertFile(store, { id: 1, repositoryId, path: "busy.txt" });
  insertChange(store, { fileId: 1, sessionId: "claude:older", agentId: "agent-1", kind: "created", observedAt: 1 });
  const insertBusyChange = store.database.prepare(
    "INSERT INTO file_changes (file_id, session_id, agent_id, kind, observed_at, request_number) VALUES (?, ?, ?, ?, ?, NULL)",
  );
  store.database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 20_001; index += 1) {
      insertBusyChange.run(1, "claude:busy", "agent-1", "edited", index + 2);
    }
    store.database.exec("COMMIT");
  } catch (error) {
    try { store.database.exec("ROLLBACK"); } catch { /* best effort */ }
    throw error;
  }

  const { stub, source } = await buildSource(store);
  source.fileHistory(repositoryId, { path: "busy.txt" });
  await stub.runCycle();
  const history = source.fileHistory(repositoryId, { path: "busy.txt" });

  assert.equal(history.readiness, "ready");
  assert.equal(history.truncated, false);
  assert.deepEqual(history.sessions.map((session) => session.sessionId), ["claude:busy", "claude:older"]);
  assert.equal(history.sessions[0].editCount, 20_001);
});

// --- LRU and idle bounds for repository listings and file histories ---

test("repositoryFiles: LRU-bounded to 64 concurrently retained listings", async (t) => {
  const store = await openStore(t);
  const { stub, source } = await buildSource(store);
  for (let index = 0; index < 65; index += 1) source.repositoryFiles(repoId(index));
  await stub.runCycle();
  // Touching a 65th key evicts the least-recently-touched (index 0).
  assert.equal(source.repositoryFiles(repoId(0)).readiness, "loading", "evicted by the 64-entry cap, requires a fresh build");
});

test("fileHistory: a new selection is built in the next cycle even after 32 files already hold blocks", async (t) => {
  const store = await openStore(t);
  const repositoryId = repoId(8);
  for (let index = 1; index <= 33; index += 1) {
    insertFile(store, { id: index, repositoryId, path: `f${index}.txt` });
    insertChange(store, { fileId: index, sessionId: "claude:s1", agentId: "agent-1", kind: "created", observedAt: index });
  }
  const { stub, source } = await buildSource(store);
  for (let index = 1; index <= 32; index += 1) source.fileHistory(repositoryId, { path: `f${index}.txt` });
  await stub.runCycle();
  // All 32 keys now hold blocks and fill the per-cycle budget; select a 33rd.
  for (let index = 1; index <= 32; index += 1) assert.equal(source.fileHistory(repositoryId, { path: `f${index}.txt` }).readiness, "ready");
  assert.equal(source.fileHistory(repositoryId, { path: "f33.txt" }).readiness, "loading");
  await stub.runCycle();
  assert.equal(source.fileHistory(repositoryId, { path: "f33.txt" }).readiness, "ready", "a new key is built before existing blocks spend the budget");
});

test("repositoryFiles: a newly opened repository is built in the next cycle even after 8 listings hold blocks", async (t) => {
  const store = await openStore(t);
  const { stub, source } = await buildSource(store);
  for (let index = 0; index < 8; index += 1) source.repositoryFiles(repoId(100 + index));
  await stub.runCycle();
  for (let index = 0; index < 8; index += 1) assert.equal(source.repositoryFiles(repoId(100 + index)).readiness, "ready");
  source.repositoryFiles(repoId(200));
  await stub.runCycle();
  assert.equal(source.repositoryFiles(repoId(200)).readiness, "ready");
});

test("fileHistory: idle keys (10+ minutes untouched) are dropped and rebuilt fresh on the next request", async (t) => {
  const store = await openStore(t);
  const repositoryId = repoId(7);
  insertFile(store, { id: 1, repositoryId, path: "a.txt" });
  insertChange(store, { fileId: 1, sessionId: "claude:s1", agentId: "agent-1", kind: "created", observedAt: 1_000 });
  let clock = 0;
  const { stub, source } = await buildSource(store, { now: () => clock });
  source.fileHistory(repositoryId, { path: "a.txt" });
  await stub.runCycle(store, { now: clock });
  assert.equal(source.fileHistory(repositoryId, { path: "a.txt" }).readiness, "ready");

  clock += 11 * 60_000; // past the 10-minute idle window, with no request in between
  await stub.runCycle(store, { now: clock });
  const afterIdle = source.fileHistory(repositoryId, { path: "a.txt" });
  assert.equal(afterIdle.readiness, "loading", "the idle key was dropped and must be rebuilt");
});

// --- wiring: attachFileHistory runs the file-change index contributor first, in the same cycle ---

test("attachFileHistory registers the file-change index contributor before its own, so a cycle sees fresh rows", async (t) => {
  const store = await openStore(t);
  const root = (await temporaryDirectory(t)).directory;
  const stub = createStubRuntime({ store });
  const source = attachFileHistory(stub.runtime, {
    resolveRepository: stubResolver(repoId(8), root), checkpointStore: null,
    demandedSessionIds: () => ["claude:session-1"], onSessionChange: () => {},
  });
  // Feed a checkpoint snapshot the way observation-runtime.mjs would (queued on the store
  // runtime, delivered to every contributor's onCheckpoint via `snapshots`).
  const snap = snapshot({
    localSessionId: "session-1", cwd: root,
    toolCalls: [toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [{ path: "a.txt", kind: "created" }] })],
  });
  await stub.runCycle(store, { now: 1, snapshots: [snap] });

  const block = source.sessionFiles("claude:session-1");
  assert.equal(block.readiness, "ready", "file-history-domain saw the row the file-change index just wrote in the same cycle");
  assert.deepEqual(block.files.map((f) => f.path), ["a.txt"]);
});

// --- request-handler route: query validation, method, and loading-then-ready ---

async function withServer(t, runtime) {
  const server = http.createServer(createRequestHandler({ runtime }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET /api/repository-files: 503 with an unavailable body, never an empty 200, when serving is not wired", async (t) => {
  const repositoryId = repoId(10);
  const origin = await withServer(t, {});
  const response = await fetch(`${origin}/api/repository-files?repositoryId=${repositoryId}`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.readiness, "unavailable");
  assert.equal(body.kind, "files");
});

test("the monitor server forwards every observation serve hook to the request handler", async () => {
  const { readFile } = await import("node:fs/promises");
  const runtimeSource = await readFile(new URL("../monitor/observation-runtime.mjs", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("../monitor/server.mjs", import.meta.url), "utf8");
  const hooks = [...new Set([...runtimeSource.matchAll(/^ {4}(serve[A-Za-z]+):/gmu)].map((match) => match[1]))];
  assert.ok(hooks.includes("serveRepositoryFiles"));
  for (const hook of hooks) assert.match(serverSource, new RegExp(`${hook}: observation\.${hook},`), hook);
});

test("GET /api/repository-files: 400 on an invalid query, 405 on a non-GET method", async (t) => {
  const repositoryId = repoId(9);
  const origin = await withServer(t, { serveRepositoryFiles: () => ({ kind: "files", revision: 1, readiness: "ready", repositoryId, files: [], folders: [], historicalFolders: [], truncated: false }) });
  const cases = [
    `repositoryId=${repositoryId}&unknown=1`,
    `repositoryId=${repositoryId}&fileId=f1&path=a.txt`,
    `repositoryId=${repositoryId}&path=..%2Fescape.txt`,
    `repositoryId=${repositoryId}&path=%2Fabsolute.txt`,
    "repositoryId=not-a-repo-id",
    "fileId=f1",
  ];
  for (const query of cases) {
    const response = await fetch(`${origin}/api/repository-files?${query}`);
    assert.equal(response.status, 400, query);
    const body = await response.json();
    assert.equal(body.error, "Invalid repository files query");
  }
  const postResponse = await fetch(`${origin}/api/repository-files?repositoryId=${repositoryId}`, { method: "POST" });
  assert.equal(postResponse.status, 405);
});

test("GET /api/repository-files: serves loading then ready after a cycle, and 503 with an unavailable body on exception", async (t) => {
  const repositoryId = repoId(10);
  const store = await openStore(t);
  insertFile(store, { id: 1, repositoryId, path: "a.txt" });
  insertChange(store, { fileId: 1, sessionId: "claude:s1", agentId: "agent-1", kind: "created", observedAt: 1_000 });
  const { stub, source } = await buildSource(store);

  const origin = await withServer(t, { serveRepositoryFiles: (query) => (query.path
    ? source.fileHistory(query.repositoryId, { path: query.path })
    : source.repositoryFiles(query.repositoryId)) });

  const loadingResponse = await fetch(`${origin}/api/repository-files?repositoryId=${repositoryId}&path=a.txt`);
  assert.equal(loadingResponse.status, 200);
  assert.equal((await loadingResponse.json()).readiness, "loading");

  await stub.runCycle();

  const readyResponse = await fetch(`${origin}/api/repository-files?repositoryId=${repositoryId}&path=a.txt`);
  assert.equal(readyResponse.status, 200);
  assert.equal((await readyResponse.json()).readiness, "ready");

  const failingOrigin = await withServer(t, { serveRepositoryFiles: () => { throw new Error("boom"); } });
  const failedResponse = await fetch(`${failingOrigin}/api/repository-files?repositoryId=${repositoryId}`);
  assert.equal(failedResponse.status, 503);
  const failedBody = await failedResponse.json();
  assert.equal(failedBody.readiness, "unavailable");
  assert.equal(failedBody.kind, "files");
});
