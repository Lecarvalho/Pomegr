import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPO = `repo-${"a".repeat(24)}`;
const OTHER = `repo-${"b".repeat(24)}`;
const defaults = () => ({
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false, markDone: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false, followUps: true,
});
function setup(t) {
  const directory = mkdtempSync(path.join(process.cwd(), ".aril-test-"));
  const store = openTaskStore({ directory, now: () => 1700000000000 });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory, set: (settings, repo = REPO) => store.apply(repo, "aril_settings_set", { settings }) };
}
const EMPTY = { text: "", previous: null, updatedAt: null, updatedBy: null };
const invalid = (answer) => assert.deepEqual(answer, { ok: false, error: "invalid" });

test("board carries the settings settlement time without adding it to writable settings", (t) => {
  const { store, set } = setup(t);
  assert.equal(store.readBoard(REPO).aril.settings.settledAt, null);
  assert.equal(set({ mergeMethod: "merge" }).ok, true);
  assert.equal(store.readBoard(REPO).aril.settings.settledAt, "2023-11-14T22:13:20.000Z");
  invalid(set({ settledAt: "2023-11-14T22:13:20.000Z" }));
  assert.equal(store.readBoard(OTHER).aril.settings.settledAt, null);
});

test("plan rules accept only bounded repository-relative Markdown paths", (t) => {
  const { set } = setup(t);
  for (const value of ["next.md", "docs/plans/next-step_2.md", ".plans/v1.2.md", `${"a".repeat(197)}.md`]) {
    assert.equal(set({ workRules: [{ kind: "plan", value }] }).ok, true, value);
  }
  for (const value of ["", "/next.md", "C:/next.md", "docs\\next.md", "../next.md", "docs/../next.md", "./next.md", "docs/./next.md", "next.txt", "next.MD", "docs//next.md", "next.md\n", `${"a".repeat(198)}.md`, null]) {
    invalid(set({ workRules: [{ kind: "plan", value }] }));
  }
});

test("defaults, subset replacement, repository isolation and persistence", (t) => {
  const { store, directory, set } = setup(t);
  assert.deepEqual(store.readBoard(REPO).aril, { settings: { ...defaults(), settledAt: null }, memory: EMPTY, grant: null });
  assert.deepEqual(set({}), { ok: true, settings: defaults() });
  assert.equal(set({ actions: { ...defaults().actions, start: true }, pairedDevices: true }).ok, true);
  assert.deepEqual(set({ actions: defaults().actions }), { ok: true, settings: { ...defaults(), pairedDevices: true } });
  assert.deepEqual(store.readBoard(OTHER).aril, { settings: { ...defaults(), settledAt: null }, memory: EMPTY, grant: null });
  const again = openTaskStore({ directory });
  try { assert.equal(again.readBoard(REPO).aril.settings.pairedDevices, true); } finally { again.close(); }
  const leaked = store.readBoard(REPO).aril;
  leaked.settings.actions.start = true;
  assert.equal(store.readBoard(REPO).aril.settings.actions.start, false);
});

test("settings reject unknown keys and invalid whole fields without partial writes", (t) => {
  const { store, set } = setup(t);
  for (const settings of [null, [], 1, { unknown: true }, { actions: {} }, { actions: { ...defaults().actions, extra: false } },
    { limits: {} }, { limits: { hours: 1, starts: 1, concurrent: 1, sendBacks: 0, allowancePercent: 1 } },
    { reviewer: {} }, { pairedDevices: 1 }, { pairedDevices: null }, { followUps: null }, { followUps: "false" }, { workRules: {} }]) invalid(set(settings));
  for (const key of Object.keys(defaults().actions)) for (const value of [null, 0, "true"]) invalid(set({ actions: { ...defaults().actions, [key]: value } }));
  for (const payload of [{}, { settings: {}, extra: 1 }, { settings: [], text: "no" }]) invalid(store.apply(REPO, "aril_settings_set", payload));
  invalid(set({ pairedDevices: true, workRules: [{ kind: "unknown", value: "bad" }] }));
  assert.deepEqual(store.readBoard(REPO).aril.settings, { ...defaults(), settledAt: null });
});

