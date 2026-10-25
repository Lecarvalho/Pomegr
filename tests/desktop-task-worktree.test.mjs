import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskWorktrees, TASK_WORKTREE_DIRECTORY, TASK_WORKTREE_REPOSITORY_PATH, taskBranch } from "../desktop/runtime/task-worktree.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const root = path.resolve("/pomegr-data", TASK_WORKTREE_DIRECTORY);
const repositoryRoot = path.resolve("/work/repo");
const directory = path.join(repositoryRoot, ".pomegr", "worktrees", "T-3");
// Where a worktree was made before worktrees moved into the repository.
const legacy = path.join(root, repositoryId, "T-3");
const place = { repositoryRoot, repositoryId, taskId: "T-3" };
const listing = (branch = "refs/heads/tasks/T-3", at = directory) =>
  `worktree ${repositoryRoot.replaceAll("\\", "/")}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${at.replaceAll("\\", "/")}\nHEAD abc\n${branch ? `branch ${branch}` : "detached"}\n\n`;

/** Fake Git: `answers` maps the first argument after `-C <directory>` (two words for `worktree`) to `{ ok, stdout }`. */
function harness({ answers = {}, exists = false, legacyExists = false, legacyRoot = root, managerOptions = {} } = {}) {
  const calls = [];
  const made = [];
  const ignored = [];
  const present = new Set([...(exists ? [directory] : []), ...(legacyExists ? [legacy] : [])]);
  const worktrees = createTaskWorktrees({
    ...managerOptions,
    root: legacyRoot,
    environment: { PATH: "C:\\Windows", SECRET_KEY: "nope" },
    directoryExists: (target) => present.has(target),
    makeDirectory: (target) => { made.push(target); },
    ignoreContents: (target) => { ignored.push(target); },
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      const key = args[2] === "worktree" ? `worktree ${args[3]}` : args[2];
      const answer = typeof answers[key] === "function" ? answers[key](args) : answers[key] ?? { ok: true, stdout: "" };
      if (key === "worktree add" && answer.ok) present.add(directory);
      if (key === "worktree remove" && answer.ok) present.delete(args[4]);
      queueMicrotask(() => callback(answer.ok ? null : new Error("git failed"), answer.stdout ?? "", ""));
    },
  });
  return { worktrees, calls, made, ignored, git: () => calls.map((call) => call.args.slice(2).join(" ")) };
}

test("the task branch and the worktree folders are fixed", () => {
  assert.equal(taskBranch("T-3"), "tasks/T-3");
  assert.deepEqual(TASK_WORKTREE_REPOSITORY_PATH, [".pomegr", "worktrees"]);
  assert.equal(TASK_WORKTREE_DIRECTORY, "task-worktrees");
});

test("inventory includes only exact Git-known task folders and reports safe task and worktree facts", async () => {
  const old = path.join(repositoryRoot, ".pomegr", "worktrees", "T-2");
  const oldLegacy = path.join(root, repositoryId, "T-4");
  const arbitrary = path.join(repositoryRoot, "elsewhere", "T-1");
  const output = [
    `worktree ${repositoryRoot.replaceAll("\\", "/")}\nHEAD abc\nbranch refs/heads/main`,
    `worktree ${old.replaceAll("\\", "/")}\nHEAD def\nbranch refs/heads/tasks/T-2`,
    `worktree ${directory.replaceAll("\\", "/")}\nHEAD ghi\nbranch refs/heads/tasks/T-3`,
    `worktree ${oldLegacy.replaceAll("\\", "/")}\nHEAD mno\nbranch refs/heads/tasks/T-4`,
    `worktree ${arbitrary.replaceAll("\\", "/")}\nHEAD jkl\nbranch refs/heads/tasks/T-1`,
  ].join("\n\n");
  const h = harness({ exists: true, answers: { "worktree list": { ok: true, stdout: output }, "rev-list": { ok: true, stdout: "1\n" } } });
  const rows = await h.worktrees.inventory({
    ...place,
    tasks: [{ id: "T-3", state: "queued", columnId: "col-ready" }],
    columns: [{ id: "col-ready", name: "Ready" }],
  });
  assert.deepEqual(rows.map(({ taskId }) => taskId), ["T-2", "T-3", "T-4"]);
  assert.deepEqual(rows.map(({ state, column }) => [state, column]), [["not on board", "not on board"], ["queued", "Ready"], ["not on board", "not on board"]]);
  assert.equal(rows.every(({ clean, uniqueCommits, sizeMB, atLeast }) => typeof clean === "boolean" && typeof uniqueCommits === "boolean" && typeof sizeMB === "number" && typeof atLeast === "boolean"), true);
  assert.equal(rows.some((row) => JSON.stringify(row).includes("/work/repo")), false);
});

