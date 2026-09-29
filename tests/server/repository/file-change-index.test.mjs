import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openMonitorStore } from "../../../server/persistence/monitor-store.mjs";
import { createMonitorStoreRuntime } from "../../../server/persistence/monitor-store-runtime.mjs";
import {
  createFileChangeIndexContributor,
  fileHistory,
  listRepositoryFiles,
  listSessionFileChanges,
} from "../../../server/repository/file-change-index.mjs";
import { readGitRenamesAsync } from "../../../server/repository/git-state.mjs";
import { createRepositoryInventoryRuntime } from "../../../server/repository/repository-inventory-runtime.mjs";
import { SessionObservationCheckpointStore } from "../../../server/sessions/checkpoints/session-observation-checkpoints.mjs";

// Synthetic checkpoint snapshots carrying only the shared `fileChanges` record shape
// (AGENTS.md "File-change history" / the Part 2 plan's "Shared evidence record"); these
// tests do not depend on either provider adapter's evidence-generation work.

// `t.after` hooks run in registration order, so every closer (store.close) must be
// registered through `onClose` *before* the directory removal below can run: otherwise
// Windows can still be holding the WAL/-shm handle open when `rm` tries to unlink it.
async function temporaryDirectory(t, prefix = "pomegr-file-change-index-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
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

async function openTestStore(t) {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  return store;
}

async function temporaryPlainDirectory(t, prefix = "pomegr-file-change-index-") {
  return (await temporaryDirectory(t, prefix)).directory;
}

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function toolCall({ timestamp, actorId = "agent-1", fileChanges }) {
  return { timestamp, actor: { id: actorId }, fileChanges };
}

// A valid-shaped repositoryId (repo-<24 hex chars>), deterministic per label, matching what
// the real session-identity rule / repository inventory would compute (server/normalize/session-identity.mjs).
// Unbound file changes are now attributed only through evidence.session.repositoryId, so a
// session fixture's stub resolver and its recorded identity always share this same id.
function repoId(label) {
  return `repo-${Buffer.from(String(label)).toString("hex").padEnd(24, "0").slice(0, 24)}`;
}

// `repositoryAttribution`/`repositoryId` default to a proven single repository, matching how
// claude.mjs and codex.mjs now populate evidence.session for every provider (see
// server/normalize/session-identity.mjs). Pass `repositoryAttribution: "unknown"`/`"multiple"` (or omit
// `repositoryId`) to model a session whose identity is not a proven single repository.
function snapshot({
  providerId = "claude", localSessionId = "session-1", cwd, toolCalls,
  repositoryAttribution = "single", repositoryId = repoId("default"),
}) {
  return { providerId, localSessionId, evidence: { session: { cwd, repositoryAttribution, repositoryId }, toolCalls } };
}

function stubResolver(repositoryId, root) {
  return async () => ({ repositoryId, root });
}

function git(root, ...args) {
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// --- created / edited / deleted / recreated, and idempotent re-apply ---

test("created, edited, deleted, and recreated resolve in one apply; re-apply is idempotent", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const repositoryId = repoId("a");
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });

  const snap = snapshot({
    cwd: root, repositoryId,
    toolCalls: [
      toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [{ path: "a.txt", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T10:01:00.000Z", fileChanges: [{ path: "a.txt", kind: "edited" }] }),
      toolCall({ timestamp: "2026-09-22T10:02:00.000Z", fileChanges: [{ path: "a.txt", kind: "deleted" }] }),
      toolCall({ timestamp: "2026-09-22T10:03:00.000Z", fileChanges: [{ path: "a.txt", kind: "created" }] }),
    ],
  });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snap] });

  const files = listRepositoryFiles(store, repositoryId);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "a.txt");
  assert.equal(files[0].deletedAt, null, "created after delete clears the tombstone");

  const history = fileHistory(store, files[0].id);
  assert.deepEqual(history.map((entry) => entry.kind), ["created", "deleted", "edited", "created"]);
  assert.ok(history.every((entry) => entry.sessionId === "claude:session-1" && entry.agentId === "agent-1"));

  const limited = fileHistory(store, files[0].id, { limit: 2 });
  assert.deepEqual(limited.map((entry) => entry.kind), ["created", "deleted"]);

  await contributor.onCheckpoint(store, { now: 2, snapshots: [snap] });
  const filesAgain = listRepositoryFiles(store, repositoryId);
  assert.equal(filesAgain.length, 1);
  assert.equal(filesAgain[0].id, files[0].id, "re-applying the same snapshot must not create a duplicate file row");
  const historyAgain = fileHistory(store, files[0].id);
  assert.equal(historyAgain.length, 4, "re-applying the same snapshot must not duplicate file_changes");
  assert.deepEqual(historyAgain.map((entry) => entry.kind), ["created", "deleted", "edited", "created"]);
});

