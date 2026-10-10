// A linked Git worktree belongs to its main repository (product-owner decision, 2026-10-10): its sessions
// take the main repository's ID and name, while their own root stays the worktree's top level.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkoutRoots, readGitCheckout } from "../../../server/repository/git-checkout.mjs";
import { createRepositoryInventoryRuntime } from "../../../server/repository/repository-inventory-runtime.mjs";

const MAIN = path.resolve("/work/Pomegr");
const WORKTREE = path.resolve("/data/task-worktrees/repo-0123456789abcdef01234567/T-20");
const BARE_WORKTREE = path.resolve("/work/bare-checkout");
const SEPARATE = path.resolve("/work/separate");
const FAILING = path.resolve("/work/failing");

/** A lookup stand-in answering what `readGitCheckout` answers: the top level and, for a linked worktree, the common directory. */
function checkoutLookup(cwd) {
  const inside = (root) => cwd === root || cwd.startsWith(`${root}${path.sep}`);
  if (inside(MAIN)) return { root: MAIN, commonDir: null };
  if (inside(WORKTREE)) return { root: WORKTREE, commonDir: path.join(MAIN, ".git") };
  // A worktree of a bare repository: the common directory is the bare repository itself, not a `.git` folder.
  if (inside(BARE_WORKTREE)) return { root: BARE_WORKTREE, commonDir: path.resolve("/srv/git/project.git") };
  // A common directory named `.git` whose parent is the top level itself is no other repository.
  if (inside(SEPARATE)) return { root: SEPARATE, commonDir: path.join(SEPARATE, ".git") };
  if (inside(FAILING)) throw new Error("git unavailable");
  return null;
}

async function runtimes(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-worktree-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const storeFile = path.join(directory, "inventory.json");
  const registry = { providers: [] };
  // The earlier contract: the lookup answers the top level alone. Sharing the store shares the salt.
  const before = createRepositoryInventoryRuntime({ registry, storeFile, gitRoot: async (cwd) => checkoutLookup(cwd)?.root ?? null });
  await before.ready;
  const runtime = createRepositoryInventoryRuntime({ registry, storeFile, gitRoot: async (cwd) => checkoutLookup(cwd) });
  return { before, runtime };
}

test("a linked worktree resolves to its main repository's ID and name, and the main checkout keeps its ID", async (context) => {
  const { before, runtime } = await runtimes(context);
  const mainBefore = await before.identify(MAIN);
  const worktreeBefore = await before.identify(WORKTREE);
  assert.notEqual(worktreeBefore.repositoryId, mainBefore.repositoryId, "the superseded rule gave a worktree its own identity");
  assert.equal(worktreeBefore.name, "T-20");

  const main = await runtime.identify(path.join(MAIN, "server"));
  assert.deepEqual(main, mainBefore, "a main checkout's existing ID and name are unchanged");
  assert.deepEqual(await runtime.identify(path.join(WORKTREE, "server")), main);
});

test("the resolver keeps a worktree session's own root and reports the main root beside it", async (context) => {
  const { runtime } = await runtimes(context);
  const main = await runtime.resolveRepository(MAIN, { requireGit: true });
  assert.deepEqual(main, { repositoryId: main.repositoryId, root: MAIN, mainRoot: MAIN, recognized: true });
  for (const options of [{ requireGit: true }, {}]) {
    const resolved = await runtime.resolveRepository(path.join(WORKTREE, "app"), options);
    assert.equal(resolved.repositoryId, main.repositoryId);
    assert.equal(resolved.root, WORKTREE, "Git state of the session is read in its worktree, never in the main checkout");
    assert.equal(resolved.mainRoot, MAIN);
  }
});

test("the root of a repository ID is the main root, whichever checkout was identified last", async (context) => {
  const { runtime } = await runtimes(context);
  // A worktree seen before its main checkout already yields the main root (task start, issues, plugin setup, gates).
  const { repositoryId } = await runtime.identify(WORKTREE);
  assert.equal(runtime.repositoryRoot(repositoryId), MAIN);
  await runtime.identify(MAIN);
  await runtime.resolveRepository(path.join(WORKTREE, "app"), { requireGit: true });
  await runtime.resolveRepository(WORKTREE);
  assert.equal(runtime.repositoryRoot(repositoryId), MAIN);

  await runtime.reconcile([
    { id: "claude:a", provider: "claude", repositoryId, project: "Pomegr", isLive: false, updatedAt: "2026-10-10T10:00:00.000Z" },
    { id: "claude:b", provider: "claude", repositoryId, project: "Pomegr", isLive: false, updatedAt: "2026-10-10T11:00:00.000Z" },
  ]);
  const { repositories } = runtime.readRepositories().snapshot.value;
  assert.deepEqual(repositories.map((entry) => [entry.name, entry.displayName, entry.sessionCount]), [["Pomegr", "Pomegr", 2]]);
});