test("follow-ups default on, switch off, and old stored settings read as on (T-183)", (t) => {
  const { store, directory, set } = setup(t);
  assert.equal(store.readBoard(REPO).aril.settings.followUps, true);
  assert.equal(set({ followUps: false }).settings.followUps, false);
  assert.equal(store.readBoard(REPO).aril.settings.followUps, false);
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try {
    database.prepare("UPDATE aril_settings SET value = ? WHERE repository_id = ?")
      .run(JSON.stringify(Object.fromEntries(Object.entries(defaults()).filter(([key]) => key !== "followUps"))), REPO);
  } finally { database.close(); }
  assert.equal(store.readBoard(REPO).aril.settings.followUps, true);
});

test("merge method accepts only the supported values and old stored settings read as repository default", (t) => {
  const { store, directory, set } = setup(t);
  for (const method of [null, "squash", "merge", "rebase"]) {
    assert.deepEqual(set({ mergeMethod: method }).settings.mergeMethod, method);
  }
  for (const method of [undefined, "", "fast-forward", 1, false, {}]) invalid(set({ mergeMethod: method }));
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try {
    database.prepare("UPDATE aril_settings SET value = ? WHERE repository_id = ?")
      .run(JSON.stringify(Object.fromEntries(Object.entries(defaults()).filter(([key]) => key !== "mergeMethod"))), REPO);
  } finally { database.close(); }
  assert.equal(store.readBoard(REPO).aril.settings.mergeMethod, null);
});

test("merge mode and branch deletion accept only their values, default to not settled, and old rows read the defaults", (t) => {
  const { store, directory, set } = setup(t);
  for (const mode of [null, "direct", "auto"]) assert.equal(set({ mergeMode: mode }).settings.mergeMode, mode);
  for (const value of [null, true, false]) assert.equal(set({ deleteBranch: value }).settings.deleteBranch, value);
  for (const mode of [undefined, "", "queue", "Direct", 1, true, {}]) invalid(set({ mergeMode: mode }));
  for (const value of [undefined, "true", 0, 1, "delete", {}]) invalid(set({ deleteBranch: value }));
  assert.equal(set({ mergeMode: "auto", deleteBranch: true }).ok, true);
  assert.deepEqual([store.readBoard(REPO).aril.settings.mergeMode, store.readBoard(REPO).aril.settings.deleteBranch], ["auto", true]);
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try {
    database.prepare("UPDATE aril_settings SET value = ? WHERE repository_id = ?")
      .run(JSON.stringify(Object.fromEntries(Object.entries(defaults()).filter(([key]) => !["mergeMode", "deleteBranch"].includes(key)))), REPO);
  } finally { database.close(); }
  assert.deepEqual([store.readBoard(REPO).aril.settings.mergeMode, store.readBoard(REPO).aril.settings.deleteBranch], [null, null]);
});

test("Mark done is its own boolean action, off by default, required with the other actions, and off in old rows (T-182)", (t) => {
  const { store, directory, set } = setup(t);
  assert.equal(store.readBoard(REPO).aril.settings.actions.markDone, false);
  assert.equal(set({ actions: { ...defaults().actions, markDone: true } }).settings.actions.markDone, true);
  const older = Object.fromEntries(Object.entries(defaults().actions).filter(([key]) => key !== "markDone"));
  for (const actions of [older, { ...defaults().actions, markDone: "yes" }, { ...defaults().actions, markDone: null }]) invalid(set({ actions }));
  assert.equal(store.readBoard(REPO).aril.settings.actions.markDone, true);
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try {
    database.prepare("UPDATE aril_settings SET value = ? WHERE repository_id = ?").run(JSON.stringify({ ...defaults(), actions: { ...older, merge: true } }), REPO);
  } finally { database.close(); }
  assert.deepEqual(store.readBoard(REPO).aril.settings.actions, { ...defaults().actions, merge: true });
});

