import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitReadFailure, readGitState, readGitStateAsync } from "../../../server/repository/git-state.mjs";
import { createSessionRepositoryEnrichment, liveRepositoryReadiness } from "../../../server/repository/session-repository-enrichment.mjs";
import { resolveSessionIdentity } from "../../../server/normalize/session-identity.mjs";
import { createCodexRepositoryAttributionTracker } from "../../../server/providers/codex/repository-attribution.mjs";
import { projectSessionDomains } from "../../../server/sessions/domain/session-domain-projection.mjs";
import { createEmptyMonitorState } from "../../../shared/monitor-state.mjs";

// T-194: a session page showed "Not a Git repository" for a Codex task session that ran in a
// Git checkout. Each layer is tested here: the Git reader, the Codex attribution, enrichment and
// readiness, and the served session domains. The UI is in tests/ui/repository-unavailable.test.tsx.

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const PLACEHOLDER = () => ({ available: false, branch: "", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } });
const NO_PULL_REQUESTS = () => ({ status: "unavailable", checkedAt: null, items: [] });

function gitRead(root, branch) {
  return { available: true, branch, files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null }, _repositoryRoot: root, _headOid: "a".repeat(40) };
}

function enrichmentFixture(gitReader) {
  const jobs = [];
  const enrichment = createSessionRepositoryEnrichment({
    gitReader, pullRequestReader: async () => NO_PULL_REQUESTS(), now: () => 10_000, cacheMs: 2_500,
    providerFolders: { folders: {} }, unavailableGitState: PLACEHOLDER, unavailablePullRequests: NO_PULL_REQUESTS,
  });
  const evidence = (cwd, recordedGitBranch = "") => ({ session: { cwd, recordedGitBranch, startedAt: new Date(0).toISOString() }, pullRequestCreations: [], executionTasks: [] });
  async function settle(sessionId, sessionEvidence, attribution) {
    enrichment.liveEnrichment(sessionId, sessionEvidence, attribution, (task) => jobs.push(task)).enqueue?.();
    while (jobs.length) await jobs.shift()();
    const live = enrichment.liveEnrichment(sessionId, sessionEvidence, attribution, (task) => jobs.push(task));
    return { ...live, readiness: liveRepositoryReadiness({ available: live.value.repository.available, check: live.check }), reason: enrichment.unavailableReasonForSession(sessionId) };
  }
  return { settle, evidence };
}

// --- Git reader -------------------------------------------------------------------------------

test("the Git reader names a confirmed non-repository folder and never puts a placeholder in its branch", async (context) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pomegr not a repository -"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const asynchronous = await readGitStateAsync(folder);
  assert.equal(asynchronous.available, false);
  assert.equal(asynchronous.branch, "");
  assert.equal(asynchronous._unavailable, "not_repository");
  const synchronous = readGitState(folder);
  assert.equal(synchronous.branch, "");
  assert.equal(synchronous._unavailable, "not_repository");
});

test("a repository with no commit is a failed read, not a non-repository", async (context) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pomegr empty repository -"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", folder], { stdio: "ignore" });
  const state = await readGitStateAsync(folder);
  assert.equal(state.available, false);
  assert.equal(state._unavailable, "failed");
});