test("a bare repository's worktree, a common directory under the top level, a failed lookup, and a non-Git folder keep their own root", async (context) => {
  const { before, runtime } = await runtimes(context);
  for (const root of [BARE_WORKTREE, SEPARATE]) {
    const resolved = await runtime.resolveRepository(root, { requireGit: true });
    assert.deepEqual(resolved, { repositoryId: (await before.identify(root)).repositoryId, root, mainRoot: root, recognized: true });
    assert.equal(runtime.repositoryRoot(resolved.repositoryId), root);
  }
  assert.equal(await runtime.resolveRepository(FAILING, { requireGit: true }), null);
  const plain = path.resolve("/work/notes");
  assert.equal(await runtime.resolveRepository(plain, { requireGit: true }), null);
  assert.deepEqual(await runtime.resolveRepository(plain), { repositoryId: (await before.identify(plain)).repositoryId, root: plain, mainRoot: plain });
});

test("checkoutRoots accepts only a common directory named .git outside the top level", () => {
  assert.deepEqual(checkoutRoots(MAIN), { root: MAIN, mainRoot: MAIN });
  assert.deepEqual(checkoutRoots({ root: WORKTREE, commonDir: path.join(MAIN, ".git") }), { root: WORKTREE, mainRoot: MAIN });
  for (const commonDir of [null, undefined, "", ".git", "relative/.git", path.join(MAIN, ".git", "modules", "lib"),
    path.resolve("/srv/git/project.git"), path.join(WORKTREE, ".git"), `${path.join(MAIN, ".git")}\u0000`]) {
    assert.deepEqual(checkoutRoots({ root: WORKTREE, commonDir }), { root: WORKTREE, mainRoot: WORKTREE });
  }
  for (const answer of [null, undefined, "", "relative", { root: "relative", commonDir: path.join(MAIN, ".git") }, { commonDir: path.join(MAIN, ".git") }]) {
    assert.equal(checkoutRoots(answer), null);
  }
});

test("a real git worktree resolves to its main repository through the default lookup", async (context) => {
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let directory;
  try {
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "pomegr-worktree-git-")));
    context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch { context.skip("git is not available"); return; }
  const main = path.join(directory, "Pomegr");
  const worktree = path.join(directory, "task-worktrees", "T-20");
  const bare = path.join(directory, "bare.git");
  const bareWorktree = path.join(directory, "from-bare");
  await mkdir(path.join(main, "src"), { recursive: true });
  await writeFile(path.join(main, "src", "a.txt"), "a\n");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", main], { stdio: "ignore" });
  git(main, "add", ".");
  git(main, "-c", "user.name=Pomegr", "-c", "user.email=pomegr@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "first");
  git(main, "worktree", "add", "--quiet", "-b", "tasks/T-20", worktree);
  execFileSync("git", ["clone", "--quiet", "--bare", main, bare], { stdio: "ignore" });
  git(bare, "worktree", "add", "--quiet", "-b", "from-bare", bareWorktree);

  const same = (left, right) => assert.equal(path.resolve(left).toLowerCase(), path.resolve(right).toLowerCase());
  const mainCheckout = await readGitCheckout(path.join(main, "src"));
  same(mainCheckout.root, main);
  assert.equal(mainCheckout.commonDir, null);
  const linked = checkoutRoots(await readGitCheckout(path.join(worktree, "src")));
  same(linked.root, worktree);
  same(linked.mainRoot, main);
  const fromBare = checkoutRoots(await readGitCheckout(bareWorktree));
  same(fromBare.root, bareWorktree);
  same(fromBare.mainRoot, bareWorktree);
  assert.equal(await readGitCheckout(directory), null);

  const runtime = createRepositoryInventoryRuntime({ registry: { providers: [] }, storeFile: path.join(directory, "inventory.json") });
  const resolvedMain = await runtime.resolveRepository(main, { requireGit: true });
  const resolvedWorktree = await runtime.resolveRepository(path.join(worktree, "src"), { requireGit: true });
  assert.equal(resolvedWorktree.repositoryId, resolvedMain.repositoryId);
  same(resolvedWorktree.root, worktree);
  same(runtime.repositoryRoot(resolvedMain.repositoryId), main);
  assert.deepEqual(await runtime.identify(worktree), { repositoryId: resolvedMain.repositoryId, name: "Pomegr" });
  assert.notEqual((await runtime.resolveRepository(bareWorktree, { requireGit: true })).repositoryId, resolvedMain.repositoryId);
});
