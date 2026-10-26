import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { serveAgentTaskReportRoute } from "../../../server/serving/task-session-routes.mjs";
import { openTemporaryStore as setup, REPOSITORY as REPOSITORY_ID, SESSION, FACTS, passingGates, withDatabase } from "./queue-test-support.mjs";

const COMPLETE = "/api/agent/v1/tasks/complete", BLOCK = "/api/agent/v1/tasks/block";
const OTHER_SESSION = "codex:unrelated-session", TEXT = "PRIVATE-REWORK-TEXT";
const apply = (env, action, payload) => env.store.apply(REPOSITORY_ID, action, payload);
const taskOf = (env, id = "T-1") => env.store.readBoard(REPOSITORY_ID).tasks.find((task) => task.id === id);
function startedTask(env) {
  assert.equal(apply(env, "create", { text: "Fixing task" }).ok, true);
  const plan = env.store.planStart(REPOSITORY_ID, { id: "T-1" }, () => FACTS, passingGates);
  assert.equal(plan.ok, true);
  assert.equal(env.store.bindSession({ token: plan.plan.token, sessionId: SESSION }).ok, true);
}
async function send(env, { path, body }) {
  const request = Readable.from([Buffer.from(body)]);
  request.headers = { "content-type": "application/json" };
  const out = {};
  const response = { writeHead: (status, headers) => Object.assign(out, { status, headers }), end: (body) => { out.json = JSON.parse(body); } };
  await serveAgentTaskReportRoute({ request, response, requestUrl: new URL(path, "http://127.0.0.1"), taskStore: env.store });
  return out;
}
const refused = (response, status, reason) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(response.json, { schemaVersion: 1, ok: false, reason });
};

test("complete and block record session reworks after reporting, with partial and duplicate outcomes", async (t) => {
  const env = await setup(t);
  startedTask(env);
  apply(env, "create", { text: "Earlier work" });
  for (const requestPath of [COMPLETE, BLOCK]) {
    const body = { sessionRef: SESSION, ...(requestPath === BLOCK ? { reason: "stuck" } : {}), reworks: [
      { ref: "T-2", cause: "missed_wiring" }, { ref: "#336", cause: "spec_gap" },
      { ref: "T-999", cause: "other" }, { ref: "T-1", cause: "other" },
    ] };
    const response = await send(env, { path: requestPath, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.reworks, [
      { ref: "T-2", status: requestPath === COMPLETE ? "recorded" : "exists" },
      { ref: "#336", status: requestPath === COMPLETE ? "recorded" : "exists" },
      { ref: "T-999", status: "refused", reason: "not_found" }, { ref: "T-1", status: "refused", reason: "invalid" },
    ]);
    assert.equal(taskOf(env).state, requestPath === COMPLETE ? "needs_review" : "blocked");
  }
  assert.deepEqual(taskOf(env).reworks, [
    { ref: "#336", cause: "spec_gap", declaredBy: "session" }, { ref: "T-2", cause: "missed_wiring", declaredBy: "session" },
  ]);
  assert.deepEqual(taskOf(env, "T-2").reworkedBy, [{ ref: "T-1", cause: "missed_wiring", declaredBy: "session" }]);
  assert.equal(env.store.readLog(REPOSITORY_ID, { limit: 20 }).entries.filter((entry) => entry.kind === "rework" && entry.task === "T-1").length, 2);
  withDatabase(env.directory, (db) => assert.deepEqual(db.prepare("SELECT declared_by, at FROM task_rework").all().map((row) => ({ ...row })),
    Array(2).fill({ declared_by: "session", at: env.clock.now })));
  for (const ref of ["#1", "#2", "#3"]) assert.equal(apply(env, "rework_declare", { fix: "T-1", reworks: ref, cause: "other" }).ok, true);
  const full = await send(env, { path: COMPLETE, body: JSON.stringify({ sessionRef: SESSION, reworks: [{ ref: "#4", cause: "other" }] }) });
  assert.equal(full.status, 200);
  assert.deepEqual(full.json.reworks, [{ ref: "#4", status: "refused", reason: "limit" }]);
  assert.equal(taskOf(env).state, "needs_review");
});

test("report route and store reject malformed reworks and unknown fields before applying reports", async (t) => {
  const env = await setup(t);
  startedTask(env);
  const valid = [{ ref: "#1", cause: "other" }];
  for (const requestPath of [COMPLETE, BLOCK]) {
    for (const extra of [{ reworks: valid, unknown: true }, ...[null, [], {}, Array(6).fill(valid[0]),
      [{ ref: "#01", cause: "other" }], [{ ref: "T-2", cause: "unknown" }], [{ ...valid[0], text: TEXT }],
    ].map((reworks) => ({ reworks }))]) {
      const fields = { ...(requestPath === BLOCK ? { reason: "stuck" } : {}), ...extra };
      refused(await send(env, { path: requestPath, body: JSON.stringify({ sessionRef: SESSION, ...fields }) }), 400, "invalid");
      const call = requestPath === BLOCK ? env.store.blockTask : env.store.completeTask;
      assert.deepEqual(call({ sessionId: SESSION, ...fields }), { ok: false, error: "invalid" });
      assert.equal(taskOf(env).report, null);
    }
  }
});

test("a block report records a new rework on the named assigned task", async (t) => {
  const env = await setup(t);
  startedTask(env);
  apply(env, "create", { text: "Assigned fix" });
  assert.equal(apply(env, "session_assign", { id: "T-2", sessionId: SESSION }).ok, true);
  const response = await send(env, { path: BLOCK, body: JSON.stringify({ sessionRef: SESSION, taskId: "T-2", reason: "stuck",
    reworks: [{ ref: "T-1", cause: "latent" }] }) });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.reworks, [{ ref: "T-1", status: "recorded" }]);
  assert.equal(taskOf(env, "T-2").state, "blocked");
  assert.deepEqual(taskOf(env, "T-2").reworks, [{ ref: "T-1", cause: "latent", declaredBy: "session" }]);
  assert.equal(taskOf(env).report, null);
});

test("report and rework log commit atomically, and refused reports record no links", async (t) => {
  const env = await setup(t);
  startedTask(env);
  const reworks = [{ ref: "#336", cause: "other" }];
  assert.equal(env.store.completeTask({ sessionId: OTHER_SESSION, reworks }).error, "not_found");
  withDatabase(env.directory, (db) => db.exec("CREATE TRIGGER refuse_rework_log AFTER INSERT ON task_log WHEN NEW.kind = 'rework' BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  assert.equal(env.store.completeTask({ sessionId: SESSION, reworks }).ok, false);
  assert.equal(taskOf(env).report, null);
  assert.equal(taskOf(env).reworks, undefined);
  withDatabase(env.directory, (db) => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_rework").get().n, 0));
});
