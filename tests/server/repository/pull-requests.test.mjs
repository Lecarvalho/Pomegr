import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCheckStatus, normalizePullRequest, pullRequestCheckRead, pullRequestCheckStatus, pullRequestUrls, readPullRequests } from "../../../server/repository/pull-requests.mjs";
import { pullRequestCreationEvents, readClaudePullRequestCreations } from "../../../server/providers/claude/pull-requests.mjs";
import { parseCodexPullRequestRecords } from "../../../server/providers/codex/pull-requests.mjs";

function bashCall(id, command) {
  return { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id, input: { command } }] } };
}

function toolResult(id, content, isError = false) {
  return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } };
}

test("associates only canonical PR URLs returned by successful PR creation tools", () => {
  const records = [
    bashCall("create-1", "gh pr create --title safe"),
    toolResult("create-1", "Created https://github.com/PomegrHQ/pomegr/pull/42"),
    bashCall("view-1", "gh pr view 99"),
    toolResult("view-1", "https://github.com/PomegrHQ/pomegr/pull/99"),
    bashCall("create-2", "gh pr create --title failed"),
    toolResult("create-2", "https://github.com/PomegrHQ/pomegr/pull/43", true),
  ];

  const creations = pullRequestCreationEvents(records);
  assert.deepEqual(pullRequestUrls(creations), ["https://github.com/PomegrHQ/pomegr/pull/42"]);
  assert.deepEqual(pullRequestUrls(records), [], "generic enrichment accepts normalized evidence, not Claude records");
  assert.doesNotMatch(JSON.stringify(pullRequestUrls(creations)), /safe|failed|Created/);
});

test("normalizes bounded GitHub metadata without carrying extra fields", () => {
  const item = normalizePullRequest({
    number: 42,
    title: `Ship the drawer\n${"x".repeat(240)}`,
    state: "OPEN",
    url: "https://github.com/PomegrHQ/pomegr/pull/42",
    headRefName: "feature/pr-drawer",
    baseRefName: "main",
    isDraft: true,
    additions: 447,
    deletions: 22,
    updatedAt: "2026-08-10T12:00:00.000Z",
    body: "PRIVATE BODY",
    author: { login: "PRIVATE AUTHOR" },
  });

  assert.equal(item.state, "open");
  assert.equal(item.draft, true);
  assert.equal(item.title.length, 180);
  assert.deepEqual(Object.keys(item), ["host", "repository", "number", "title", "url", "state", "draft", "headBranch", "baseBranch", "additions", "deletions", "updatedAt", "association"]);
  assert.doesNotMatch(JSON.stringify(item), /PRIVATE/);
});

test("combines transcript-created and current-branch PRs while preserving session association", async () => {
  const records = [
    bashCall("create-1", "gh pr create"),
    toolResult("create-1", "https://github.com/PomegrHQ/pomegr/pull/42"),
  ];
  const ghRunner = async (_cwd, args) => {
    if (args[1] === "view") return JSON.stringify({
      number: 42,
      title: "Created in session",
      state: "OPEN",
      url: "https://github.com/PomegrHQ/pomegr/pull/42",
      headRefName: "feature/pr-drawer",
      baseRefName: "main",
      additions: 10,
      deletions: 2,
    });
    return JSON.stringify([
      { number: 42, title: "Created in session", state: "OPEN", url: "https://github.com/PomegrHQ/pomegr/pull/42" },
      { number: 41, title: "Earlier branch PR", state: "CLOSED", url: "https://github.com/PomegrHQ/pomegr/pull/41" },
    ]);
  };

  const result = await readPullRequests([], {
    cwd: "C:\\repo",
    branch: "feature/pr-drawer",
    historical: false,
    sessionCreations: pullRequestCreationEvents(records),
    ghRunner,
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.items.map(({ number, association }) => ({ number, association })), [
    { number: 42, association: "session" },
    { number: 41, association: "branch" },
  ]);
});

test("historical sessions never infer PRs from the current branch", async () => {
  let branchLookup = false;
  const result = await readPullRequests([], {
    cwd: "C:\\repo",
    branch: "feature/old",
    historical: true,
    ghRunner: async () => { branchLookup = true; return "[]"; },
  });

  assert.equal(branchLookup, false);
  assert.deepEqual(result, { status: "ready", checkedAt: null, items: [] });
});

test("reconstructs session PR associations from the complete transcript", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-prs-"));
  const file = path.join(directory, "session.jsonl");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const records = [
    bashCall("create-old", "gh pr create"),
    toolResult("create-old", "https://github.com/PomegrHQ/pomegr/pull/40"),
  ];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const result = await readPullRequests([], {
    cwd: directory,
    branch: "feature/history",
    historical: true,
    sessionCreations: await readClaudePullRequestCreations([{ file, records: [] }]),
    ghRunner: async () => JSON.stringify({
      number: 40,
      title: "Recovered from full history",
      state: "MERGED",
      mergedAt: "2026-08-10T12:00:00.000Z",
      url: "https://github.com/PomegrHQ/pomegr/pull/40",
    }),
  });

  assert.equal(result.items[0].number, 40);
  assert.equal(result.items[0].state, "merged");
  assert.equal(result.items[0].association, "session");
});

