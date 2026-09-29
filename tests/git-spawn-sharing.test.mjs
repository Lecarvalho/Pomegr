import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// Count every git process this file's monitor modules start. Installed before they load.
const spawned = [];
const originalExecFile = childProcess.execFile;
childProcess.execFile = function countedExecFile(command, args, ...rest) {
  if (/(^|[\\/])git(\.exe)?$/i.test(String(command))) spawned.push(Array.isArray(args) ? args : []);
  return originalExecFile.call(this, command, args, ...rest);
};
// Keep `util.promisify(execFile)` resolving `{ stdout, stderr }`, as the original does.
const originalPromisified = originalExecFile[promisify.custom];
childProcess.execFile[promisify.custom] = function countedPromisifiedExecFile(command, args, ...rest) {
  if (/(^|[\\/])git(\.exe)?$/i.test(String(command))) spawned.push(Array.isArray(args) ? args : []);
  return originalPromisified.call(this, command, args, ...rest);
};
syncBuiltinESMExports();
const { readGitStateAsync } = await import("../monitor/git-state.mjs");
const { createGitRootLookup, createRepositoryInventoryRuntime } = await import("../monitor/repository-inventory-runtime.mjs");

function git(cwd, ...args) {
  return childProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function repositoryFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-git-spawns-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repository = path.join(root, "repository");
  childProcess.execFileSync("git", ["init", "--initial-branch=feature", repository], { stdio: "ignore" });
  git(repository, "config", "user.name", "Pomegr Test");
  git(repository, "config", "user.email", "pomegr@example.test");
  await writeFile(path.join(repository, "tracked.txt"), "first\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "Initial commit");
  await writeFile(path.join(repository, "untracked.txt"), "local\n");
  return { root, repository };
}

test("concurrent live Git inspections of one working tree share one set of git processes", async (context) => {
  const { repository } = await repositoryFixture(context);
  await readGitStateAsync(repository); // settles one-time remote-cache setup
  spawned.length = 0;
  const single = await readGitStateAsync(repository);
  const perInspection = spawned.length;
  assert.ok(perInspection > 0);

  spawned.length = 0;
  const shared = await Promise.all([readGitStateAsync(repository), readGitStateAsync(repository), readGitStateAsync(repository)]);
  assert.equal(spawned.length, perInspection, "three concurrent sessions in one repository inspect it once");
  for (const state of shared) assert.deepStrictEqual(state, single, "every caller receives the same answer as an unshared read");
  assert.notEqual(shared[0], shared[1], "each caller owns its copy");
  assert.notEqual(shared[0].files, shared[1].files);

  spawned.length = 0;
  await readGitStateAsync(repository);
  await readGitStateAsync(repository);
  assert.equal(spawned.length, perInspection * 2, "a finished inspection is never reused; later reads observe Git afresh");
});

test("Git root lookups run once per directory within the resolver freshness window", async () => {
  let clock = 1_000;
  const reads = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const lookup = createGitRootLookup(async (cwd) => { reads.push(cwd); await gate; return cwd.endsWith("repo") ? cwd : null; },
    { now: () => clock, ttlMs: 300_000 });
  const repo = path.resolve("fixture", "repo");
  const pending = [lookup(repo), lookup(path.join(repo, ".")), lookup(path.resolve("fixture", "other"))];
  release();
  assert.deepEqual(await Promise.all(pending), [repo, repo, null]);
  assert.equal(reads.length, 2, "concurrent callers for one directory share the lookup");
  clock += 299_999;
  assert.equal(await lookup(repo), repo);
  assert.equal(reads.length, 2, "an answer is reused inside the freshness window");
  clock += 1;
  await lookup(repo);
  assert.equal(reads.length, 3, "the directory is asked again once the window has passed");

  let attempts = 0;
  const failing = createGitRootLookup(async () => { attempts += 1; throw new Error("transient"); }, { now: () => clock });
  await assert.rejects(failing(repo));
  await assert.rejects(failing(repo));
  assert.equal(attempts, 2, "a failed lookup is not retained");
});

test("repository identity and Git-required resolution share one root lookup per directory", async (context) => {
  const { root, repository } = await repositoryFixture(context);
  const nested = path.join(repository, "nested");
  const runtime = createRepositoryInventoryRuntime({
    registry: { providers: [], get: () => null, list: () => [] },
    storeFile: path.join(root, "inventory.json"),
    persistence: false,
  });
  spawned.length = 0;
  const [plain, required, again] = await Promise.all([
    runtime.resolveRepository(repository),
    runtime.resolveRepository(repository, { requireGit: true }),
    runtime.resolveRepository(repository, { requireGit: true }),
  ]);
  const rootLookups = spawned.filter((args) => args.includes("--show-toplevel")).length;
  assert.equal(rootLookups, 1, "one git rev-parse --show-toplevel for three concurrent resolutions");
  assert.equal(plain.repositoryId, required.repositoryId);
  assert.deepStrictEqual(required, again);
  assert.equal(await runtime.resolveRepository(nested, { requireGit: true }), null, "a missing directory is still not a recognized repository");
  runtime.close?.();
});
