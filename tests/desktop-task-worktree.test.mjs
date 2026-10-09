import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTaskWorktrees, TASK_WORKTREE_DIRECTORY, taskBranch } from "../desktop/runtime/task-worktree.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const root = path.resolve("/pomegr-data", TASK_WORKTREE_DIRECTORY);
const repositoryRoot = path.resolve("/work/repo");
const directory = path.join(root, repositoryId, "T-3");
const place = { repositoryRoot, repositoryId, taskId: "T-3" };
const listing = (branch = "refs/heads/tasks/T-3") =>
  `worktree ${repositoryRoot.replaceAll("\\", "/")}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${directory.replaceAll("\\", "/")}\nHEAD abc\n${branch ? `branch ${branch}` : "detached"}\n\n`;

/** Fake Git: `answers` maps the first argument after `-C <directory>` (two words for `worktree`) to `{ ok, stdout }`. */
function harness({ answers = {}, exists = false } = {}) {
  const calls = [];
  const made = [];
  const present = new Set(exists ? [directory] : []);
  const worktrees = createTaskWorktrees({
    root,
    environment: { PATH: "C:\\Windows", SECRET_KEY: "nope" },
    directoryExists: (target) => present.has(target),
    makeDirectory: (target) => { made.push(target); },
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      const key = args[2] === "worktree" ? `worktree ${args[3]}` : args[2];
      const answer = typeof answers[key] === "function" ? answers[key](args) : answers[key] ?? { ok: true, stdout: "" };
      if (key === "worktree add" && answer.ok) present.add(directory);
      if (key === "worktree remove" && answer.ok) present.delete(directory);
      queueMicrotask(() => callback(answer.ok ? null : new Error("git failed"), answer.stdout ?? "", ""));
    },
  });
  return { worktrees, calls, made, git: () => calls.map((call) => call.args.slice(2).join(" ")) };
}

test("the task branch and the owned directory name are fixed", () => {
  assert.equal(taskBranch("T-3"), "tasks/T-3");
  assert.equal(TASK_WORKTREE_DIRECTORY, "task-worktrees");
});

test("a new worktree is added on a new task branch at HEAD, with argument arrays and no shell", async () => {
  const h = harness({ answers: { "show-ref": { ok: false } } });
  assert.deepEqual(await h.worktrees.ensure(place), { ok: true, directory, created: true, branchCreated: true });
  assert.deepEqual(h.made, [path.join(root, repositoryId)]);
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
  const noRoot = createTaskWorktrees({ root: "relative", execFile: () => { throw new Error("never"); } });
  assert.deepEqual(await noRoot.ensure(place), { ok: false });
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
  assert.equal(h.git().at(-1), "branch -d tasks/T-3", "the safe delete, never -D");

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
  assert.notEqual(first.directory, second.directory);
  assert.equal(git(first.directory, "branch", "--show-current").trim(), "tasks/T-1");
  assert.equal(git(second.directory, "branch", "--show-current").trim(), "tasks/T-2");

  // A clean worktree of the task is used again.
  assert.deepEqual(await worktrees.ensure(at("T-1")), { ok: true, directory: first.directory, created: false, branchCreated: false });

  // Uncommitted changes: not reused, not removed.
  writeFileSync(path.join(first.directory, "new.txt"), "work\n");
  assert.deepEqual(await worktrees.ensure(at("T-1")), { ok: false, reason: "dirty" });
  assert.equal(await worktrees.locate({ repositoryId: at("T-1").repositoryId, taskId: "T-1" }), first.directory);
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
  assert.equal(await h.worktrees.locate({ repositoryId, taskId: "T-3" }), directory);
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
    assert.equal(await h.worktrees.locate({ repositoryId, taskId: "T-3" }), null);
  }
  h = harness({ exists: true });
  for (const bad of [undefined, {}, { repositoryId: "x", taskId: "T-3" }, { repositoryId, taskId: "../T-3" }, { repositoryId, taskId: "T-0" }]) {
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

test("with real Git: a worktree root reached through a Windows short name is still reused", { skip: process.platform !== "win32" || !gitAvailable() }, async (context) => {
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

  const worktrees = createTaskWorktrees({ root: path.join(short, TASK_WORKTREE_DIRECTORY) });
  const at = { repositoryRoot: repository, repositoryId, taskId: "T-1" };
  const first = await worktrees.ensure(at);
  assert.deepEqual([first.ok, first.created], [true, true]);
  assert.deepEqual(await worktrees.ensure(at), { ok: true, directory: first.directory, created: false, branchCreated: false });
  writeFileSync(path.join(first.directory, "draft.txt"), "work\n");
  assert.deepEqual(await worktrees.ensure(at), { ok: false, reason: "dirty" });
});