test("Codex emits provider-neutral events only for successful recognized PR creation results", async () => {
  const records = [
    { timestamp: "2026-08-11T18:00:00.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "create-1", arguments: JSON.stringify({ command: "gh pr create --title PRIVATE", cwd: "PRIVATE_PATH_MUST_NOT_LEAK" }) } },
    { timestamp: "2026-08-11T18:00:01.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "create-1", output: "TOOL_OUTPUT_MUST_NOT_LEAK https://github.com/PomegrHQ/pomegr/pull/52", exit_code: 0 } },
    { timestamp: "2026-08-11T18:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "view-1", arguments: JSON.stringify({ command: "gh pr view 53" }) } },
    { timestamp: "2026-08-11T18:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "view-1", output: "https://github.com/PomegrHQ/pomegr/pull/53" } },
    { timestamp: "2026-08-11T18:00:04.000Z", type: "response_item", payload: { type: "function_call", name: "mcp__github__create_pull_request", call_id: "create-failed", arguments: "{}" } },
    { timestamp: "2026-08-11T18:00:05.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "create-failed", output: "https://github.com/PomegrHQ/pomegr/pull/54", is_error: true } },
  ];
  const creations = parseCodexPullRequestRecords(records, { actorId: "primary", sourceKey: "fixture" });

  assert.equal(creations.length, 1);
  assert.deepEqual({ actorId: creations[0].actorId, timestamp: creations[0].timestamp, url: creations[0].url }, {
    actorId: "primary",
    timestamp: "2026-08-11T18:00:01.000Z",
    url: "https://github.com/PomegrHQ/pomegr/pull/52",
  });
  assert.doesNotMatch(JSON.stringify(creations), /PRIVATE|TOOL_OUTPUT|gh pr create/);

  const result = await readPullRequests([], {
    historical: true,
    sessionCreations: creations,
    ghRunner: async () => JSON.stringify({
      number: 52,
      title: "Created by Codex",
      state: "OPEN",
      url: "https://github.com/PomegrHQ/pomegr/pull/52",
    }),
  });
  assert.deepEqual(result.items.map(({ number, association }) => ({ number, association })), [{ number: 52, association: "session" }]);
});

const run = (status, conclusion = null) => ({ __typename: "CheckRun", name: "PRIVATE NAME", detailsUrl: "https://example.invalid/PRIVATE", status, conclusion });
const context = (state) => ({ __typename: "StatusContext", context: "PRIVATE CONTEXT", targetUrl: "https://example.invalid/PRIVATE", state });

test("normalizes the check rollup to one fixed aggregate status", () => {
  assert.equal(normalizeCheckStatus([]), "none");
  assert.equal(normalizeCheckStatus([run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED"), run("COMPLETED", "NEUTRAL"), context("SUCCESS")]), "passed");
  for (const status of ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]) assert.equal(normalizeCheckStatus([run("COMPLETED", "SUCCESS"), run(status)]), "pending", status);
  for (const state of ["PENDING", "EXPECTED"]) assert.equal(normalizeCheckStatus([context("SUCCESS"), context(state)]), "pending", state);
  for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]) {
    assert.equal(normalizeCheckStatus([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS"), run("COMPLETED", conclusion)]), "failed", conclusion);
  }
  for (const state of ["FAILURE", "ERROR"]) assert.equal(normalizeCheckStatus([context("PENDING"), context(state)]), "failed", state);
});

test("a missing, oversized, or unrecognized check rollup is unknown, never a status", () => {
  for (const rollup of [
    undefined, null, "SUCCESS", {}, 1,
    [null], [{}], ["SUCCESS"],
    [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    [run("COMPLETED", "SUCCESS"), run("COMPLETED", "MADE_UP")],
    [run("COMPLETED")],
    [run("MADE_UP")],
    [context("MADE_UP")],
    Array.from({ length: 201 }, () => run("COMPLETED", "SUCCESS")),
  ]) assert.equal(normalizeCheckStatus(rollup), null, JSON.stringify(rollup)?.slice(0, 80));
});

test("the check status is read with the pull request and kept out of the normalized item", async () => {
  const url = (number) => `https://github.com/PomegrHQ/pomegr-checks/pull/${number}`;
  const fields = [];
  const ghRunner = (rollups) => async (_cwd, args) => {
    fields.push(args.at(-1));
    if (args[1] === "view") return JSON.stringify({ number: 7, state: "OPEN", url: url(7), headRefName: "tasks/13", statusCheckRollup: rollups[7] });
    return JSON.stringify([
      { number: 7, state: "OPEN", url: url(7), headRefName: "tasks/13", statusCheckRollup: rollups[7] },
      { number: 6, state: "MERGED", mergedAt: "2026-10-01T00:00:00Z", url: url(6), headRefName: "tasks/13", statusCheckRollup: rollups[6] },
    ]);
  };
  const read = (rollups) => readPullRequests([], { cwd: "C:\\repo", branch: "tasks/13", sessionCreations: [{ url: url(7) }], ghRunner: ghRunner(rollups) });

  assert.equal(pullRequestCheckStatus(url(7)), null);
  const result = await read({ 7: [run("IN_PROGRESS")], 6: [run("COMPLETED", "SUCCESS")] });
  assert.ok(fields.every((value) => value.endsWith(",statusCheckRollup")));
  assert.equal(pullRequestCheckStatus(url(7)), "pending");
  assert.equal(pullRequestCheckStatus(url(6)), "passed");
  assert.deepEqual(result.items.map((item) => item.number), [7, 6]);
  assert.doesNotMatch(JSON.stringify(result), /statusCheckRollup|passed|pending|PRIVATE/u);
  assert.deepEqual(Object.keys(result), ["status", "checkedAt", "items"]);

  // The newest read replaces the status; a read that does not establish one clears it.
  await read({ 7: [run("COMPLETED", "FAILURE")], 6: [] });
  assert.equal(pullRequestCheckStatus(url(7)), "failed");
  assert.equal(pullRequestCheckStatus(url(6)), "none");
  await read({ 7: [run("MADE_UP")] });
  assert.equal(pullRequestCheckStatus(url(7)), null);
  assert.equal(pullRequestCheckStatus(url(6)), null);
  for (const value of [undefined, null, 7, "", "https://example.invalid/pull/7"]) assert.equal(pullRequestCheckStatus(value), null);
});

test("a check status keeps the time of the read that established it, and a read that establishes nothing clears it", async () => {
  const url = "https://github.com/PomegrHQ/pomegr-checks/pull/21";
  const ghRunner = (rollup) => async () => JSON.stringify([{ number: 21, state: "OPEN", url, headRefName: "tasks/21", statusCheckRollup: rollup }]);
  const read = (rollup) => readPullRequests([], { cwd: "C:\\repo", branch: "tasks/21", ghRunner: ghRunner(rollup) });

  assert.equal(pullRequestCheckRead(url), null);
  const before = Date.now();
  await read([run("COMPLETED", "SUCCESS")]);
  const after = Date.now();
  const first = pullRequestCheckRead(url);
  assert.deepEqual(Object.keys(first), ["status", "readAt"]);
  assert.equal(first.status, "passed");
  assert.ok(Number.isSafeInteger(first.readAt) && first.readAt >= before && first.readAt <= after, `${first.readAt} in ${before}..${after}`);
  assert.equal(pullRequestCheckStatus(url), "passed");

  // A lookup never renews the time, and the caller cannot change what is held.
  const heldAt = first.readAt;
  first.readAt = 0;
  first.status = "failed";
  assert.deepEqual(pullRequestCheckRead(url), { status: "passed", readAt: heldAt });
  assert.deepEqual(pullRequestCheckRead(url), { status: "passed", readAt: heldAt });

  // A newer read replaces both the status and the time.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await read([run("IN_PROGRESS")]);
  const second = pullRequestCheckRead(url);
  assert.equal(second.status, "pending");
  assert.ok(second.readAt > heldAt, `${second.readAt} after ${heldAt}`);

  // A read that establishes no status clears the entry, time included.
  await read([run("MADE_UP")]);
  assert.equal(pullRequestCheckRead(url), null);
  assert.equal(pullRequestCheckStatus(url), null);
  for (const value of [undefined, null, 21, "", "https://example.invalid/pull/21"]) assert.equal(pullRequestCheckRead(value), null);
});

test("at most 256 check statuses are held, the oldest read first out", async () => {
  const url = (number) => `https://github.com/PomegrHQ/pomegr-bound/pull/${number}`;
  const items = Array.from({ length: 300 }, (_, index) => ({ number: index + 1, state: "OPEN", url: url(index + 1), headRefName: "tasks/bound", statusCheckRollup: [run("COMPLETED", "SUCCESS")] }));
  await readPullRequests([], { cwd: "C:\\repo", branch: "tasks/bound", ghRunner: async () => JSON.stringify(items) });

  assert.equal(pullRequestCheckRead(url(300))?.status, "passed");
  assert.equal(pullRequestCheckRead(url(45))?.status, "passed");
  assert.equal(pullRequestCheckRead(url(44)), null);
  assert.equal(pullRequestCheckRead(url(1)), null);
  assert.equal(pullRequestCheckStatus(url(44)), null);
});

test("a gh that cannot read checks still answers the pull request, with an unknown check status", async () => {
  const url = "https://github.com/PomegrHQ/pomegr-checks/pull/9";
  const calls = [];
  const result = await readPullRequests([], {
    cwd: "C:\\repo",
    branch: "tasks/no-checks",
    ghRunner: async (_cwd, args) => {
      calls.push(args.at(-1));
      return args.at(-1).includes("statusCheckRollup") ? null : JSON.stringify([{ number: 9, state: "OPEN", url, headRefName: "tasks/no-checks" }]);
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0], `${calls[1]},statusCheckRollup`);
  assert.deepEqual(result.items.map(({ number, state }) => ({ number, state })), [{ number: 9, state: "open" }]);
  assert.equal(pullRequestCheckStatus(url), null);
});
