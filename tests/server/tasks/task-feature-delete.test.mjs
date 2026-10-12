import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { normalizeFeatureDeletePayload } from "../../../server/tasks/task-record.mjs";
import {
  OTHER_REPOSITORY, REPOSITORY, SESSION, START_TIME, metaValue, openTemporaryStore, pauseReasonKey, queueRow, queueTask, setMeta, setQueueRow,
  startedTask, updateTask, withDatabase,
} from "./queue-test-support.mjs";

// The desktop's feature_delete: the feature goes, its tasks stay on the board with no feature, and a started task refuses it.

const UNKNOWN = `feat-${"0".repeat(12)}`;
const TOKEN = "d".repeat(40);
const DONE_SESSION = "claude:2c9f3d2f-1111-4222-8333-444455556666";
const descriptionKey = (id) => `feature_description:${REPOSITORY}:${id}`;
const appVersionKey = (id) => `feature_app_version:${REPOSITORY}:${id}`;

const featureId = (store, name, repositoryId = REPOSITORY) => store.readBoard(repositoryId).features.find((feature) => feature.name === name)?.id;
const rows = (directory, repositoryId = REPOSITORY) => withDatabase(directory, (database) =>
  database.prepare("SELECT * FROM tasks WHERE repository_id = ? ORDER BY number").all(repositoryId).map((row) => ({ ...row })));
const featureRows = (directory) => withDatabase(directory, (database) => database.prepare("SELECT id, repository_id, name FROM features ORDER BY id").all().map((row) => ({ ...row })));
const withoutFeature = (row) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== "feature_id" && name !== "step"));
const columnId = (store, name) => store.readBoard(REPOSITORY).columns.find((column) => column.name === name).id;

function addFeature(store, name, details = {}) {
  assert.equal(store.apply(REPOSITORY, "feature_create", { name, ...details }).ok, true);
  return featureId(store, name);
}

function addTask(store, text, payload = {}) {
  const result = store.apply(REPOSITORY, "create", { text, ...payload });
  assert.equal(result.ok, true, text);
  return result.taskId;
}

/** A feature with tasks in several columns and states, another feature, and a task of no feature. */
async function populated(context) {
  const { store, clock, directory } = await openTemporaryStore(context, "pomegr-task-feature-delete-");
  const feature = addFeature(store, "Uploads", { description: "SECRET-CONTEXT", appVersion: "1.4.0" });
  const other = addFeature(store, "Other");
  const idle = addTask(store, "Not queued, step 1", { featureId: feature, step: 1 });
  const firstQueued = addTask(store, "Queued, step 2", { featureId: feature, step: 2 });
  const secondQueued = addTask(store, "Queued, parallel in step 2", { featureId: feature, step: 2 });
  const scheduled = addTask(store, "Scheduled, step 3", { featureId: feature, step: 3 });
  const finished = addTask(store, "Done with a session", { featureId: feature, step: 1 });
  const single = addTask(store, "A single queued task");
  const kept = addTask(store, "Another feature's task", { featureId: other, step: 1 });
  queueTask(store, secondQueued);
  queueTask(store, firstQueued);
  assert.equal(store.apply(REPOSITORY, "queue_add", { id: scheduled, at: new Date(clock.now + 3_600_000).toISOString() }).ok, true);
  queueTask(store, single);
  assert.equal(store.apply(REPOSITORY, "move", { id: idle, columnId: columnId(store, "Backlog"), position: 0 }).ok, true);
  assert.equal(store.apply(REPOSITORY, "move", { id: finished, columnId: columnId(store, "Done"), position: 0 }).ok, true);
  updateTask(directory, 5, { state: "done", session_id: DONE_SESSION, report_at: START_TIME, report_results: "[]" });
  return { store, clock, directory, feature, other, ids: { idle, firstQueued, secondQueued, scheduled, finished, single, kept } };
}

