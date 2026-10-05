import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionHistoryStore } from "../../../../server/sessions/history/session-history-store.mjs";

// Unassociated tool calls: the `unassociated=1` activity filter pages tool calls whose recorded request
// is null, and `unassociatedTotal` counts them for the scope. Split from session-history-store.test.mjs,
// which is at the repository's file-size limit.
const request = (id, observedAt, agentId = "primary") => ({
  id: `request-${id}`, agentId, observedAt, cacheLifetime: null,
  uncachedInputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, totalTokens: 10,
  precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null,
});
const REQUESTS = [
  request("1a1a1a1a1a1a1a1a", "2026-09-14T00:00:00Z"), request("2b2b2b2b2b2b2b2b", "2026-09-14T00:01:00Z"),
  request("3c3c3c3c3c3c3c3c", "2026-09-14T00:02:00Z", "child"),
];
const [R1, R2, R3] = REQUESTS.map((item) => item.id);
const NON_CALL_TOOLS = new Set(["User input", "Assistant replied", "Task completed", "Shell failed"]);
const FAILED_SHELL = { tool: "Bash", workKind: "shell", status: "failed", durationMs: 30 };
// Oldest first, one second apart: [id, agent, request, tool, row fields]. Linked calls, ten unassociated
// primary calls (a failed shell among them), three unassociated child calls, and non-call rows with a null request.
const SPEC = [
  ["row-input", "primary", R1, "User input", { workKind: "input" }], ["lk-1", "primary", R1],
  ["u-01", "primary", null], ["u-02", "primary", null], ["uc-1", "child", null], ["u-03", "primary", null],
  ["row-reply", "primary", null, "Assistant replied", { workKind: "reply", detail: "" }], ["lk-2", "primary", R2],
  ["u-04", "primary", null, "Bash", FAILED_SHELL], ["uc-2", "child", null],
  ["row-notice", "primary", null, "Task completed", { workKind: "agent" }], ["u-05", "primary", null],
  ["lk-3", "child", R3], ["u-06", "primary", null], ["u-07", "primary", null], ["uc-3", "child", null],
  ["row-shell-failed", "primary", null, "Shell failed", { workKind: "shell", status: "failed" }],
  ["u-08", "primary", null], ["u-09", "primary", null], ["u-10", "primary", null],
  ["row-child-reply", "child", null, "Assistant replied", { workKind: "reply", detail: "" }],
];
const ROWS = SPEC.map(([id, agentId, requestId, tool = "Read", fields = {}], index) => ({
  id, timestamp: `2026-09-14T01:00:${String(index).padStart(2, "0")}Z`, actor: "Agent", tool, workKind: "read",
  detail: "Safe label", status: null, durationMs: null, requestId, agentId, ...fields,
}));
const inScope = (row, scope) => scope === "all" || (scope === "primary" ? row.agentId === "primary" : row.agentId !== "primary");
const unassociatedIds = (scope) => ROWS.filter((row) => inScope(row, scope) && row.requestId === null && !NON_CALL_TOOLS.has(row.tool)).map((row) => row.id);

async function assertUnassociatedHistory(reader, id) {
  const read = (query) => reader.read(id, { kind: "activity", ...query });
  for (const scope of ["all", "primary", "subagents", "child"]) {
    const expected = unassociatedIds(scope);
    const plain = await read({ scope });
    assert.equal(plain.unassociatedTotal, expected.length, `${scope} count`);
    assert.equal(plain.total, ROWS.filter((row) => inScope(row, scope)).length, "the unfiltered feed still lists every row");
    const lastOffset = Math.floor((expected.length - 1) / 8) * 8;
    for (const [query, offset] of [[{}, 0], [{ offset: "8" }, 8], [{ offset: "latest" }, lastOffset], [{ limit: "500" }, 0]]) {
      if (offset >= expected.length) continue;
      const page = await read({ scope, unassociated: "1", ...query });
      assert.equal(page.status, "ready");
      assert.equal(page.total, expected.length, `${scope} filtered total`);
      assert.equal(page.unassociatedTotal, expected.length);
      assert.equal(page.offset, offset, `${scope} ${JSON.stringify(query)} offset`);
      assert.deepEqual(page.items.map((item) => item.id), expected.slice(offset, offset + 8), `${scope} ${JSON.stringify(query)} items`);
      for (const item of page.items) {
        assert.equal(item.requestId, null); assert.equal(NON_CALL_TOOLS.has(item.tool), false);
        assert.equal(Object.hasOwn(item, "call"), false, "the marker stays monitor-private");
      }
      // Request groups, counts and revision do not depend on the filter.
      for (const field of ["requestGroups", "range", "requestTotal", "callTotal", "byKind", "shellTasks", "revision"])
        assert.deepEqual(page[field], plain[field], `${scope} ${field} is independent of unassociated=1`);
    }
    // Linked calls plus unassociated calls are the scope's tool calls.
    let linked = 0;
    for (const item of REQUESTS) {
      const group = await read({ scope, filterRequestId: item.id });
      linked += group.items.filter((row) => !NON_CALL_TOOLS.has(row.tool)).length;
    }
    const toolCalls = plain.byKind.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(toolCalls, ROWS.filter((row) => inScope(row, scope) && !NON_CALL_TOOLS.has(row.tool)).length);
    assert.equal(linked + plain.unassociatedTotal, toolCalls, `${scope} linked plus unassociated`);
  }
  const everything = await read({ scope: "all", unassociated: "1" });
  assert.equal(everything.items.find((item) => item.id === "u-04").status, "failed", "a failed unassociated call stays listed");
  assert.deepEqual(everything.shellTasks, { total: 1, failed: 1 });
  assert.deepEqual((await read({ unassociated: "0" })).items, (await read({})).items, "only 1 selects the filter");
  const requests = await reader.read(id, { kind: "requests", unassociated: "1" });
  assert.equal(requests.total, REQUESTS.length, "kind=requests ignores the filter");
  assert.equal(Object.hasOwn(requests, "unassociatedTotal"), false);
}

