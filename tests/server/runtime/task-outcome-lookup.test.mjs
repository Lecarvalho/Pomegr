import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createTaskLookups } from "../../../server/runtime/task-start-lookup.mjs";
import { serveTaskActionRoute } from "../../../server/serving/task-routes.mjs";
import { readTaskOutcome } from "../../../server/tasks/task-outcomes.mjs";
import { createMonitorRuntime } from "../../../server/server.mjs";
import { FACTS, openTemporaryStore, passingGates, REPOSITORY, SESSION, withDatabase } from "../tasks/queue-test-support.mjs";

const SECOND = "codex:019a0000-2222-7333-8444-555566667777";
const SINCE = Date.parse("2026-10-24T12:00:00Z");
const BEFORE = "2026-10-24T11:59:59Z";
const AT = "2026-10-24T12:00:00Z";
const AFTER = "2026-10-24T12:00:01Z";
const UNKNOWN = { owner_turns: null, commits_after_review: null, pull_request: null, pull_request_state: null };

function sources(entries = {}, records = {}) {
  return {
    observationStore: { get: (provider, localId) => entries[`${provider}:${localId}`] },
    repositoryRecordForSession: (id) => records[id],
  };
}

async function resolve(entries = {}, records = {}, ids = [SESSION, SECOND]) {
  const { resolveTaskOutcomeFacts } = await import("../../../server/runtime/task-outcome-lookup.mjs");
  return resolveTaskOutcomeFacts(ids, SINCE, "T-172", sources(entries, records));
}

test("only times strictly after Review count, summed across sessions", async () => {
  const result = await resolve({
    [SESSION]: { evidence: { userMessageTimes: [BEFORE, AT, AFTER] } },
    [SECOND]: { evidence: { userMessageTimes: [AT, AFTER, AFTER] } },
  }, {
    [SESSION]: { commitTimes: [BEFORE, AT, AFTER, AFTER] },
    [SECOND]: { commitTimes: [AT, AFTER] },
  });
  assert.deepEqual(result, { ...UNKNOWN, owner_turns: 3, commits_after_review: 3 });
});

test("missing observations and records are unknown, retained empty arrays are zero", async () => {
  assert.deepEqual(await resolve(), UNKNOWN);
  assert.deepEqual(await resolve({ [SESSION]: { evidence: {} } }, { [SESSION]: { commitTimes: null } }), UNKNOWN);
  assert.deepEqual(await resolve({ [SESSION]: { evidence: { userMessageTimes: [] } } }), { ...UNKNOWN, owner_turns: 0 });
  assert.deepEqual(await resolve({}, { [SECOND]: { commitTimes: [] } }), { ...UNKNOWN, commits_after_review: 0 });
});

const pull = (number, headBranch, association = "session", state = "open") => ({ number, headBranch, association, state, title: "private", url: "private" });
const entry = (items, status = "ready") => ({ publicState: { session: { pullRequests: { status, items } } } });

test("the task branch beats a higher-numbered session pull request across sessions", async () => {
  assert.deepEqual(await resolve({
    [SESSION]: entry([pull(200, "other")]),
    [SECOND]: entry([pull(42, "tasks/T-172", "branch", "merged")]),
  }), { ...UNKNOWN, pull_request: 42, pull_request_state: "merged" });
});

test("fallback selects the highest-numbered session pull request only", async () => {
  assert.deepEqual(await resolve({
    [SESSION]: entry([pull(900, "other", "branch"), pull(4, "other")]),
    [SECOND]: entry([pull(8, "other", "session", "closed")]),
  }), { ...UNKNOWN, pull_request: 8, pull_request_state: "closed" });
  assert.deepEqual(await resolve({ [SESSION]: entry([pull(900, "other", "branch")]) }), UNKNOWN);
});

test("a pull-request block that is not ready gives null", async () => {
  assert.deepEqual(await resolve({ [SESSION]: entry([pull(42, "tasks/T-172")], "loading") }), UNKNOWN);
});

test("createTaskLookups binds the committed outcome sources", () => {
  const lookups = createTaskLookups({
    ...sources({ [SESSION]: { evidence: { userMessageTimes: [AFTER] } } }, { [SESSION]: { commitTimes: [AFTER] } }),
    repositoryInventory: {}, catalogSessions: () => [],
  });
  assert.deepEqual(lookups.resolveTaskOutcomeFacts([SESSION], SINCE, "T-172"), { ...UNKNOWN, owner_turns: 1, commits_after_review: 1 });
});