test("deleting a feature detaches every task and changes nothing else on a task row", async (context) => {
  const { store, directory, feature, other, ids } = await populated(context);
  const before = rows(directory);
  const orderBefore = store.readBoard(REPOSITORY).queue.order;
  assert.deepEqual(before.map((row) => row.feature_id === feature), [true, true, true, true, true, false, false]);
  assert.equal(before.find((row) => row.number === 5).state, "done");
  assert.deepEqual(new Set(before.filter((row) => row.feature_id === feature).map((row) => row.state)), new Set(["not_queued", "queued", "scheduled", "done"]));

  const result = store.apply(REPOSITORY, "feature_delete", { id: feature });
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.features.map((entry) => entry.name), ["Other"]);

  const after = rows(directory);
  assert.equal(after.length, before.length);
  assert.equal(new Set(after.map((row) => row.number)).size, after.length);
  for (const row of after) {
    const stored = before.find((candidate) => candidate.number === row.number);
    // Every field but the feature and the step is the one it was, the update time included.
    assert.deepEqual(withoutFeature(row), withoutFeature(stored), `T-${row.number}`);
    if (stored.feature_id === feature) assert.deepEqual([row.feature_id, row.step], [null, null], `T-${row.number}`);
    else assert.deepEqual([row.feature_id, row.step], [stored.feature_id, stored.step], `T-${row.number}`);
    assert.equal((row.feature_id === null) === (row.step === null), true);
  }
  assert.equal(after.some((row) => row.feature_id === feature), false);
  assert.equal(after.find((row) => row.number === 7).feature_id, other);
  // The board serves the detached tasks as tasks with no feature and no step, in the columns they were in.
  const board = store.readBoard(REPOSITORY);
  for (const id of [ids.idle, ids.firstQueued, ids.secondQueued, ids.scheduled, ids.finished]) {
    const task = board.tasks.find((entry) => entry.id === id);
    assert.deepEqual([task.featureId, task.step], [null, null], id);
  }
  assert.equal(board.tasks.find((task) => task.id === ids.finished).columnId, columnId(store, "Done"));
  assert.equal(board.tasks.length, before.length);
  // A queued task is now a single queued task: the same tasks are queued.
  assert.deepEqual([...board.queue.order].sort(), [...orderBefore].sort());
  assert.equal(board.queue.order.includes(ids.single), true);
  assert.deepEqual(featureRows(directory).map((row) => row.name), ["Other"]);
  assert.equal(metaValue(directory, descriptionKey(feature)), null);
  assert.equal(metaValue(directory, appVersionKey(feature)), null);
  assert.equal(store.readFeature(REPOSITORY, feature), null);
  assert.deepEqual(store.apply(REPOSITORY, "feature_delete", { id: feature }), { ok: false, error: "not_found" });
});

test("queued tasks keep their stored queue position once detached", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-feature-delete-");
  const feature = addFeature(store, "Uploads");
  const first = addTask(store, "First", { featureId: feature, step: 1 });
  const second = addTask(store, "Second", { featureId: feature, step: 2 });
  const third = addTask(store, "Third", { featureId: feature, step: 3 });
  for (const id of [third, first, second]) queueTask(store, id);
  // Inside a feature the steps order the queue; once detached, the stored positions do.
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, [first, second, third]);
  const positions = rows(directory).map((row) => [row.number, row.queue_position, row.position, row.column_id]);
  assert.equal(store.apply(REPOSITORY, "feature_delete", { id: feature }).ok, true);
  assert.deepEqual(rows(directory).map((row) => [row.number, row.queue_position, row.position, row.column_id]), positions);
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual([...board.queue.order].sort(), [first, second, third]);
  const position = (id) => board.tasks.find((task) => task.id === id).position;
  assert.deepEqual(board.queue.order, board.queue.order.toSorted((a, b) => position(a) - position(b) || Number(a.slice(2)) - Number(b.slice(2))));
});

test("a feature with no task is deleted with its description and app version", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-feature-delete-");
  const empty = addFeature(store, "Empty", { description: "SECRET-CONTEXT", appVersion: "2.0" });
  const kept = addFeature(store, "Kept", { description: "kept" });
  const answer = store.apply(REPOSITORY, "feature_delete", { id: empty });
  assert.deepEqual(Object.keys(answer).sort(), ["board", "ok"]);
  assert.deepEqual(answer.board.features.map((feature) => feature.name), ["Kept"]);
  assert.equal(metaValue(directory, descriptionKey(empty)), null);
  assert.equal(metaValue(directory, appVersionKey(empty)), null);
  assert.equal(store.readFeature(REPOSITORY, kept).description, "kept");
  assert.doesNotMatch(JSON.stringify(answer), /SECRET-CONTEXT/u);
});