for (const storage of ["memory", "disk index", "block store"]) {
  test(`unassociated tool calls page with an exact scoped count (${storage})`, async (t) => {
    const directory = storage === "memory" ? null : await mkdtemp(path.join(os.tmpdir(), "pomegr-history-unassociated-"));
    if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
    const id = `codex:unassociated-${storage.replace(" ", "-")}`;
    const store = new SessionHistoryStore({ directory });
    if (storage === "block store") await store.publishRequestContribution(id, { epoch: 1, sequence: 1, requests: REQUESTS, activity: ROWS });
    else await store.publish(id, { requests: REQUESTS, activity: ROWS, complete: true });
    await assertUnassociatedHistory(directory ? new SessionHistoryStore({ directory }) : store, id);
    if (storage === "block store") assert.ok((await readdir(directory)).some((name) => name.endsWith(".history.sqlite")), "served through the block store");
  });
}

test("an unavailable activity feed counts zero unassociated calls", async () => {
  const unavailable = await new SessionHistoryStore().read("codex:unassociated-missing", { kind: "activity", unassociated: "1" });
  assert.equal(unavailable.status, "unavailable"); assert.equal(unavailable.unassociatedTotal, 0); assert.equal(unavailable.total, 0);
});

test("an index committed before the filter serves it without a rebuild", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-unassociated-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = async () => Promise.all((await readdir(directory, { recursive: true })).sort().map(async (name) => {
    try { return [name, (await readFile(path.join(directory, name))).toString("base64")]; } catch { return [name, null]; }
  }));

  const indexed = new SessionHistoryStore({ directory });
  await indexed.publish("codex:legacy-disk-index", { requests: REQUESTS, activity: ROWS, complete: true });
  const before = await files();
  const revision = (await new SessionHistoryStore({ directory }).read("codex:legacy-disk-index", { kind: "activity" })).revision;
  await assertUnassociatedHistory(new SessionHistoryStore({ directory }), "codex:legacy-disk-index");
  assert.deepEqual(await files(), before, "the committed index and blocks are untouched, with no rebuild");
  assert.equal((await new SessionHistoryStore({ directory }).read("codex:legacy-disk-index", { kind: "activity" })).revision, revision);

  // A block-store ref written before the tool-call marker is classified by its row label.
  const blocks = new SessionHistoryStore({ directory });
  await blocks.publishRequestContribution("codex:legacy-blocks", { epoch: 1, sequence: 1, requests: REQUESTS, activity: ROWS });
  const location = path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".history.sqlite")));
  const db = new DatabaseSync(location);
  db.exec("UPDATE rows SET ref=json_remove(ref,'$.call'), data=json_remove(data,'$.call') WHERE kind='activity'");
  db.close();
  const sqlite = await readFile(location);
  await assertUnassociatedHistory(new SessionHistoryStore({ directory }), "codex:legacy-blocks");
  assert.ok(sqlite.equals(await readFile(location)), "reads never rewrite the committed rows");
});

test("a disk index ref written before the tool-call marker is never unassociated", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-history-unassociated-unmarked-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await new SessionHistoryStore({ directory }).publish("codex:unmarked-disk-index", { requests: REQUESTS, activity: ROWS, complete: true });
  const location = path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".index.json")));
  const index = JSON.parse(await readFile(location, "utf8"));
  assert.ok(index.activity.length === ROWS.length && index.activity.every((ref) => typeof ref.call === "boolean"));
  // The pre-marker shape: the ref keeps its request but cannot say whether the row is a tool call.
  for (const ref of index.activity) delete ref.call;
  await writeFile(location, JSON.stringify(index), "utf8");
  const reader = new SessionHistoryStore({ directory });
  const page = await reader.read("codex:unmarked-disk-index", { kind: "activity", unassociated: "1" });
  assert.equal(page.status, "ready");
  assert.deepEqual(page.items, [], "user input, replies and notices never page as unassociated calls");
  assert.equal(page.total, 0); assert.equal(page.unassociatedTotal, 0);
  const plain = await reader.read("codex:unmarked-disk-index", { kind: "activity" });
  assert.equal(plain.unassociatedTotal, 0); assert.equal(plain.total, ROWS.length, "the unfiltered feed still lists every row");
});
