import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DESKTOP_AUTH_HEADER } from "../../../shared/local-auth.mjs";
import {
  TASK_GATE_TREE_LIMIT, TASK_GATE_TREE_MAX_AGE_MS, TASK_GATE_TREE_REFRESH_MS, TASK_GATE_USAGE_MAX_AGE_MS,
  createTaskGateFacts, createTaskTreeObservation, gateProviderStatusFact, gateUsageFact,
} from "../../../server/runtime/task-gate-facts.mjs";
import { createTaskLookups } from "../../../server/runtime/task-start-lookup.mjs";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { GATE_REASONS, GATE_THRESHOLDS, projectGates } from "../../../server/serving/task-routes.mjs";
import { TASK_GATE_REASONS, TASK_GATE_THRESHOLDS } from "../../../server/tasks/task-gates.mjs";
import {
  FACTS, GATE_FACTS, REPOSITORY, createTask, metaValue, openTemporaryStore, passingGates, queueRow, queueSettings, queueTask, repositoryNumber,
  setMeta, storedDispatch, updateTask,
} from "./queue-test-support.mjs";

const TOKEN = "t".repeat(43);
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const SECRET_ROOT = "C:/Work/SECRET-ROOT/repo";
const thresholdKey = (repositoryId = REPOSITORY) => `queue_gate_threshold:${repositoryId}`;
const gatesWith = (changes) => () => ({ ...GATE_FACTS, ...changes });
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A running queue with `count` queued tasks. */
function runningQueue(store, count = 1, payload = {}) {
  for (let index = 0; index < count; index += 1) createTask(store, REPOSITORY, payload);
  for (let index = 1; index <= count; index += 1) queueTask(store, `T-${index}`);
  assert.equal(queueSettings(store, true).ok, true);
}

