import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { serveSessionDirectoryWithTasks } from "../../../server/serving/session-directory-tasks.mjs";
import { createSessionCatalogInventory } from "../../../server/sessions/catalog/session-catalog-inventory.mjs";
import { OTHER_REPOSITORY, REPOSITORY, createTask, openTemporaryStore, startedTask, updateTask, withDatabase } from "./queue-test-support.mjs";

const DESKTOP = "d".repeat(40);
const session = (index) => `claude:session-${index}`;
const SECRET_TEXT = "SECRET-TASK-TEXT";

function createFeature(store, name, repositoryId = REPOSITORY) {
  const result = store.apply(repositoryId, "feature_create", { name });
  assert.equal(result.ok, true);
  return result.board.features.find((feature) => feature.name === name).id;
}

/** Two features and one plain task in one repository, each task linked to a session, plus a task with no session. */
async function linkedStore(context) {
  const env = await openTemporaryStore(context, "pomegr-task-link-");
  const board = createFeature(env.store, "Task board v1");
  const search = createFeature(env.store, "Search");
  createTask(env.store, REPOSITORY, { text: SECRET_TEXT, featureId: board, step: 1 });
  createTask(env.store, REPOSITORY, { text: SECRET_TEXT, featureId: board, step: 2 });
  createTask(env.store, REPOSITORY, { text: SECRET_TEXT, featureId: search, step: 1 });
  createTask(env.store, REPOSITORY, { text: SECRET_TEXT });
  createTask(env.store, REPOSITORY, { text: SECRET_TEXT, featureId: search, step: 1 });
  startedTask(env.directory, 1, { session: session(1), state: "done" });
  startedTask(env.directory, 2, { session: session(2), state: "needs_review" });
  startedTask(env.directory, 3, { session: session(3), state: "queued" });
  startedTask(env.directory, 4, { session: session(4), state: "stalled" });
  return { ...env, board, search };
}

function catalog(count = 6) {
  const inventory = createSessionCatalogInventory({ providers: ["claude"] });
  inventory.updateHeaders("claude", Array.from({ length: count }, (_, index) => ({
    localId: `session-${index}`, title: `Session ${index}`, project: "Pomegr", createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    updatedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(), isLive: index === 2, needsInput: false, activityStatus: index === 2 ? "working" : "idle",
  })));
  return { serveSessionDirectory: (query) => inventory.directory(query), observationActive: () => true };
}

test("a session's task reference carries only the ID, repository, outcome state, feature and step", async (t) => {
  const { store, board, search } = await linkedStore(t);
  const references = store.sessionTasks([session(1), session(2), session(3), session(4), session(5), session(1), 7, null]);
  assert.deepEqual([...references], [
    [session(1), { id: "T-1", repositoryId: REPOSITORY, state: "done", featureId: board, feature: "Task board v1", step: 1 }],
    [session(2), { id: "T-2", repositoryId: REPOSITORY, state: "needs_review", featureId: board, feature: "Task board v1", step: 2 }],
    // A state the session's own state already shows is served as null.
    [session(3), { id: "T-3", repositoryId: REPOSITORY, state: null, featureId: search, feature: "Search", step: 1 }],
    [session(4), { id: "T-4", repositoryId: REPOSITORY, state: "stalled", featureId: null, feature: null, step: null }],
  ]);
  assert.equal(JSON.stringify([...references]).includes(SECRET_TEXT), false);
});

test("blocked is an outcome state; not queued, queued and scheduled are not", async (t) => {
  const { store, directory } = await linkedStore(t);
  for (const [state, served] of [["blocked", "blocked"], ["not_queued", null], ["queued", null], ["scheduled", null]]) {
    updateTask(directory, 1, { state });
    assert.equal(store.sessionTasks([session(1)]).get(session(1)).state, served, state);
  }
});

test("a feature's sessions and the feature groups read only linked tasks", async (t) => {
  const { store, board, search } = await linkedStore(t);
  assert.deepEqual(store.featureSessions(board), { id: board, name: "Task board v1", sessionIds: [session(1), session(2)] });
  assert.deepEqual(store.featureSessions(search), { id: search, name: "Search", sessionIds: [session(3)] });
  for (const unknown of ["feat-000000000000", "", "Task board v1", null, 7, `${board}'`]) assert.equal(store.featureSessions(unknown), null);
  const groups = store.featureSessionGroups();
  assert.deepEqual([...groups.members].sort(), [[session(1), board], [session(2), board], [session(3), search]]);
  assert.deepEqual([...groups.labels].sort(), [[board, "Task board v1"], [search, "Search"]].sort());
});

