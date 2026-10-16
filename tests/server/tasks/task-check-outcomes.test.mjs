import assert from "node:assert/strict";
import test from "node:test";
import { readTaskCheckFacts } from "../../../server/runtime/task-session-lookup.mjs";
import { readPullRequests } from "../../../server/repository/pull-requests.mjs";
import { createSessionRepositoryEnrichment } from "../../../server/repository/session-repository-enrichment.mjs";
import { readChecks, verifyChecks } from "../../../server/tasks/task-checks.mjs";
import { TASK_CHECKS, normalizeStoredTask } from "../../../server/tasks/task-record.mjs";

// A report tells a condition that failed from one Pomegr could not verify (task T-90). The session of the report that
// showed the difference was launched on one branch and made its own task branch in the same checkout.

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const SESSION = "codex:0b8f2c1e-1111-4222-8333-444455556666";
const ROOT = "C:\\synthetic\\checkout";
const LAUNCH_BRANCH = "tasks/T-62";
const TASK_BRANCH = "tasks/T-64";
const PULL_URL = "https://github.com/PomegrHQ/pomegr/pull/197";
const HEAD_OID = "b".repeat(40);
const iso = (milliseconds) => new Date(milliseconds).toISOString();

const READ_AT = Object.freeze({ tree: 2000, branch: 2000, pullRequests: 2000, ci: 2000 });
const WORK_AT = Object.freeze({ tree: 1000, repository: 1000 });
const PASSING = Object.freeze({ treeClean: true, branchCommits: true, pullRequestStates: ["open", "merged"], ciPassed: true, readAt: READ_AT, workAt: WORK_AT });
const UNAVAILABLE = (check) => ({ check, passed: false, unavailable: true });
const FAILED = (check) => ({ check, passed: false });
const VERIFIED = TASK_CHECKS.filter((check) => check !== "user_validated");

test("a condition read after the work is passed or failed, and neither result is marked unavailable", () => {
  assert.deepEqual(verifyChecks(TASK_CHECKS, PASSING), VERIFIED.map((check) => ({ check, passed: true })));
  const failing = { ...PASSING, treeClean: false, branchCommits: false, pullRequestStates: ["closed"], ciPassed: false };
  assert.deepEqual(verifyChecks(TASK_CHECKS, failing), VERIFIED.map(FAILED));
  // A ready pull-request block that lists none is a known answer: no pull request is open or merged.
  assert.deepEqual(verifyChecks(["pr_open", "pr_merged"], { ...PASSING, pullRequestStates: [] }), [FAILED("pr_open"), FAILED("pr_merged")]);
});

test("a condition with no dated reading is unavailable, whatever value the fact holds", () => {
  for (const facts of [null, {}, { treeClean: null, branchCommits: null, pullRequestStates: null, ciPassed: null, readAt: READ_AT, workAt: WORK_AT }]) {
    assert.deepEqual(verifyChecks(TASK_CHECKS, facts), VERIFIED.map(UNAVAILABLE), JSON.stringify(facts));
  }
  // A passing or a failing value read before the work, or at no known time, says nothing about now.
  for (const value of [true, false]) {
    const facts = { ...PASSING, treeClean: value, branchCommits: value, ciPassed: value };
    assert.deepEqual(verifyChecks(["tree_clean", "commit_on_branch", "ci_passed"], { ...facts, workAt: { tree: 2001, repository: 2001 } }),
      ["tree_clean", "commit_on_branch", "ci_passed"].map(UNAVAILABLE), `stale ${value}`);
    assert.deepEqual(verifyChecks(["tree_clean"], { ...facts, workAt: { tree: Number.POSITIVE_INFINITY, repository: null } }), [UNAVAILABLE("tree_clean")], `running ${value}`);
    assert.deepEqual(verifyChecks(["tree_clean", "pr_open"], { ...facts, readAt: {} }), [UNAVAILABLE("pr_open"), UNAVAILABLE("tree_clean")], `undated ${value}`);
  }
});

