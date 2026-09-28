import assert from "node:assert/strict";
import test from "node:test";

import os from "node:os";

import { memoizeRepositoryResolver, resolveSessionIdentity } from "../monitor/session-identity.mjs";
import { createCodexRepositoryAttributionTracker } from "../monitor/providers/codex-repository-attribution.mjs";

/**
 * A resolver stand-in that mirrors the real repository-inventory-runtime
 * contract: `requireGit: true` returns null unless `cwd` is inside one of the
 * configured roots; without it, a non-Git directory still resolves to an
 * ad-hoc identity for that directory itself (never null), exactly like
 * `identify()` falling back to the raw cwd when no Git root is found.
 */
function makeResolver(roots, { onCall } = {}) {
  return async (cwd, options = {}) => {
    onCall?.(cwd, options);
    for (const [prefix, target] of Object.entries(roots)) {
      if (cwd === prefix || cwd.startsWith(`${prefix}/`) || cwd.startsWith(`${prefix}\\`)) {
        return { repositoryId: target.repositoryId, root: target.root, ...(options.requireGit ? { recognized: true } : {}) };
      }
    }
    if (options.requireGit) return null;
    return { repositoryId: `adhoc:${cwd}`, root: cwd };
  };
}

test("launch cwd inside a recognized Git repository names the project, including from a nested subdirectory", async () => {
  const resolveRepository = makeResolver({ "/repo/root": { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/root" } });
  const identity = await resolveSessionIdentity({
    launchCwd: "/repo/root/src/nested/dir",
    recordedBranch: "main",
    resolveRepository,
  });
  assert.deepEqual(identity, {
    state: "single", repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", project: "root", recordedBranch: "main", root: "/repo/root",
  });
});

test("a worktree resolves to its own root independently of the main repository", async () => {
  const resolveRepository = makeResolver({
    "/repo/main": { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/main" },
    "/repo/worktrees/feature": { repositoryId: "repo-bbbbbbbbbbbbbbbbbbbbbbbb", root: "/repo/worktrees/feature" },
  });
  const identity = await resolveSessionIdentity({ launchCwd: "/repo/worktrees/feature", resolveRepository });
  assert.equal(identity.state, "single");
  assert.equal(identity.repositoryId, "repo-bbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(identity.project, "feature");
});

test("a proven mutation inside the launch repository leaves the identity unchanged, including the branch", async () => {
  const resolveRepository = makeResolver({ "/repo/root": { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/root" } });
  const identity = await resolveSessionIdentity({
    launchCwd: "/repo/root",
    recordedBranch: "codex/clapline",
    provenRepositories: new Map([["repo-aaaaaaaaaaaaaaaaaaaaaaaa", { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/root" }]]),
    resolveRepository,
  });
  assert.deepEqual(identity, {
    state: "single", repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", project: "root", recordedBranch: "codex/clapline", root: "/repo/root",
  });
});

test("a proven mutation outside the launch repository refines the project and drops the launch branch", async () => {
  const resolveRepository = makeResolver({ "/repo/launch": { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/launch" } });
  const identity = await resolveSessionIdentity({
    launchCwd: "/repo/launch",
    recordedBranch: "codex/clapline",
    provenRepositories: [{ repositoryId: "repo-bbbbbbbbbbbbbbbbbbbbbbbb", root: "/repo/mutated" }],
    resolveRepository,
  });
  assert.deepEqual(identity, {
    state: "single", repositoryId: "repo-bbbbbbbbbbbbbbbbbbbbbbbb", project: "mutated", recordedBranch: null, root: "/repo/mutated",
  });
});

test("a mutation outside the launch repository with no Git launch directory still refines and drops the branch", async () => {
  const resolveRepository = makeResolver({});
  const identity = await resolveSessionIdentity({
    launchCwd: "/tmp/scratch",
    recordedBranch: "codex/clapline",
    provenRepositories: [{ repositoryId: "repo-bbbbbbbbbbbbbbbbbbbbbbbb", root: "/repo/mutated" }],
    resolveRepository,
  });
  assert.equal(identity.state, "single");
  assert.equal(identity.repositoryId, "repo-bbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(identity.project, "mutated");
  assert.equal(identity.recordedBranch, null, "a launch branch is not a branch for the mutation repository");
});

test("mutations proven in two distinct repositories become Multiple repositories regardless of launch cwd", async () => {
  const resolveRepository = makeResolver({ "/repo/launch": { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/launch" } });
  const identity = await resolveSessionIdentity({
    launchCwd: "/repo/launch",
    recordedBranch: "main",
    provenRepositories: [
      { repositoryId: "repo-bbbbbbbbbbbbbbbbbbbbbbbb", root: "/repo/one" },
      { repositoryId: "repo-cccccccccccccccccccccccc", root: "/repo/two" },
    ],
    resolveRepository,
  });
  assert.deepEqual(identity, { state: "multiple", repositoryId: null, project: "Multiple repositories", recordedBranch: null, root: null });
});

test("a launch cwd confirmed outside Git with no proven mutation uses the launch directory's own basename", async () => {
  const resolveRepository = makeResolver({});
  const identity = await resolveSessionIdentity({ launchCwd: "/tmp/pomegr-codex-clapline-abc123", resolveRepository });
  assert.deepEqual(identity, {
    state: "unknown", repositoryId: null, project: "pomegr-codex-clapline-abc123", recordedBranch: null, root: null,
  });
});

test("a deleted launch directory behaves like a non-Git directory instead of throwing", async () => {
  // The inventory resolver answers null for a directory Git cannot inspect (it
  // catches the failure itself), so a deleted directory is an answered "not Git".
  const resolveRepository = async () => null;
  const identity = await resolveSessionIdentity({ launchCwd: "/tmp/deleted-dir", resolveRepository });
  assert.equal(identity.state, "unknown");
  assert.equal(identity.project, "deleted-dir");
  assert.equal(identity.repositoryId, null);
});

test("no launch cwd and no proven mutation is Unknown project", async () => {
  const resolveRepository = makeResolver({});
  const identity = await resolveSessionIdentity({ launchCwd: null, resolveRepository });
  assert.deepEqual(identity, { state: "unknown", repositoryId: null, project: "Unknown project", recordedBranch: null, root: null });
});

test("no resolver capability at all keeps Unknown project instead of guessing a basename", async () => {
  const identity = await resolveSessionIdentity({ launchCwd: "C:\\synthetic\\repo" });
  assert.deepEqual(identity, { state: "unknown", repositoryId: null, project: "Unknown project", recordedBranch: null, root: null });
});

test("no wired resolver at header time does not block catalog publication and degrades to Unknown project", async () => {
  const identity = await resolveSessionIdentity({ launchCwd: "/repo/root", provenRepositories: null, resolveRepository: null });
  assert.equal(identity.state, "unknown");
  assert.equal(identity.project, "Unknown project");
});

test("a resolver slower than the bound degrades instead of blocking catalog publication", async () => {
  let released = false;
  const resolveRepository = () => new Promise((resolve) => { setTimeout(() => { released = true; resolve(null); }, 300); });
  const startedAt = Date.now();
  const identity = await resolveSessionIdentity({ launchCwd: "/tmp/slow", resolveRepository, resolverTimeoutMs: 15 });
  assert.ok(Date.now() - startedAt < 1_000, "must not wait for the full resolver delay");
  assert.equal(identity.state, "unknown");
  assert.equal(identity.project, "Unknown project", "an unanswered lookup never names the launch directory");
  assert.equal(released, false, "the bound resolver call had not settled yet when the identity degraded");
});

test("a resolver that throws is treated as unconfirmed rather than fatal", async () => {
  const resolveRepository = async () => { throw new Error("git executable unavailable"); };
  const identity = await resolveSessionIdentity({ launchCwd: "/tmp/erroring", resolveRepository });
  assert.equal(identity.state, "unknown");
  assert.equal(identity.project, "Unknown project");
});

test("historical sessions after restart still resolve through the launch directory with no remembered proof", async () => {
  const resolveRepository = makeResolver({ "/repo/root": { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/root" } });
  // provenRepositories is empty, as it would be for an in-memory tracker that
  // has not yet re-observed this session's mutations since a restart.
  const identity = await resolveSessionIdentity({ launchCwd: "/repo/root/nested", provenRepositories: new Map(), resolveRepository });
  assert.equal(identity.state, "single");
  assert.equal(identity.repositoryId, "repo-aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(identity.project, "root");
});

test("a single proven repository skips the requireGit launch check entirely", async () => {
  let requireGitCalls = 0;
  const resolveRepository = makeResolver(
    { "/repo/launch": { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/launch" } },
    { onCall: (_cwd, options) => { if (options.requireGit) requireGitCalls += 1; } },
  );
  await resolveSessionIdentity({
    launchCwd: "/repo/launch",
    provenRepositories: [{ repositoryId: "repo-bbbbbbbbbbbbbbbbbbbbbbbb", root: "/repo/mutated" }],
    resolveRepository,
  });
  assert.equal(requireGitCalls, 0, "a proven single repository already answers the rule without a Git-recognition check");
});

test("a timed-out lookup from a nested repository subdirectory never names the subdirectory", async () => {
  const resolveRepository = () => new Promise((resolve) => { setTimeout(() => resolve({ repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/root" }), 200); });
  const identity = await resolveSessionIdentity({ launchCwd: "/repo/root/monitor/providers", recordedBranch: "main", resolveRepository, resolverTimeoutMs: 10 });
  assert.deepEqual(identity, { state: "unknown", repositoryId: null, project: "Unknown project", recordedBranch: null, root: null });
});

test("a non-Git launch directory names the project only when its basename is a safe display name", async () => {
  const resolveRepository = makeResolver({});
  const cases = [
    ["C:\\", "Unknown project"],
    ["\\\\?\\C:\\", "Unknown project"],
    ["\\\\fileserver\\", "Unknown project"],
    ["\\\\fileserver\\secret-share", "Unknown project"],
    ["C:\\Users\\someone\\.codex", "Unknown project"],
    [os.homedir(), "Unknown project"],
    [`/tmp/${"x".repeat(129)}`, "Unknown project"],
    ["/tmp/bad\u0007name", "Unknown project"],
    ["\\\\fileserver\\share\\scratch", "scratch"],
    ["/tmp/scratch-notes", "scratch-notes"],
  ];
  for (const [launchCwd, project] of cases) {
    const identity = await resolveSessionIdentity({ launchCwd, resolveRepository });
    assert.equal(identity.project, project, JSON.stringify(launchCwd));
    assert.equal(identity.repositoryId, null);
  }
});

test("the branch check's launch identity runs alongside the Git lookup, not after it", async () => {
  let inFlight = 0; let peak = 0;
  const inner = makeResolver({ "/repo/root": { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: "/repo/root" } });
  const resolveRepository = async (cwd, options) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return inner(cwd, options);
  };
  const identity = await resolveSessionIdentity({ launchCwd: "/repo/root", recordedBranch: "main", resolveRepository });
  assert.equal(identity.recordedBranch, "main");
  assert.equal(peak, 2);
});

test("the memoized resolver shares one call per launch directory, warms after a timeout, expires, and drops rejections", async () => {
  let calls = 0; let now = 0; let fail = false;
  const memo = memoizeRepositoryResolver(async (cwd) => { calls += 1; if (fail) throw new Error("x"); await new Promise((resolve) => setTimeout(resolve, 30)); return { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root: cwd }; }, { ttlMs: 1_000, now: () => now });
  const slow = await Promise.all([1, 2, 3].map(() => resolveSessionIdentity({ launchCwd: "/repo/root", resolveRepository: memo, resolverTimeoutMs: 5 })));
  assert.equal(calls, 1);
  assert.ok(slow.every((identity) => identity.project === "Unknown project"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await resolveSessionIdentity({ launchCwd: "/repo/root", resolveRepository: memo, resolverTimeoutMs: 5 })).project, "root", "the slow call warmed the next poll");
  assert.equal(calls, 1);
  now = 2_000; fail = true;
  await memo("/repo/root", { requireGit: true }).catch(() => {});
  assert.equal(calls, 2);
  fail = false;
  await memo("/repo/root", { requireGit: true });
  assert.equal(calls, 3, "a rejected call is not retained");
});

test("catalog-header identity never overwrites or demotes a full read's attribution", async () => {
  const tracker = createCodexRepositoryAttributionTracker();
  const root = "/repo/root";
  const resolveRepository = makeResolver({ [root]: { repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", root } });
  await tracker.resolveIdentity("s1", { launchCwd: root, recordedBranch: "feat/x", resolveRepository, bindings: new Map() });
  assert.equal(tracker.get("s1").recordedBranch, "feat/x");
  const header = await tracker.headerIdentity("s1", { launchCwd: root, resolveRepository });
  assert.deepEqual(header, { state: "single", repositoryId: "repo-aaaaaaaaaaaaaaaaaaaaaaaa", project: "root" });
  const hanging = () => new Promise(() => {});
  await tracker.headerIdentity("s1", { launchCwd: root, resolveRepository: hanging });
  assert.equal(tracker.get("s1").state, "single");
  assert.equal(tracker.get("s1").recordedBranch, "feat/x");
  const unseen = await tracker.headerIdentity("s2", { launchCwd: root, resolveRepository });
  assert.equal(unseen.project, "root");
  assert.equal(tracker.get("s2").state, "unknown", "a header lookup writes nothing");
});
