import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizePullRequest, pullRequestUrls, readPullRequests } from "../monitor/pull-requests.mjs";
import { parseCodexPullRequestRecords } from "../monitor/providers/codex-pull-requests.mjs";

function bashCall(id, command) {
  return { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id, input: { command } }] } };
}

function toolResult(id, content, isError = false) {
  return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } };
}

test("associates only canonical PR URLs returned by successful PR creation tools", () => {
  const records = [
    bashCall("create-1", "gh pr create --title safe"),
    toolResult("create-1", "Created https://github.com/ThreadlightHQ/threadlight/pull/42"),
    bashCall("view-1", "gh pr view 99"),
    toolResult("view-1", "https://github.com/ThreadlightHQ/threadlight/pull/99"),
    bashCall("create-2", "gh pr create --title failed"),
    toolResult("create-2", "https://github.com/ThreadlightHQ/threadlight/pull/43", true),
  ];

  assert.deepEqual(pullRequestUrls(records), ["https://github.com/ThreadlightHQ/threadlight/pull/42"]);
  assert.doesNotMatch(JSON.stringify(pullRequestUrls(records)), /safe|failed|Created/);
});

test("normalizes bounded GitHub metadata without carrying extra fields", () => {
  const item = normalizePullRequest({
    number: 42,
    title: `Ship the drawer\n${"x".repeat(240)}`,
    state: "OPEN",
    url: "https://github.com/ThreadlightHQ/threadlight/pull/42",
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
    toolResult("create-1", "https://github.com/ThreadlightHQ/threadlight/pull/42"),
  ];
  const ghRunner = async (_cwd, args) => {
    if (args[1] === "view") return JSON.stringify({
      number: 42,
      title: "Created in session",
      state: "OPEN",
      url: "https://github.com/ThreadlightHQ/threadlight/pull/42",
      headRefName: "feature/pr-drawer",
      baseRefName: "main",
      additions: 10,
      deletions: 2,
    });
    return JSON.stringify([
      { number: 42, title: "Created in session", state: "OPEN", url: "https://github.com/ThreadlightHQ/threadlight/pull/42" },
      { number: 41, title: "Earlier branch PR", state: "CLOSED", url: "https://github.com/ThreadlightHQ/threadlight/pull/41" },
    ]);
  };

  const result = await readPullRequests(records, { cwd: "C:\\repo", branch: "feature/pr-drawer", historical: false, ghRunner });

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadlight-prs-"));
  const file = path.join(directory, "session.jsonl");
  context.after(() => rm(directory, { recursive: true, force: true }));
  const records = [
    bashCall("create-old", "gh pr create"),
    toolResult("create-old", "https://github.com/ThreadlightHQ/threadlight/pull/40"),
  ];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const result = await readPullRequests([], {
    cwd: directory,
    branch: "feature/history",
    historical: true,
    transcripts: [{ file, records: [] }],
    ghRunner: async () => JSON.stringify({
      number: 40,
      title: "Recovered from full history",
      state: "MERGED",
      mergedAt: "2026-08-10T12:00:00.000Z",
      url: "https://github.com/ThreadlightHQ/threadlight/pull/40",
    }),
  });

  assert.equal(result.items[0].number, 40);
  assert.equal(result.items[0].state, "merged");
  assert.equal(result.items[0].association, "session");
});

test("Codex emits provider-neutral events only for successful recognized PR creation results", async () => {
  const records = [
    { timestamp: "2026-08-11T18:00:00.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "create-1", arguments: JSON.stringify({ command: "gh pr create --title PRIVATE", cwd: "PRIVATE_PATH_MUST_NOT_LEAK" }) } },
    { timestamp: "2026-08-11T18:00:01.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "create-1", output: "TOOL_OUTPUT_MUST_NOT_LEAK https://github.com/ThreadlightHQ/threadlight/pull/52", exit_code: 0 } },
    { timestamp: "2026-08-11T18:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "view-1", arguments: JSON.stringify({ command: "gh pr view 53" }) } },
    { timestamp: "2026-08-11T18:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "view-1", output: "https://github.com/ThreadlightHQ/threadlight/pull/53" } },
    { timestamp: "2026-08-11T18:00:04.000Z", type: "response_item", payload: { type: "function_call", name: "mcp__github__create_pull_request", call_id: "create-failed", arguments: "{}" } },
    { timestamp: "2026-08-11T18:00:05.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "create-failed", output: "https://github.com/ThreadlightHQ/threadlight/pull/54", is_error: true } },
  ];
  const creations = parseCodexPullRequestRecords(records, { actorId: "primary", sourceKey: "fixture" });

  assert.equal(creations.length, 1);
  assert.deepEqual({ actorId: creations[0].actorId, timestamp: creations[0].timestamp, url: creations[0].url }, {
    actorId: "primary",
    timestamp: "2026-08-11T18:00:01.000Z",
    url: "https://github.com/ThreadlightHQ/threadlight/pull/52",
  });
  assert.doesNotMatch(JSON.stringify(creations), /PRIVATE|TOOL_OUTPUT|gh pr create/);

  const result = await readPullRequests([], {
    historical: true,
    sessionCreations: creations,
    ghRunner: async () => JSON.stringify({
      number: 52,
      title: "Created by Codex",
      state: "OPEN",
      url: "https://github.com/ThreadlightHQ/threadlight/pull/52",
    }),
  });
  assert.deepEqual(result.items.map(({ number, association }) => ({ number, association })), [{ number: 52, association: "session" }]);
});
