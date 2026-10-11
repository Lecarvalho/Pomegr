// Removing a done task's worktree and branch is the default. The store holds the task's choice and which
// done tasks still wait for the desktop to remove theirs; the routes add only the repository root.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { OTHER_REPOSITORY, REPOSITORY, createTask, metaValue, openTemporaryStore, updateTask } from "./queue-test-support.mjs";

const TOKEN = "t".repeat(40);
const ROOT = "C:\\Work\\repo";
const keepKey = (taskId, repositoryId = REPOSITORY) => `task_keep_worktree:${repositoryId}:${taskId}`;
const pendingKey = (taskId, repositoryId = REPOSITORY) => `task_worktree_cleanup:${repositoryId}:${taskId}`;
const runOf = (board, id) => board.tasks.find((task) => task.id === id).run;

function markDone(store, directory, number, repositoryId = REPOSITORY) {
  updateTask(directory, number, { state: "blocked" }, repositoryId);
  assert.equal(store.apply(repositoryId, "resolve_done", { id: `T-${number}` }).ok, true);
}

test("a task removes its worktree by default, and keeping it is a stored choice that an edit turns on and off", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-worktree-cleanup-");
  assert.deepEqual(runOf(createTask(store), "T-1"), { provider: null, model: null, effort: null, remoteControl: false });
  assert.equal(metaValue(directory, keepKey("T-1")), null);

  const kept = createTask(store, REPOSITORY, { run: { keepWorktree: true } });
  assert.deepEqual(runOf(kept, "T-2"), { provider: null, model: null, effort: null, remoteControl: false, keepWorktree: true });
  assert.equal(metaValue(directory, keepKey("T-2")), "1");
  assert.equal(runOf(createTask(store, REPOSITORY, { run: { keepWorktree: false } }), "T-3").keepWorktree, undefined);
  assert.equal(store.apply(REPOSITORY, "create", { text: "bad", run: { keepWorktree: "yes" } }).ok, false);

  // An edit of another field leaves the choice; an edit of the run replaces it.
  assert.equal(runOf(store.apply(REPOSITORY, "update", { id: "T-2", text: "edited" }).board, "T-2").keepWorktree, true);
  assert.equal(runOf(store.apply(REPOSITORY, "update", { id: "T-2", run: { effort: "low" } }).board, "T-2").keepWorktree, undefined);
  assert.equal(metaValue(directory, keepKey("T-2")), null);
  assert.equal(runOf(store.apply(REPOSITORY, "update", { id: "T-1", run: { keepWorktree: true } }).board, "T-1").keepWorktree, true);
  assert.equal(metaValue(directory, keepKey("T-1")), "1");
});

test("a task marked done waits for its worktree to be removed, unless it keeps it, until the desktop reports it gone", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-worktree-cleanup-");
  createTask(store);
  createTask(store, REPOSITORY, { run: { keepWorktree: true } });
  createTask(store, OTHER_REPOSITORY);
  assert.deepEqual(store.worktreeCleanups(), { ok: true, cleanups: [] });

  markDone(store, directory, 1);
  markDone(store, directory, 2);
  markDone(store, directory, 1, OTHER_REPOSITORY);
  assert.deepEqual(store.worktreeCleanups(), { ok: true, cleanups: [{ repositoryId: REPOSITORY, taskId: "T-1" }, { repositoryId: OTHER_REPOSITORY, taskId: "T-1" }] });
  assert.equal(metaValue(directory, pendingKey("T-2")), null);

  for (const payload of [{}, { id: "T-0" }, { id: "T-1", extra: true }, null]) {
    assert.deepEqual(store.worktreeCleaned(REPOSITORY, payload), { ok: false, error: "invalid" });
  }
  assert.deepEqual(store.worktreeCleaned("repo-x", { id: "T-1" }), { ok: false, error: "invalid" });
  assert.deepEqual(store.worktreeCleaned(REPOSITORY, { id: "T-1" }), { ok: true });
  assert.deepEqual(store.worktreeCleaned(REPOSITORY, { id: "T-1" }), { ok: true }, "reporting twice is harmless");
  assert.deepEqual(store.worktreeCleanups(), { ok: true, cleanups: [{ repositoryId: OTHER_REPOSITORY, taskId: "T-1" }] });

  // A deleted task leaves neither flag behind.
  assert.equal(store.apply(OTHER_REPOSITORY, "delete", { id: "T-1" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-2" }).ok, true);
  assert.deepEqual(store.worktreeCleanups(), { ok: true, cleanups: [] });
  assert.equal(metaValue(directory, keepKey("T-2")), null);

  store.close();
  assert.deepEqual(store.worktreeCleanups(), { ok: false, error: "unavailable" });
});

async function startRoute(context, { taskStore, roots = { [REPOSITORY]: ROOT } } = {}) {
  const runtime = { resolveTaskStart: (repositoryId) => ({ root: roots[repositoryId] ?? null, pluginReady: false }) };
  const server = http.createServer(createRequestHandler({ runtime, taskStore, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return async (action, body, headers = { "x-pomegr-desktop-authorization": TOKEN }) => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/tasks/${action}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}

test("the worktree routes answer the desktop only: the waiting tasks with their repository root, one root, and a removal report", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-worktree-cleanup-");
  createTask(store, REPOSITORY, { text: "SECRET-TASK-TEXT" });
  createTask(store, OTHER_REPOSITORY);
  markDone(store, directory, 1);
  markDone(store, directory, 1, OTHER_REPOSITORY);
  const post = await startRoute(context, { taskStore: store });

  // A repository the monitor has not located is left out and asked about again later.
  const listed = await post("worktree-cleanups", {});
  assert.deepEqual(listed, { status: 200, json: { ok: true, cleanups: [{ repositoryId: REPOSITORY, taskId: "T-1", repositoryRoot: ROOT }] } });
  assert.equal(JSON.stringify(listed.json).includes("SECRET"), false);
  assert.equal((await post("worktree-cleanups", { repositoryId: REPOSITORY })).status, 400);

  assert.deepEqual(await post("worktree-root", { repositoryId: REPOSITORY, payload: {} }), { status: 200, json: { ok: true, root: ROOT } });
  assert.deepEqual(await post("worktree-root", { repositoryId: OTHER_REPOSITORY, payload: {} }), { status: 404, json: { ok: false, error: "not_found" } });
  assert.deepEqual(await post("worktree-root", { repositoryId: REPOSITORY, payload: { id: "T-1" } }), { status: 400, json: { ok: false, error: "invalid" } });

  assert.deepEqual(await post("worktree-cleaned", { repositoryId: REPOSITORY, payload: { id: "T-0" } }), { status: 400, json: { ok: false, error: "invalid" } });
  assert.deepEqual(await post("worktree-cleaned", { repositoryId: REPOSITORY, payload: { id: "T-1" } }), { status: 200, json: { ok: true } });
  assert.deepEqual((await post("worktree-cleanups", {})).json, { ok: true, cleanups: [] });

  for (const action of ["worktree-cleanups", "worktree-root", "worktree-cleaned"]) {
    const refused = await post(action, { repositoryId: REPOSITORY, payload: {} }, {});
    assert.notEqual(refused.status, 200, action);
    assert.equal(JSON.stringify(refused.json ?? "").includes("Work"), false);
  }
});