test("a later snapshot whose bounded tail omits earlier tool calls keeps their committed changes", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repoId("default"), root), checkpointStore: null });
  const early = toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [{ path: "early.txt", kind: "created" }] });
  const later = toolCall({ timestamp: "2026-09-22T11:00:00.000Z", fileChanges: [{ path: "later.txt", kind: "edited" }] });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snapshot({ cwd: root, toolCalls: [early] })] });
  // The evidence tail advanced: the early call fell out of the window.
  await contributor.onCheckpoint(store, { now: 2, snapshots: [snapshot({ cwd: root, toolCalls: [later] })] });

  const changes = listSessionFileChanges(store, "claude:session-1");
  assert.deepEqual(changes.map((entry) => entry.path), ["later.txt", "early.txt"]);
});

// --- shell move continuity, with attribution ---

test("shell move continuity: same file identity, new path, both events attributed", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const inventoryStoreDirectory = await temporaryPlainDirectory(t);
  const inventory = createRepositoryInventoryRuntime({
    registry: { providers: [] },
    storeFile: path.join(inventoryStoreDirectory, "inventory.json"),
    now: () => 5_000,
    gitRoot: async () => root,
  });
  await inventory.ready;
  const contributor = createFileChangeIndexContributor({ resolveRepository: inventory.resolveRepository, checkpointStore: null });
  // The session's own recorded identity (evidence.session.repositoryId) is what unbound
  // changes are attributed through now, so it must be the same identity the real inventory
  // resolver would compute for this cwd (in production both come from the same resolver).
  const { repositoryId } = await inventory.identify(root);

  const snap = snapshot({
    cwd: root, repositoryId,
    toolCalls: [
      toolCall({ timestamp: "2026-09-22T09:00:00.000Z", actorId: "agent-a", fileChanges: [{ path: "a.txt", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T09:05:00.000Z", actorId: "agent-b",
        fileChanges: [{ path: "b.txt", kind: "moved", previousPath: "a.txt" }] }),
    ],
  });
  await contributor.onCheckpoint(store, { now: 5_000, snapshots: [snap] });

  const files = listRepositoryFiles(store, repositoryId);
  assert.equal(files.length, 1, "the move continues the same file identity, not a new row");
  assert.equal(files[0].path, "b.txt");

  const history = fileHistory(store, files[0].id);
  assert.deepEqual(history.map((entry) => entry.kind), ["moved", "created"]);
  assert.deepEqual(history.map((entry) => entry.agentId), ["agent-b", "agent-a"], "both the create and the move carry agent attribution");
  assert.ok(history.every((entry) => entry.sessionId === "claude:session-1"));

  const pathRows = store.database.prepare("SELECT path, source, valid_to FROM file_paths WHERE file_id = ? ORDER BY valid_from").all(files[0].id);
  assert.equal(pathRows.length, 2);
  assert.equal(pathRows[0].path, "a.txt");
  assert.equal(pathRows[0].source, "recorded");
  assert.notEqual(pathRows[0].valid_to, null);
  assert.equal(pathRows[1].path, "b.txt");
  assert.equal(pathRows[1].source, "shell_move");
  assert.equal(pathRows[1].valid_to, null);

  // Idempotent re-apply must not duplicate the file_paths rows or throw on the unique index.
  await contributor.onCheckpoint(store, { now: 6_000, snapshots: [snap] });
  const pathRowCount = store.database.prepare("SELECT COUNT(*) AS count FROM file_paths WHERE file_id = ?").get(files[0].id).count;
  assert.equal(pathRowCount, 2);
});

test("moved: skips continuity when the target path already belongs to a different live file", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const repositoryId = repoId("conflict");
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });

  const snap = snapshot({
    cwd: root, repositoryId,
    toolCalls: [
      toolCall({ timestamp: "2026-09-22T09:00:00.000Z", fileChanges: [{ path: "a.txt", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T09:01:00.000Z", fileChanges: [{ path: "b.txt", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T09:02:00.000Z", fileChanges: [{ path: "b.txt", kind: "moved", previousPath: "a.txt" }] }),
    ],
  });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snap] });

  const files = listRepositoryFiles(store, repositoryId);
  assert.deepEqual(files.map((entry) => entry.path).sort(), ["a.txt", "b.txt"], "continuity was skipped; both files stay distinct");
  const aFile = files.find((entry) => entry.path === "a.txt");
  const bFile = files.find((entry) => entry.path === "b.txt");
  assert.deepEqual(fileHistory(store, aFile.id).map((entry) => entry.kind), ["created"]);
  assert.deepEqual(fileHistory(store, bFile.id).map((entry) => entry.kind), ["moved", "created"],
    "the move event is still recorded, against whichever file already owns the target path");
});

