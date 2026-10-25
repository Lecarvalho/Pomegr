import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPO = `repo-${"a".repeat(24)}`;
const OTHER = `repo-${"b".repeat(24)}`;
const defaults = () => ({
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false },
  limits: { hours: null, starts: null, concurrent: null, sendBacks: null, allowancePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false,
});
function setup(t) {
  const directory = mkdtempSync(path.join(process.cwd(), ".aril-test-"));
  const store = openTaskStore({ directory, now: () => 1700000000000 });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory, set: (settings, repo = REPO) => store.apply(repo, "aril_settings_set", { settings }) };
}
const invalid = (answer) => assert.deepEqual(answer, { ok: false, error: "invalid" });

test("defaults, subset replacement, repository isolation and persistence", (t) => {
  const { store, directory, set } = setup(t);
  assert.deepEqual(store.readBoard(REPO).aril, { settings: defaults(), memory: [] });
  assert.deepEqual(set({}), { ok: true, settings: defaults() });
  assert.equal(set({ actions: { ...defaults().actions, start: true }, pairedDevices: true }).ok, true);
  assert.deepEqual(set({ actions: defaults().actions }), { ok: true, settings: { ...defaults(), pairedDevices: true } });
  assert.deepEqual(store.readBoard(OTHER).aril, { settings: defaults(), memory: [] });
  const again = openTaskStore({ directory });
  try { assert.equal(again.readBoard(REPO).aril.settings.pairedDevices, true); } finally { again.close(); }
  const leaked = store.readBoard(REPO).aril;
  leaked.settings.actions.start = true;
  assert.equal(store.readBoard(REPO).aril.settings.actions.start, false);
});

test("settings reject unknown keys and invalid whole fields without partial writes", (t) => {
  const { store, set } = setup(t);
  for (const settings of [null, [], 1, { unknown: true }, { actions: {} }, { actions: { ...defaults().actions, extra: false } },
    { limits: {} }, { reviewer: {} }, { pairedDevices: 1 }, { pairedDevices: null }, { workRules: {} }]) invalid(set(settings));
  for (const key of Object.keys(defaults().actions)) for (const value of [null, 0, "true"]) invalid(set({ actions: { ...defaults().actions, [key]: value } }));
  for (const payload of [{}, { settings: {}, extra: 1 }, { settings: [], text: "no" }]) invalid(store.apply(REPO, "aril_settings_set", payload));
  invalid(set({ pairedDevices: true, workRules: [{ kind: "unknown", value: "bad" }] }));
  assert.deepEqual(store.readBoard(REPO).aril.settings, defaults());
});

test("every limit accepts null and inclusive integer bounds only", (t) => {
  const { set } = setup(t);
  for (const [key, min, max] of [["hours", 1, 72], ["starts", 1, 100], ["concurrent", 1, 10], ["sendBacks", 0, 10], ["allowancePercent", 1, 100]]) {
    for (const value of [null, min, max]) assert.equal(set({ limits: { ...defaults().limits, [key]: value } }).ok, true);
    for (const value of [min - 1, max + 1, 1.5, "1", true]) invalid(set({ limits: { ...defaults().limits, [key]: value } }));
  }
  invalid(set({ limits: { ...defaults().limits, extra: null } }));
});

test("reviewer uses task model validation and nullable provider, with an explicit boolean", (t) => {
  const { set } = setup(t);
  for (const provider of [null, "claude", "codex"]) assert.equal(set({ reviewer: { provider, model: null, differentFromBuilder: true } }).ok, true);
  for (const model of ["gpt-6", "a".repeat(120)]) assert.equal(set({ reviewer: { provider: "codex", model, differentFromBuilder: false } }).ok, true);
  for (const reviewer of [{ ...defaults().reviewer, provider: "other" }, { ...defaults().reviewer, differentFromBuilder: 1 },
    { ...defaults().reviewer, extra: 1 }, ...["a".repeat(121), "../x", "two words", "x\nname", 5].map((model) => ({ provider: "codex", model, differentFromBuilder: false }))]) invalid(set({ reviewer }));
});

test("work rules validate parser tags, one-line text, existing feature and task IDs, and bounds", (t) => {
  const { store, set } = setup(t);
  const feature = store.apply(REPO, "feature_create", { name: "Feature" }).board.features[0].id;
  for (let i = 0; i < 50; i++) assert.equal(store.apply(REPO, "create", { text: `Task ${i}` }).ok, true);
  const taskIds = store.readBoard(REPO).tasks.map((task) => task.id);
  const rules = [{ kind: "tag", value: "tech-debt" }, { kind: "text", value: "a".repeat(80) }, { kind: "feature", value: feature }, { kind: "tasks", value: taskIds }];
  assert.deepEqual(set({ workRules: rules }).settings.workRules, rules);
  for (const value of ["a", "a".repeat(40), "cafe\u0301"]) assert.equal(set({ workRules: [{ kind: "tag", value }] }).ok, true);
  for (const value of ["", "two words", "a".repeat(41), "[tag]", "image", "a\n", "a/b"]) invalid(set({ workRules: [{ kind: "tag", value }] }));
  for (const value of ["", "a".repeat(81), "a\nb", "a\rb", "a\u2028b", "a\0b", 1]) invalid(set({ workRules: [{ kind: "text", value }] }));
  for (const rule of [null, {}, { kind: "tag", value: "x", extra: 1 }, { kind: "feature", value: "feat-000000000000" },
    { kind: "tasks", value: [] }, { kind: "tasks", value: ["T-51"] }, { kind: "tasks", value: [...taskIds, "T-1"] }, { kind: "tasks", value: "T-1" }]) invalid(set({ workRules: [rule] }));
  assert.equal(set({ workRules: Array.from({ length: 20 }, () => rules[0]) }).ok, true);
  invalid(set({ workRules: Array.from({ length: 21 }, () => rules[0]) }));
  invalid(set({ workRules: [{ kind: "feature", value: feature }] }, OTHER));
  invalid(set({ workRules: [{ kind: "tasks", value: ["T-1"] }] }, OTHER));
});