async function startHandler(context, { taskStore, runtime }) {
  const server = http.createServer(createRequestHandler({ runtime, taskStore, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const send = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { [DESKTOP_AUTH_HEADER]: TOKEN, ...(init.headers || {}) } });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) };
  };
  const post = (action, body) => send(`/internal/tasks/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { board: () => send(`/api/tasks?repositoryId=${REPOSITORY}`), post };
}

test("the route's mirrored gate constants match the rule module", () => {
  assert.deepEqual([...GATE_THRESHOLDS], [...TASK_GATE_THRESHOLDS]);
  assert.deepEqual([...GATE_REASONS], [...TASK_GATE_REASONS]);
});

test("a board read with gate facts carries the readings and why the next task waits; without a resolver it carries none", async (context) => {
  const { store } = await openTemporaryStore(context);
  createTask(store, REPOSITORY, { run: { provider: "codex", model: null, effort: null } });
  assert.equal(Object.hasOwn(store.readBoard(REPOSITORY).queue, "gates"), false);
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.gates, {
    threshold: 85,
    usage: { claude: { status: "ok", fiveHourPercent: 10, sevenDayPercent: 10 }, codex: { status: "ok", fiveHourPercent: 10, sevenDayPercent: 10 } },
    providerStatus: { claude: "ok", codex: "ok" },
    workingTree: "clean",
    next: null,
  });
  queueTask(store, "T-1");
  const facts = gatesWith({ usage: { ...GATE_FACTS.usage, codex: { fiveHourPercent: 91, sevenDayPercent: 40 } }, treeClean: false });
  const { gates } = store.readBoard(REPOSITORY, { resolveGateFacts: facts }).queue;
  assert.deepEqual(gates.next, { taskId: "T-1", provider: "codex", blockedBy: null, reasons: ["usage_over", "tree_dirty"] });
  assert.deepEqual(gates.usage.codex, { status: "over", fiveHourPercent: 91, sevenDayPercent: 40 });
  // The board a mutation answers carries the same block.
  assert.deepEqual(store.apply(REPOSITORY, "queue_settings", { on: true }, { resolveGateFacts: facts }).board.queue.gates, gates);
});

test("a resolver that throws or answers junk reads every gate unknown and never fails the read", async (context) => {
  const { store } = await openTemporaryStore(context);
  runningQueue(store);
  for (const resolveGateFacts of [() => { throw new Error("boom"); }, () => null, () => "facts", () => ({ usage: 1, providerStatus: [], treeClean: "yes" })]) {
    const board = store.readBoard(REPOSITORY, { resolveGateFacts });
    assert.equal(board.readiness, "ready");
    assert.deepEqual(board.queue.gates.next.reasons, ["usage_unknown", "provider_status_unknown", "tree_unknown"]);
    assert.deepEqual(store.nextQueueStarts({ resolveGateFacts }), { ok: true, starts: [] });
  }
});

test("the next task names the earlier step it waits on", async (context) => {
  const { store } = await openTemporaryStore(context);
  const feature = store.apply(REPOSITORY, "feature_create", { name: "Feature" }).board.features[0].id;
  createTask(store, REPOSITORY, { featureId: feature, step: 1 });
  createTask(store, REPOSITORY, { featureId: feature, step: 2 });
  queueTask(store, "T-2");
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.gates.next,
    { taskId: "T-2", provider: "claude", blockedBy: "T-1", reasons: ["previous_step"] });
  assert.equal(queueSettings(store, true).ok, true);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  assert.deepEqual(store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates), { ok: false, error: "gate_held" });
});

test("a held gate keeps the queue running and the task queued, and the start is answered once the gate opens", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningQueue(store);
  for (const held of [
    gatesWith({ usage: { ...GATE_FACTS.usage, claude: { fiveHourPercent: 85, sevenDayPercent: 1 } } }),
    gatesWith({ usage: { ...GATE_FACTS.usage, claude: null } }),
    gatesWith({ providerStatus: { claude: "incident", codex: "operational" } }),
    gatesWith({ providerStatus: { claude: null, codex: "operational" } }),
    gatesWith({ treeClean: false }),
    gatesWith({ treeClean: null }),
    null,
  ]) {
    assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: held }), { ok: true, starts: [] });
    assert.deepEqual({ ...queueRow(directory) }, { queue_status: "running", queue_blocked_by: null });
    assert.equal(store.readBoard(REPOSITORY).tasks[0].state, "queued");
  }
  // The other provider's trouble does not hold a Claude Code task.
  const codexTrouble = gatesWith({ usage: { ...GATE_FACTS.usage, codex: null }, providerStatus: { claude: "operational", codex: "incident" } });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: codexTrouble }), { ok: true, starts: [{ repositoryId: REPOSITORY, taskId: "T-1" }] });
});

test("a manual start the gates hold is gate_held and mints nothing", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  for (const held of [gatesWith({ treeClean: false }), gatesWith({ usage: null }), () => { throw new Error("boom"); }, null, undefined]) {
    assert.deepEqual(store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, held), { ok: false, error: "gate_held" });
    assert.equal(storedDispatch(directory, 1), null);
  }
  // The earlier refusals still answer first, so a gate says nothing about a task that could not start anyway.
  assert.equal(store.planStart(REPOSITORY, { id: "T-1" }, () => ({ root: SECRET_ROOT, pluginReady: false }), null).error, "plugin_missing");
  assert.equal(store.planStart(REPOSITORY, { id: "T-9" }, () => FACTS, null).error, "not_found");
  assert.equal(store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates).ok, true);
});

test("the threshold is one fixed choice per repository, kept in meta, and changes nothing else", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningQueue(store);
  assert.equal(metaValue(directory, thresholdKey()), null);
  assert.equal(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.gates.threshold, 85);
  for (const threshold of [70, 95, 85]) {
    const result = store.apply(REPOSITORY, "queue_settings", { threshold }, { resolveGateFacts: passingGates });
    assert.equal(result.ok, true);
    assert.equal(result.board.queue.gates.threshold, threshold);
    assert.equal(result.board.queue.status, "running");
    assert.equal(metaValue(directory, thresholdKey()), String(threshold));
  }
  for (const payload of [{ threshold: 80 }, { threshold: "85" }, { threshold: null }, { threshold: 85, on: true }, { on: true, threshold: 85 }, {}]) {
    assert.deepEqual(store.apply(REPOSITORY, "queue_settings", payload), { ok: false, error: "invalid" });
  }
  // Another repository keeps the default, and a malformed stored value is the default too.
  assert.equal(store.readBoard(repositoryNumber(7), { resolveGateFacts: passingGates }).queue.gates.threshold, 85);
  setMeta(directory, thresholdKey(), "C:\\not-a-threshold");
  assert.equal(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.gates.threshold, 85);
});

test("the threshold decides the start", async (context) => {
  const { store } = await openTemporaryStore(context);
  runningQueue(store);
  const facts = gatesWith({ usage: { ...GATE_FACTS.usage, claude: { fiveHourPercent: 80, sevenDayPercent: 5 } } });
  assert.equal(store.nextQueueStarts({ resolveGateFacts: facts }).starts.length, 1);
  assert.equal(store.apply(REPOSITORY, "queue_settings", { threshold: 70 }).ok, true);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: facts }), { ok: true, starts: [] });
  assert.equal(store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, facts).error, "gate_held");
  assert.equal(store.apply(REPOSITORY, "queue_settings", { threshold: 95 }).ok, true);
  assert.equal(store.nextQueueStarts({ resolveGateFacts: facts }).starts.length, 1);
});

test("projectGates rebuilds a valid block and drops a block with any value outside the contract", () => {
  const valid = {
    threshold: 85,
    usage: { claude: { status: "ok", fiveHourPercent: 62, sevenDayPercent: 31 }, codex: { status: "unknown", fiveHourPercent: null, sevenDayPercent: null } },
    providerStatus: { claude: "ok", codex: "incident" },
    workingTree: "clean",
    next: { taskId: "T-15", provider: "claude", blockedBy: "T-12", reasons: ["previous_step"] },
  };
  assert.deepEqual(projectGates({ ...valid, root: SECRET_ROOT, usage: { ...valid.usage, claude: { ...valid.usage.claude, resetsAt: "soon" } }, next: { ...valid.next, text: "secret" } }), valid);
  assert.deepEqual(projectGates({ ...valid, next: null }), { ...valid, next: null });
  for (const broken of [
    null, undefined, "gates", [],
    { ...valid, threshold: 80 },
    { ...valid, workingTree: SECRET_ROOT },
    { ...valid, usage: { ...valid.usage, claude: { status: "ok", fiveHourPercent: 62.5, sevenDayPercent: 31 } } },
    { ...valid, usage: { ...valid.usage, claude: { status: "ok", fiveHourPercent: 101, sevenDayPercent: 31 } } },
    { ...valid, usage: { claude: valid.usage.claude } },
    { ...valid, providerStatus: { claude: "ok", codex: "degraded" } },
    { ...valid, next: { ...valid.next, taskId: "15" } },
    { ...valid, next: { ...valid.next, provider: "other" } },
    { ...valid, next: { ...valid.next, blockedBy: SECRET_ROOT } },
    { ...valid, next: { ...valid.next, reasons: ["previous_step", "git status failed"] } },
    { ...valid, next: undefined },
  ]) assert.equal(projectGates(broken), undefined);
});

test("GET /api/tasks serves the gates from the runtime lookup, and queue-next and start-plan obey them", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningQueue(store);
  let facts = { ...GATE_FACTS, treeClean: false, root: SECRET_ROOT };
  const asked = [];
  const runtime = {
    resolveTaskGateFacts(repositoryId) { asked.push(repositoryId); return facts; },
    resolveTaskStart: () => FACTS,
  };
  const { board, post } = await startHandler(context, { taskStore: store, runtime });

  const held = await board();
  assert.equal(held.status, 200);
  assert.deepEqual(Object.keys(held.json.queue), ["status", "blockedBy", "pauseReason", "order", "gates"]);
  assert.deepEqual(Object.keys(held.json.queue.gates), ["threshold", "usage", "providerStatus", "workingTree", "next"]);
  assert.equal(held.json.queue.gates.workingTree, "dirty");
  assert.deepEqual(held.json.queue.gates.next, { taskId: "T-1", provider: "claude", blockedBy: null, reasons: ["tree_dirty"] });
  assert.equal(held.text.includes("SECRET-ROOT"), false);
  assert.deepEqual(asked, [REPOSITORY]);

  assert.deepEqual((await post("queue-next", {})).json, { ok: true, starts: [] });
  const refused = await post("start-plan", { repositoryId: REPOSITORY, payload: { id: "T-1" } });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { ok: false, error: "gate_held" });
  assert.equal(storedDispatch(directory, 1), null);
  assert.equal(queueRow(directory).queue_status, "running");

  const changed = await post("queue_settings", { repositoryId: REPOSITORY, payload: { threshold: 95 } });
  assert.equal(changed.json.board.queue.gates.threshold, 95);

  facts = GATE_FACTS;
  assert.deepEqual((await board()).json.queue.gates.next.reasons, []);
  assert.deepEqual((await post("queue-next", {})).json, { ok: true, starts: [{ repositoryId: REPOSITORY, taskId: "T-1" }] });
  assert.equal((await post("start-plan", { repositoryId: REPOSITORY, payload: { id: "T-1" } })).json.ok, true);
});

test("a runtime without the gate lookup serves no gates and holds every start", async (context) => {
  const { store } = await openTemporaryStore(context);
  runningQueue(store);
  const { board, post } = await startHandler(context, { taskStore: store, runtime: { resolveTaskStart: () => FACTS } });
  assert.equal(Object.hasOwn((await board()).json.queue, "gates"), false);
  assert.deepEqual((await post("queue-next", {})).json, { ok: true, starts: [] });
  assert.equal((await post("start-plan", { repositoryId: REPOSITORY, payload: { id: "T-1" } })).json.error, "gate_held");
});

test("a task linked to a session is not the next start, so its gates are not the queue's", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningQueue(store, 2);
  updateTask(directory, 1, { state: "done" });
  assert.equal(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.gates.next.taskId, "T-2");
});

test("usage counts only when available and fresh, by the five-hour and seven-day windows", () => {
  const limits = [
    { id: "current-session", window: "5 hours", percent: 62.4 },
    { id: "all-models", window: "7 days", percent: 31 },
    { id: "model", window: "7 days", percent: 12 },
  ];
  const at = new Date(NOW - 60_000).toISOString();
  assert.deepEqual(gateUsageFact({ available: true, fetchedAt: at, freshness: "fresh", limits }, NOW), { fiveHourPercent: 62.4, sevenDayPercent: 31 });
  assert.equal(gateUsageFact({ available: true, fetchedAt: at, freshness: "stale", limits }, NOW), null);
  assert.equal(gateUsageFact({ available: false, fetchedAt: at, freshness: "fresh", limits }, NOW), null);
  assert.equal(gateUsageFact({ available: true, fetchedAt: null, freshness: "fresh", limits }, NOW), null);
  assert.equal(gateUsageFact({ available: true, fetchedAt: new Date(NOW + 60_000).toISOString(), freshness: "fresh", limits }, NOW), null);
  for (const value of [null, undefined, "usage", { available: true, fetchedAt: at, limits: "none" }]) assert.equal(gateUsageFact(value, NOW), null);
  // A provider that reports no freshness of its own is fresh by the age of its fetch.
  const old = new Date(NOW - TASK_GATE_USAGE_MAX_AGE_MS - 1).toISOString();
  const codex = [{ id: "codex-primary", window: "5 hours", percent: 18 }, { id: "other-primary", window: "5 hours", percent: 40 }, { id: "codex-secondary", window: "7 days", percent: 9 }];
  assert.deepEqual(gateUsageFact({ available: true, fetchedAt: at, limits: codex }, NOW), { fiveHourPercent: 40, sevenDayPercent: 9 });
  assert.equal(gateUsageFact({ available: true, fetchedAt: old, limits: codex }, NOW), null);
  // A missing window, or one malformed reading among several, is not known.
  assert.deepEqual(gateUsageFact({ available: true, fetchedAt: at, limits: [{ window: "7 days", percent: 9 }] }, NOW), { fiveHourPercent: null, sevenDayPercent: 9 });
  assert.equal(gateUsageFact({ available: true, fetchedAt: at, limits: [{ window: "5 hours", percent: 18 }, { window: "5 hours", percent: "40" }] }, NOW).fiveHourPercent, null);
});

test("provider status counts only when ready, fresh, and known", () => {
  const row = { provider: "claude", readiness: "ready", freshness: "fresh", status: "operational" };
  assert.equal(gateProviderStatusFact(row), "operational");
  for (const status of ["degraded", "outage", "maintenance"]) assert.equal(gateProviderStatusFact({ ...row, status }), "incident");
  for (const changed of [{ status: "unknown" }, { status: "fine" }, { freshness: "stale" }, { freshness: "unknown" }, { readiness: "loading" }, { readiness: "unavailable" }]) {
    assert.equal(gateProviderStatusFact({ ...row, ...changed }), null);
  }
  assert.equal(gateProviderStatusFact(null), null);
});

test("the working tree is observed off the request path and served only while fresh", async () => {
  let now = NOW;
  let files = [];
  const reads = [];
  const tree = createTaskTreeObservation({
    repositoryRoot: (id) => (id === REPOSITORY ? SECRET_ROOT : null),
    gitReader: async (root, options) => { reads.push({ root, options }); return { available: true, files }; },
    forbiddenRoots: () => ["C:/Users/x/.claude"],
    now: () => now,
  });
  assert.equal(tree.read(REPOSITORY), null, "the first ask answers unknown and queues the read");
  assert.equal(tree.read(REPOSITORY), null, "an inspection in flight is not repeated");
  await settle();
  assert.deepEqual(reads, [{ root: SECRET_ROOT, options: { forbiddenRoots: ["C:/Users/x/.claude"] } }]);
  assert.equal(tree.read(REPOSITORY), true);
  assert.equal(reads.length, 1, "a fresh observation is not refreshed");

  files = [{ status: "M", path: "a.txt" }];
  now += TASK_GATE_TREE_REFRESH_MS;
  assert.equal(tree.read(REPOSITORY), true, "the committed observation is served while the refresh runs");
  await settle();
  assert.equal(reads.length, 2);
  assert.equal(tree.read(REPOSITORY), false);

  now += TASK_GATE_TREE_MAX_AGE_MS + 1;
  assert.equal(tree.read(REPOSITORY), null, "an old observation is unknown, never the last known value");
  await settle();
  assert.equal(tree.read(REPOSITORY), false);

  assert.equal(tree.read(repositoryNumber(1)), null, "a repository with no recognized root is never inspected");
  await settle();
  assert.equal(reads.length, 3);
  tree.stop();
  assert.equal(tree.read(REPOSITORY), null);
});

test("a failed or unavailable Git read is unknown, and only the most recently asked repositories are held", async () => {
  let now = NOW;
  let answer = () => { throw new Error(`fatal: ${SECRET_ROOT}`); };
  const roots = [];
  const tree = createTaskTreeObservation({ repositoryRoot: (id) => `C:/repos/${id}`, gitReader: async (root) => { roots.push(root); return answer(); }, now: () => now });
  tree.read(REPOSITORY);
  await settle();
  assert.equal(tree.read(REPOSITORY), null);
  answer = () => ({ available: false, files: [] });
  now += TASK_GATE_TREE_REFRESH_MS;
  tree.read(REPOSITORY);
  await settle();
  assert.equal(tree.read(REPOSITORY), null);
  answer = () => ({ available: true, files: [] });
  now += TASK_GATE_TREE_REFRESH_MS;
  tree.read(REPOSITORY);
  await settle();
  assert.equal(tree.read(REPOSITORY), true);

  for (let index = 1; index <= TASK_GATE_TREE_LIMIT; index += 1) tree.read(repositoryNumber(index));
  await settle();
  const before = roots.length;
  assert.equal(tree.read(REPOSITORY), null, "the least recently asked repository was dropped and is observed again");
  await settle();
  assert.equal(roots.length, before + 1);
});

test("the gate facts join committed usage, provider status, and the tree, and expose nothing else", () => {
  const at = new Date(NOW - 1000).toISOString();
  const resolve = createTaskGateFacts({
    usageLimits: () => ({ providers: [
      { provider: "claude", usageLimits: { available: true, fetchedAt: at, freshness: "fresh", error: "secret", limits: [{ window: "5 hours", percent: 62, resetsAt: at }, { window: "7 days", percent: 31 }] } },
      { provider: "codex", usageLimits: { available: false, fetchedAt: null, limits: [] } },
    ] }),
    providerStatus: () => ({ providers: [{ provider: "claude", readiness: "ready", freshness: "fresh", status: "degraded", statusPageUrl: "https://example.test", incidents: [{ name: "secret" }] }] }),
    tree: { read: (id) => id === REPOSITORY },
    now: () => NOW,
  });
  assert.deepEqual(resolve(REPOSITORY), {
    usage: { claude: { fiveHourPercent: 62, sevenDayPercent: 31 }, codex: null },
    providerStatus: { claude: "incident", codex: null },
    treeClean: true,
  });
  assert.equal(resolve(repositoryNumber(2)).treeClean, false);
  const empty = createTaskGateFacts({ usageLimits: () => null, providerStatus: () => null, tree: null, now: () => NOW });
  assert.deepEqual(empty(REPOSITORY), { usage: { claude: null, codex: null }, providerStatus: { claude: null, codex: null }, treeClean: null });
});

test("createTaskLookups wires the gate facts from the committed sources it is handed", async () => {
  const at = new Date(NOW - 1000).toISOString();
  const lookups = createTaskLookups({
    observationStore: { get: () => null }, catalogSessions: () => [],
    repositoryInventory: { repositoryRoot: (id) => (id === REPOSITORY ? SECRET_ROOT : null) },
    gateSources: {
      usageLimits: () => ({ providers: [{ provider: "claude", usageLimits: { available: true, fetchedAt: at, freshness: "fresh", limits: [{ window: "5 hours", percent: 5 }, { window: "7 days", percent: 6 }] } }] }),
      providerStatus: () => ({ providers: [{ provider: "claude", readiness: "ready", freshness: "fresh", status: "operational" }] }),
      gitReader: async () => ({ available: true, files: [] }),
      forbiddenRoots: () => [],
      now: () => NOW,
    },
  });
  assert.equal(lookups.resolveTaskGateFacts(REPOSITORY).treeClean, null);
  await settle();
  assert.deepEqual(lookups.resolveTaskGateFacts(REPOSITORY), {
    usage: { claude: { fiveHourPercent: 5, sevenDayPercent: 6 }, codex: null },
    providerStatus: { claude: "operational", codex: null },
    treeClean: true,
  });
  assert.equal(JSON.stringify(lookups.resolveTaskGateFacts(REPOSITORY)).includes("SECRET-ROOT"), false);
});