test("every limit accepts null and inclusive integer bounds only", (t) => {
  const { set } = setup(t);
  for (const [key, min, max] of [["hours", 1, 72], ["tasks", 1, 100], ["tasksAtATime", 1, 10], ["sendBacks", 0, 10], ["usagePercent", 1, 100]]) {
    for (const value of [null, min, max]) assert.equal(set({ limits: { ...defaults().limits, [key]: value } }).ok, true);
    for (const value of [min - 1, max + 1, 1.5, "1", true]) invalid(set({ limits: { ...defaults().limits, [key]: value } }));
  }
  invalid(set({ limits: { ...defaults().limits, extra: null } }));
});

test("legacy grant limits migrate on read and write using the new names", (t) => {
  const { store, directory, set } = setup(t);
  set({});
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try {
    const legacy = { ...defaults(), limits: { hours: 4, starts: 8, concurrent: 2, sendBacks: 3, allowancePercent: 60 } };
    database.prepare("UPDATE aril_settings SET value = ? WHERE repository_id = ?").run(JSON.stringify(legacy), REPO);
  } finally { database.close(); }
  assert.deepEqual(store.readBoard(REPO).aril.settings.limits,
    { hours: 4, tasks: 8, tasksAtATime: 2, sendBacks: 3, usagePercent: 60 });
  assert.deepEqual(set({ pairedDevices: true }).settings.limits,
    { hours: 4, tasks: 8, tasksAtATime: 2, sendBacks: 3, usagePercent: 60 });
  const reopened = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  try {
    assert.deepEqual(JSON.parse(reopened.prepare("SELECT value FROM aril_settings WHERE repository_id = ?").get(REPO).value).limits,
      { hours: 4, tasks: 8, tasksAtATime: 2, sendBacks: 3, usagePercent: 60 });
  } finally { reopened.close(); }
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
  assert.equal(store.apply(REPO, "aril_memory_set", { text: "- Keep this" }).ok, true);
  assert.equal(store.apply(REPO, "delete", { id: "T-1" }).ok, true);
  assert.deepEqual(store.readBoard(REPO).aril.settings.workRules, [{ kind: "tasks", value: ["T-2"] }, { kind: "text", value: "Rule" }]);
  assert.equal(store.readBoard(OTHER).aril.settings.workRules.length, 3);
  assert.equal(store.readBoard(REPO).aril.memory.text, "- Keep this");
});

test("a repository's memory is free text the owner replaces whole: the text before is kept, with who and when, and it stays in its repository", (t) => {
  const { store } = setup(t);
  const set = (text, repo = REPO) => store.apply(repo, "aril_memory_set", { text });
  assert.deepEqual(store.readBoard(REPO).aril.memory, EMPTY);
  for (const text of ["a\0b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b", 5, null]) invalid(set(text));
  invalid(store.apply(REPO, "aril_memory_set", { text: "yes", extra: true }));
  invalid(store.apply(REPO, "aril_memory_set", {}));
  assert.deepEqual(set("a".repeat(6001)), { ok: false, error: "limit" });
  const first = set("- Docs in English.\r\n- One owner page per subject.\tTabs are fine.");
  assert.deepEqual(first, { ok: true, memory: { text: "- Docs in English.\n- One owner page per subject.\tTabs are fine.", previous: "", updatedAt: 1700000000000, updatedBy: "owner" } });
  assert.deepEqual(Object.keys(first).sort(), ["memory", "ok"]);
  assert.equal(set("b".repeat(6000)).ok, true, "6,000 characters fit");
  assert.deepEqual(store.readBoard(REPO).aril.memory, { text: "b".repeat(6000), previous: "- Docs in English.\n- One owner page per subject.\tTabs are fine.", updatedAt: 1700000000000, updatedBy: "owner" });
  assert.equal(set("b".repeat(6000)).memory.previous.startsWith("- Docs"), true, "the same text is not a change");
  assert.deepEqual(store.readBoard(OTHER).aril.memory, EMPTY);
  assert.equal(set("- Other repository.", OTHER).ok, true);
  assert.equal(store.readBoard(REPO).aril.memory.text, "b".repeat(6000));
  assert.equal(set("").ok, true, "the owner may empty it");
  assert.equal(store.readBoard(REPO).aril.memory.text, "");
  assert.deepEqual(Object.keys(store.readBoard(REPO).aril.memory).sort(), ["previous", "text", "updatedAt", "updatedBy"]);
  for (const retired of ["aril_memory_add", "aril_memory_update", "aril_memory_remove"]) assert.deepEqual(store.apply(REPO, retired, { text: "x" }), { ok: false, error: "unsupported" }, retired);
});