test("inventory derives IDs from listed folder names, sorts numerically, and caps rows at 30", async () => {
  const entries = Array.from({ length: 35 }, (_, index) => {
    const id = `T-${index + 1}`;
    const at = path.join(repositoryRoot, ".pomegr", "worktrees", id).replaceAll("\\", "/");
    return `worktree ${at}\nHEAD abc\nbranch refs/heads/tasks/${id}`;
  });
  const h = harness({ answers: { "worktree list": { ok: true, stdout: entries.join("\n\n") } } });
  const rows = await h.worktrees.inventory({ ...place, tasks: [{ id: "T-999", state: "done", columnId: "x" }] });
  assert.equal(rows.length, 30);
  assert.deepEqual(rows.map(({ taskId }) => taskId), Array.from({ length: 30 }, (_, index) => `T-${index + 1}`));
});

test("inventory reads clean and unique-commit facts independently for each worktree", async () => {
  const other = path.join(repositoryRoot, ".pomegr", "worktrees", "T-2");
  const blocks = listing().split("\n\n").slice(0, 2);
  blocks.push(`worktree ${other.replaceAll("\\", "/")}\nHEAD def\nbranch refs/heads/tasks/T-2`);
  const h = harness({ answers: {
    "worktree list": { ok: true, stdout: blocks.join("\n\n") },
    status: (args) => ({ ok: true, stdout: path.basename(args[1]) === "T-3" ? " M draft.txt\n" : "" }),
    "rev-list": (args) => ({ ok: true, stdout: path.basename(args[1]) === "T-3" ? "0\n" : "2\n" }),
  } });
  const rows = await h.worktrees.inventory({ ...place });
  assert.deepEqual(rows.map(({ taskId, clean, uniqueCommits }) => [taskId, clean, uniqueCommits]), [["T-2", true, true], ["T-3", false, false]]);
});

test("inventory bounds directory iteration and size walks skip symlinks", async () => {
  let read = 0;
  const entries = async function* () {
    for (let index = 0; index < 20_001; index++) {
      read++;
      yield { name: `f-${index}`, isSymbolicLink: () => index === 0 };
    }
  };
  let statCalls = 0;
  const h = harness({
    answers: { "worktree list": { ok: true, stdout: listing() } },
    managerOptions: {
      openDirectory: async () => entries(),
      lstat: async () => { statCalls++; return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: 1024 }; },
      now: () => 0,
    },
  });
  const [row] = await h.worktrees.inventory({ ...place });
  assert.equal(row.atLeast, true);
  assert.equal(row.sizeMB, 19.5);
  assert.equal(read, 20_000, "the iterator stops without reading an entry beyond its bound");
  assert.equal(statCalls, 19_999, "the first entry was a symlink and was never statted");
});

test("inventory stops a size walk at two seconds", async () => {
  let clock = 0;
  const h = harness({
    answers: { "worktree list": { ok: true, stdout: listing() } },
    managerOptions: {
      openDirectory: async () => (async function* () { yield { name: "one", isSymbolicLink: () => false }; })(),
      lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: 1024 }),
      now: () => { clock += 1_000; return clock; },
    },
  });
  const [row] = await h.worktrees.inventory({ ...place });
  assert.equal(row.atLeast, true);
  assert.equal(row.sizeMB, 0);
});