test("task deletion prunes task rules and retains unrelated settings and memory", (t) => {
  const { store, set } = setup(t);
  for (const repo of [REPO, OTHER]) {
    store.apply(repo, "create", { text: "First" }); store.apply(repo, "create", { text: "Second" });
    assert.equal(set({ workRules: [{ kind: "tasks", value: ["T-1", "T-2"] }, { kind: "tasks", value: ["T-1"] }, { kind: "text", value: "Rule" }] }, repo).ok, true);
  }
  assert.equal(store.apply(REPO, "aril_memory_add", { text: "Keep this" }).ok, true);
  assert.equal(store.apply(REPO, "delete", { id: "T-1" }).ok, true);
  assert.deepEqual(store.readBoard(REPO).aril.settings.workRules, [{ kind: "tasks", value: ["T-2"] }, { kind: "text", value: "Rule" }]);
  assert.equal(store.readBoard(OTHER).aril.settings.workRules.length, 3);
  assert.equal(store.readBoard(REPO).aril.memory[0].text, "Keep this");
});

test("memory CRUD, ordering, fixed answers, repository isolation, limits and line rules", (t) => {
  const { store } = setup(t);
  const apply = (action, payload, repo = REPO) => store.apply(repo, `aril_memory_${action}`, payload);
  for (const text of ["", " ", "a".repeat(301), "a\nb", "a\rb", "a\tb", "a\0b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b", 5]) invalid(apply("add", { text }));
  invalid(apply("add", { text: "yes", extra: true }));
  const first = apply("add", { text: "a".repeat(300) });
  assert.deepEqual(Object.keys(first).sort(), ["entry", "ok"]);
  assert.deepEqual(first.entry, { id: 1, text: "a".repeat(300), createdAt: 1700000000000, updatedAt: 1700000000000 });
  assert.equal(apply("add", { text: "other" }, OTHER).ok, true);
  for (const action of ["update", "remove"]) {
    assert.deepEqual(apply(action, { id: first.entry.id, ...(action === "update" ? { text: "edit" } : {}) }, OTHER), { ok: false, error: "not_found" });
    for (const id of [0, -1, 1.5, "1", null]) invalid(apply(action, { id, ...(action === "update" ? { text: "edit" } : {}) }));
  }
  invalid(apply("update", { id: 1, text: "bad\nline" }));
  const updated = apply("update", { id: 1, text: "Changed" });
  assert.deepEqual(updated, { ok: true, entry: { ...first.entry, text: "Changed" } });
  for (let i = 1; i < 100; i++) assert.equal(apply("add", { text: `Entry ${i}` }).ok, true);
  assert.deepEqual(apply("add", { text: "Overflow" }), { ok: false, error: "limit" });
  assert.equal(apply("update", { id: 1, text: "At limit" }).ok, true);
  const memory = store.readBoard(REPO).aril.memory;
  assert.equal(memory.length, 100);
  assert.deepEqual(memory.map((entry) => entry.id), memory.map((entry) => entry.id).toSorted((a, b) => a - b));
  assert.deepEqual(apply("remove", { id: 1 }), { ok: true });
  assert.deepEqual(apply("remove", { id: 1 }), { ok: false, error: "not_found" });
  assert.equal(apply("add", { text: "Room again" }).ok, true);
  assert.equal(store.readBoard(OTHER).aril.memory.length, 1);
});

test("opening an existing version-one store adds both tables without losing tasks", (t) => {
  const { store, directory } = setup(t);
  store.apply(REPO, "create", { text: "Existing" });
  store.close();
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  database.exec("DROP TABLE IF EXISTS aril_settings; DROP TABLE IF EXISTS aril_memory;");
  database.close();
  const reopened = openTaskStore({ directory });
  try {
    assert.equal(reopened.readBoard(REPO).tasks[0].text, "Existing");
    assert.deepEqual(reopened.readBoard(REPO).aril, { settings: defaults(), memory: [] });
    assert.equal(reopened.apply(REPO, "aril_memory_add", { text: "New" }).ok, true);
    const inspect = new DatabaseSync(path.join(directory, "tasks.sqlite"));
    try { assert.equal(inspect.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1"); } finally { inspect.close(); }
  } finally { reopened.close(); }
});

test("memory updates keep creation time and survive reopening in original creation order", (t) => {
  const { store, directory } = setup(t);
  store.close();
  let at = 1700000000000;
  const timed = openTaskStore({ directory, now: () => at });
  try {
    const first = timed.apply(REPO, "aril_memory_add", { text: "First" }).entry;
    at += 1000;
    const second = timed.apply(REPO, "aril_memory_add", { text: "Second" }).entry;
    at += 1000;
    assert.deepEqual(timed.apply(REPO, "aril_memory_update", { id: first.id, text: "Updated" }).entry,
      { ...first, text: "Updated", updatedAt: at });
    timed.close();
    const reopened = openTaskStore({ directory });
    try { assert.deepEqual(reopened.readBoard(REPO).aril.memory, [{ ...first, text: "Updated", updatedAt: at }, second]); } finally { reopened.close(); }
  } finally { timed.close(); }
});