test("a task that has started and is not done refuses the delete and changes nothing", async (context) => {
  for (const [label, start] of [
    ["a linked session", (directory) => startedTask(directory, 2, { session: SESSION })],
    ["a live dispatch", (directory, clock) => startedTask(directory, 2, { mintedAt: clock.now })],
    ["needs review", (directory) => updateTask(directory, 2, { state: "needs_review" })],
    ["stalled", (directory) => updateTask(directory, 2, { state: "stalled" })],
    ["blocked by the agent", (directory) => updateTask(directory, 2, { state: "blocked" })],
  ]) {
    const { store, clock, directory, feature } = await populated(context);
    start(directory, clock);
    const before = { rows: rows(directory), features: featureRows(directory), description: metaValue(directory, descriptionKey(feature)), version: metaValue(directory, appVersionKey(feature)), board: store.readBoard(REPOSITORY) };
    assert.deepEqual(store.apply(REPOSITORY, "feature_delete", { id: feature }), { ok: false, error: "conflict" }, label);
    assert.deepEqual(rows(directory), before.rows, label);
    assert.deepEqual(featureRows(directory), before.features, label);
    assert.equal(metaValue(directory, descriptionKey(feature)), before.description);
    assert.equal(metaValue(directory, appVersionKey(feature)), before.version);
    assert.deepEqual(store.readBoard(REPOSITORY), before.board, label);
  }
});

test("a dispatch that is no longer live and a done task with a session do not block the delete", async (context) => {
  const { store, clock, directory, feature } = await populated(context);
  startedTask(directory, 2, { mintedAt: clock.now - 10 * 60 * 60 * 1000 });
  assert.equal(rows(directory).find((row) => row.number === 5).session_id, DONE_SESSION);
  assert.equal(store.apply(REPOSITORY, "feature_delete", { id: feature }).ok, true);
  assert.equal(rows(directory).some((row) => row.feature_id === feature), false);
});

test("the refusal follows the unfinished task: once it is done the feature can go", async (context) => {
  const { store, directory, feature } = await populated(context);
  startedTask(directory, 2, { session: "claude:1b8f2c1e-1111-4222-8333-444455556666" });
  assert.deepEqual(store.apply(REPOSITORY, "feature_delete", { id: feature }), { ok: false, error: "conflict" });
  updateTask(directory, 2, { state: "done" });
  assert.equal(store.apply(REPOSITORY, "feature_delete", { id: feature }).ok, true);
});

test("an unknown feature and another repository's feature are not found", async (context) => {
  const { store, directory, feature } = await populated(context);
  const before = rows(directory);
  assert.deepEqual(store.apply(REPOSITORY, "feature_delete", { id: UNKNOWN }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "feature_delete", { id: feature }), { ok: false, error: "not_found" });
  assert.deepEqual(rows(directory), before);
  assert.equal(featureId(store, "Uploads"), feature);
});