test("Aril's update is applied to the text as it is, written as Aril's, and bounded: too long, a line that is not there, and other shapes change nothing", (t) => {
  const { store, directory } = setup(t);
  const update = (payload, repo = REPO) => store.updateArilMemory(repo, payload);
  assert.deepEqual(update({ add: ["Docs in English."], remove: [] }), { ok: true, added: 1, removed: 0 }, "the first line starts a text");
  assert.deepEqual(store.readBoard(REPO).aril.memory, { text: "- Docs in English.", previous: "", updatedAt: 1700000000000, updatedBy: "aril" });
  assert.equal(store.apply(REPO, "aril_memory_set", { text: "- Docs in English.\nFree words." }).ok, true);
  assert.equal(store.readBoard(REPO).aril.memory.updatedBy, "owner");
  assert.deepEqual(update({ add: ["Plans merge at once."], remove: ["Docs in English."] }), { ok: true, added: 1, removed: 1 });
  assert.deepEqual(store.readBoard(REPO).aril.memory, { text: "Free words.\n- Plans merge at once.", previous: "- Docs in English.\nFree words.", updatedAt: 1700000000000, updatedBy: "aril" });
  assert.deepEqual(update({ add: ["Plans merge at once."], remove: [] }), { ok: true, added: 0, removed: 0 }, "nothing changes");
  assert.deepEqual(update({ add: [], remove: ["A line that is not there."] }), { ok: false, error: "not_found" });
  for (const bad of [{}, { add: [], remove: [] }, { add: ["x".repeat(301)], remove: [] }, { add: ["a\nb"], remove: [] }, { add: Array(11).fill("x"), remove: [] }, { add: ["x"], remove: [], scope: "owner" }, { add: "x", remove: [] }]) invalid(update(bad));
  assert.equal(store.apply(REPO, "aril_memory_set", { text: Array.from({ length: 20 }, () => `- ${"x".repeat(297)}`).join("\n") }).ok, true);
  assert.deepEqual(update({ add: ["y".repeat(300)], remove: [] }), { ok: false, error: "limit" }, "an update that would pass 6,000 characters changes nothing");
  assert.equal(store.readBoard(REPO).aril.memory.text.length, 5999);
  assert.deepEqual(store.readBoard(OTHER).aril.memory, EMPTY, "another repository is untouched");
  assert.deepEqual(update({ add: ["x"], remove: [] }, "not-a-repository"), { ok: false, error: "invalid" });
  void directory;
});