test("detailed remove reports safety distinctions while the default contract stays unchanged", async () => {
  const listed = { "worktree list": { ok: true, stdout: listing() } };
  let h = harness({ exists: true, answers: { ...listed, status: { ok: true, stdout: " M draft.txt\n" } } });
  assert.equal(await h.worktrees.remove({ ...place, detailed: true }), "dirty");
  assert.equal(await h.worktrees.remove(place), "kept");
  h = harness({ exists: true, answers: { ...listed, status: { ok: false } } });
  assert.equal(await h.worktrees.remove({ ...place, detailed: true }), "failed");
  h = harness({ exists: true, answers: { "worktree list": { ok: true, stdout: "" } } });
  assert.equal(await h.worktrees.remove({ ...place, detailed: true }), "failed");
  h = harness({ exists: true, answers: { ...listed, "rev-list": { ok: true, stdout: "2\n" } } });
  assert.equal(await h.worktrees.remove({ ...place, detailed: true }), "unique_commits");
  h = harness({ exists: true, answers: { ...listed, "rev-list": { ok: false } } });
  assert.equal(await h.worktrees.remove({ ...place, detailed: true }), "failed");
  h = harness();
  assert.equal(await h.worktrees.remove({ ...place, detailed: true }), "not_found");
});

test("a new worktree is added inside the repository on a new task branch at HEAD, with argument arrays and no shell", async () => {
  const h = harness({ answers: { "show-ref": { ok: false } } });
  assert.deepEqual(await h.worktrees.ensure(place), { ok: true, directory, created: true, branchCreated: true });
  assert.deepEqual(h.made, [path.join(repositoryRoot, ".pomegr", "worktrees")]);
  assert.deepEqual(h.ignored, h.made, "the folder ignores its own contents, so the repository's tree stays clean");
  assert.deepEqual(h.calls.map((call) => call.args), [
    ["-C", repositoryRoot, "show-ref", "--verify", "--quiet", "refs/heads/tasks/T-3"],
    ["-C", repositoryRoot, "worktree", "add", "-b", "tasks/T-3", directory, "HEAD"],
  ]);
  for (const call of h.calls) {
    assert.equal(call.file, "git");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0");
    assert.ok(call.options.timeout > 0);
  }
});

test("an existing task branch is checked out instead of created", async () => {
  const h = harness();
  assert.deepEqual(await h.worktrees.ensure(place), { ok: true, directory, created: true, branchCreated: false });
  assert.deepEqual(h.calls[1].args, ["-C", repositoryRoot, "worktree", "add", directory, "tasks/T-3"]);
});

test("a worktrees folder that cannot ignore its contents makes no worktree", async () => {
  const worktrees = createTaskWorktrees({
    directoryExists: () => false, makeDirectory() {}, ignoreContents() { throw new Error("EACCES"); }, execFile: () => { throw new Error("never"); },
  });
  assert.deepEqual(await worktrees.ensure(place), { ok: false });
});

test("a worktree made in the desktop data folder before the move is used, opened, and removed where it is", async () => {
  const safe = { "worktree list": { ok: true, stdout: listing(undefined, legacy) }, "rev-list": { ok: true, stdout: "0\n" } };
  let h = harness({ legacyExists: true, answers: safe });
  assert.deepEqual(await h.worktrees.ensure(place), { ok: true, directory: legacy, created: false, branchCreated: false });
  assert.deepEqual([h.made, h.ignored], [[], []]);
  assert.equal(await h.worktrees.locate({ repositoryId, taskId: "T-3" }), legacy);
  assert.equal(await h.worktrees.locate({ repositoryRoot, repositoryId, taskId: "T-3" }), legacy);
  assert.equal(await h.worktrees.remove({ ...place, deleteBranch: true }), "removed");
  assert.deepEqual(h.git().slice(-2), [`worktree remove ${legacy}`, "branch -D tasks/T-3"]);

  // Without the data folder only the repository's own folder is read.
  h = harness({ legacyExists: true, legacyRoot: "relative", answers: { "show-ref": { ok: false } } });
  assert.deepEqual(await h.worktrees.ensure(place), { ok: true, directory, created: true, branchCreated: true });
  assert.equal(await h.worktrees.locate({ repositoryId, taskId: "T-3" }), null);
});

test("a failed add answers not ok", async () => {
  const h = harness({ answers: { "show-ref": { ok: false }, "worktree add": { ok: false } } });
  assert.deepEqual(await h.worktrees.ensure(place), { ok: false });
});

