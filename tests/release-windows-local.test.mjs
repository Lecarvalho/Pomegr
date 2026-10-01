import assert from "node:assert/strict";
import test from "node:test";

import { validateThenDispatchRelease } from "../scripts/release-windows-local.mjs";

const BASE = "a".repeat(40);
const BUMPED = "b".repeat(40);
const OTHER = "c".repeat(40);

function fakeRepository(overrides = {}) {
  const state = {
    branch: "main",
    head: BASE,
    remoteMain: BASE,
    packageVersion: "1.2.3",
    localTags: {},
    remoteTags: {},
    dirty: false,
    calls: [],
    ...overrides,
  };
  const git = (args) => {
    const [verb, ...rest] = args;
    if (verb === "status") return state.dirty ? " M package.json" : "";
    if (verb === "ls-remote") return state.remoteTags[rest[2].slice("refs/tags/".length)] ? "found" : "";
    if (verb === "fetch" || verb === "add") return "";
    if (verb === "rev-parse") {
      const reference = rest.at(-1);
      if (rest[0] === "--abbrev-ref") return state.branch;
      if (reference === "HEAD") return state.head;
      if (reference === "refs/remotes/origin/main") return state.remoteMain;
      const tagged = state.localTags[reference.slice("refs/tags/".length, -"^{commit}".length)];
      if (!tagged) throw new Error("unknown revision");
      return tagged;
    }
    if (verb === "tag" && rest[0] === "--list") return state.localTags[rest[1]] ? rest[1] : "";
    if (verb === "tag") { state.localTags[rest[1]] = state.head; return ""; }
    if (verb === "commit") { state.head = BUMPED; return ""; }
    if (verb === "push" && rest[1].startsWith("HEAD:")) { state.remoteMain = state.head; return ""; }
    if (verb === "push") {
      const tag = rest[1].slice("refs/tags/".length);
      state.remoteTags[tag] = state.localTags[tag];
      return "";
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const gh = (args) => {
    const target = args.at(-1);
    if (args[0] === "workflow") return "";
    if (!target.includes("/git/ref/tags/")) return "{}";
    const sha = state.remoteTags[decodeURIComponent(target.split("/").at(-1))];
    if (!sha) throw new Error("not found");
    return JSON.stringify({ object: { type: "commit", sha } });
  };
  const runCommand = async (command, args) => {
    state.calls.push([command, ...args].join(" "));
    if (command === "git") return git(args);
    if (command === "gh") return gh(args);
    if (command === "node" && args[1] === "version") { state.packageVersion = args[2]; return ""; }
    throw new Error(`unexpected ${command}`);
  };
  const options = {
    cwd: "repo",
    runCommand,
    readText: async () => JSON.stringify({ version: state.packageVersion }),
    npmCli: "npm-cli.js",
    nodeExecutable: "node",
  };
  return { state, options };
}

const dispatched = (state) => state.calls.filter((call) => call.startsWith("gh workflow run"));

test("a new release tag bumps, commits, pushes, tags, and dispatches the pushed commit", async () => {
  const { state, options } = fakeRepository();
  const result = await validateThenDispatchRelease({ ...options, tag: "v1.2.4" });

  assert.deepEqual(result, { tag: "v1.2.4", version: "1.2.4", dispatched: true });
  assert.equal(state.remoteMain, BUMPED);
  assert.deepEqual(state.remoteTags, { "v1.2.4": BUMPED });
  assert.ok(state.calls.includes("node npm-cli.js version 1.2.4 --no-git-tag-version"));
  assert.ok(state.calls.includes("git add -- package.json package-lock.json"));
  assert.ok(state.calls.includes("git tag -a v1.2.4 -m Pomegr 1.2.4"));
  assert.match(dispatched(state)[0], new RegExp(`--ref v1\\.2\\.4 -f tag=v1\\.2\\.4 -f release_sha=${BUMPED}$`));
});

test("an already bumped main is tagged without another version commit", async () => {
  const { state, options } = fakeRepository({ packageVersion: "1.2.4" });
  await validateThenDispatchRelease({ ...options, tag: "v1.2.4" });

  assert.equal(state.head, BASE);
  assert.deepEqual(state.remoteTags, { "v1.2.4": BASE });
  assert.equal(dispatched(state).length, 1);
});

test("an existing remote tag is dispatched as is and never rewritten", async () => {
  const { state, options } = fakeRepository({
    branch: "HEAD", packageVersion: "1.2.4", localTags: { "v1.2.4": BASE }, remoteTags: { "v1.2.4": BASE }, remoteMain: OTHER,
  });
  await validateThenDispatchRelease({ ...options, tag: "v1.2.4" });

  assert.equal(dispatched(state).length, 1);
  assert.ok(!state.calls.some((call) => /^git (push|tag -a|commit)/.test(call)));
});

test("check-only never changes the repository or dispatches", async () => {
  const { state, options } = fakeRepository();
  await assert.rejects(
    validateThenDispatchRelease({ ...options, tag: "v1.2.4", checkOnly: true }),
    /DESKTOP_RELEASE_TAG_VERSION_MISMATCH/,
  );
  assert.ok(!state.calls.some((call) => /^(node|git (push|tag|commit|add)|gh workflow)/.test(call)));
});

test("a new release refuses a dirty checkout, another branch, unsynced main, and a stray local tag", async () => {
  const cases = [
    [{ dirty: true }, /POMEGR_RELEASE_CHECKOUT_DIRTY/],
    [{ branch: "feature" }, /POMEGR_RELEASE_BRANCH_NOT_MAIN/],
    [{ remoteMain: OTHER }, /POMEGR_RELEASE_MAIN_NOT_SYNCED/],
    [{ localTags: { "v1.2.4": BASE } }, /POMEGR_RELEASE_LOCAL_TAG_MISMATCH/],
    [{ packageVersion: "1.2.4", localTags: { "v1.2.4": OTHER } }, /POMEGR_RELEASE_LOCAL_TAG_MISMATCH/],
  ];
  for (const [overrides, expected] of cases) {
    const { state, options } = fakeRepository(overrides);
    await assert.rejects(validateThenDispatchRelease({ ...options, tag: "v1.2.4" }), expected);
    assert.ok(!state.calls.some((call) => /^(git push|gh workflow)/.test(call)));
  }
  const { options } = fakeRepository();
  await assert.rejects(validateThenDispatchRelease({ ...options, tag: "1.2.4" }), /DESKTOP_RELEASE_TAG_VERSION_MISMATCH/);
  await assert.rejects(validateThenDispatchRelease({ ...options, tag: "v1.2" }), /DESKTOP_RELEASE_VERSION_INVALID/);
});