test("opening an existing version-one store adds the settings and memory tables without losing tasks", (t) => {
  const { store, directory } = setup(t);
  store.apply(REPO, "create", { text: "Existing" });
  store.close();
  const database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  database.exec("DROP TABLE IF EXISTS aril_settings; DROP TABLE IF EXISTS aril_memory; DROP TABLE IF EXISTS aril_memory_text;");
  database.close();
  const reopened = openTaskStore({ directory });
  try {
    assert.equal(reopened.readBoard(REPO).tasks[0].text, "Existing");
    assert.deepEqual(reopened.readBoard(REPO).aril, { settings: { ...defaults(), settledAt: null }, memory: EMPTY, grant: null });
    assert.equal(reopened.apply(REPO, "aril_memory_set", { text: "- New" }).ok, true);
    const inspect = new DatabaseSync(path.join(directory, "tasks.sqlite"));
    try { assert.equal(inspect.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1"); } finally { inspect.close(); }
  } finally { reopened.close(); }
});

test("the older memory lines become each repository's text once, oldest first, and stay readable until the text is written", (t) => {
  const { store, directory } = setup(t);
  store.apply(REPO, "create", { text: "Existing" });
  store.close();
  const file = path.join(directory, "tasks.sqlite");
  const insert = (database, repo, text, created, updated = created) => database.prepare("INSERT INTO aril_memory (repository_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)").run(repo, text, created, updated);
  let database = new DatabaseSync(file);
  insert(database, REPO, "Second line.", 2000, 5000);
  insert(database, REPO, "First line.", 1000);
  insert(database, REPO, "Third line.", 3000);
  insert(database, OTHER, "Other repository.", 1500);
  // The text cannot be written: the lines stay where they are and are read as the memory, so nothing is lost while the migration cannot finish.
  database.exec("CREATE TRIGGER block_memory_text BEFORE INSERT ON aril_memory_text BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
  database.close();
  let blocked = openTaskStore({ directory });
  try {
    assert.deepEqual(blocked.readBoard(REPO).aril.memory, { text: "- First line.\n- Second line.\n- Third line.", previous: null, updatedAt: 5000, updatedBy: "owner" });
    assert.equal(blocked.readBoard(OTHER).aril.memory.text, "- Other repository.");
  } finally { blocked.close(); }
  database = new DatabaseSync(file);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM aril_memory").get().n, 4, "the lines are still there");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM aril_memory_text").get().n, 0);
  database.exec("DROP TRIGGER block_memory_text");
  database.close();
  const migrated = openTaskStore({ directory });
  try {
    assert.deepEqual(migrated.readBoard(REPO).aril.memory, { text: "- First line.\n- Second line.\n- Third line.", previous: null, updatedAt: 5000, updatedBy: "owner" });
    assert.equal(migrated.readBoard(OTHER).aril.memory.text, "- Other repository.");
  } finally { migrated.close(); }
  database = new DatabaseSync(file);
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM aril_memory").get().n, 0, "the text was written and the lines went in the same transaction");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM aril_memory_text").get().n, 2);
  } finally { database.close(); }
  // Opening again migrates nothing and changes nothing.
  const again = openTaskStore({ directory });
  try { assert.equal(again.readBoard(REPO).aril.memory.text, "- First line.\n- Second line.\n- Third line."); } finally { again.close(); }
});

test("lines that do not fit one text become the newest lines that fit, and the whole is kept as the text before", (t) => {
  const { store, directory } = setup(t);
  store.apply(REPO, "create", { text: "Existing" });
  store.close();
  let database = new DatabaseSync(path.join(directory, "tasks.sqlite"));
  for (let index = 0; index < 100; index += 1) database.prepare("INSERT INTO aril_memory (repository_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)").run(REPO, `${index}`.padEnd(300, "x"), index, index);
  database.close();
  const reopened = openTaskStore({ directory });
  try {
    const memory = reopened.readBoard(REPO).aril.memory;
    assert.ok(memory.text.length <= 6000);
    assert.equal(memory.previous.split("\n").length, 100, "nothing is lost");
    assert.ok(memory.text.endsWith(memory.previous.split("\n").at(-1)), "the newest line is kept");
    assert.equal(memory.updatedBy, "owner");
  } finally { reopened.close(); }
});