test("PR log facts share outcome selection and use checks only on the selected head", async () => {
  const { resolveTaskPullRequestFacts } = await import("../../../server/runtime/task-outcome-lookup.mjs");
  const headOid = "a".repeat(40);
  const chosen = { ...pull(42, "tasks/T-172", "branch"), headOid, url: "chosen" };
  const other = { ...pull(200, "other"), headOid: "b".repeat(40), url: "other" };
  const block = entry([other, chosen]);
  block.publicState.session.pullRequests.checkReads = [
    { url: "chosen", headOid, status: "passed" }, { url: "other", headOid: other.headOid, status: "failed" },
  ];
  const inputs = sources({ [SESSION]: block });
  const result = resolveTaskPullRequestFacts(SESSION, "T-172", inputs);
  assert.deepEqual(result, { number: 42, state: "open", headOid, checks: "passed" });
  assert.equal(result.number, (await resolve({ [SESSION]: block }, {}, [SESSION])).pull_request);
  for (const read of [{ headOid: "b".repeat(40), status: "passed" }, { headOid, status: "pending" }, { headOid, status: null }]) {
    block.publicState.session.pullRequests.checkReads = [{ url: "chosen", ...read }];
    assert.equal(resolveTaskPullRequestFacts(SESSION, "T-172", inputs).checks, null);
  }
  block.publicState.session.pullRequests.checkReads = [];
  assert.equal(resolveTaskPullRequestFacts(SESSION, "T-172", inputs).checks, null);
  delete block.publicState.session.pullRequests.checkReads;
  assert.equal(resolveTaskPullRequestFacts(SESSION, "T-172", { ...inputs, checkRead: () => ({ headOid, status: "failed" }) }).checks, "failed");
  block.publicState.session.pullRequests.items = [pull(5, "other"), other, pull(900, "other", "branch")];
  assert.equal(resolveTaskPullRequestFacts(SESSION, "T-172", inputs).number, 200);
  assert.equal((await resolve({ [SESSION]: block }, {}, [SESSION])).pull_request, 200);
});

test("PR facts reuse the response-bound head when normalized items have no head OID", async () => {
  const { resolveTaskPullRequestFacts } = await import("../../../server/runtime/task-outcome-lookup.mjs");
  const headOid = "a".repeat(40);
  const block = entry([pull(42, "tasks/T-172")]);
  block.publicState.session.pullRequests.checkReads = [{ url: "private", headOid, status: "failed" }];
  const inputs = sources({ [SESSION]: block });
  const expected = { number: 42, state: "open", headOid, checks: "failed" };
  assert.deepEqual(resolveTaskPullRequestFacts(SESSION, "T-172", inputs), expected);
  const lookups = createTaskLookups({ ...inputs, repositoryInventory: {}, catalogSessions: () => [] });
  assert.deepEqual(lookups.resolveTaskPullRequestFacts(SESSION, "T-172"), expected);
  block.publicState.session.pullRequests.checkReads[0].headOid = "invalid";
  assert.deepEqual(lookups.resolveTaskPullRequestFacts(SESSION, "T-172"), { ...expected, headOid: null, checks: null });
  block.publicState.session.pullRequests.status = "loading";
  assert.deepEqual(lookups.resolveTaskPullRequestFacts(SESSION, "T-172"), { number: null, state: null, headOid: null, checks: null });
});

test("the monitor outcome lookup never loads an absent repository sidecar", async () => {
  const reads = [];
  const runtime = createMonitorRuntime({
    providerRegistry: { providers: [] }, monitorStore: false, notificationPersistence: false,
    repositoryInventory: { subscribe: () => () => {} },
    checkpointStore: {
      async loadRepositorySnapshots() { reads.push("all"); return []; },
      async writeRepositorySnapshot() {},
      async loadRepositorySnapshot(...args) { reads.push(args); return null; },
    },
  });
  assert.deepEqual(runtime.resolveTaskOutcomeFacts([SESSION], SINCE, "T-172"), UNKNOWN);
  assert.deepEqual(runtime.resolveTaskPullRequestFacts(SESSION, "T-172"), { number: null, state: null, headOid: null, checks: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, []);
});

test("resolve_done routes outcome facts into the private row", async (t) => {
  const { store, clock, directory } = await openTemporaryStore(t);
  assert.equal(store.apply(REPOSITORY, "create", { text: "Outcome task" }).ok, true);
  const planned = store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.equal(store.bindSession({ token: planned.plan.token, sessionId: SESSION }).ok, true);
  assert.equal(store.completeTask({ sessionId: SESSION }).ok, true);
  const facts = { owner_turns: 2, commits_after_review: 3, pull_request: 42, pull_request_state: "merged" };
  const calls = [];
  const request = Readable.from([Buffer.from(JSON.stringify({ repositoryId: REPOSITORY, payload: { id: "T-1" } }))]);
  request.method = "POST";
  request.headers = { "content-type": "application/json" };
  const response = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await serveTaskActionRoute({
    request, response, requestUrl: new URL("http://localhost/internal/tasks/resolve_done"), taskStore: store,
    resolveOutcomeFacts: (...args) => { calls.push(args); return facts; },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(calls, [[[SESSION], clock.now, "T-1"]]);
  const row = withDatabase(directory, (database) => readTaskOutcome(database, REPOSITORY, 1));
  for (const [key, value] of Object.entries(facts)) {
    assert.equal(row[key], value);
    assert.equal(JSON.stringify(response.body).includes(key), false);
  }
});