test("a listed pull request of unknown state leaves the answer unavailable unless another one holds it", () => {
  const judged = (pullRequestStates) => verifyChecks(["pr_open", "pr_merged"], { ...PASSING, pullRequestStates });
  assert.deepEqual(judged(["unknown"]), [UNAVAILABLE("pr_open"), UNAVAILABLE("pr_merged")]);
  assert.deepEqual(judged(["unknown", "open"]), [{ check: "pr_open", passed: true }, UNAVAILABLE("pr_merged")]);
  assert.deepEqual(judged(["closed", "draft"]), [UNAVAILABLE("pr_open"), UNAVAILABLE("pr_merged")], "a malformed list is no reading");
});

test("the board's reading of a waiting task stays pass or fail only", () => {
  assert.deepEqual(readChecks(["pr_open", "tree_clean"], null), [FAILED("pr_open"), FAILED("tree_clean")]);
  assert.deepEqual(readChecks(["pr_open"], PASSING), [{ check: "pr_open", passed: true }]);
});

// The enrichment of a session bound to `ROOT` on its launch branch, whose working tree is on `branch` now.
function boundSession({ branch = TASK_BRANCH, root = ROOT, files = [], pulls = "passed" } = {}) {
  const jobs = [];
  const ghCalls = [];
  const rollup = { passed: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], pending: [{ __typename: "CheckRun", status: "IN_PROGRESS" }] };
  const enrichment = createSessionRepositoryEnrichment({
    gitReader: async () => ({ available: true, branch, files, isMain: false, commits: [], _repositoryRoot: root, _headOid: HEAD_OID,
      comparison: { branch: "origin/main", kind: "base", ahead: 1, behind: 0, integrated: false }, remote: { status: "ready", checkedAt: iso(Date.now()) } }),
    pullRequestReader: (creations, options) => readPullRequests(creations, { ...options, ghRunner: async (cwd, args) => {
      ghCalls.push(args);
      return JSON.stringify(pulls === "none" ? [] : [{ number: 197, state: "OPEN", url: PULL_URL, headRefName: TASK_BRANCH, headRefOid: HEAD_OID, statusCheckRollup: rollup[pulls] }]);
    } }),
    now: Date.now,
    cacheMs: 0,
    providerFolders: { folders: {} },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
  });
  const evidence = { session: { cwd: ROOT, recordedGitBranch: LAUNCH_BRANCH, startedAt: iso(0) }, pullRequestCreations: [], executionTasks: [] };
  const binding = { state: "single", repositoryId: REPOSITORY_ID, root: ROOT, fingerprint: "bound", recordedBranch: LAUNCH_BRANCH };
  const live = () => enrichment.liveEnrichment(SESSION, evidence, binding, (job) => jobs.push(job));
  return { enrichment, ghCalls, live, async settle() { live().enqueue?.(); while (jobs.length) await jobs.shift()(); return live(); } };
}

// The committed state the report is judged beside: the last Git command ended before the report arrived.
const committed = (value) => ({ get: () => ({ publicState: {
  session: { id: SESSION, repository: value.repository, pullRequests: value.pullRequests }, agents: [], activity: { items: [], total: 0 },
  executionTasks: [{ id: "tool-push", workKind: "git_push", status: "completed", finishedAt: iso(Date.now() - 60_000) }],
} }) });
const REPORTED = ["pr_open", "tree_clean", "ci_passed"];

test("a report from a session that left its launch branch is judged on the branch its checkout has", async () => {
  const session = boundSession();
  const shown = await session.settle();
  // The live check still refuses the other branch: the Repository tab says that the branch changed.
  assert.equal(shown.value.repository.available, false);
  assert.equal(session.enrichment.unavailableReasonForSession(SESSION), "branch_changed");
  const store = committed(shown.value);
  assert.deepEqual(verifyChecks(REPORTED, await readTaskCheckFacts(SESSION, { observationStore: store, readNow: null })), REPORTED.map(UNAVAILABLE),
    "without the report's read nothing is known, and nothing is called failed");

  const results = verifyChecks(REPORTED, await readTaskCheckFacts(SESSION, { observationStore: store, readNow: session.enrichment.readNow }));
  assert.deepEqual(results, REPORTED.map((check) => ({ check, passed: true })));
  assert.ok(session.ghCalls.some((args) => args.includes(TASK_BRANCH)) && !session.ghCalls.some((args) => args.includes(LAUNCH_BRANCH)), "the pull requests are those of the branch the checkout has");

  // The report's read is its own: it replaces nothing the session shows.
  assert.equal(session.live().value.repository.available, false);
  assert.equal(session.enrichment.repositoryRootForSession(SESSION), null);
  assert.equal(session.enrichment.unavailableReasonForSession(SESSION), "branch_changed");
});