test("a feature name that no longer validates is served as no feature", async (t) => {
  const { store, directory, board } = await linkedStore(t);
  withDatabase(directory, (database) => database.prepare("UPDATE features SET name = ? WHERE id = ?").run("two\nlines", board));
  assert.deepEqual(store.sessionTasks([session(1)]).get(session(1)), { id: "T-1", repositoryId: REPOSITORY, state: "done", featureId: null, feature: null, step: null });
  assert.equal(store.featureSessions(board), null);
  assert.equal(store.featureSessionGroups().labels.has(board), false);
});

test("a closed store answers null and never throws", async (t) => {
  const { store, board } = await linkedStore(t);
  store.close();
  assert.equal(store.sessionTasks([session(1)]), null);
  assert.equal(store.featureSessions(board), null);
  assert.equal(store.featureSessionGroups(), null);
});

test("an allowed directory page joins the task reference, and a session with no task has null", async (t) => {
  const { store } = await linkedStore(t);
  const page = serveSessionDirectoryWithTasks({ runtime: catalog(), taskStore: store, allowed: true, query: { filter: "all", pageSize: 25 } });
  assert.equal(page.taskReadiness, "ready");
  assert.equal(page.matchedCount, 6);
  assert.deepEqual(page.sessions.map((row) => [row.id, row.task?.id ?? null, row.task?.state ?? null]), [
    [session(5), null, null], [session(4), "T-4", "stalled"], [session(3), "T-3", null], [session(2), "T-2", "needs_review"], [session(1), "T-1", "done"], [session(0), null, null],
  ]);
  assert.equal(JSON.stringify(page).includes(SECRET_TEXT), false);
});

test("a client that is not allowed gets the list with no task key, and a feature scope matches nothing", async (t) => {
  const { store, board } = await linkedStore(t);
  const runtime = catalog();
  const plain = serveSessionDirectoryWithTasks({ runtime, taskStore: store, allowed: false, query: { filter: "all", pageSize: 25 } });
  assert.equal(plain.taskReadiness, "desktop_only");
  assert.equal(plain.sessions.length, 6);
  assert.ok(plain.sessions.every((row) => !("task" in row)));
  const filtered = serveSessionDirectoryWithTasks({ runtime, taskStore: store, allowed: false, feature: board, query: { filter: "all", pageSize: 25 } });
  assert.deepEqual([filtered.taskReadiness, filtered.matchedCount, filtered.sessions, "feature" in filtered], ["desktop_only", 0, [], false]);
  const grouped = serveSessionDirectoryWithTasks({ runtime, taskStore: store, allowed: false, groupFeature: true, query: { filter: "all", pageSize: 25 } });
  assert.deepEqual([grouped.taskReadiness, grouped.groupBy, grouped.groups, grouped.groupCount, grouped.matchedCount], ["desktop_only", "feature", [], 0, 0]);
  assert.equal(JSON.stringify([plain, filtered, grouped]).includes("Task board v1"), false);
});

test("no task store is unavailable, never an unfiltered list for a feature scope", async (t) => {
  const { board } = await linkedStore(t);
  const runtime = catalog();
  const plain = serveSessionDirectoryWithTasks({ runtime, taskStore: null, allowed: true, query: { filter: "all", pageSize: 25 } });
  assert.deepEqual([plain.taskReadiness, plain.sessions.length], ["unavailable", 6]);
  const filtered = serveSessionDirectoryWithTasks({ runtime, taskStore: null, allowed: true, feature: board, query: { filter: "all", pageSize: 25 } });
  assert.deepEqual([filtered.taskReadiness, filtered.matchedCount], ["unavailable", 0]);
});