// --- Git-only rename continuity ---

test("Git-only rename: continuity with no file_changes row and no session attribution", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t, "pomegr-file-change-git-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Pomegr Test");
  git(root, "config", "user.email", "pomegr@example.test");
  await writeFile(path.join(root, "a.txt"), "hello\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-m", "add a.txt");

  const repositoryId = repoId("git");
  const contributor = createFileChangeIndexContributor({
    resolveRepository: stubResolver(repositoryId, root), checkpointStore: null, readRenames: readGitRenamesAsync,
  });

  const baseMs = Date.parse("2026-09-22T09:00:00.000Z");
  const seedSnap = snapshot({
    cwd: root, repositoryId,
    toolCalls: [toolCall({ timestamp: new Date(baseMs).toISOString(), fileChanges: [{ path: "a.txt", kind: "created" }] })],
  });
  // First cycle: nothing to continue from yet, so this only records the create and
  // baselines the repository's observed Git head.
  await contributor.onCheckpoint(store, { now: baseMs, snapshots: [seedSnap] });

  const filesBefore = listRepositoryFiles(store, repositoryId);
  assert.equal(filesBefore.length, 1);
  assert.equal(filesBefore[0].path, "a.txt");
  const fileId = filesBefore[0].id;
  const historyBefore = fileHistory(store, fileId);
  assert.equal(historyBefore.length, 1);

  git(root, "mv", "a.txt", "b.txt");
  git(root, "commit", "-m", "rename to b.txt");

  // A distinct session id keeps this trigger snapshot from touching session-1's changes.
  const idleSnap = snapshot({ localSessionId: "idle-trigger", cwd: root, toolCalls: [] });
  // Past the contributor's 60s per-repository Git-check interval.
  await contributor.onCheckpoint(store, { now: baseMs + 61_000, snapshots: [idleSnap] });

  const filesAfter = listRepositoryFiles(store, repositoryId);
  assert.equal(filesAfter.length, 1, "the rename continues the same tracked file; it does not create a second one");
  assert.equal(filesAfter[0].id, fileId);
  assert.equal(filesAfter[0].path, "b.txt");

  assert.deepEqual(fileHistory(store, fileId), historyBefore, "a Git-only rename adds no file_changes row");

  const pathRows = store.database.prepare("SELECT path, source FROM file_paths WHERE file_id = ?").all(fileId);
  const bySource = Object.fromEntries(pathRows.map((row) => [row.source, row.path]));
  assert.deepEqual(bySource, { recorded: "a.txt", git: "b.txt" });
});

// --- nested cwd rebasing ---

test("a path relative to a nested cwd is rebased onto the repository root", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const cwd = path.join(root, "packages", "app");
  const repositoryId = repoId("nested");
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });

  const snap = snapshot({
    cwd, repositoryId,
    toolCalls: [toolCall({ timestamp: "2026-09-22T09:00:00.000Z", fileChanges: [{ path: "src/index.ts", kind: "created" }] })],
  });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snap] });

  const files = listRepositoryFiles(store, repositoryId);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "packages/app/src/index.ts");
});

// --- invalid paths dropped ---