test("an existing worktree is reused only when Git lists it on the task branch and it is clean", async () => {
  let h = harness({ exists: true, answers: { "worktree list": { ok: true, stdout: listing() } } });
  assert.deepEqual(await h.worktrees.ensure(place), { ok: true, directory, created: false, branchCreated: false });
  assert.deepEqual(h.git(), ["worktree list --porcelain", "status --porcelain --untracked-files=normal"]);
  assert.equal(h.calls[1].args[1], directory);

  const refusals = [
    { "worktree list": { ok: true, stdout: listing() }, status: { ok: true, stdout: " M file.txt\n" } },
    { "worktree list": { ok: true, stdout: listing() }, status: { ok: true, stdout: "?? new.txt\n" } },
    { "worktree list": { ok: true, stdout: listing() }, status: { ok: false } },
    { "worktree list": { ok: true, stdout: listing("refs/heads/other") } },
    { "worktree list": { ok: true, stdout: listing(null) } },
    { "worktree list": { ok: true, stdout: `worktree ${repositoryRoot}\nHEAD abc\nbranch refs/heads/main\n\n` } },
    { "worktree list": { ok: false } },
  ];
  for (const answers of refusals) {
    h = harness({ exists: true, answers });
    const dirty = answers.status?.ok === true && answers.status.stdout !== "";
    assert.deepEqual(await h.worktrees.ensure(place), dirty ? { ok: false, reason: "dirty" } : { ok: false }, JSON.stringify(answers));
    assert.equal(h.git().some((command) => command.startsWith("worktree add") || command.startsWith("worktree remove")), false);
  }
});

test("invalid input makes no Git call", async () => {
  const h = harness();
  const invalid = [
    undefined, {}, { ...place, taskId: "T-0" }, { ...place, taskId: "../T-1" }, { ...place, taskId: "T-1 --force" },
    { ...place, repositoryId: "repo-XYZ" }, { ...place, repositoryId: `${repositoryId}/..` },
    { ...place, repositoryRoot: "relative" }, { ...place, repositoryRoot: `${repositoryRoot}"` }, { ...place, repositoryRoot: 7 },
  ];
  for (const request of invalid) {
    assert.deepEqual(await h.worktrees.ensure(request), { ok: false });
    assert.equal(await h.worktrees.remove(request), "failed");
  }
  assert.equal(h.calls.length, 0);
});

test("remove deletes only a listed, clean worktree whose commits exist elsewhere", async () => {
  const safe = { "worktree list": { ok: true, stdout: listing() }, "rev-list": { ok: true, stdout: "0\n" } };
  let h = harness({ exists: true, answers: safe });
  assert.equal(await h.worktrees.remove(place), "removed");
  assert.deepEqual(h.git(), [
    "worktree list --porcelain",
    "status --porcelain --untracked-files=normal",
    "rev-list --count HEAD --not --remotes --exclude=tasks/T-3 --branches",
    `worktree remove ${directory}`,
  ]);
  assert.equal(h.git().some((command) => command.includes("--force")), false);

  h = harness({ exists: true, answers: safe });
  assert.equal(await h.worktrees.remove({ ...place, deleteBranch: true }), "removed");
  assert.equal(h.git().at(-1), "branch -D tasks/T-3", "the worktree's own branch, whose commits were just found elsewhere");

  // A worktree on another branch, or on none, goes without a branch delete.
  for (const branch of ["refs/heads/other", null]) {
    h = harness({ exists: true, answers: { ...safe, "worktree list": { ok: true, stdout: listing(branch) } } });
    assert.equal(await h.worktrees.remove({ ...place, deleteBranch: true }), "removed");
    assert.equal(h.git().some((command) => command.startsWith("branch")), false);
  }

  const kept = [
    { ...safe, status: { ok: true, stdout: " M file.txt\n" } },
    { ...safe, status: { ok: false } },
    { ...safe, "rev-list": { ok: true, stdout: "2\n" } },
    { ...safe, "rev-list": { ok: false } },
    { ...safe, "worktree list": { ok: true, stdout: "" } },
    { ...safe, "worktree list": { ok: false } },
  ];
  for (const answers of kept) {
    h = harness({ exists: true, answers });
    assert.equal(await h.worktrees.remove({ ...place, deleteBranch: true }), "kept", JSON.stringify(answers));
    assert.equal(h.git().some((command) => command.startsWith("worktree remove") || command.startsWith("branch")), false);
  }

  h = harness();
  assert.equal(await h.worktrees.remove(place), "absent");
  assert.equal(h.calls.length, 0);
  h = harness({ exists: true, answers: { ...safe, "worktree remove": { ok: false } } });
  assert.equal(await h.worktrees.remove({ ...place, deleteBranch: true }), "failed");
  assert.equal(h.git().some((command) => command.startsWith("branch")), false);
});

