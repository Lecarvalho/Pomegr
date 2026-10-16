import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexExecutionTaskRecords } from "../../../server/providers/codex/execution-tasks.mjs";
import { createSessionRepositoryEnrichment, serializeServedSessionState } from "../../../server/repository/session-repository-enrichment.mjs";
import { pullRequestCheckRead, readPullRequests } from "../../../server/repository/pull-requests.mjs";
import { readTaskCheckFacts, resolveTaskCheckFacts } from "../../../server/runtime/task-session-lookup.mjs";
import { verifyChecks } from "../../../server/tasks/task-checks.mjs";

const SESSION = "codex:14400000-0000-4000-8000-000000000001";
const CLAUDE_SESSION = "claude:14400000-0000-4000-8000-000000000002";
const ROOT = "C:\\synthetic\\task-ci-evidence";
const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const BRANCH = "tasks/T-144";
const URL = "https://github.com/PomegrHQ/pomegr/pull/144";
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const timestamp = (milliseconds) => new Date(milliseconds).toISOString();
const now = () => Date.now();

function codexCodeModeTasks({ finishedAt = null } = {}) {
  const calledAt = "2026-10-16T14:02:20.000Z";
  const resultAt = finishedAt || "2026-10-16T14:02:27.842Z";
  const records = [
    { type: "response_item", timestamp: calledAt, payload: {
      type: "custom_tool_call", name: "exec", call_id: "exec-pr-and-report",
      input: 'const result = await tools.exec_command({ cmd: "gh pr edit 144 --title synthetic" }); text(result); text(await tools.mcp__pomegr__complete_task({}));',
    } },
  ];
  if (finishedAt) records.push({ type: "response_item", timestamp: resultAt, payload: {
    type: "custom_tool_call_output", call_id: "exec-pr-and-report", output: [
      { type: "input_text", text: "Script completed" },
      { type: "input_text", text: "Exit code: 0" },
    ],
  } });
  return parseCodexExecutionTaskRecords(records);
}

function checkRollup(kind) {
  if (kind === "missing") return undefined;
  if (kind === "none") return [];
  if (kind === "pending") return [{ __typename: "CheckRun", status: "IN_PROGRESS" }];
  const conclusion = kind === "failed" ? "FAILURE" : "SUCCESS";
  return [{ __typename: "CheckRun", status: "COMPLETED", conclusion }];
}

function scenario({ provider = "codex", headOid = HEAD, prHeadOid = HEAD, prBranch = BRANCH, checks = "passed", includePull = true } = {}) {
  const jobs = [];
  let failPullRequests = false;
  const evidence = {
    session: { cwd: ROOT, recordedGitBranch: BRANCH, startedAt: timestamp(Date.now() - 60_000) },
    pullRequestCreations: [],
    executionTasks: [],
  };
  const attribution = { state: "single", repositoryId: REPOSITORY_ID, root: ROOT, fingerprint: `${provider}:${ROOT}`, recordedBranch: BRANCH };
  const pullRequestReader = (creations, options) => readPullRequests(creations, {
    ...options,
    ghRunner: async (_cwd, args) => {
      if (failPullRequests) throw new Error("synthetic GitHub read failure");
      const fields = args.at(-1);
      if (args[1] === "list") {
        if (!includePull) return "[]";
        return JSON.stringify([{
          number: 144, state: "OPEN", url: URL, headRefName: prBranch, headRefOid: prHeadOid,
          ...(fields.includes("statusCheckRollup") && checks !== "missing" ? { statusCheckRollup: checkRollup(checks) } : {}),
        }]);
      }
      if (!includePull) return "{}";
      return JSON.stringify({
        number: 144, state: "OPEN", url: URL, headRefName: prBranch, headRefOid: prHeadOid,
        ...(fields.includes("statusCheckRollup") && checks !== "missing" ? { statusCheckRollup: checkRollup(checks) } : {}),
      });
    },
  });
  const enrichment = createSessionRepositoryEnrichment({
    gitReader: async () => ({
      available: true, branch: BRANCH, files: [], isMain: false, commits: [], _repositoryRoot: ROOT, _headOid: headOid,
      comparison: { branch: "origin/main", kind: "base", ahead: 1, behind: 0, integrated: false },
      remote: { status: "ready", checkedAt: timestamp(Date.now()) },
    }),
    pullRequestReader,
    now,
    cacheMs: 0,
    providerFolders: { folders: {} },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
  });
  const sessionId = provider === "claude" ? CLAUDE_SESSION : SESSION;
  const live = () => enrichment.liveEnrichment(sessionId, evidence, attribution, (job) => jobs.push(job));
  const state = { session: { id: sessionId }, executionTasks: evidence.executionTasks, agents: [], activity: { items: [], total: 0 } };
  const store = { get: () => ({ publicState: state }) };
  async function settle() {
    const pending = live();
    pending.enqueue?.();
    while (jobs.length) await jobs.shift()();
    state.session = { ...state.session, ...live().value };
    return live().value;
  }
  return { enrichment, evidence, live, settle, state, store, sessionId, failPullRequestReads() { failPullRequests = true; } };
}

