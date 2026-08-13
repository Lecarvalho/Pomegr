import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGitState, readGitStateAsync, refreshRemoteGitState } from "../monitor/git-state.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function repositoryFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr Git José -"));
  const repository = path.join(root, "repository with spaces");
  const remote = path.join(root, "origin é.git");
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "--initial-branch=main", repository], { stdio: "ignore" });
  git(repository, "config", "user.name", "Pomegr Test");
  git(repository, "config", "user.email", "pomegr@example.test");
  await writeFile(path.join(repository, "tracked.txt"), "first\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "Initial commit");
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "-u", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repository, "remote", "set-head", "origin", "main");
  return { root, repository, remote };
}

test("reads recent commits and upstream divergence on the main branch", async (context) => {
  const { repository } = await repositoryFixture(context);
  await writeFile(path.join(repository, "tracked.txt"), "second\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "Local main commit");
  await writeFile(path.join(repository, "tracked.txt"), "third\n");
  await writeFile(path.join(repository, "untracked.txt"), "local\n");

  const trackingBefore = git(repository, "rev-parse", "origin/main");
  await refreshRemoteGitState(repository, { force: true });
  const state = readGitState(repository);
  const asyncState = await readGitStateAsync(repository);

  assert.equal(state.available, true);
  assert.equal(state.branch, "main");
  assert.equal(state.isMain, true);
  assert.deepEqual(state.comparison, { branch: "origin/main", kind: "upstream", ahead: 1, behind: 0, integrated: false });
  assert.equal(state.remote.status, "ready");
  assert.match(state.remote.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(git(repository, "rev-parse", "origin/main"), trackingBefore);
  assert.equal(state.commits[0].subject, "Local main commit");
  assert.deepEqual(state.files, [
    { status: " M", path: "tracked.txt" },
    { status: "??", path: "untracked.txt" },
  ]);
  assert.deepEqual(asyncState, state);
});

test("shows only commits unique to a feature branch", async (context) => {
  const { root, repository, remote } = await repositoryFixture(context);
  git(repository, "switch", "-c", "feature/branch-summary");
  await writeFile(path.join(repository, "feature.txt"), "feature\n");
  git(repository, "add", "feature.txt");
  git(repository, "commit", "-m", "Add branch summary");

  const publisher = path.join(root, "publisher");
  execFileSync("git", ["clone", "--quiet", remote, publisher], { stdio: "ignore" });
  git(publisher, "config", "user.name", "Pomegr Publisher");
  git(publisher, "config", "user.email", "publisher@example.test");
  await writeFile(path.join(publisher, "remote.txt"), "remote\n");
  git(publisher, "add", "remote.txt");
  git(publisher, "commit", "-m", "Advance remote main");
  git(publisher, "push", "origin", "main");
  const staleTrackingRef = git(repository, "rev-parse", "origin/main");

  await refreshRemoteGitState(repository, { force: true });
  const state = readGitState(repository);

  assert.equal(state.isMain, false);
  assert.deepEqual(state.comparison, { branch: "origin/main", kind: "base", ahead: 1, behind: 1, integrated: false });
  assert.deepEqual(state.commits.map((commit) => commit.subject), ["Add branch summary"]);
  assert.equal(git(repository, "rev-parse", "origin/main"), staleTrackingRef);
  assert.doesNotMatch(JSON.stringify(state), /origin\.git|publisher/);
});

test("does not fall back to a stale tracking ref when the remote is unavailable", async (context) => {
  const { root, repository } = await repositoryFixture(context);
  git(repository, "remote", "set-url", "origin", path.join(root, "missing.git"));

  await refreshRemoteGitState(repository, { force: true });
  const state = readGitState(repository);

  assert.equal(state.remote.status, "unavailable");
  assert.equal(state.comparison, null);
});

test("treats squash-merged branch changes as integrated instead of ahead", async (context) => {
  const { root, repository, remote } = await repositoryFixture(context);
  git(repository, "switch", "-c", "feature/squash-merged");
  await writeFile(path.join(repository, "first-feature.txt"), "first\n");
  git(repository, "add", "first-feature.txt");
  git(repository, "commit", "-m", "First feature commit");
  await writeFile(path.join(repository, "second-feature.txt"), "second\n");
  git(repository, "add", "second-feature.txt");
  git(repository, "commit", "-m", "Second feature commit");

  const publisher = path.join(root, "squash-publisher");
  execFileSync("git", ["clone", "--quiet", remote, publisher], { stdio: "ignore" });
  git(publisher, "config", "user.name", "Pomegr Publisher");
  git(publisher, "config", "user.email", "publisher@example.test");
  await writeFile(path.join(publisher, "first-feature.txt"), "first\n");
  await writeFile(path.join(publisher, "second-feature.txt"), "second\n");
  git(publisher, "add", "first-feature.txt", "second-feature.txt");
  git(publisher, "commit", "-m", "Squash feature changes");
  git(publisher, "push", "origin", "main");

  await refreshRemoteGitState(repository, { force: true });
  const state = readGitState(repository);

  assert.deepEqual(state.comparison, { branch: "origin/main", kind: "base", ahead: 0, behind: 1, integrated: true });
  assert.deepEqual(state.commits, []);
});