test("the feature filter narrows the page and names the feature; an unknown feature matches nothing", async (t) => {
  const { store, board } = await linkedStore(t);
  const runtime = catalog();
  const page = serveSessionDirectoryWithTasks({ runtime, taskStore: store, allowed: true, feature: board, query: { filter: "all", pageSize: 25 } });
  assert.deepEqual(page.feature, { id: board, name: "Task board v1" });
  assert.deepEqual([page.matchedCount, page.sessions.map((row) => row.id)], [2, [session(2), session(1)]]);
  // The catalog's own scopes still apply inside the feature.
  const live = serveSessionDirectoryWithTasks({ runtime, taskStore: store, allowed: true, feature: board, query: { filter: "live", pageSize: 25 } });
  assert.deepEqual(live.sessions.map((row) => row.id), [session(2)]);
  const unknown = serveSessionDirectoryWithTasks({ runtime, taskStore: store, allowed: true, feature: "feat-000000000000", query: { filter: "all", pageSize: 25 } });
  assert.deepEqual([unknown.feature, unknown.matchedCount, unknown.taskReadiness], [null, 0, "ready"]);
});

test("grouping by feature lists only sessions started for a feature task", async (t) => {
  const { store, board, search } = await linkedStore(t);
  const page = serveSessionDirectoryWithTasks({ runtime: catalog(), taskStore: store, allowed: true, groupFeature: true, query: { filter: "all", pageSize: 25 } });
  assert.deepEqual([page.groupBy, page.groupCount, page.matchedCount, page.sessions, page.nextCursor], ["feature", 2, 3, [], null]);
  // Groups follow their newest-created session, like the project and provider groups.
  assert.deepEqual(page.groups.map((group) => [group.key, group.label, group.count, group.live, group.sessions.map((row) => [row.id, row.task.id])]), [
    [search, "Search", 1, 0, [[session(3), "T-3"]]],
    [board, "Task board v1", 2, 1, [[session(2), "T-2"], [session(1), "T-1"]]],
  ]);
});

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("GET /api/sessions joins task references only for a marked same-computer read", async (t) => {
  const { store, board } = await linkedStore(t);
  const server = await listen(createRequestHandler({ runtime: catalog(), taskStore: store, authorizationToken: DESKTOP }));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async (query, headers = { "x-pomegr-desktop-authorization": DESKTOP }) => {
    const response = await fetch(`${origin}/api/sessions?mode=directory&${query}`, { headers });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  };
  const marked = await read("tasks=1");
  assert.deepEqual([marked.status, marked.cache, marked.body.taskReadiness], [200, "no-store", "ready"]);
  assert.equal(marked.body.sessions.find((row) => row.id === session(2)).task.feature, "Task board v1");
  assert.equal((await fetch(`${origin}/api/sessions?mode=directory&tasks=1`)).status, 401);
  // No marker: the list, and no task reference.
  for (const denied of [await read(""), await read("filter=all")]) {
    assert.equal(denied.status, 200);
    assert.equal(denied.body.taskReadiness, "desktop_only");
    assert.equal(JSON.stringify(denied.body).includes("Task board v1"), false);
    assert.ok(denied.body.sessions.every((row) => !("task" in row)));
  }
  const filtered = await read(`tasks=1&feature=${board}`);
  assert.deepEqual([filtered.body.matchedCount, filtered.body.feature.name], [2, "Task board v1"]);
  assert.equal((await read(`feature=${board}`)).body.matchedCount, 0);
  const grouped = await read("tasks=1&group=feature");
  assert.deepEqual([grouped.body.groupBy, grouped.body.groups.length], ["feature", 2]);
  for (const invalid of ["tasks=2", "feature=Task%20board", "feature=feat-XYZ", "group=task", `feature=${board}&feature=${board}`]) assert.equal((await read(invalid)).status, 400, invalid);
  for (const body of [marked.body, filtered.body, grouped.body]) assert.equal(JSON.stringify(body).includes(SECRET_TEXT), false);
});

test("a task in another repository links by session, not by repository", async (t) => {
  const { store, directory } = await linkedStore(t);
  createTask(store, OTHER_REPOSITORY, { text: SECRET_TEXT });
  startedTask(directory, 1, { session: session(0), state: "done", repositoryId: OTHER_REPOSITORY });
  assert.deepEqual(store.sessionTasks([session(0)]).get(session(0)), { id: "T-1", repositoryId: OTHER_REPOSITORY, state: "done", featureId: null, feature: null, step: null });
});