test("feature_delete takes the feature's ID and nothing else", async (context) => {
  const { store, directory, feature } = await populated(context);
  const before = rows(directory);
  for (const payload of [
    {}, { id: "Uploads" }, { id: "feat-xyz" }, { id: feature.toUpperCase() }, { id: 7 }, { id: null }, { id: feature, force: true }, { id: feature, name: "Uploads" }, { feature }, { feature: { id: feature } },
    null, "x", [], [feature],
  ]) assert.deepEqual(store.apply(REPOSITORY, "feature_delete", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(rows(directory), before);
  assert.equal(featureId(store, "Uploads"), feature);
  assert.deepEqual(normalizeFeatureDeletePayload({ id: feature }), { feature: { id: feature } });
  assert.equal(normalizeFeatureDeletePayload({ id: feature, extra: 1 }), undefined);
});

test("the agent's delete_feature keeps refusing a feature that holds a task", async (context) => {
  const { store, directory, feature, ids } = await populated(context);
  const before = rows(directory);
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_delete", { feature }), { ok: false, error: "conflict" });
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_delete", { feature: "Uploads" }), { ok: false, error: "conflict" });
  assert.deepEqual(rows(directory), before);
  // The owner's delete detaches the tasks; a feature with no task is still the agent's to delete.
  assert.equal(store.apply(REPOSITORY, "feature_delete", { id: feature }).ok, true);
  const empty = addFeature(store, "Empty");
  assert.equal(store.apply(REPOSITORY, "agent_feature_delete", { feature: empty }).ok, true);
  assert.equal(store.readBoard(REPOSITORY).tasks.some((task) => task.id === ids.idle), true);
});

test("a queue pause that names a detached task stays valid", async (context) => {
  const { store, directory, feature, ids } = await populated(context);
  setQueueRow(directory, "paused", ids.firstQueued);
  setMeta(directory, pauseReasonKey(), "worktree_dirty");
  const before = store.readBoard(REPOSITORY).queue;
  assert.deepEqual([before.status, before.blockedBy, before.pauseReason], ["paused", ids.firstQueued, "worktree_dirty"]);
  assert.equal(store.apply(REPOSITORY, "feature_delete", { id: feature }).ok, true);
  const after = store.readBoard(REPOSITORY).queue;
  assert.deepEqual([after.status, after.blockedBy, after.pauseReason], ["paused", ids.firstQueued, "worktree_dirty"]);
  assert.deepEqual(queueRow(directory), { queue_status: "paused", queue_blocked_by: ids.firstQueued });
  assert.equal(metaValue(directory, pauseReasonKey()), "worktree_dirty");
  assert.equal(after.order.includes(ids.firstQueued), true);
});

test("a delete that cannot finish writes nothing", async (context) => {
  const { store, directory, feature } = await populated(context);
  // A task row that no longer validates fails the projection that ends every write, so the whole delete is rolled back.
  updateTask(directory, 7, { text: "" });
  const before = { rows: rows(directory), features: featureRows(directory), description: metaValue(directory, descriptionKey(feature)) };
  assert.deepEqual(store.apply(REPOSITORY, "feature_delete", { id: feature }), { ok: false, error: "conflict" });
  assert.deepEqual(rows(directory), before.rows);
  assert.deepEqual(featureRows(directory), before.features);
  assert.equal(metaValue(directory, descriptionKey(feature)), before.description);
});

async function startRoute(context, store) {
  const server = http.createServer(createRequestHandler({ runtime: {}, taskStore: store, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function post(port, name, body, headers = { "x-pomegr-desktop-authorization": TOKEN, "content-type": "application/json" }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/internal/tasks/${name}`, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* text */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("feature_delete through the monitor route answers the fixed statuses", async (context) => {
  const { store, directory, feature } = await populated(context);
  const port = await startRoute(context, store);
  startedTask(directory, 2, { session: SESSION });
  const refused = await post(port, "feature_delete", { repositoryId: REPOSITORY, payload: { id: feature } });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { ok: false, error: "conflict" });
  assert.equal((await post(port, "feature_delete", { repositoryId: REPOSITORY, payload: { id: UNKNOWN } })).status, 404);
  assert.equal((await post(port, "feature_delete", { repositoryId: REPOSITORY, payload: { id: feature, force: true } })).status, 400);
  assert.equal((await post(port, "feature_delete", { repositoryId: REPOSITORY, payload: { id: feature } }, { "content-type": "application/json" })).status, 401);
  updateTask(directory, 2, { state: "done" });
  const deleted = await post(port, "feature_delete", { repositoryId: REPOSITORY, payload: { id: feature } });
  assert.equal(deleted.status, 200);
  assert.deepEqual(Object.keys(deleted.json).sort(), ["board", "ok"]);
  assert.doesNotMatch(deleted.text, /SECRET-CONTEXT|1\.4\.0/u);
  assert.equal(deleted.json.board.tasks.every((task) => task.featureId !== feature), true);
});

test("a detached waiting card of Ready joins the single tasks, after another feature's waiting cards", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-feature-delete-");
  const feature = addFeature(store, "Uploads");
  const later = addFeature(store, "Later");
  const first = addTask(store, "First", { featureId: feature, step: 1 });
  const second = addTask(store, "Second", { featureId: feature, step: 2 });
  const other = addTask(store, "Another feature's task", { featureId: later, step: 1 });
  const single = addTask(store, "A single task");
  for (const id of [first, second, other, single]) queueTask(store, id);
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, [first, second, other, single]);
  const before = rows(directory);

  assert.equal(store.apply(REPOSITORY, "feature_delete", { id: feature }).ok, true);

  // Ready reads in start order: the remaining feature first, then the single tasks by the place they held.
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(board.queue.order, [other, first, second, single]);
  const ready = board.tasks.filter((task) => board.queue.order.includes(task.id)).sort((a, b) => a.position - b.position).map((task) => task.id);
  assert.deepEqual(ready, [other, first, second, single]);
  const after = rows(directory);
  assert.deepEqual(after.map((row) => row.number), before.map((row) => row.number));
  // Only the place in Ready moves: the column, the state and the queue fields of every task hold.
  const kept = ({ position, feature_id, step, ...row }) => row;
  assert.deepEqual(after.map(kept), before.map(kept));
  assert.deepEqual(after.map((row) => row.position).sort(), before.map((row) => row.position).sort());
});
