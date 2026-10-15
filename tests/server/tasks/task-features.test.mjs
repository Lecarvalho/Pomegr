import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TASK_BOUNDS } from "../../../server/tasks/task-record.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER_REPOSITORY = `repo-${"b2".repeat(12)}`;
const UNKNOWN_FEATURE = `feat-${"0".repeat(12)}`;

async function temporaryStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-features-"));
  const store = openTaskStore({ directory });
  t.after(async () => {
    store.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return { store, databasePath: path.join(directory, "tasks.sqlite") };
}

function markDone(databasePath, number) {
  const database = new DatabaseSync(databasePath);
  try { database.prepare("UPDATE tasks SET state = 'done' WHERE number = ?").run(number); } finally { database.close(); }
}

function addFeature(store, name, repository = REPOSITORY) {
  const before = new Set(store.readBoard(repository).features.map((feature) => feature.id));
  const result = store.apply(repository, "feature_create", { name });
  assert.equal(result.ok, true, name);
  return result.board.features.find((feature) => !before.has(feature.id)).id;
}

const addTask = (store, payload, repository = REPOSITORY) => store.apply(repository, "create", { text: "task", ...payload });
const placement = (board) => board.tasks.map((task) => [task.id, task.featureId]);

test("feature_create lists an empty feature as not done and generates a feat id", async (t) => {
  const { store } = await temporaryStore(t);
  const result = store.apply(REPOSITORY, "feature_create", { name: "  Search  " });
  assert.equal(result.ok, true);
  assert.equal(result.board.features.length, 1);
  assert.match(result.board.features[0].id, /^feat-[0-9a-f]{12}$/u);
  assert.deepEqual([result.board.features[0].name, result.board.features[0].done], ["Search", false]);
  const second = store.apply(REPOSITORY, "feature_create", { name: "Billing" });
  assert.deepEqual(second.board.features.map((feature) => feature.name), ["Search", "Billing"]);
});

test("feature_create bounds the name, the keys, the count, and duplicates", async (t) => {
  const { store } = await temporaryStore(t);
  const invalid = [{}, { name: "" }, { name: "   " }, { name: "two\nlines" }, { name: "x".repeat(81) }, { name: 7 }, { name: "ok", extra: 1 }, null, "name"];
  for (const payload of invalid) assert.deepEqual(store.apply(REPOSITORY, "feature_create", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.equal(store.apply(REPOSITORY, "feature_create", { name: "x".repeat(80) }).ok, true);
  assert.deepEqual(store.apply(REPOSITORY, "feature_create", { name: "x".repeat(80) }), { ok: false, error: "conflict" });
  // The same name in another repository is not a duplicate.
  assert.equal(store.apply(OTHER_REPOSITORY, "feature_create", { name: "x".repeat(80) }).ok, true);
  for (let count = 1; count < TASK_BOUNDS.featuresPerRepository; count += 1) assert.equal(store.apply(REPOSITORY, "feature_create", { name: `Feature ${count}` }).ok, true);
  assert.deepEqual(store.apply(REPOSITORY, "feature_create", { name: "One too many" }), { ok: false, error: "limit" });
  assert.equal(store.readBoard(REPOSITORY).features.length, TASK_BOUNDS.featuresPerRepository);
});

test("create attaches a task to a feature or to none, and a feature gives it no step", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  addTask(store, { featureId: null });
  addTask(store, {});
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(placement(board), [["T-1", feature], ["T-2", feature], ["T-3", null], ["T-4", null]]);
  assert.deepEqual(board.tasks.map((task) => [Object.hasOwn(task, "step"), task.group]), Array(4).fill([false, null]));
});

test("create validates the feature and the key shapes, and a step is no key", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  const foreign = addFeature(store, "Other", OTHER_REPOSITORY);
  for (const step of [undefined, null, 0, 1, 2, "1"]) {
    assert.deepEqual(addTask(store, { featureId: feature, step }), { ok: false, error: "invalid" }, String(step));
  }
  assert.deepEqual(addTask(store, { featureId: feature, group: "grp-000000000001" }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: 7 }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: "feat-short" }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: UNKNOWN_FEATURE }), { ok: false, error: "not_found" });
  assert.deepEqual(addTask(store, { featureId: foreign }), { ok: false, error: "not_found" });
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 0);
});

test("a feature is done only when the owner marks it, whatever the states of its tasks", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  const flag = () => store.readBoard(REPOSITORY).features.find((candidate) => candidate.id === feature).done;
  assert.equal(flag(), false);
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  markDone(databasePath, 1);
  markDone(databasePath, 2);
  // Every task done no longer makes the feature done: it still takes a task.
  assert.equal(flag(), false);
  assert.equal(addTask(store, { featureId: feature }).ok, true);
  // An empty feature can be marked done.
  const empty = addFeature(store, "Empty");
  assert.equal(store.apply(REPOSITORY, "feature_update", { id: empty, done: true }).ok, true);
  assert.equal(store.readBoard(REPOSITORY).features.find((candidate) => candidate.id === empty).done, true);
});