test("that read reports a verified failure as failed", async () => {
  const dirty = boundSession({ files: [{ status: "modified", path: "src/a.mjs" }], pulls: "pending" });
  const pending = verifyChecks(REPORTED, await readTaskCheckFacts(SESSION, { observationStore: committed((await dirty.settle()).value), readNow: dirty.enrichment.readNow }));
  assert.deepEqual(pending, [{ check: "pr_open", passed: true }, FAILED("tree_clean"), UNAVAILABLE("ci_passed")]);

  const none = boundSession({ pulls: "none" });
  const absent = verifyChecks(REPORTED, await readTaskCheckFacts(SESSION, { observationStore: committed((await none.settle()).value), readNow: none.enrichment.readNow }));
  assert.deepEqual(absent, [FAILED("pr_open"), { check: "tree_clean", passed: true }, UNAVAILABLE("ci_passed")]);
});

test("a read that Git answers for another checkout verifies nothing", async () => {
  const session = boundSession({ root: "C:\\synthetic\\elsewhere" });
  const shown = await session.settle();
  assert.equal(await session.enrichment.readNow(SESSION), null);
  assert.deepEqual(verifyChecks(REPORTED, await readTaskCheckFacts(SESSION, { observationStore: committed(shown.value), readNow: session.enrichment.readNow })), REPORTED.map(UNAVAILABLE));
});

test("a session still on its recorded branch commits the report's read like any refresh", async () => {
  const session = boundSession({ branch: LAUNCH_BRANCH });
  const blocks = await session.enrichment.readNow(SESSION);
  assert.equal(blocks, null, "a session the monitor has not derived holds no binding to read");
  session.live();
  const read = await session.enrichment.readNow(SESSION);
  assert.equal(read.repository.branch, LAUNCH_BRANCH);
  assert.equal(session.live().value.repository.available, true);
  assert.equal(session.enrichment.unavailableReasonForSession(SESSION), null);
});

// A stored report row, as the task store reads it back.
const storedRow = (results) => ({
  repository_id: REPOSITORY_ID, number: 1, text: "Synthetic task", column_id: `col-${"0".repeat(11)}1`, position: 0, feature_id: null, step: null,
  run_provider: null, run_model: null, run_effort: null, checks: JSON.stringify(["pr_open", "tree_clean"]), own_condition: null,
  state: "needs_review", queue_position: null, scheduled_at: null, session_id: null, dispatch_token: null,
  report_at: 1_700_000_003_000, report_results: JSON.stringify(results), report_block_reason: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_003_000,
});

test("a stored result keeps the unavailable mark, and a pass never carries it", () => {
  const kept = normalizeStoredTask(storedRow([{ check: "pr_open", passed: true }, UNAVAILABLE("tree_clean")]));
  assert.deepEqual(kept.report.results, [{ check: "pr_open", passed: true }, UNAVAILABLE("tree_clean")]);
  // A row written before the mark existed reads as before.
  assert.deepEqual(normalizeStoredTask(storedRow([FAILED("pr_open")])).report.results, [FAILED("pr_open")]);
  for (const bad of [{ check: "pr_open", passed: true, unavailable: true }, { check: "pr_open", passed: false, unavailable: false }, { check: "pr_open", passed: false, unavailable: "yes" }]) {
    assert.equal(normalizeStoredTask(storedRow([bad])), undefined, JSON.stringify(bad));
  }
});