test("a failed Git call maps to one fixed reason, judged on Git's diagnostic and never on its command line", () => {
  assert.equal(gitReadFailure(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })), "git_missing");
  assert.equal(gitReadFailure(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stderr: "" })), "timeout");
  assert.equal(gitReadFailure(Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" })), "timeout");
  assert.equal(gitReadFailure(Object.assign(new Error("Command failed"), { code: 128, stderr: "fatal: detected dubious ownership in repository at 'C:/x'" })), "refused");
  assert.equal(gitReadFailure(Object.assign(new Error("Command failed"), { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" })), "not_repository");
  // The command line names safe.directory and could name any path; only stderr is read.
  assert.equal(gitReadFailure(Object.assign(new Error("Command failed: git -c safe.directory=C:/not a git repository"), { code: 128, stderr: "fatal: ambiguous argument 'HEAD'" })), "failed");
  assert.equal(gitReadFailure(undefined), "failed");
});

// --- Enrichment and readiness -----------------------------------------------------------------

test("(a) an unbound session serves no branch: its placeholder is empty and its check has nothing to confirm", async () => {
  let reads = 0;
  const { settle, evidence } = enrichmentFixture(async () => { reads += 1; return PLACEHOLDER(); });
  const live = await settle("codex:unbound", evidence("C:\\synthetic\\folder"), { state: "unknown" });
  assert.equal(reads, 0, "no binding, no Git read");
  assert.equal(live.check, "none");
  assert.equal(live.value.repository.branch, "");
  assert.equal(live.reason, null);
});

for (const reason of ["timeout", "git_missing", "refused", "failed"]) {
  test(`(b) a bound session whose Git read failed (${reason}) keeps that reason, not "Not a Git repository"`, async () => {
    const root = "C:\\synthetic\\bound";
    const { settle, evidence } = enrichmentFixture(async () => ({ ...PLACEHOLDER(), _unavailable: reason }));
    const live = await settle("codex:failed", evidence(root, "main"), { state: "single", repositoryId: REPOSITORY_ID, root, fingerprint: "f", recordedBranch: "main" });
    assert.equal(live.check, "confirmed");
    assert.equal(live.readiness, "unavailable");
    assert.equal(live.reason, reason);
    assert.equal(live.value.repository.branch, "");
    assert.equal(Object.hasOwn(live.value.repository, "_unavailable"), false);
  });
}

test("(c) a bound session whose folder Git confirmed is not a repository keeps not_repository", async () => {
  const root = "C:\\synthetic\\removed-git";
  const { settle, evidence } = enrichmentFixture(async () => ({ ...PLACEHOLDER(), _unavailable: "not_repository" }));
  const live = await settle("codex:not-repository", evidence(root, "main"), { state: "single", repositoryId: REPOSITORY_ID, root, fingerprint: "f", recordedBranch: "main" });
  assert.equal(live.readiness, "unavailable");
  assert.equal(live.reason, "not_repository");
});

test("a branch change keeps its own reason ahead of any read reason", async () => {
  const root = "C:\\synthetic\\moved";
  const { settle, evidence } = enrichmentFixture(async (cwd) => gitRead(cwd, "other"));
  const live = await settle("codex:moved", evidence(root, "main"), { state: "single", repositoryId: REPOSITORY_ID, root, fingerprint: "f", recordedBranch: "main" });
  assert.equal(live.reason, "branch_changed");
});

// --- Codex attribution to binding -------------------------------------------------------------

function resolver(roots) {
  return async (cwd, options = {}) => {
    for (const [prefix, target] of Object.entries(roots)) {
      if (cwd === prefix || cwd.startsWith(`${prefix}\\`)) return { ...target, ...(options.requireGit ? { recognized: true } : {}) };
    }
    return options.requireGit ? null : { repositoryId: `adhoc:${cwd}`, root: cwd };
  };
}

test("T-341: a Codex task session launched in the repository root that works in a worktree it made binds to that worktree and shows its branch", async () => {
  const main = "C:\\synthetic\\Clapline";
  const worktree = "C:\\synthetic\\Clapline-t341";
  const tracker = createCodexRepositoryAttributionTracker();
  const resolveRepository = resolver({
    [worktree]: { repositoryId: REPOSITORY_ID, root: worktree, mainRoot: main },
    [main]: { repositoryId: REPOSITORY_ID, root: main, mainRoot: main },
  });
  // Codex recorded the launch checkout's branch; the session's edits prove the worktree.
  await tracker.resolveIdentity("thread-t341", {
    launchCwd: main, recordedBranch: "feat/t328-roughs-in-app", resolveRepository,
    bindings: new Map([[REPOSITORY_ID, { repositoryId: REPOSITORY_ID, root: worktree, mainRoot: main }]]),
  });
  const attribution = tracker.get("thread-t341");
  assert.equal(attribution.root, worktree);
  assert.equal(attribution.recordedBranch, null, "the launch checkout's branch does not name the worktree");
  assert.equal(attribution.anyBranch, true);

  const roots = [];
  const { settle, evidence } = enrichmentFixture(async (cwd) => { roots.push(cwd); return gitRead(cwd, "feat/t341-roughs-api"); });
  const live = await settle("codex:thread-t341", evidence(main, ""), attribution);
  assert.deepEqual(roots, [worktree]);
  assert.equal(live.readiness, "ready");
  assert.equal(live.value.repository.available, true);
  assert.equal(live.value.repository.branch, "feat/t341-roughs-api");
});

test("(d) a Codex task session started in a Pomegr task worktree binds on its recorded branch and shows it", async () => {
  const main = "C:\\synthetic\\Clapline";
  const worktree = `${main}\\.pomegr\\worktrees\\T-7`;
  const tracker = createCodexRepositoryAttributionTracker();
  const resolveRepository = resolver({
    [worktree]: { repositoryId: REPOSITORY_ID, root: worktree, mainRoot: main },
    [main]: { repositoryId: REPOSITORY_ID, root: main, mainRoot: main },
  });
  await tracker.resolveIdentity("thread-t7", {
    launchCwd: worktree, recordedBranch: "tasks/T-7", resolveRepository,
    bindings: new Map([[REPOSITORY_ID, { repositoryId: REPOSITORY_ID, root: worktree, mainRoot: main }]]),
  });
  const attribution = tracker.get("thread-t7");
  assert.equal(attribution.root, worktree);
  assert.equal(attribution.recordedBranch, "tasks/T-7");
  assert.equal(Object.hasOwn(attribution, "anyBranch"), false, "a verified branch keeps the branch-change check");

  const { settle, evidence } = enrichmentFixture(async (cwd) => gitRead(cwd, "tasks/T-7"));
  const live = await settle("codex:thread-t7", evidence(worktree, "tasks/T-7"), attribution);
  assert.equal(live.readiness, "ready");
  assert.equal(live.value.repository.branch, "tasks/T-7");
});

test("an unanswered branch check leaves the binding undecided instead of reading any branch", async () => {
  // The launch lookup never answers within the bound; the proven worktree needs no lookup.
  const identity = await resolveSessionIdentity({
    launchCwd: "C:\synthetic\slow", recordedBranch: "main", resolveRepository: () => new Promise(() => {}), resolverTimeoutMs: 10,
    provenRepositories: [{ repositoryId: REPOSITORY_ID, root: "C:\synthetic\slow-wt", mainRoot: "C:\synthetic\slow" }],
  });
  assert.equal(identity.state, "single");
  assert.equal(identity.recordedBranch, null);
  assert.equal(Object.hasOwn(identity, "anyBranch"), false);
});

// --- Served session domains -------------------------------------------------------------------

function snapshot(repository, readiness = "ready") {
  const base = createEmptyMonitorState({ connected: true, source: "Codex", view: "live" });
  const publicState = {
    ...base,
    session: {
      id: "codex:served", title: "Served", project: "Clapline", startedAt: null, updatedAt: null, durationMs: 0, cost: null, summary: null, progress: null,
      pomegrPlugin: null, signal: null, repositoryId: REPOSITORY_ID, contextInventoryRef: null, repository, pullRequests: NO_PULL_REQUESTS(),
    },
    readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: readiness, resources: "ready", usageLimits: "ready" },
  };
  return { publicState, readiness: publicState.readiness, observedAt: null, evidence: { toolCalls: [] } };
}

test("the served summary names no branch for an unavailable repository, and carries the live check's reason", () => {
  const placeholder = { ...PLACEHOLDER(), branch: "Not a Git repository", historical: false };
  const unbound = projectSessionDomains("codex:served", snapshot(placeholder, "ready")).domains;
  assert.equal(unbound.get("session-summary").repository.branch, null, "even an old placeholder is not a branch");
  assert.equal(unbound.get("session-summary").repository.unavailableReason, null);
  assert.equal(unbound.get("repository").unavailableReason, null);

  for (const reason of ["not_repository", "timeout", "git_missing", "refused", "failed", "branch_changed"]) {
    const { domains } = projectSessionDomains("codex:served", snapshot({ ...PLACEHOLDER(), historical: false }, "unavailable"), { repositoryUnavailableReason: reason });
    assert.equal(domains.get("session-summary").repository.unavailableReason, reason);
    assert.equal(domains.get("repository").unavailableReason, reason);
  }
  const unknown = projectSessionDomains("codex:served", snapshot({ ...PLACEHOLDER(), historical: false }, "unavailable"), { repositoryUnavailableReason: "C:\\private\\path" }).domains;
  assert.equal(unknown.get("repository").unavailableReason, null, "only a fixed code is served");

  const shown = projectSessionDomains("codex:served", snapshot({ ...gitRead("C:\\x", "main"), historical: false }), { repositoryUnavailableReason: "timeout" }).domains;
  assert.equal(shown.get("session-summary").repository.branch, "main");
  assert.equal(shown.get("session-summary").repository.unavailableReason, null, "a shown repository keeps its last known-good value and no reason");
});