test("a feature marked done with open tasks refuses new tasks and leaves its tasks untouched, until it is reopened", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  const open = addFeature(store, "Open");
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  addTask(store, { featureId: open });
  markDone(databasePath, 1);
  assert.equal(store.apply(REPOSITORY, "queue_add", { id: "T-2" }).ok, true);
  const before = store.readBoard(REPOSITORY);

  const marked = store.apply(REPOSITORY, "feature_update", { id: feature, done: true });
  assert.deepEqual(Object.keys(marked).filter((key) => key !== "board"), ["ok"]);
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(board.features.map((candidate) => [candidate.name, candidate.done]), [["Search", true], ["Open", false]]);
  // Nothing moves, unqueues, changes state, or is deleted.
  const cards = (snapshot) => snapshot.tasks.map((task) => [task.id, task.featureId, task.columnId, task.position, task.state, task.updatedAt]);
  assert.deepEqual(cards(board), cards(before));
  assert.deepEqual(board.queue.order, before.queue.order);
  // The details stay as they were.
  assert.deepEqual(store.readFeature(REPOSITORY, feature), { id: feature, title: "Search", description: null, appVersion: null });

  // A done feature takes no new task, on create, by update, or through the agent's add.
  assert.deepEqual(addTask(store, { featureId: feature }), { ok: false, error: "conflict" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-4", featureId: feature }), { ok: false, error: "conflict" });
  assert.deepEqual(store.apply(REPOSITORY, "agent_create", { sessionId: "session-a", task: { text: "late", featureId: feature } }), { ok: false, error: "conflict" });
  // A task already in it keeps it, and an edit of that task still works.
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-3", text: "renamed" }).ok, true);
  assert.equal(store.readBoard(REPOSITORY).tasks.find((task) => task.id === "T-3").featureId, feature);
  // Editing the other fields keeps the flag.
  assert.equal(store.apply(REPOSITORY, "feature_update", { id: feature, name: "Search done" }).ok, true);
  assert.equal(store.readBoard(REPOSITORY).features[0].done, true);

  assert.equal(store.apply(REPOSITORY, "feature_update", { id: feature, done: false }).ok, true);
  assert.equal(store.readBoard(REPOSITORY).features[0].done, false);
  assert.equal(addTask(store, { featureId: feature }).ok, true);
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-4", featureId: feature }).ok, true);
});

test("only the desktop feature_update takes done; the agent's feature actions refuse it", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  for (const done of [1, "true", null, {}]) {
    assert.deepEqual(store.apply(REPOSITORY, "feature_update", { id: feature, done }), { ok: false, error: "invalid" }, JSON.stringify(done));
  }
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_update", { feature, done: true }), { ok: false, error: "invalid" });
  assert.deepEqual(store.apply(REPOSITORY, "agent_feature_create", { title: "Other", done: true }), { ok: false, error: "invalid" });
  assert.equal(store.readBoard(REPOSITORY).features[0].done, false);
  // Deleting a done feature drops its flag with it.
  assert.equal(store.apply(REPOSITORY, "feature_update", { id: feature, done: true }).ok, true);
  assert.equal(store.apply(REPOSITORY, "feature_delete", { id: feature }).ok, true);
  assert.deepEqual(store.readBoard(REPOSITORY).features, []);
});

test("update attaches, detaches, and moves between features without moving the card", async (t) => {
  const { store } = await temporaryStore(t);
  const a = addFeature(store, "A");
  const b = addFeature(store, "B");
  for (let count = 0; count < 3; count += 1) addTask(store, { featureId: a });
  addTask(store, { featureId: b });
  addTask(store, {});
  const positions = (board) => board.tasks.map((task) => [task.id, task.columnId, task.position]);
  const before = store.readBoard(REPOSITORY);
  let board = store.apply(REPOSITORY, "update", { id: "T-2", featureId: b }).board;
  assert.deepEqual(placement(board), [["T-1", a], ["T-2", b], ["T-3", a], ["T-4", b], ["T-5", null]]);
  board = store.apply(REPOSITORY, "update", { id: "T-5", featureId: a }).board;
  assert.equal(board.tasks[4].featureId, a);
  board = store.apply(REPOSITORY, "update", { id: "T-1", featureId: null }).board;
  assert.equal(board.tasks[0].featureId, null);
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-1", featureId: null }).ok, true);
  assert.deepEqual(positions(board), positions(before));
  // Another task's update time stays when it is not the one edited.
  assert.equal(board.tasks.find((task) => task.id === "T-4").updatedAt, before.tasks.find((task) => task.id === "T-4").updatedAt);
  // Text edits alone leave the feature untouched.
  assert.deepEqual(placement(store.apply(REPOSITORY, "update", { id: "T-5", text: "renamed" }).board).at(-1), ["T-5", a]);
  // A step is no key of an update.
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-2", step: 1 }), { ok: false, error: "invalid" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: null, step: null }), { ok: false, error: "invalid" });
});

test("update to an unknown or foreign feature is not_found for an unknown or foreign feature", async (t) => {
  const { store } = await temporaryStore(t);
  const foreign = addFeature(store, "Foreign", OTHER_REPOSITORY);
  addTask(store, {});
  const before = store.readBoard(REPOSITORY);
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: foreign }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: UNKNOWN_FEATURE }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: "nope" }), { ok: false, error: "invalid" });
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});

test("delete leaves the other tasks of the feature as they are, and the empty feature stays", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  for (let count = 0; count < 3; count += 1) addTask(store, { featureId: feature });
  assert.deepEqual(placement(store.apply(REPOSITORY, "delete", { id: "T-2" }).board), [["T-1", feature], ["T-3", feature]]);
  store.apply(REPOSITORY, "delete", { id: "T-1" });
  const emptied = store.apply(REPOSITORY, "delete", { id: "T-3" });
  assert.equal(emptied.board.features.length, 1);
  assert.equal(addTask(store, { featureId: feature }).ok, true);
});
