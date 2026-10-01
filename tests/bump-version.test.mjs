import assert from "node:assert/strict";
import test from "node:test";

import { bumpVersion } from "../scripts/bump-version.mjs";

function fakeRepository(overrides = {}) {
  const state = { branch: "feat/next-release", dirty: false, calls: [], ...overrides };
  const runCommand = async (command, args) => {
    state.calls.push([command, ...args].join(" "));
    if (command !== "git") return "";
    if (args[0] === "status") return state.dirty ? " M package.json" : "";
    if (args[0] === "rev-parse") return state.branch;
    return "";
  };
  return { state, options: { cwd: "repo", runCommand, npmCli: "npm-cli.js", nodeExecutable: "node" } };
}

test("a version bump sets the version, commits both package files, and pushes the checked-out branch", async () => {
  const { state, options } = fakeRepository();
  assert.deepEqual(await bumpVersion({ ...options, version: "v1.2.4" }), { version: "1.2.4", branch: "feat/next-release" });
  assert.deepEqual(state.calls.slice(-4), [
    "node npm-cli.js version 1.2.4 --no-git-tag-version",
    "git add -- package.json package-lock.json",
    "git commit -m chore: bump version to 1.2.4",
    "git push origin HEAD:refs/heads/feat/next-release",
  ]);
  assert.ok(!state.calls.some((call) => /^git tag|^gh /.test(call)));
});

test("a version bump refuses an invalid version, a dirty checkout, and a detached HEAD", async () => {
  const cases = [
    [{}, "1.2", /DESKTOP_RELEASE_VERSION_INVALID/],
    [{ dirty: true }, "1.2.4", /POMEGR_VERSION_CHECKOUT_DIRTY/],
    [{ branch: "HEAD" }, "1.2.4", /POMEGR_VERSION_BRANCH_REQUIRED/],
  ];
  for (const [overrides, version, expected] of cases) {
    const { state, options } = fakeRepository(overrides);
    await assert.rejects(bumpVersion({ ...options, version }), expected);
    assert.ok(!state.calls.some((call) => /^(node|git (add|commit|push))/.test(call)));
  }
});
