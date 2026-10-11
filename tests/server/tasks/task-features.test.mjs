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
const tasksOf = (board, featureId) => board.tasks.filter((task) => task.featureId === featureId).map((task) => task.id);

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

test("create places a task in a feature by feature ID only, and a task carries no step", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  addTask(store, { featureId: null });
  addTask(store, {});
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(placement(board), [["T-1", feature], ["T-2", feature], ["T-3", null], ["T-4", null]]);
  for (const task of board.tasks) assert.equal(Object.hasOwn(task, "step"), false);
  // The cards keep the order they were created in, which is the order the feature's tasks run.
  assert.deepEqual(tasksOf(board, feature), ["T-1", "T-2"]);
});

test("create validates the feature and the key shapes, and refuses a step key", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  const foreign = addFeature(store, "Other", OTHER_REPOSITORY);
  for (const step of [undefined, null, 0, 1, 2, -1, 1.5, "1", Number.NaN]) {
    assert.deepEqual(addTask(store, { featureId: feature, step }), { ok: false, error: "invalid" }, String(step));
  }
  assert.deepEqual(addTask(store, { step: 1 }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: null, step: 1 }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: 7 }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: "feat-short" }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: UNKNOWN_FEATURE }), { ok: false, error: "not_found" });
  assert.deepEqual(addTask(store, { featureId: foreign }), { ok: false, error: "not_found" });
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 0);
});

test("the stored step column is 1 beside a feature and NULL without, and the board never serves it", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  addTask(store, {});
  const stored = () => {
    const database = new DatabaseSync(databasePath);
    try { return database.prepare("SELECT number, step FROM tasks ORDER BY number").all().map((row) => [row.number, row.step]); } finally { database.close(); }
  };
  assert.deepEqual(stored(), [[1, 1], [2, 1], [3, null]]);
  store.apply(REPOSITORY, "update", { id: "T-3", featureId: feature });
  store.apply(REPOSITORY, "update", { id: "T-1", featureId: null });
  assert.deepEqual(stored(), [[1, null], [2, 1], [3, 1]]);
  assert.equal(JSON.stringify(store.readBoard(REPOSITORY)).includes("step"), false);
});

test("the done flag is false for an empty or mixed feature and true once every task is done", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  const flag = () => store.readBoard(REPOSITORY).features.find((candidate) => candidate.id === feature).done;
  assert.equal(flag(), false);
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  markDone(databasePath, 1);
  assert.equal(flag(), false);
  markDone(databasePath, 2);
  assert.equal(flag(), true);
  // A done feature accepts no new task, on create or from another feature.
  const open = addFeature(store, "Open");
  addTask(store, { featureId: open });
  assert.deepEqual(addTask(store, { featureId: feature }), { ok: false, error: "conflict" });
  assert.equal(addTask(store, {}).ok, true);
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-4", featureId: feature }), { ok: false, error: "conflict" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-3", featureId: feature }), { ok: false, error: "conflict" });
  // A done task has started, so it is no longer edited inside its own feature either.
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-2", featureId: feature, text: "renamed" }), { ok: false, error: "conflict" });
  assert.deepEqual(tasksOf(store.readBoard(REPOSITORY), feature), ["T-1", "T-2"]);
  assert.equal(flag(), true);
});

test("update attaches, detaches, and moves between features by feature ID", async (t) => {
  const { store } = await temporaryStore(t);
  const a = addFeature(store, "A");
  const b = addFeature(store, "B");
  for (let count = 0; count < 3; count += 1) addTask(store, { featureId: a });
  addTask(store, { featureId: b });
  addTask(store, {});
  let board = store.apply(REPOSITORY, "update", { id: "T-2", featureId: b }).board;
  assert.deepEqual(placement(board), [["T-1", a], ["T-2", b], ["T-3", a], ["T-4", b], ["T-5", null]]);
  // A loose task attaches to a feature.
  board = store.apply(REPOSITORY, "update", { id: "T-5", featureId: a }).board;
  assert.deepEqual(tasksOf(board, a), ["T-1", "T-3", "T-5"]);
  // Detaching leaves the rest of the old feature alone.
  board = store.apply(REPOSITORY, "update", { id: "T-1", featureId: null }).board;
  assert.equal(board.tasks[0].featureId, null);
  assert.deepEqual(tasksOf(board, a), ["T-3", "T-5"]);
  // A text edit alone leaves the feature untouched, and a task keeps no step.
  board = store.apply(REPOSITORY, "update", { id: "T-5", text: "renamed" }).board;
  assert.equal(board.tasks.at(-1).featureId, a);
  assert.equal(Object.hasOwn(board.tasks.at(-1), "step"), false);
});

test("update refuses a step key and answers not_found for an unknown or foreign feature", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  const foreign = addFeature(store, "Foreign", OTHER_REPOSITORY);
  addTask(store, {});
  addTask(store, { featureId: feature });
  const before = store.readBoard(REPOSITORY);
  for (const payload of [{ step: 1 }, { step: -2 }, { step: null }, { featureId: feature, step: 1 }, { featureId: null, step: null }]) {
    assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", ...payload }), { ok: false, error: "invalid" }, JSON.stringify(payload));
  }
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: foreign }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: UNKNOWN_FEATURE }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: "nope" }), { ok: false, error: "invalid" });
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});

test("delete leaves the other tasks of the feature in place", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  for (let count = 0; count < 3; count += 1) addTask(store, { featureId: feature });
  assert.deepEqual(placement(store.apply(REPOSITORY, "delete", { id: "T-2" }).board), [["T-1", feature], ["T-3", feature]]);
  store.apply(REPOSITORY, "delete", { id: "T-1" });
  const emptied = store.apply(REPOSITORY, "delete", { id: "T-3" });
  assert.equal(emptied.board.features.length, 1);
  // The empty feature stays and takes a task again.
  addTask(store, { featureId: feature });
  assert.deepEqual(tasksOf(store.readBoard(REPOSITORY), feature), ["T-4"]);
});
