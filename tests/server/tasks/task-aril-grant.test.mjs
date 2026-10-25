import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as grants from "../../../server/tasks/task-aril-grant.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { REPOSITORY as REPO, passingGates, GATE_FACTS, createTask, queueTask, updateTask, setMeta, withDatabase, dispatchMintedAt, repositoryNumber } from "./queue-test-support.mjs";

const actions = { start: true, review: true, sendBack: false, merge: false, writeTasks: false };
const limits = { hours: 1, starts: 4, concurrent: 3, sendBacks: null, allowancePercent: null };
function setup(t) {
  const directory = mkdtempSync(path.join(process.cwd(), ".grant-test-"));
  const clock = { now: 1700000000000 };
  const store = openTaskStore({ directory, now: () => clock.now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const set = (settings, repo = REPO) => store.apply(repo, "aril_settings_set", { settings });
  const start = (repo = REPO) => store.apply(repo, "grant_start", {});
  const ready = (text = "task", repo = REPO) => {
    createTask(store, repo, { text });
    const id = `T-${Math.max(...store.readBoard(repo).tasks.map((task) => Number(task.id.slice(2))))}`;
    queueTask(store, id, repo);
    return id;
  };
  const next = (resolveGateFacts = passingGates) => store.nextGrantSteps({ resolveGateFacts });
  const configure = (settings = {}, repo = REPO) => assert.equal(set({ actions, limits, workRules: [{ kind: "text", value: "task" }], ...settings }, repo).ok, true);
  return { store, directory, clock, set, start, ready, next, configure };
}
const step = (taskId, kind = "start", repositoryId = REPO) => ({ repositoryId, taskId, kind,
  ...(kind === "review" ? { run: { provider: "claude", model: null, effort: null } } : {}) });
const error = (answer, code) => assert.deepEqual(answer, { ok: false, error: code });

test("grant reviewer rule covers providers, model precedence, effort and identical runs", () => {
  for (const model of [null, "builder-model"]) for (const effort of [null, "low", "medium", "high", "xhigh"]) {
    for (const reviewerModel of [null, "builder-model", "review-model"]) {
      // Expected runs with differentFromBuilder off and on, including explicit-provider precedence.
      const claude = { provider: "claude", model: null, effort: null }, codex = { provider: "codex", model: null, effort: null };
      const ownClaude = { provider: "claude", model, effort }, ownCodex = { provider: "codex", model, effort };
      const chosenClaude = { ...ownClaude, model: reviewerModel ?? model }, chosenCodex = { ...ownCodex, model: reviewerModel ?? model };
      const crossClaude = { ...claude, model: reviewerModel }, crossCodex = { ...codex, model: reviewerModel };
      const cases = [
        [null, null, claude, claude], [null, "claude", crossClaude, crossClaude], [null, "codex", crossCodex, crossCodex],
        ["claude", null, ownClaude, codex], ["claude", "claude", chosenClaude, chosenClaude], ["claude", "codex", crossCodex, crossCodex],
        ["codex", null, ownCodex, claude], ["codex", "claude", crossClaude, crossClaude], ["codex", "codex", chosenCodex, chosenCodex],
      ];
      for (const [builder, preference, same, different] of cases) for (const differentFromBuilder of [false, true]) {
        if (builder === null && model !== null) continue;
        const run = Object.freeze({ provider: builder, model, effort });
        const reviewer = Object.freeze({ provider: preference, model: reviewerModel, differentFromBuilder });
        const expected = differentFromBuilder ? different : same;
        const unchanged = expected.provider === builder && expected.model === model && expected.effort === effort;
        assert.deepEqual(grants.grantReviewRun(run, reviewer), unchanged ? null : expected, JSON.stringify({ run, reviewer }));
      }
    }
  }
});

test("grant review steps read the live reviewer rule and omit identical overrides", (t) => {
  const { store, configure, start, ready, directory, set, next } = setup(t);
  ready(); ready();
  assert.equal(store.apply(REPO, "update", { id: "T-1", run: { provider: "codex", model: "builder-model", effort: "high" } }).ok, true);
  updateTask(directory, 1, { state: "needs_review", session_id: "codex:builder" });
  configure(); start();
  const review = { repositoryId: REPO, taskId: "T-1", kind: "review" };
  assert.deepEqual(next().steps, [review, step("T-2")]);
  for (const [reviewer, run] of [
    [{ provider: null, model: "ignored-model", differentFromBuilder: true }, { provider: "claude", model: null, effort: null }],
    [{ provider: "claude", model: "review-model", differentFromBuilder: false }, { provider: "claude", model: "review-model", effort: null }],
    [{ provider: "codex", model: "review-model", differentFromBuilder: true }, { provider: "codex", model: "review-model", effort: "high" }],
    [{ provider: "codex", model: "builder-model", differentFromBuilder: true }, null],
  ]) {
    assert.equal(set({ reviewer }).ok, true);
    assert.deepEqual(next().steps, [{ ...review, ...(run ? { run } : {}) }, step("T-2")]);
  }
});

test("restart ends all active grants atomically, including grants with no eligible work", (t) => {
  const { store, configure, start, clock, directory, next } = setup(t);
  const other = repositoryNumber(2);
  for (const repo of [REPO, other]) { configure({}, repo); start(repo); }
  assert.deepEqual(next().steps, []);
  for (const payload of [null, {}, { reason: "start_failed" }, { reason: "app_restart", extra: true }]) {
    error(store.endAllGrants(payload), "invalid");
  }
  withDatabase(directory, (db) => db.exec(`CREATE TRIGGER refuse_grant_end BEFORE UPDATE ON aril_grants
    WHEN EXISTS (SELECT 1 FROM aril_grants WHERE ended_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`));
  error(store.endAllGrants({ reason: "app_restart" }), "unavailable");
  for (const repo of [REPO, other]) assert.equal(store.checkGrant(repo).active, true);
  withDatabase(directory, (db) => db.exec("DROP TRIGGER refuse_grant_end"));
  assert.deepEqual(store.endAllGrants({ reason: "app_restart" }), { ok: true, ended: 2 });
  for (const repo of [REPO, other]) {
    const grant = store.readBoard(repo).aril.grant;
    assert.equal(grant.active, false);
    assert.equal(grant.endReason, "app_restart");
    assert.equal(grant.endedAt, clock.now);
  }
  assert.deepEqual(store.endAllGrants({ reason: "app_restart" }), { ok: true, ended: 0 });
});

test("restart preserves already ended grants and settles expired grants by their existing rule", (t) => {
  const { store, configure, start, clock } = setup(t);
  configure(); start();
  clock.now += 3600000;
  assert.deepEqual(store.endAllGrants({ reason: "app_restart" }), { ok: true, ended: 0 });
  assert.equal(store.readBoard(REPO).aril.grant.endReason, "expired");
});

test("grant preconditions, exact actions, conflict, stop, and board history", (t) => {
  const { store, configure, start, clock } = setup(t);
  assert.equal(store.readBoard(REPO).aril.grant, null);
  error(start(), "not_ready");
  for (const key of ["hours", "starts", "concurrent"]) {
    configure({ limits: { ...limits, [key]: null } });
    error(start(), "not_ready");
  }
  configure({ actions: { ...actions, start: false, review: false, merge: true } });
  error(start(), "not_ready");
  configure();
  for (const name of ["grant_start", "grant_stop"]) for (const payload of [null, [], { extra: true }]) error(store.apply(REPO, name, payload), "invalid");
  const grant = { startedAt: clock.now, endsAt: clock.now + 3600000, startsUsed: 0, actions, limits, active: true };
  assert.deepEqual(start(), { ok: true, grant });
  error(start(), "conflict");
  assert.deepEqual(store.readBoard(REPO).aril.grant, grant);
  assert.deepEqual(store.apply(REPO, "grant_stop", {}), { ok: true });
  clock.now += 1;
  assert.deepEqual(store.apply(REPO, "grant_stop", {}), { ok: true });
  assert.deepEqual(store.readBoard(REPO).aril.grant, { ...grant, active: false, endReason: "stopped", endedAt: clock.now - 1 });
  assert.equal(start().ok, true);
});

test("snapshots persist across settings edits and reopening; additive schema remains version one", (t) => {
  const { store, directory, configure, start, clock } = setup(t);
  configure();
  const original = start().grant;
  configure({ actions: { ...actions, start: false }, limits: { ...limits, starts: 1 } });
  assert.deepEqual(store.readBoard(REPO).aril.grant, original);
  const reopened = openTaskStore({ directory, now: () => clock.now });
  try { assert.deepEqual(reopened.readBoard(REPO).aril.grant, original); } finally { reopened.close(); }
  withDatabase(directory, (db) => {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1");
    assert.throws(() => db.prepare("INSERT INTO aril_grants(repository_id, started_at, ends_at, actions, limits) VALUES (?, ?, ?, ?, ?)")
      .run(REPO, clock.now, clock.now + 1, JSON.stringify(actions), JSON.stringify(limits)), /UNIQUE/u);
  });
});

test("reads expire grants at the boundary and terminate exhausted grants transactionally", (t) => {
  const { store, configure, start, clock, directory, next } = setup(t);
  configure(); start();
  clock.now += 3599999;
  assert.deepEqual(store.checkGrant(REPO), { ok: true, active: true });
  clock.now += 1;
  assert.deepEqual(next(), { ok: true, steps: [] });
  assert.equal(store.readBoard(REPO).aril.grant.endReason, "expired");
  start();
  withDatabase(directory, (db) => db.prepare("UPDATE aril_grants SET starts_used = 4 WHERE ended_at IS NULL").run());
  assert.deepEqual(store.checkGrant(REPO), { ok: true, active: false });
  assert.equal(store.readBoard(REPO).aril.grant.endReason, "starts_used");
  start(); clock.now += 3600000;
  assert.equal(store.readBoard(REPO).aril.grant.endReason, "expired", "board reads also commit expiry");
});

test("record counts only builder starts, appends both kinds, refuses inactive and invalid requests", (t) => {
  const { store, configure, start, ready } = setup(t);
  ready(); configure({ limits: { ...limits, starts: 1 } });
  error(store.recordGrant(REPO, { taskId: "T-1", kind: "start" }), "not_active");
  start();
  error(store.recordGrant(REPO, { taskId: "T-2", kind: "start" }), "not_found");
  for (const payload of [{ taskId: "T-1", kind: "merge" }, { taskId: "T-1", kind: "start", extra: 1 }, {}]) error(store.recordGrant(REPO, payload), "invalid");
  assert.deepEqual(store.recordGrant(REPO, { taskId: "T-1", kind: "review" }), { ok: true });
  assert.equal(store.readBoard(REPO).aril.grant.startsUsed, 0);
  assert.deepEqual(store.recordGrant(REPO, { taskId: "T-1", kind: "start" }), { ok: true });
  assert.equal(store.readBoard(REPO).aril.grant.endReason, "starts_used");
  error(store.recordGrant(REPO, { taskId: "T-1", kind: "start" }), "not_active");
  assert.deepEqual(store.readLog(REPO, { limit: 10 }).entries.map(({ kind, task }) => ({ kind, task })), [
    { kind: "grant_review", task: "T-1" }, { kind: "grant_start", task: "T-1" },
  ]);
});

test("end reasons are fixed and ending an inactive grant is idempotent", (t) => {
  const { store, configure, start } = setup(t);
  configure();
  for (const reason of ["start_failed", "app_restart"]) {
    start(); assert.deepEqual(store.endGrant(REPO, { reason }), { ok: true });
    assert.equal(store.readBoard(REPO).aril.grant.endReason, reason);
    assert.deepEqual(store.endGrant(REPO, { reason }), { ok: true });
  }
  for (const reason of ["expired", "stopped", "other", null]) error(store.endGrant(REPO, { reason }), "invalid");
});

test("an older version-one store adds grants and a failed log append rolls back a start count", (t) => {
  const { store, directory, configure, ready, clock } = setup(t);
  ready(); configure(); store.close();
  withDatabase(directory, (db) => db.exec("DROP TABLE aril_grants"));
  const reopened = openTaskStore({ directory, now: () => clock.now });
  try {
    assert.equal(reopened.readBoard(REPO).aril.grant, null);
    assert.equal(reopened.readBoard(REPO).tasks.length, 1);
    assert.equal(reopened.apply(REPO, "grant_start", {}).ok, true);
    withDatabase(directory, (db) => db.exec("CREATE TRIGGER refuse_grant_log BEFORE INSERT ON task_log BEGIN SELECT RAISE(ABORT, 'test'); END"));
    error(reopened.recordGrant(REPO, { taskId: "T-1", kind: "start" }), "unavailable");
    assert.equal(reopened.readBoard(REPO).aril.grant.startsUsed, 0);
    assert.deepEqual(reopened.readLog(REPO, { limit: 10 }).entries, []);
    clock.now += 3600000;
    error(reopened.recordGrant(REPO, { taskId: "T-1", kind: "start" }), "not_active");
    assert.equal(withDatabase(directory, (db) => db.prepare("SELECT end_reason FROM aril_grants").get().end_reason), "expired");
  } finally { reopened.close(); }
});

test("Ready includes unqueued startable cards, excludes Backlog, and respects work rules for starts", (t) => {
  const { store, ready, configure, start, next } = setup(t);
  ready("task selected"); ready("task excluded");
  assert.equal(store.apply(REPO, "queue_remove", { id: "T-1" }).ok, true);
  createTask(store, REPO, { text: "task selected in Backlog" });
  configure({ workRules: [{ kind: "text", value: "selected" }] }); start();
  assert.deepEqual(next().steps, [step("T-1")]);
});

test("work rules select reviews by leading tag, insensitive text, feature, or task ID; empty rules select none", (t) => {
  const { store, configure, start, ready, directory, set, next } = setup(t);
  for (const text of ["[ Fix ] task", "task NEEDLE", "task feature", "task listed", "task [ Fix ]", "[ image ] [ Fix ] task"]) ready(text);
  const featureId = store.apply(REPO, "feature_create", { name: "Feature" }).board.features[0].id;
  assert.equal(store.apply(REPO, "update", { id: "T-3", featureId }).ok, true);
  for (let n = 1; n <= 6; n++) updateTask(directory, n, { state: "needs_review", session_id: `codex:builder-${n}` });
  configure({ workRules: [], limits: { ...limits, concurrent: 4 } }); start();
  assert.deepEqual(next().steps, []);
  assert.equal(set({ workRules: [{ kind: "tag", value: "Fix" }, { kind: "text", value: "needle" }, { kind: "feature", value: featureId }, { kind: "tasks", value: ["T-4"] }] }).ok, true);
  assert.deepEqual(next().steps, [1, 2, 3, 4].map((n) => step(`T-${n}`, "review")));
});

test("review selection excludes dispatch, bound reviewer, missing builder and current verdict; old verdict permits review", (t) => {
  const { configure, start, ready, directory, clock, next } = setup(t);
  for (let n = 1; n <= 7; n++) { ready(); updateTask(directory, n, { state: "needs_review", session_id: `codex:builder-${n}` }); }
  updateTask(directory, 2, { session_id: null });
  setMeta(directory, `task_review_dispatch:${REPO}:T-3`, dispatchMintedAt(clock.now));
  setMeta(directory, `task_review_dispatch:${REPO}:T-4`, dispatchMintedAt(clock.now - 1000000));
  setMeta(directory, `task_reviewer:${REPO}:T-5`, "codex:reviewer");
  withDatabase(directory, (db) => {
    for (const n of [6, 7]) {
      db.prepare("INSERT INTO task_reviews(repository_id, number, session_id, at, verdict) VALUES (?, ?, ?, ?, 'pass')").run(REPO, n, `codex:r-${n}`, clock.now);
      db.prepare("INSERT INTO task_events(repository_id, number, kind, at) VALUES (?, ?, 'review', ?)").run(REPO, n, clock.now + (n === 7 ? 1 : 0));
    }
  });
  configure(); start();
  assert.deepEqual(next().steps, [step("T-1", "review"), step("T-7", "review")]);
});

test("starts use Ready order, startability and after rules without changing the queue", (t) => {
  const { store, configure, start, ready, directory, clock, next } = setup(t);
  for (let n = 1; n <= 6; n++) ready();
  const columnId = store.readBoard(REPO).columns.find((c) => c.name === "Ready").id;
  assert.equal(store.apply(REPO, "move", { id: "T-2", columnId, position: 0 }).ok, true);
  assert.equal(store.apply(REPO, "after_set", { id: "T-3", after: ["T-6"] }).ok, true);
  updateTask(directory, 4, { dispatch_token: dispatchMintedAt(clock.now), state: "needs_review" });
  updateTask(directory, 5, { state: "done", session_id: "codex:done" });
  updateTask(directory, 6, { state: "scheduled", scheduled_at: clock.now + 100000 });
  configure(); start();
  // A live dispatch holds other groups through the same queue gate.
  assert.deepEqual(next().steps, []);
  updateTask(directory, 4, { dispatch_token: null });
  const before = store.readBoard(REPO).queue.status;
  assert.deepEqual(next().steps, [step("T-2"), step("T-1")]);
  assert.equal(store.readBoard(REPO).queue.status, before);
  assert.equal(store.readBoard(REPO).tasks.every((task) => task.session === null || task.id === "T-5"), true);
});

test("concurrency subtracts linked unreported builders and running reviews, remaining starts also caps selection", (t) => {
  const { store, configure, start, ready, directory, next } = setup(t);
  for (let n = 1; n <= 5; n++) ready();
  assert.equal(store.apply(REPO, "queue_group", { ids: ["T-1", "T-2", "T-3", "T-4"] }).ok, true);
  updateTask(directory, 1, { session_id: "codex:builder" });
  updateTask(directory, 5, { state: "needs_review", session_id: "codex:finished", report_at: 1, report_results: "[]" });
  setMeta(directory, `task_reviewer:${REPO}:T-5`, "codex:reviewer");
  configure(); start();
  assert.deepEqual(next().steps, [step("T-2")]);
  assert.deepEqual(store.recordGrant(REPO, { taskId: "T-1", kind: "start" }), { ok: true });
  assert.deepEqual(store.recordGrant(REPO, { taskId: "T-1", kind: "start" }), { ok: true });
  assert.deepEqual(store.recordGrant(REPO, { taskId: "T-1", kind: "start" }), { ok: true });
  updateTask(directory, 1, { state: "needs_review", report_at: 1, report_results: "[]" });
  assert.deepEqual(next().steps.filter((s) => s.kind === "start"), [step("T-2")]);
});

test("reviews take session capacity before starts, including when only one slot remains", (t) => {
  const { store, ready, configure, start, directory, next } = setup(t);
  ready(); ready(); ready();
  updateTask(directory, 2, { state: "needs_review", session_id: "codex:finished-two" });
  configure({ limits: { ...limits, concurrent: 1 } }); start();
  assert.deepEqual(next().steps, [step("T-2", "review")]);
  updateTask(directory, 3, { state: "needs_review", session_id: "codex:finished-three" });
  assert.deepEqual(next().steps, [step("T-2", "review")], "review candidates share the same single slot");
  setMeta(directory, `task_reviewer:${REPO}:T-2`, "codex:reviewer");
  assert.deepEqual(next().steps, [], "a running review exhausts the session capacity");
  assert.equal(store.readBoard(REPO).aril.grant.startsUsed, 0);
});

test("reviews consume concurrency but leave the remaining builder-start allowance intact", (t) => {
  const { ready, configure, start, directory, next } = setup(t);
  for (let n = 1; n <= 4; n++) ready();
  updateTask(directory, 1, { state: "needs_review", session_id: "codex:finished-one" });
  updateTask(directory, 2, { state: "needs_review", session_id: "codex:finished-two" });
  configure({ limits: { ...limits, starts: 1, concurrent: 3 } }); start();
  assert.deepEqual(next().steps, [step("T-1", "review"), step("T-2", "review"), step("T-3")]);
});

// A board whose columns no longer match the fixed five has no Ready column for the store, as for the queue.
test("grant starts never take a column by its name, and start nothing on a board without the fixed columns", (t) => {
  const { store, ready, configure, start, directory, next } = setup(t);
  ready();
  assert.equal(store.apply(REPO, "queue_remove", { id: "T-1" }).ok, true);
  createTask(store, REPO, { text: "task in Backlog" });
  configure(); start();
  withDatabase(directory, (db) => {
    db.prepare("UPDATE columns SET name = 'Selected work' WHERE repository_id = ? AND position = 1").run(REPO);
    db.prepare("UPDATE columns SET name = 'Ready' WHERE repository_id = ? AND position = 0").run(REPO);
  });
  assert.deepEqual(next().steps, []);
});

test("start gates use resolver, threshold and queue window; reviews do not use start gates", (t) => {
  const { store, configure, start, ready, clock, directory, next } = setup(t);
  ready(); ready(); updateTask(directory, 2, { state: "needs_review", session_id: "codex:builder" });
  configure(); start();
  for (const resolver of [null, () => { throw new Error("private"); }, () => ({ ...GATE_FACTS, treeClean: false }), () => ({ ...GATE_FACTS, providerStatus: { claude: "incident", codex: "operational" } })]) {
    assert.deepEqual(next(resolver).steps, [step("T-2", "review")]);
  }
  const usage = () => ({ ...GATE_FACTS, usage: { ...GATE_FACTS.usage, claude: { fiveHourPercent: 80, sevenDayPercent: 10 } } });
  assert.equal(store.apply(REPO, "queue_settings", { threshold: 70 }).ok, true);
  assert.deepEqual(next(usage).steps, [step("T-2", "review")]);
  assert.equal(store.apply(REPO, "queue_settings", { threshold: 95 }).ok, true);
  assert.equal(next(usage).steps.length, 2);
  setMeta(directory, `queue_stop_after:${REPO}`, String(clock.now));
  assert.deepEqual(next().steps, [step("T-2", "review")]);
  setMeta(directory, `queue_stop_after:${REPO}`, String(clock.now + 10000));
  setMeta(directory, `queue_start_at:${REPO}`, String(clock.now + 1000));
  assert.deepEqual(next().steps, [step("T-2", "review")]);
});

test("action snapshots select only allowed kinds and cap all repositories at sixteen", (t) => {
  const { configure, start, ready, directory, next } = setup(t);
  for (let n = 1; n <= 20; n++) {
    const repo = repositoryNumber(n);
    ready("task", repo); ready("task", repo);
    updateTask(directory, 2, { state: "needs_review", session_id: `codex:b-${n}` }, repo);
    configure({ actions: { ...actions, start: n % 2 === 0, review: n % 2 !== 0 } }, repo); start(repo);
  }
  assert.deepEqual(next().steps, Array.from({ length: 16 }, (_, i) => step(i % 2 === 0 ? "T-2" : "T-1", i % 2 === 0 ? "review" : "start", repositoryNumber(i + 1))));
});