test("a throwing execFile is a failure, never an exception", async () => {
  const worktrees = createTaskWorktrees({ root, directoryExists: () => false, makeDirectory() {}, execFile: () => { throw new Error("ENOENT"); } });
  assert.deepEqual(await worktrees.ensure(place), { ok: false });
});

function gitAvailable() {
  try { execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true }); return true; } catch { return false; }
}

test("with real Git: parallel worktrees are made, reused, and never removed with work in them", { skip: !gitAvailable() }, async (context) => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pomegr-task-worktree-")));
  context.after(() => { rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); });
  const repository = path.join(base, "repo");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["init", "--quiet", repository], { windowsHide: true, stdio: "ignore" });
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repository, "config", key, value);
  writeFileSync(path.join(repository, "file.txt"), "one\n");
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "first");

  const worktrees = createTaskWorktrees({ root: path.join(base, TASK_WORKTREE_DIRECTORY) });
  const at = (taskId) => ({ repositoryRoot: repository, repositoryId, taskId });
  const first = await worktrees.ensure(at("T-1"));
  const second = await worktrees.ensure(at("T-2"));
  assert.deepEqual([first.ok, first.created, first.branchCreated, second.ok], [true, true, true, true]);
  assert.equal(first.directory, path.join(repository, ".pomegr", "worktrees", "T-1"));
  assert.equal(second.directory, path.join(repository, ".pomegr", "worktrees", "T-2"));
  assert.equal(git(repository, "status", "--porcelain", "--untracked-files=normal"), "", "the worktrees leave the repository's own tree clean");
  assert.equal(git(first.directory, "branch", "--show-current").trim(), "tasks/T-1");
  assert.equal(git(second.directory, "branch", "--show-current").trim(), "tasks/T-2");

  // A clean worktree of the task is used again.
  assert.deepEqual(await worktrees.ensure(at("T-1")), { ok: true, directory: first.directory, created: false, branchCreated: false });

  // Uncommitted changes: not reused, not removed.
  writeFileSync(path.join(first.directory, "new.txt"), "work\n");
  assert.deepEqual(await worktrees.ensure(at("T-1")), { ok: false, reason: "dirty" });
  assert.equal(await worktrees.locate({ repositoryRoot: repository, repositoryId, taskId: "T-1" }), first.directory);
  assert.equal(await worktrees.locate({ repositoryId, taskId: "T-1" }), null);
  assert.equal(await worktrees.remove(at("T-1")), "kept");
  assert.equal(existsSync(path.join(first.directory, "new.txt")), true);

  // A commit that exists nowhere else: not removed.
  git(first.directory, "add", ".");
  git(first.directory, "commit", "--quiet", "-m", "task work");
  assert.equal(await worktrees.remove({ ...at("T-1"), deleteBranch: true }), "kept");
  assert.equal(existsSync(first.directory), true);

  // Nothing of its own: removed, and its unused branch with it.
  assert.equal(await worktrees.remove({ ...at("T-2"), deleteBranch: true }), "removed");
  assert.equal(existsSync(second.directory), false);
  assert.equal(git(repository, "branch", "--list", "tasks/T-2").trim(), "");
  assert.equal(await worktrees.remove(at("T-2")), "absent");

  // Once the work is on another branch too, the worktree can go; the task branch stays.
  git(repository, "merge", "--quiet", "tasks/T-1");
  assert.equal(await worktrees.remove(at("T-1")), "removed");
  assert.match(git(repository, "branch", "--list", "tasks/T-1"), /tasks\/T-1/u);

  // A done task's branch goes with its worktree once its commits are on another branch, merged into the root or not.
  const third = await worktrees.ensure(at("T-3"));
  writeFileSync(path.join(third.directory, "third.txt"), "work\n");
  git(third.directory, "add", ".");
  git(third.directory, "commit", "--quiet", "-m", "third");
  assert.equal(await worktrees.remove({ ...at("T-3"), deleteBranch: true }), "kept");
  git(repository, "branch", "kept-elsewhere", "tasks/T-3");
  assert.equal(await worktrees.remove({ ...at("T-3"), deleteBranch: true }), "removed");
  assert.equal(git(repository, "branch", "--list", "tasks/T-3").trim(), "");
  assert.match(git(repository, "branch", "--list", "kept-elsewhere"), /kept-elsewhere/u);

  // A worktree made in the desktop data folder before the move is still the task's worktree.
  const old = path.join(base, TASK_WORKTREE_DIRECTORY, repositoryId, "T-4");
  git(repository, "worktree", "add", "--quiet", "-b", "tasks/T-4", old, "HEAD");
  assert.deepEqual(await worktrees.ensure(at("T-4")), { ok: true, directory: old, created: false, branchCreated: false });
  assert.equal(await worktrees.locate({ repositoryId, taskId: "T-4" }), old);
  assert.equal(await worktrees.remove({ ...at("T-4"), deleteBranch: true }), "removed");
  assert.equal(existsSync(old), false);
});

