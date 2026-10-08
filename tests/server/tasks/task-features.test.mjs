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
const placement = (board) => board.tasks.map((task) => [task.id, task.step]);
const steps = (board, featureId) => board.tasks.filter((task) => task.featureId === featureId).map((task) => task.step);

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

test("create defaults to a new last step and an explicit step joins an existing one", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature, step: 2 });
  addTask(store, { featureId: feature, step: 1 });
  addTask(store, { featureId: feature, step: null });
  addTask(store, {});
  addTask(store, { featureId: null });
  assert.deepEqual(placement(store.readBoard(REPOSITORY)), [["T-1", 1], ["T-2", 2], ["T-3", 2], ["T-4", 1], ["T-5", 3], ["T-6", null], ["T-7", null]]);
});

test("create validates the step bounds, the feature, and the key shapes", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  const foreign = addFeature(store, "Other", OTHER_REPOSITORY);
  for (const step of [0, -1, 1.5, "1", 2, 9, Number.NaN]) {
    assert.deepEqual(addTask(store, { featureId: feature, step }), { ok: false, error: "invalid" }, String(step));
  }
  addTask(store, { featureId: feature });
  assert.deepEqual(addTask(store, { featureId: feature, step: 3 }), { ok: false, error: "invalid" });
  assert.equal(addTask(store, { featureId: feature, step: 2 }).ok, true);
  assert.deepEqual(addTask(store, { step: 1 }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: null, step: 1 }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: 7 }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: "feat-short" }), { ok: false, error: "invalid" });
  assert.deepEqual(addTask(store, { featureId: UNKNOWN_FEATURE }), { ok: false, error: "not_found" });
  assert.deepEqual(addTask(store, { featureId: foreign }), { ok: false, error: "not_found" });
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 2);
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
  // A task stays free to move inside its own done feature.
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-2", step: 1 }).ok, true);
  assert.deepEqual(steps(store.readBoard(REPOSITORY), feature), [1, 1]);
  assert.equal(flag(), true);
});

test("update moves a task inside its feature, renumbers, and leaves other update times alone", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  for (let count = 0; count < 3; count += 1) addTask(store, { featureId: feature });
  const before = store.readBoard(REPOSITORY);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // T-1 jumps to the new last step; the emptied step 1 disappears and the rest close up.
  const moved = store.apply(REPOSITORY, "update", { id: "T-1", step: 4 });
  assert.deepEqual(placement(moved.board), [["T-1", 3], ["T-2", 1], ["T-3", 2]]);
  const updatedAt = (board, id) => board.tasks.find((task) => task.id === id).updatedAt;
  for (const id of ["T-2", "T-3"]) assert.equal(updatedAt(moved.board, id), updatedAt(before, id), id);
  assert.notEqual(updatedAt(moved.board, "T-1"), updatedAt(before, "T-1"));
  // The task's own feature ID names the same kind of move.
  assert.deepEqual(placement(store.apply(REPOSITORY, "update", { id: "T-1", featureId: feature, step: 1 }).board), [["T-1", 1], ["T-2", 1], ["T-3", 2]]);
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-2", step: 9 }), { ok: false, error: "invalid" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-2", step: 0 }), { ok: false, error: "invalid" });
});

test("update attaches, detaches, and moves between features, renumbering both", async (t) => {
  const { store } = await temporaryStore(t);
  const a = addFeature(store, "A");
  const b = addFeature(store, "B");
  for (let count = 0; count < 3; count += 1) addTask(store, { featureId: a });
  addTask(store, { featureId: b });
  addTask(store, {});
  // Moving T-2 (A, step 2) to B defaults to B's new last step; A closes the gap.
  let board = store.apply(REPOSITORY, "update", { id: "T-2", featureId: b }).board;
  assert.deepEqual(board.tasks.map((task) => [task.id, task.featureId, task.step]), [["T-1", a, 1], ["T-2", b, 2], ["T-3", a, 2], ["T-4", b, 1], ["T-5", null, null]]);
  // An explicit step joins an existing one in the other feature.
  board = store.apply(REPOSITORY, "update", { id: "T-3", featureId: b, step: 1 }).board;
  assert.deepEqual(board.tasks.map((task) => [task.id, task.featureId, task.step]), [["T-1", a, 1], ["T-2", b, 2], ["T-3", b, 1], ["T-4", b, 1], ["T-5", null, null]]);
  // A loose task attaches to a new last step.
  board = store.apply(REPOSITORY, "update", { id: "T-5", featureId: a }).board;
  assert.deepEqual([board.tasks[4].featureId, board.tasks[4].step], [a, 2]);
  // Detaching clears the step and closes the gap in the old feature.
  board = store.apply(REPOSITORY, "update", { id: "T-1", featureId: null }).board;
  assert.deepEqual([board.tasks[0].featureId, board.tasks[0].step], [null, null]);
  assert.deepEqual(steps(board, a), [1]);
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: null, step: 1 }), { ok: false, error: "invalid" });
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-1", featureId: null, step: null }).ok, true);
  // Text edits alone leave the placement untouched.
  assert.deepEqual(placement(store.apply(REPOSITORY, "update", { id: "T-5", text: "renamed" }).board).at(-1), ["T-5", 1]);
});

test("update placement is invalid without a feature and not_found for an unknown or foreign feature", async (t) => {
  const { store } = await temporaryStore(t);
  const foreign = addFeature(store, "Foreign", OTHER_REPOSITORY);
  addTask(store, {});
  const before = store.readBoard(REPOSITORY);
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", step: 1 }), { ok: false, error: "invalid" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: foreign }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: UNKNOWN_FEATURE }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", featureId: "nope" }), { ok: false, error: "invalid" });
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-1", step: -2 }), { ok: false, error: "invalid" });
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});

test("delete renumbers the steps of the feature the task leaves", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  for (let count = 0; count < 3; count += 1) addTask(store, { featureId: feature });
  assert.deepEqual(placement(store.apply(REPOSITORY, "delete", { id: "T-2" }).board), [["T-1", 1], ["T-3", 2]]);
  store.apply(REPOSITORY, "delete", { id: "T-1" });
  const emptied = store.apply(REPOSITORY, "delete", { id: "T-3" });
  assert.equal(emptied.board.features.length, 1);
  // The empty feature stays and takes a first task at step 1.
  addTask(store, { featureId: feature });
  assert.deepEqual(steps(store.readBoard(REPOSITORY), feature), [1]);
});
