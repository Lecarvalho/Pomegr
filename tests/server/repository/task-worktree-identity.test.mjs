// A removed Pomegr task worktree (`.../task-worktrees/<repository ID>/<task ID>`) gets no Git answer. Its
// path names the repository, and the inventory accepts that only for a repository ID it already knows.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { taskWorktreeRepositoryId } from "../../../server/repository/git-checkout.mjs";
import { createRepositoryInventoryRuntime } from "../../../server/repository/repository-inventory-runtime.mjs";
import { createSessionRepositoryAssociations } from "../../../server/repository/session-repository-association.mjs";
import { isTaskId } from "../../../server/tasks/task-record.mjs";

const MAIN = path.resolve("/work/Pomegr");
const DATA = path.resolve("/data/pomegr");
const UNKNOWN_ID = "repo-ffffffffffffffffffffffff";
const worktreePath = (repositoryId, taskId, ...rest) => path.join(DATA, "task-worktrees", repositoryId, taskId, ...rest);

async function inventory(context, { existing = [] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-worktree-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    registry: { providers: [] }, storeFile: path.join(directory, "inventory.json"),
    // Git answers for the main checkout and for folders that still exist; everything else has no answer.
    gitRoot: async (cwd) => [MAIN, ...existing].find((root) => cwd === root || cwd.startsWith(`${root}${path.sep}`)) ?? null,
  };
  const runtime = createRepositoryInventoryRuntime(options);
  await runtime.ready;
  // A second runtime on the same store shares the salt and never learns the main repository: the plain fallback.
  const plain = createRepositoryInventoryRuntime(options);
  return { runtime, plain };
}

test("a removed task worktree under a known repository ID belongs to that repository and never becomes its root", async (context) => {
  const { runtime } = await inventory(context);
  const main = await runtime.identify(MAIN);
  const removed = worktreePath(main.repositoryId, "T-20");
  for (const cwd of [removed, path.join(removed, "src", "deep")]) {
    assert.deepEqual(await runtime.identify(cwd), main);
    assert.deepEqual(await runtime.resolveRepository(cwd), { repositoryId: main.repositoryId, root: cwd, mainRoot: MAIN });
    assert.equal(await runtime.resolveRepository(cwd, { requireGit: true }), null, "a missing folder is never a recognized Git repository");
    assert.equal(runtime.taskWorktreeOwner(cwd), "known");
  }
  assert.equal(runtime.repositoryRoot(main.repositoryId), MAIN);
  await runtime.reconcile([{ id: "claude:a", provider: "claude", repositoryId: main.repositoryId, project: "T-20", isLive: false, updatedAt: "2026-10-10T10:00:00.000Z" }]);
  assert.deepEqual(runtime.readRepositories().snapshot.value.repositories.map((entry) => entry.name), ["Pomegr"]);
});

test("an unknown or malformed ID, a wrong task ID, and a lookalike folder keep the folder-named fallback", async (context) => {
  const { runtime, plain } = await inventory(context);
  const main = await runtime.identify(MAIN);
  const id = main.repositoryId;
  const cases = [
    worktreePath(UNKNOWN_ID, "T-20"),
    worktreePath(id.toUpperCase(), "T-20"),
    worktreePath(id.slice(0, -1), "T-20"),
    worktreePath(`${id}0`, "T-20"),
    worktreePath(id, "T-0"),
    worktreePath(id, "t-20"),
    worktreePath(id, "T-20x"),
    worktreePath(id, "T-1234567890"),
    path.join(DATA, "task-worktrees", id),
    path.join(DATA, "worktrees", id, "T-20"),
    path.join(DATA, "task-worktrees-old", id, "T-20"),
    path.join(DATA, "task-worktrees", "extra", id, "T-20"),
    path.join(DATA, id, "T-20"),
  ];
  for (const cwd of cases) {
    const expected = await plain.identify(cwd);
    assert.notEqual(expected.repositoryId, id);
    assert.deepEqual(await runtime.identify(cwd), expected, cwd);
    assert.deepEqual(await runtime.resolveRepository(cwd), { repositoryId: expected.repositoryId, root: cwd, mainRoot: cwd });
    assert.equal(runtime.repositoryRoot(expected.repositoryId), cwd);
  }
  assert.equal(runtime.taskWorktreeOwner(cases[0]), "unknown");
  assert.equal(runtime.taskWorktreeOwner(cases[4]), null);
  assert.equal(runtime.repositoryRoot(id), MAIN);
});