test("with real Git: the inventory lists only Pomegr task worktrees with their facts, and a detailed removal says why one stays", { skip: !gitAvailable() }, async (context) => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pomegr-task-worktree-")));
  context.after(() => { rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); });
  const repository = path.join(base, "repo");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["init", "--quiet", repository], { windowsHide: true, stdio: "ignore" });
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repository, "config", key, value);
  writeFileSync(path.join(repository, "file.txt"), "one\n");
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "first");

  const worktrees = createTaskWorktrees({ root: path.join(base, TASK_WORKTREE_DIRECTORY) });
  const at = (taskId) => ({ repositoryRoot: repository, repositoryId, taskId });
  const [one, two, three] = [await worktrees.ensure(at("T-1")), await worktrees.ensure(at("T-2")), await worktrees.ensure(at("T-3"))];
  const old = path.join(base, TASK_WORKTREE_DIRECTORY, repositoryId, "T-4");
  git(repository, "worktree", "add", "--quiet", "-b", "tasks/T-4", old, "HEAD");
  // A worktree of the repository outside both Pomegr locations is never listed, whatever its folder is called.
  git(repository, "worktree", "add", "--quiet", "-b", "tasks/T-9", path.join(base, "elsewhere", "T-9"), "HEAD");
  writeFileSync(path.join(one.directory, "big.bin"), Buffer.alloc(2 * 1024 * 1024));
  writeFileSync(path.join(two.directory, "work.txt"), "work\n");
  git(two.directory, "add", ".");
  git(two.directory, "commit", "--quiet", "-m", "task work");

  const rows = await worktrees.inventory({ ...at("T-1"), tasks: [{ id: "T-2", state: "done", columnId: "col-done" }], columns: [{ id: "col-done", name: "Done" }] });
  assert.deepEqual(rows.map(({ taskId, state, column, clean, uniqueCommits }) => [taskId, state, column, clean, uniqueCommits]), [
    ["T-1", "not on board", "not on board", false, false], ["T-2", "done", "Done", true, true],
    ["T-3", "not on board", "not on board", true, false], ["T-4", "not on board", "not on board", true, false],
  ]);
  assert.equal(rows[0].sizeMB >= 2 && rows[0].sizeMB < 3, true);
  assert.equal(rows.every((row) => row.atLeast === false && Object.keys(row).sort().join() === "atLeast,clean,column,sizeMB,state,taskId,uniqueCommits"), true);
  assert.equal(JSON.stringify(rows).includes("pomegr-task-worktree"), false, "no row holds a path");

  assert.equal(await worktrees.remove({ ...at("T-1"), detailed: true }), "dirty");
  assert.equal(await worktrees.remove({ ...at("T-2"), detailed: true }), "unique_commits");
  assert.equal(await worktrees.remove({ ...at("T-7"), detailed: true }), "not_found");
  assert.equal(existsSync(one.directory) && existsSync(two.directory), true);
  assert.equal(await worktrees.remove({ ...at("T-3"), deleteBranch: true, detailed: true }), "removed");
  assert.equal(git(repository, "branch", "--list", "tasks/T-3").trim(), "");
  assert.equal(await worktrees.remove({ ...at("T-4"), deleteBranch: false, detailed: true }), "removed");
  assert.match(git(repository, "branch", "--list", "tasks/T-4"), /tasks\/T-4/u);
  assert.equal(existsSync(three.directory) || existsSync(old), false);
  assert.deepEqual((await worktrees.inventory(at("T-1"))).map(({ taskId }) => taskId), ["T-1", "T-2"]);
});