test("Codex code-mode completion can verify CI on the exact checkout revision while its enclosing shell is still running", async () => {
  const session = scenario();
  session.evidence.executionTasks = codexCodeModeTasks();
  const shell = session.evidence.executionTasks[0];
  assert.equal(shell.workKind, "pull_request");
  assert.equal(shell.status, "running");
  session.state.executionTasks = session.evidence.executionTasks;

  await session.settle();
  const served = serializeServedSessionState(session.state);
  assert.doesNotMatch(served, /headOid|checkReads|[a-f]{40}/i, "checkout and check revision evidence stay monitor-private");
  const boardFacts = resolveTaskCheckFacts(SESSION, { observationStore: session.store });
  assert.deepEqual(verifyChecks(["ci_passed"], boardFacts), [{ check: "ci_passed", passed: false, unavailable: true }],
    "the waiting board keeps its age rule while the enclosing exec cell is running");

  const reportFacts = await readTaskCheckFacts(SESSION, { observationStore: session.store, readNow: session.enrichment.readNow });
  assert.equal(reportFacts.ciRevisionVerified, true);
  assert.deepEqual(verifyChecks(["ci_passed"], reportFacts), [{ check: "ci_passed", passed: true }]);
});

test("Claude completion uses the same exact-revision CI evidence", async () => {
  const session = scenario({ provider: "claude" });
  session.evidence.executionTasks = [{ id: "gh-pr", workKind: "pull_request", status: "completed", finishedAt: timestamp(Date.now() - 1_000) }];
  session.state.executionTasks = session.evidence.executionTasks;
  await session.settle();
  const reportFacts = await readTaskCheckFacts(CLAUDE_SESSION, { observationStore: session.store, readNow: session.enrichment.readNow });
  assert.equal(reportFacts.ciRevisionVerified, true);
  assert.deepEqual(verifyChecks(["ci_passed"], reportFacts), [{ check: "ci_passed", passed: true }]);
});

test("CI evidence distinguishes a verified failure from pending, absent, and missing checks", async () => {
  for (const [checks, expected] of [["failed", false], ["pending", "unavailable"], ["none", "unavailable"], ["missing", "unavailable"]]) {
    const session = scenario({ checks });
    await session.settle();
    const facts = await readTaskCheckFacts(SESSION, { observationStore: session.store, readNow: session.enrichment.readNow });
    const result = verifyChecks(["ci_passed"], facts);
    assert.deepEqual(result, expected === "unavailable"
      ? [{ check: "ci_passed", passed: false, unavailable: true }]
      : [{ check: "ci_passed", passed: expected }], checks);
  }
});

test("no pull request, a branch mismatch, or a different head revision leaves CI unavailable", async () => {
  const noPull = scenario({ includePull: false });
  await noPull.settle();
  const noPullFacts = await readTaskCheckFacts(SESSION, { observationStore: noPull.store, readNow: noPull.enrichment.readNow });
  assert.deepEqual(verifyChecks(["ci_passed"], noPullFacts), [{ check: "ci_passed", passed: false, unavailable: true }]);

  for (const session of [scenario({ prBranch: "tasks/other" }), scenario({ prHeadOid: OTHER_HEAD }), scenario({ headOid: OTHER_HEAD, prHeadOid: HEAD })]) {
    await session.settle();
    const facts = await readTaskCheckFacts(SESSION, { observationStore: session.store, readNow: session.enrichment.readNow });
    assert.notEqual(facts.ciRevisionVerified, true);
    assert.deepEqual(verifyChecks(["ci_passed"], facts), [{ check: "ci_passed", passed: false, unavailable: true }]);
  }
});

test("a delayed older pull-request refresh cannot replace the newer revision-bound check read", async () => {
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const old = readPullRequests([], {
    cwd: ROOT, branch: BRANCH, fresh: true,
    ghRunner: async (_cwd, args) => {
      if (args[1] === "list") await oldGate;
      return JSON.stringify([{
        number: 144, state: "OPEN", url: URL, headRefName: BRANCH, headRefOid: OTHER_HEAD,
        ...(args.at(-1).includes("statusCheckRollup") ? { statusCheckRollup: checkRollup("failed") } : {}),
      }]);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 3));
  const current = await readPullRequests([], {
    cwd: ROOT, branch: BRANCH, fresh: true,
    ghRunner: async (_cwd, args) => JSON.stringify([{
      number: 144, state: "OPEN", url: URL, headRefName: BRANCH, headRefOid: HEAD,
      ...(args.at(-1).includes("statusCheckRollup") ? { statusCheckRollup: checkRollup("passed") } : {}),
    }]),
  });
  releaseOld();
  await old;

  const snapshot = current.checkReads?.find((read) => read.url === URL);
  assert.deepEqual(snapshot && { headOid: snapshot.headOid, status: snapshot.status }, { headOid: HEAD, status: "passed" });
  const held = pullRequestCheckRead(URL);
  assert.equal(held?.status, "passed", "late older evidence must not replace the current URL-level fallback");
});

test("a failed fresh pull-request read is unavailable for the report while live state retains its prior good block", async () => {
  const session = scenario();
  await session.settle();
  const lastKnownGood = session.live().value.pullRequests;
  assert.equal(lastKnownGood.status, "ready");
  assert.equal(lastKnownGood.checkReads[0].status, "passed");

  session.failPullRequestReads();
  const fresh = await session.enrichment.readNow(SESSION);
  assert.equal(fresh.pullRequests.status, "unavailable");
  const facts = await readTaskCheckFacts(SESSION, { observationStore: session.store, readNow: async () => fresh });
  assert.deepEqual(verifyChecks(["ci_passed"], facts), [{ check: "ci_passed", passed: false, unavailable: true }]);
  assert.doesNotMatch(JSON.stringify(facts), /PomegrHQ|headOid|checkReads|statusCheckRollup|[a-f]{40}/i);

  assert.deepEqual(session.live().value.pullRequests, lastKnownGood,
    "the committed live view retains its prior good PR evidence without substituting it into the report");
});