test("a Git answer wins over the path shape", async (context) => {
  // A folder at a task worktree path that Git answers for as a repository of its own.
  const { runtime: first } = await inventory(context);
  const { repositoryId } = await first.identify(MAIN);
  const existing = worktreePath(repositoryId, "T-3");
  const { runtime } = await inventory(context, { existing: [existing] });
  // Each inventory has its own salt, so the path uses the first one's ID: unknown here, and Git answers anyway.
  const main = await runtime.identify(MAIN);
  const own = await runtime.resolveRepository(path.join(existing, "src"), { requireGit: true });
  assert.deepEqual(own, { repositoryId: own.repositoryId, root: existing, mainRoot: existing, recognized: true });
  assert.notEqual(own.repositoryId, main.repositoryId);
  assert.equal(runtime.taskWorktreeOwner(existing), null);

  const answered = worktreePath(main.repositoryId, "T-4");
  const { runtime: both } = await inventory(context, { existing: [answered] });
  await both.identify(MAIN);
  assert.equal((await both.identify(answered)).name, "T-4", "Git answered for the folder, so the path shape is not read");
});

test("a removed task worktree identified before its repository resolves once the repository is known", async (context) => {
  const { runtime, plain } = await inventory(context);
  const mainId = (await plain.identify(MAIN)).repositoryId;
  const removed = worktreePath(mainId, "T-20");
  const fallback = await runtime.identify(removed);
  assert.equal(fallback.name, "T-20");
  assert.notEqual(fallback.repositoryId, mainId);
  assert.equal(runtime.taskWorktreeOwner(removed), "unknown");
  assert.equal(runtime.repositoryRoot(mainId), null);

  const changed = [];
  const candidate = { providerId: "claude", localSessionId: "s-1", evidence: { session: { cwd: removed, startedAt: "2026-10-10T09:00:00.000Z", repositoryAttribution: "launch" } } };
  const associations = createSessionRepositoryAssociations({
    registry: { repositoryAttributionForSession: () => null }, inventory: runtime, previousReference: () => null,
    previousAssociation: () => null, onChange: (id) => changed.push(id),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  associations.get(candidate);
  await settle();
  assert.equal(associations.get(candidate).repositoryId, fallback.repositoryId);

  await runtime.identify(MAIN);
  assert.equal(runtime.taskWorktreeOwner(removed), "known");
  changed.length = 0;
  // Any later lookup notices; the settled value is served until the new one settles, never null.
  assert.equal(associations.get(candidate).repositoryId, fallback.repositoryId);
  await settle();
  assert.equal(associations.get(candidate).repositoryId, mainId);
  assert.ok(changed.includes("claude:s-1"));
  assert.equal(runtime.repositoryRoot(mainId), MAIN);
  assert.equal(runtime.repositoryRoot(fallback.repositoryId), removed, "the earlier fallback target is left as it was");
});

test("the path rule reads the inventory's ID format and the task store's task ID format", () => {
  const id = "repo-0123456789abcdef01234567";
  assert.equal(taskWorktreeRepositoryId(worktreePath(id, "T-20", "src")), id);
  for (const taskId of ["T-1", "T-999999999", "T-0", "T-01", "T-1000000000", "t-1", "T-", "T-1a", "T1", ""]) {
    assert.equal(taskWorktreeRepositoryId(worktreePath(id, taskId || ".")) === id, isTaskId(taskId), taskId);
  }
  for (const cwd of ["", "relative/task-worktrees/x", null, undefined]) assert.equal(taskWorktreeRepositoryId(cwd), null);
});