test("only a listed, uncommitted-changes worktree is dirty; a failed status and other refusals are the plain failure", async () => {
  const dirty = harness({ exists: true, answers: { "worktree list": { ok: true, stdout: listing() }, status: { ok: true, stdout: " M a.txt\n" } } });
  assert.deepEqual(await dirty.worktrees.ensure(place), { ok: false, reason: "dirty" });
  const unknown = harness({ exists: true, answers: { "worktree list": { ok: true, stdout: listing() }, status: { ok: false } } });
  assert.deepEqual(await unknown.worktrees.ensure(place), { ok: false });
  const wrongBranch = harness({ exists: true, answers: { "worktree list": { ok: true, stdout: listing("refs/heads/other") }, status: { ok: true, stdout: " M a.txt\n" } } });
  assert.deepEqual(await wrongBranch.worktrees.ensure(place), { ok: false });
});

test("locate answers the directory only when it exists and Git lists it on the task branch, asking Git from inside it", async () => {
  let h = harness({ exists: true, answers: { "worktree list": { ok: true, stdout: listing() } } });
  assert.equal(await h.worktrees.locate({ repositoryRoot, repositoryId, taskId: "T-3" }), directory);
  assert.deepEqual(h.calls.map((call) => call.args), [["-C", directory, "worktree", "list", "--porcelain"]]);
  const misses = [
    { exists: false, answers: { "worktree list": { ok: true, stdout: listing() } } },
    { exists: true, answers: { "worktree list": { ok: true, stdout: listing("refs/heads/other") } } },
    { exists: true, answers: { "worktree list": { ok: true, stdout: listing(null) } } },
    { exists: true, answers: { "worktree list": { ok: true, stdout: `worktree ${repositoryRoot}\nHEAD abc\nbranch refs/heads/main\n\n` } } },
    { exists: true, answers: { "worktree list": { ok: false } } },
  ];
  for (const miss of misses) {
    h = harness(miss);
    assert.equal(await h.worktrees.locate({ repositoryRoot, repositoryId, taskId: "T-3" }), null);
  }
  h = harness({ exists: true });
  for (const bad of [undefined, {}, { repositoryId: "x", taskId: "T-3" }, { repositoryId, taskId: "../T-3" }, { repositoryId, taskId: "T-0" },
    { repositoryRoot: "relative", repositoryId, taskId: "T-3" }, { repositoryRoot: `${repositoryRoot}"`, repositoryId, taskId: "T-3" }].map((entry) => entry && { repositoryRoot, ...entry })) {
    assert.equal(await h.worktrees.locate(bad), null);
  }
  assert.deepEqual(h.calls, []);
});

// Windows can hand out a directory under its 8.3 short name (a CI runner's temporary folder is `RUNNER~1`), while Git
// lists a worktree by its long path. The same directory must still be recognized, or a task's worktree is never reused.
function shortPath(directory) {
  try {
    const answer = execFileSync("cmd.exe", ["/d", "/c", "for %I in (.) do @echo %~sI"], { cwd: directory, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return answer && answer.toLowerCase() !== directory.toLowerCase() ? answer : null;
  } catch { return null; }
}

test("with real Git: a repository reached through a Windows short name still has its worktree reused", { skip: process.platform !== "win32" || !gitAvailable() }, async (context) => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "pomegr task worktree long name ")));
  context.after(() => { rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); });
  const short = shortPath(base);
  if (!short) { context.skip("this volume gives no short names"); return; }
  const repository = path.join(base, "repo");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["init", "--quiet", repository], { windowsHide: true, stdio: "ignore" });
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(repository, "config", key, value);
  writeFileSync(path.join(repository, "file.txt"), "one\n");
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "first");

  const worktrees = createTaskWorktrees();
  const at = { repositoryRoot: path.join(short, "repo"), repositoryId, taskId: "T-1" };
  const first = await worktrees.ensure(at);
  assert.deepEqual([first.ok, first.created], [true, true]);
  assert.deepEqual(await worktrees.ensure(at), { ok: true, directory: first.directory, created: false, branchCreated: false });
  writeFileSync(path.join(first.directory, "draft.txt"), "work\n");
  assert.deepEqual(await worktrees.ensure(at), { ok: false, reason: "dirty" });
});