test("invalid paths (traversal, absolute, private provider roots) are dropped; the valid entry is still indexed", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const repositoryId = repoId("invalid");
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });

  const snap = snapshot({
    cwd: root, repositoryId,
    toolCalls: [
      toolCall({ timestamp: "2026-09-22T09:00:00.000Z", fileChanges: [{ path: "../../../outside.txt", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T09:01:00.000Z", fileChanges: [{ path: "/etc/passwd", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T09:02:00.000Z", fileChanges: [{ path: "C:\\outside\\evil.txt", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T09:03:00.000Z", fileChanges: [{ path: ".claude/settings.json", kind: "edited" }] }),
      toolCall({ timestamp: "2026-09-22T09:04:00.000Z", fileChanges: [{ path: "ok.txt", kind: "created" }] }),
    ],
  });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snap] });

  const files = listRepositoryFiles(store, repositoryId);
  assert.deepEqual(files.map((entry) => entry.path), ["ok.txt"], "only the single valid entry is indexed");
  const sessionRows = listSessionFileChanges(store, "claude:session-1");
  assert.deepEqual(sessionRows.map((entry) => entry.path), ["ok.txt"]);
});

// --- unbound changes require a proven single-repository session identity ---

test("an unbound file change is skipped, for every provider, unless the session's own recorded identity is a proven single repository", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const repositoryId = repoId("gated");
  // The resolver would happily answer (a valid root exists), proving the gate is the
  // session's own recorded identity, never a fresh live resolution.
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });
  const fileChanges = [{ path: "a.txt", kind: "created" }];

  for (const [providerId, session] of [
    ["codex", { cwd: root, repositoryAttribution: "multiple", repositoryId: null }],
    ["codex", { cwd: root, repositoryAttribution: "unknown", repositoryId: null }],
    // A legacy evidence shape recorded before this rule existed (no repositoryAttribution/
    // repositoryId at all) degrades the same way as "unknown": never reinterpreted through a
    // navigated cwd (see server/normalize/session-identity.mjs).
    ["claude", { cwd: root }],
  ]) {
    await contributor.onCheckpoint(store, { now: 1, snapshots: [{
      providerId, localSessionId: `ungated-${providerId}-${session.repositoryAttribution || "legacy"}`,
      evidence: { session, toolCalls: [toolCall({ timestamp: "2026-09-22T09:00:00.000Z", fileChanges })] },
    }] });
  }
  assert.equal(listRepositoryFiles(store, repositoryId).length, 0, "no ungated session ever attributed its change to a repository");

  // The same cwd, same resolver, but a session whose identity the shared rule proved single:
  // now the unbound change is attributed.
  await contributor.onCheckpoint(store, { now: 2, snapshots: [snapshot({
    localSessionId: "proven-single", cwd: root, repositoryId,
    toolCalls: [toolCall({ timestamp: "2026-09-22T09:01:00.000Z", fileChanges })],
  })] });
  assert.deepEqual(listRepositoryFiles(store, repositoryId).map((row) => row.path), ["a.txt"]);
});

// --- page bounds ---

test("query page bounds default to 100, cap at 200, and page with a stable cursor", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const repositoryId = repoId("paging");
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });

  const baseMs = Date.parse("2026-09-22T00:00:00.000Z");
  const toolCalls = [];
  for (let index = 0; index < 260; index += 1) {
    toolCalls.push(toolCall({
      timestamp: new Date(baseMs + index * 1_000).toISOString(),
      fileChanges: [{ path: `f${index}.txt`, kind: "created" }],
    }));
  }
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snapshot({ cwd: root, repositoryId, toolCalls })] });

  const sessionId = "claude:session-1";
  const defaultPage = listSessionFileChanges(store, sessionId);
  assert.equal(defaultPage.length, 100, "default limit is 100");
  const cappedPage = listSessionFileChanges(store, sessionId, { limit: 10_000 });
  assert.equal(cappedPage.length, 200, "limit is capped at 200");
  assert.equal(defaultPage[0].id, cappedPage[0].id, "newest-first ordering is stable across limits");

  const cursor = Date.parse(defaultPage[49].observedAt);
  const nextPage = listSessionFileChanges(store, sessionId, { limit: 50, before: cursor });
  assert.equal(nextPage.length, 50);
  assert.ok(Date.parse(nextPage[0].observedAt) < cursor, "the next page starts strictly before the cursor");

  const repoFilesDefault = listRepositoryFiles(store, repositoryId);
  assert.equal(repoFilesDefault.length, 100);
  const repoFilesCapped = listRepositoryFiles(store, repositoryId, { limit: 10_000 });
  assert.equal(repoFilesCapped.length, 200);
  const afterCursor = repoFilesDefault.at(-1).id;
  const nextRepoFiles = listRepositoryFiles(store, repositoryId, { after: afterCursor, limit: 50 });
  assert.equal(nextRepoFiles.length, 50);
  assert.ok(nextRepoFiles[0].id > afterCursor);
});

// --- privacy: no absolute paths in query results ---

test("query results never surface the repository root or an absolute path", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const repositoryId = repoId("privacy");
  const contributor = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });

  const snap = snapshot({
    cwd: root, repositoryId,
    toolCalls: [
      toolCall({ timestamp: "2026-09-22T09:00:00.000Z", fileChanges: [{ path: "a.txt", kind: "created" }] }),
      toolCall({ timestamp: "2026-09-22T09:01:00.000Z", fileChanges: [{ path: "b.txt", kind: "moved", previousPath: "a.txt" }] }),
    ],
  });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snap] });

  const repoRows = listRepositoryFiles(store, repositoryId);
  const sessionRows = listSessionFileChanges(store, "claude:session-1");
  const fileRows = fileHistory(store, repoRows[0].id);
  const serialized = JSON.stringify({ repoRows, sessionRows, fileRows });
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(JSON.stringify(root).slice(1, -1)), false);
  for (const row of [...repoRows, ...sessionRows]) {
    assert.equal(row.path.startsWith("/"), false);
    assert.equal(/^[A-Za-z]:/u.test(row.path), false);
  }
});

// --- rebuild from retained checkpoints ---

test("rebuild from retained checkpoints indexes them and flips storage readiness to ready", async (t) => {
  const storeTemp = await temporaryDirectory(t, "pomegr-file-change-store-");
  const storeDirectory = storeTemp.directory;
  const checkpointDirectory = await temporaryPlainDirectory(t, "pomegr-file-change-checkpoints-");
  const root = await temporaryPlainDirectory(t, "pomegr-file-change-repo-");

  const checkpointStore = new SessionObservationCheckpointStore({ directory: checkpointDirectory });
  const observedAt = "2026-09-22T09:00:00.000Z";
  const repositoryId = repoId("rebuild");
  await checkpointStore.write({
    providerId: "claude",
    localSessionId: "rebuilt-session",
    source: null,
    evidence: {
      session: { cwd: root, repositoryAttribution: "single", repositoryId },
      toolCalls: [{ timestamp: observedAt, actor: { id: "agent-1" }, fileChanges: [{ path: "a.txt", kind: "created" }] }],
    },
    readiness: {},
    revision: 1,
    observedAt,
  });

  const settings = { retentionDays: 90, thresholdMb: 500, thresholdBytes: 500 * 1024 * 1024 };
  const runtime = createMonitorStoreRuntime({ directory: storeDirectory, settings });
  runtime.registerContributor(createFileChangeIndexContributor({
    resolveRepository: stubResolver(repositoryId, root),
    checkpointStore,
  }));
  await runtime.start();
  storeTemp.onClose(() => runtime.stop());

  assert.equal(runtime.serveStorage(null).snapshot.value.readiness, "rebuilding");

  runtime.afterCheckpointWrite({ providerId: "claude", localSessionId: "trigger" });
  await waitFor(() => runtime.serveStorage(null).snapshot.value.readiness === "ready");

  const rows = listRepositoryFiles(runtime.store(), repositoryId);
  assert.equal(rows.length, 1, "the retained checkpoint's file change was indexed by the rebuild pass");
  assert.equal(rows[0].path, "a.txt");
});

test("Codex indexes each bound mutation under its own repository rather than session cwd", async (t) => {
  const store = await openTestStore(t);
  const launchRoot = await temporaryPlainDirectory(t, "pomegr-file-index-launch-");
  const contributor = createFileChangeIndexContributor({
    resolveRepository: stubResolver("repo-cccccccccccccccccccccccc", launchRoot), checkpointStore: null,
  });
  await contributor.onCheckpoint(store, { now: 1, snapshots: [snapshot({
    providerId: "codex", localSessionId: "cross-repo", cwd: launchRoot,
    toolCalls: [toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [
      { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", path: "a/inside-a.ts", kind: "created", previousPath: null },
      { repositoryId: "repo-bbbbbbbbbbbbbbbbbbbbbbbb", path: "b/inside-b.ts", kind: "edited", previousPath: null },
    ] })],
  })] });
  assert.deepEqual(listRepositoryFiles(store, "repo-aaaaaaaaaaaaaaaaaaaaaaaa").map((row) => row.path), ["a/inside-a.ts"]);
  assert.deepEqual(listRepositoryFiles(store, "repo-bbbbbbbbbbbbbbbbbbbbbbbb").map((row) => row.path), ["b/inside-b.ts"]);
  assert.equal(listRepositoryFiles(store, "repo-cccccccccccccccccccccccc").length, 0);
});

test("v1 migration discards a mixed identity corrupted by an old Codex move instead of serving its false path to Claude", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t, "pomegr-file-index-v1-mixed-");
  const repositoryId = repoId("mixed");
  const baseline = createFileChangeIndexContributor({ resolveRepository: stubResolver(repositoryId, root), checkpointStore: null });
  await baseline.onCheckpoint(store, { now: 1, snapshots: [snapshot({
    cwd: root, repositoryId,
    toolCalls: [toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [{ path: "a.txt", kind: "created" }] })],
  })] });
  const file = listRepositoryFiles(store, repositoryId)[0];
  // Model the v1 failure: a Codex path was rebased through the session cwd,
  // then rewrote the file identity originally created by Claude.
  store.database.prepare("UPDATE files SET current_path = ?, deleted_at = ? WHERE id = ?").run("b.txt", 2, file.id);
  store.database.prepare("INSERT INTO file_changes (file_id, session_id, agent_id, kind, observed_at, request_number) VALUES (?, ?, ?, ?, ?, NULL)")
    .run(file.id, "codex:legacy", "agent-1", "moved", 2);
  store.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('file_index_version', '1')").run();

  const migration = createFileChangeIndexContributor({
    resolveRepository: stubResolver(repositoryId, root),
    checkpointStore: { async load() { return { records: [] }; } },
  });
  await migration.onCheckpoint(store, { now: 2, snapshots: [] });
  assert.deepEqual(listRepositoryFiles(store, repositoryId), [], "the mixed identity is removed rather than exposing legacy Codex's false b.txt/deleted state");
});

test("legacy launch-bound evidence resolves unbound changes from its launch cwd; a proven identity ignores a cwd that resolves elsewhere", async (t) => {
  const store = await openTestStore(t);
  const root = await temporaryPlainDirectory(t);
  const launchRepository = repoId("launch");
  const calls = [];
  const resolveRepository = async (cwd, options) => { calls.push(options?.requireGit === true); return { repositoryId: launchRepository, root }; };
  const contributor = createFileChangeIndexContributor({ resolveRepository, checkpointStore: null });
  const change = (path) => [toolCall({ timestamp: "2026-09-22T10:00:00.000Z", fileChanges: [{ path, kind: "edited" }] })];

  await contributor.onCheckpoint(store, { now: 1, snapshots: [
    snapshot({ localSessionId: "legacy", cwd: root, repositoryAttribution: "launch", repositoryId: undefined, toolCalls: change("legacy.txt") }),
    snapshot({ localSessionId: "elsewhere", cwd: root, repositoryId: repoId("proven"), toolCalls: change("elsewhere.txt") }),
    snapshot({ providerId: "codex", localSessionId: "unbound", cwd: root, repositoryAttribution: null, repositoryId: null, toolCalls: change("unbound.txt") }),
  ] });

  assert.deepEqual(listRepositoryFiles(store, launchRepository).map((file) => file.path), ["legacy.txt"]);
  assert.deepEqual(listRepositoryFiles(store, repoId("proven")), [], "no root from another repository rebases a proven session's unbound path");
  assert.deepEqual(calls, [false, false], "both use the inventory cached pre-rule lookup, never a Git-only subprocess");
});
