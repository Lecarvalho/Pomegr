import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  projectSessionDomains, SESSION_DOMAIN_CATALOG_FIELDS, sessionDomainCatalogInputs, UNAVAILABLE_SESSION_DOMAIN_CATALOG_FIELDS, unavailableSessionDomains,
} from "../../../../server/sessions/domain/session-domain-projection.mjs";
import { createSessionDomainStore, SESSION_DOMAIN_NAMES } from "../../../../server/sessions/domain/session-domain-store.mjs";
import { normalizeSessionEventRecord } from "../../../../server/sessions/domain/session-event-record.mjs";
import { createEmptyMonitorState } from "../../../../shared/monitor-state.mjs";

// These tests count work. A committed snapshot is deep-frozen, as the observation store
// publishes it; only such a snapshot can be recognized as an unchanged input.
const SESSION_ID = "codex:unchanged-session";
const OBSERVED_AT = "2026-09-14T12:00:00.000Z";
const LATER = "2026-09-14T12:05:00.000Z";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function state(overrides = {}) {
  const base = createEmptyMonitorState({ connected: true, source: "Codex", view: "live" });
  return {
    ...base,
    session: {
      id: SESSION_ID, title: "Unchanged session", project: "Pomegr", startedAt: OBSERVED_AT, updatedAt: OBSERVED_AT, durationMs: 1,
      cost: null, summary: null, progress: null, pomegrPlugin: null, signal: null, repositoryId: "repo-1", contextInventoryRef: null,
      repository: { available: true, branch: "main", files: [], comparison: null, historical: false },
      pullRequests: null,
    },
    agents: [
      { id: "primary", parentId: null, label: "Primary", role: "orchestrator", customType: null, model: "test", status: "active", currentActivity: null,
        tokens: { total: 20 }, lastSeen: OBSERVED_AT, startedAt: OBSERVED_AT, updatedAt: OBSERVED_AT, cacheLifetime: null, signal: null,
        executionTasks: [{ id: "task-1", kind: "shell", workKind: "test", status: "running", background: false, backgroundId: null, startedAt: OBSERVED_AT, finishedAt: null, exitCode: null, failureCause: null }] },
    ],
    metrics: { ...base.metrics, agents: 1, activeAgents: 1, tokens: { ...base.metrics.tokens, allAgents: 20, contextHistory: { bucketMs: 60_000, buckets: [], boundaries: [] } } },
    readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "ready", usageLimits: "ready" },
    ...overrides,
  };
}

function committed(publicState = state(), { observedAt = OBSERVED_AT, evidence = { toolCalls: [] } } = {}) {
  return deepFreeze({ publicState, readiness: publicState.readiness, observedAt, evidence });
}

// One shell row as the committed catalog serves it.
function row(overrides = {}) {
  return {
    id: SESSION_ID, provider: "codex", source: "Codex", title: "Unchanged session", project: "Pomegr", createdAt: OBSERVED_AT, updatedAt: OBSERVED_AT,
    isLive: true, needsInput: false, activityStatus: "working", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 1, latestContextTotal: 20,
    progress: null, currentActivity: null, activityFallback: null, cacheTiming: null, repositoryId: "repo-1", contextInventoryRef: null,
    ...overrides,
  };
}

function revisions(store, sessionId = SESSION_ID) {
  return Object.fromEntries(SESSION_DOMAIN_NAMES.map((domain) => [domain, store.read(sessionId, domain, domain === "agent" ? "primary" : null).revision]));
}
function served(store, domain, sessionId = SESSION_ID) {
  return store.read(sessionId, domain, domain === "agent" ? "primary" : null).snapshot.value;
}
// The first commit records the session's event record; the second finds it settled.
function settle(store, snapshot, catalogRow, sessionId = SESSION_ID) {
  store.commit(sessionId, snapshot, catalogRow);
  store.commit(sessionId, snapshot, catalogRow);
}
function withoutRevision(value) {
  const rest = { ...value };
  delete rest.revision;
  return rest;
}

test("a commit from unchanged inputs runs no projection, publishes nothing, and keeps every revision", () => {
  const store = createSessionDomainStore();
  const events = [];
  const snapshot = committed();
  settle(store, snapshot, row());
  store.subscribe((event) => events.push(event));
  events.length = 0;
  const before = { stats: store.stats(), revisions: revisions(store), serialized: store.read(SESSION_ID, "session-summary").snapshot.serialized };

  for (let pass = 0; pass < 10; pass += 1) {
    // A catalog commit builds a new row object every time; only its compared fields count.
    assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
  }

  assert.equal(store.stats().projections, before.stats.projections, "no projection for unchanged inputs");
  assert.equal(store.stats().unchangedInputs, before.stats.unchangedInputs + 10);
  assert.deepEqual(revisions(store), before.revisions);
  assert.deepEqual(events, []);
  assert.equal(store.read(SESSION_ID, "session-summary").snapshot.serialized, before.serialized);
});

test("a catalog pass over N unchanged retained sessions projects none, and exactly the one whose row changed", () => {
  const store = createSessionDomainStore({ maxSessions: 64 });
  const ids = Array.from({ length: 40 }, (_, index) => `codex:retained-${String(index).padStart(2, "0")}`);
  const snapshots = new Map(ids.map((id) => [id, committed(state({ session: { ...state().session, id } }))]));
  for (const id of ids) settle(store, snapshots.get(id), row({ id }), id);
  const events = [];
  store.subscribe((event) => events.push(event));
  events.length = 0;
  const before = store.stats().projections;
  const beforeRevisions = new Map(ids.map((id) => [id, revisions(store, id)]));

  for (let pass = 0; pass < 3; pass += 1) for (const id of ids) store.commit(id, snapshots.get(id), row({ id }));
  assert.equal(store.stats().projections, before, "zero projections for 40 unchanged sessions across three catalog passes");
  assert.deepEqual(events, []);

  const changed = ids[17];
  for (const id of ids) store.commit(id, snapshots.get(id), row({ id, ...(id === changed ? { activityStatus: "idle" } : {}) }));
  assert.equal(store.stats().projections, before + 1, "exactly one projection: the session whose row changed");
  assert.deepEqual(events.map((event) => [event.sessionId, event.domain]), [[changed, "session-summary"]]);
  for (const id of ids) {
    const expected = { ...beforeRevisions.get(id) };
    if (id === changed) expected["session-summary"] = events[0].revision;
    assert.deepEqual(revisions(store, id), expected, id);
  }
  assert.equal(served(store, "session-summary", changed).lifecycle.activityStatus, "idle");
});

// One case per compared catalog field: changing only that field re-projects and advances the
// summary revision by one. A field added to the compared list without a case here fails below.
const CATALOG_FIELD_CASES = {
  isLive: { change: { isLive: false }, expected: (lifecycle) => assert.equal(lifecycle.isLive, false) },
  needsInput: { change: { needsInput: true }, expected: (lifecycle) => assert.equal(lifecycle.needsInput, true) },
  activityStatus: { change: { activityStatus: "idle" }, expected: (lifecycle) => assert.equal(lifecycle.activityStatus, "idle") },
  currentActivity: {
    change: { currentActivity: { label: "Running tests", observedAt: OBSERVED_AT, state: "current" } },
    expected: (lifecycle) => assert.deepEqual(lifecycle.currentActivity, { label: "Running tests", observedAt: OBSERVED_AT, state: "current" }),
  },
  activityFallback: {
    change: { activityFallback: { label: "test run", observedAt: OBSERVED_AT, state: "last_observed", source: "execution_task", actor: "primary" } },
    expected: (lifecycle) => assert.equal(lifecycle.activityFallback.label, "test run"),
  },
};

test("every compared catalog field has a re-projection case", () => {
  assert.deepEqual(Object.keys(CATALOG_FIELD_CASES).sort(), [...SESSION_DOMAIN_CATALOG_FIELDS].sort());
  assert.deepEqual([...UNAVAILABLE_SESSION_DOMAIN_CATALOG_FIELDS].sort(), [...SESSION_DOMAIN_CATALOG_FIELDS, "updatedAt"].sort());
});

for (const [field, { change, expected }] of Object.entries(CATALOG_FIELD_CASES)) {
  test(`a change of only the catalog row's ${field} re-projects the session and advances its summary revision`, () => {
    const store = createSessionDomainStore();
    const snapshot = committed();
    settle(store, snapshot, row());
    const before = { projections: store.stats().projections, revisions: revisions(store) };
    const events = [];
    store.subscribe((event) => events.push(event));
    events.length = 0;

    const published = store.commit(SESSION_ID, snapshot, row(change));

    assert.equal(store.stats().projections, before.projections + 1);
    assert.deepEqual(published.map((event) => event.domain), ["session-summary"]);
    assert.deepEqual(events, [...published], "the same event is published as returned");
    assert.deepEqual(revisions(store), { ...before.revisions, "session-summary": published[0].revision });
    expected(served(store, "session-summary").lifecycle);
    // The result is what a store that never saw the earlier row projects from the same inputs.
    const reference = createSessionDomainStore();
    reference.commit(SESSION_ID, snapshot, row(change));
    for (const domain of SESSION_DOMAIN_NAMES) assert.deepEqual(withoutRevision(served(store, domain)), withoutRevision(served(reference, domain)), domain);

    assert.deepEqual(store.commit(SESSION_ID, snapshot, row(change)), [], "the changed row is the new unchanged input");
    assert.equal(store.stats().projections, before.projections + 1);
  });
}

test("a change inside a nested catalog activity value re-projects", () => {
  const store = createSessionDomainStore();
  const snapshot = committed();
  const current = { label: "Running tests", observedAt: OBSERVED_AT, state: "current" };
  const fallback = { label: "test run", observedAt: OBSERVED_AT, state: "last_observed", source: "execution_task", actor: "primary" };
  settle(store, snapshot, row({ currentActivity: current, activityFallback: fallback }));
  const before = store.stats().projections;
  assert.deepEqual(store.commit(SESSION_ID, snapshot, row({ currentActivity: { ...current }, activityFallback: { ...fallback } })), [], "equal values in new objects are unchanged");
  assert.equal(store.stats().projections, before);
  assert.equal(store.commit(SESSION_ID, snapshot, row({ currentActivity: { ...current, label: "Building" }, activityFallback: fallback })).length, 1);
  assert.equal(store.commit(SESSION_ID, snapshot, row({ currentActivity: { ...current, label: "Building" }, activityFallback: { ...fallback, observedAt: LATER } })).length, 1);
  assert.equal(store.stats().projections, before + 2);
  assert.equal(served(store, "session-summary").lifecycle.activityFallback.observedAt, LATER);
});

function recordingRow(base, reads) {
  return new Proxy(base, { get(target, property, receiver) { if (typeof property === "string") reads.add(property); return Reflect.get(target, property, receiver); } });
}

test("no projection reads a catalog field outside the compared view", () => {
  const snapshot = committed();
  const reads = new Set();
  projectSessionDomains(SESSION_ID, snapshot, { catalogEntry: recordingRow(row(), reads) });
  assert.deepEqual([...reads].sort(), [...SESSION_DOMAIN_CATALOG_FIELDS].sort(), "the evidence projection reads exactly the compared fields");

  const unavailableReads = new Set();
  unavailableSessionDomains(SESSION_ID, recordingRow(row({ summaryReadiness: "unavailable" }), unavailableReads), "Codex", {});
  assert.deepEqual([...unavailableReads].sort(), [...UNAVAILABLE_SESSION_DOMAIN_CATALOG_FIELDS].sort(), "the placeholder reads exactly its compared fields");

  const storeReads = new Set();
  const store = createSessionDomainStore();
  store.commit(SESSION_ID, snapshot, recordingRow(row(), storeReads));
  store.commitUnavailable("codex:registry-only", recordingRow(row({ id: "codex:registry-only" }), storeReads), "Codex", {});
  assert.deepEqual([...storeReads].filter((name) => !UNAVAILABLE_SESSION_DOMAIN_CATALOG_FIELDS.includes(name)), [], "the store reads the row only through the compared view");

  const view = sessionDomainCatalogInputs(row());
  assert.deepEqual(Object.keys(view).sort(), [...SESSION_DOMAIN_CATALOG_FIELDS].sort());
  assert.ok(Object.isFrozen(view));
  assert.equal(sessionDomainCatalogInputs(null), null);
});

test("a row that differs only in fields outside the compared view projects identical domains and is skipped", () => {
  const snapshot = committed();
  const other = row({ title: "Renamed", project: "Elsewhere", createdAt: LATER, updatedAt: LATER, summaryReadiness: "loading", agentCount: 9, activeAgentCount: 4,
    latestContextTotal: 999, progress: { phase: "verifying", percent: 90, confidence: "high", reportedAt: LATER }, cacheTiming: { lastCacheTouchAt: LATER, cacheLifetime: "1h" },
    repositoryId: "repo-2", contextInventoryRef: { repositoryId: "repo-2" }, provider: "claude", source: "Claude Code", unknownFutureField: "value" });
  const left = projectSessionDomains(SESSION_ID, snapshot, { catalogEntry: row() });
  const right = projectSessionDomains(SESSION_ID, snapshot, { catalogEntry: other });
  assert.equal(JSON.stringify([...left.domains]), JSON.stringify([...right.domains]));
  assert.equal(JSON.stringify([...left.agentResponses]), JSON.stringify([...right.agentResponses]));

  const store = createSessionDomainStore();
  settle(store, snapshot, row());
  const before = store.stats().projections;
  assert.deepEqual(store.commit(SESSION_ID, snapshot, other), []);
  assert.equal(store.stats().projections, before);
});

test("a session without a catalog row is compared like one with a row", () => {
  const store = createSessionDomainStore();
  const snapshot = committed();
  settle(store, snapshot, null);
  const before = store.stats().projections;
  assert.deepEqual(store.commit(SESSION_ID, snapshot, null), []);
  assert.equal(store.stats().projections, before);
  // The row appears, then disappears from the catalog: each is a lifecycle input change.
  assert.equal(store.commit(SESSION_ID, snapshot, row({ activityStatus: "idle", isLive: false })).length, 1);
  assert.equal(served(store, "session-summary").lifecycle.isLive, false);
  assert.equal(store.commit(SESSION_ID, snapshot, null).length, 1);
  assert.equal(served(store, "session-summary").lifecycle.isLive, true, "without a row the lifecycle falls back to the recorded view");
  assert.equal(store.stats().projections, before + 2);
});

// One case per input the store reads besides the snapshot and the catalog row. Each source may
// change its answer without announcing it, so each is read and compared on every commit.
const READY_RESOURCES = deepFreeze({ readiness: "ready", minutes: [], minutesTruncated: false, curveRemoval: null,
  peaks: [{ id: "p1", field: "cpu_cores", observedAt: OBSERVED_AT, value: 4, matchedTaskIds: [], matchedTaskCount: 0, window: { status: "not_retained", samples: [], minute: null } }] });
const LOADING_RESOURCES = deepFreeze({ readiness: "loading", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] });
const READY_FILES = deepFreeze({ readiness: "ready", truncated: false,
  files: [{ fileId: "f1", path: "app/file.ts", kind: "edited", changeCount: 1, lastObservedAt: OBSERVED_AT, agents: [{ agentId: "primary", changeCount: 1 }] }] });
const LOADING_FILES = deepFreeze({ readiness: "loading", files: [], truncated: false });
const GIT_OBSERVED = deepFreeze({ files: [{ path: "docs/notes.md", source: "committed", change: "modified" }], truncated: false });
const COMMIT_TIMES = Object.freeze([OBSERVED_AT]);
const NO_RECORD = Object.freeze({ gitObserved: null, commitTimes: null });
const UNAVAILABLE_REPOSITORY = { session: { ...state().session, repository: { available: false, branch: null, files: [], comparison: null, historical: false } } };
const DIRTY_REPOSITORY = { session: { ...state().session, repository: { available: true, branch: "main", files: [{ status: "modified", path: "app/file.ts" }], comparison: null, historical: false } } };

const SIDE_INPUT_CASES = [
  { name: "the repository root", option: "repositoryRootForSession", initial: null, next: process.cwd(), domains: ["repository", "session-summary"], overrides: DIRTY_REPOSITORY,
    expected: (store) => assert.deepEqual(served(store, "repository").repository.files, [{ status: "modified", path: "app/file.ts" }]) },
  { name: "the repository-unavailable reason", option: "repositoryUnavailableReasonForSession", initial: null, next: "branch_changed", domains: ["repository"], overrides: UNAVAILABLE_REPOSITORY,
    expected: (store) => assert.equal(served(store, "repository").unavailableReason, "branch_changed") },
  { name: "the retained resource block", option: "retainedResourcesForSession", initial: LOADING_RESOURCES, next: READY_RESOURCES, domains: ["resources", "session-summary"],
    expected: (store) => assert.equal(served(store, "resources").retained.peaks.length, 1) },
  { name: "the recorded file history", option: "fileHistoryForSession", initial: LOADING_FILES, next: READY_FILES, domains: ["repository", "session-summary"],
    expected: (store) => assert.equal(served(store, "session-summary").repository.touchedFiles, 1) },
  { name: "the recorded Git-observed files", option: "repositoryRecordForSession", initial: NO_RECORD, next: Object.freeze({ gitObserved: GIT_OBSERVED, commitTimes: null }), domains: ["repository"],
    expected: (store) => assert.deepEqual(served(store, "repository").touchedFiles.files.map((file) => file.path), ["docs/notes.md"]) },
  { name: "the recorded commit times", option: "repositoryRecordForSession", initial: NO_RECORD, next: Object.freeze({ gitObserved: null, commitTimes: COMMIT_TIMES }), domains: ["session-summary"],
    expected: (store) => assert.ok(served(store, "session-summary").events.items.some((item) => item.kind === "commit_observed")) },
  { name: "the recorded event sidecar", option: "eventRecordForSession", initial: null,
    next: normalizeSessionEventRecord({ version: 1, refills: [], compactions: [{ at: OBSERVED_AT, agentId: "primary", trigger: "manual" }] }), domains: ["session-summary"],
    expected: (store) => assert.ok(served(store, "session-summary").events.items.some((item) => item.kind === "context_compacted")) },
];

for (const { name, option, initial, next, domains, overrides, expected } of SIDE_INPUT_CASES) {
  test(`a change of only ${name} re-projects the session and advances the affected revisions`, () => {
    let value = initial;
    const store = createSessionDomainStore({ [option]: () => value });
    const snapshot = committed(state(overrides));
    settle(store, snapshot, row());
    const before = { projections: store.stats().projections, revisions: revisions(store) };
    assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
    assert.equal(store.stats().projections, before.projections, "unchanged: no projection");

    value = next;
    const published = store.commit(SESSION_ID, snapshot, row());
    assert.equal(store.stats().projections, before.projections + 1, "changed: one projection in the same commit");
    assert.deepEqual(published.map((event) => event.domain).sort(), [...domains].sort());
    const after = { ...before.revisions };
    for (const event of published) after[event.domain] = event.revision;
    assert.deepEqual(revisions(store), after);
    for (const event of published) assert.ok(event.revision > before.revisions[event.domain], event.domain);
    expected(store);

    // The recorded event sidecar merges into the kept record, so that commit moves it once more.
    store.commit(SESSION_ID, snapshot, row());
    const settledAt = store.stats().projections;
    assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
    assert.equal(store.stats().projections, settledAt, "the new value is the new unchanged input");
  });
}

test("a replaced snapshot always re-projects, and an equal one in a new object is a no-op as before", () => {
  const store = createSessionDomainStore();
  settle(store, committed(), row());
  const before = { projections: store.stats().projections, revisions: revisions(store) };
  assert.deepEqual(store.commit(SESSION_ID, committed(), row()), [], "equal evidence in a new snapshot object changes no revision");
  assert.equal(store.stats().projections, before.projections + 1, "a new snapshot object is projected to find that out");
  const renamed = committed(state({ session: { ...state().session, title: "Renamed" } }));
  assert.deepEqual(store.commit(SESSION_ID, renamed, row()).map((event) => event.domain).sort(), ["details", "session-summary"]);
  assert.equal(store.stats().projections, before.projections + 2);
});

test("a live repository file that stops being safely contained is withdrawn by the next commit of unchanged inputs", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pomegr-domain-ambient-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repository");
  const outside = path.join(temporary, "outside");
  await mkdir(path.join(root, "inside"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "inside", "file.txt"), "test");
  await writeFile(path.join(outside, "file.txt"), "test");

  const store = createSessionDomainStore({ repositoryRootForSession: () => root });
  const files = [{ status: "modified", path: "inside/file.txt" }, { status: "modified", path: "kept.txt" }];
  const snapshot = committed(state({ session: { ...state().session, repository: { available: true, branch: "main", files, comparison: null, historical: false } } }));
  settle(store, snapshot, row());
  assert.deepEqual(served(store, "repository").repository.files, files);
  const before = { stats: store.stats(), revisions: revisions(store) };

  // Unchanged disk: the paths are validated again, as before, and nothing is projected.
  assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
  assert.equal(store.stats().liveRepositoryValidations, before.stats.liveRepositoryValidations + 1, "the filesystem is consulted on every commit");
  assert.equal(store.stats().projections, before.stats.projections);

  // The directory becomes a link that leaves the repository. No committed input changed.
  await rm(path.join(root, "inside"), { recursive: true, force: true });
  try {
    await symlink(outside, path.join(root, "inside"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    context.skip("The test environment cannot create a directory link: " + (error.code || "unknown"));
    return;
  }
  const published = store.commit(SESSION_ID, snapshot, row());
  assert.equal(store.stats().projections, before.stats.projections + 1);
  assert.deepEqual(published.map((event) => event.domain).sort(), ["repository", "session-summary"]);
  assert.deepEqual(served(store, "repository").repository.files, [{ status: "modified", path: "kept.txt" }], "the escaped path is withdrawn in the same commit");
  assert.equal(served(store, "session-summary").repository.changedFiles, 1);
  assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
  assert.equal(store.stats().projections, before.stats.projections + 1);
});

test("a recorded historical repository and a clean live one consult no filesystem state", () => {
  const store = createSessionDomainStore({ repositoryRootForSession: () => process.cwd() });
  const historical = committed(state({ view: "history", session: { ...state().session,
    repository: { available: true, branch: "main", files: [{ status: "modified", path: "app/file.ts" }], comparison: null, historical: true } } }));
  settle(store, historical, row({ isLive: false, activityStatus: "stopped" }));
  settle(store, committed(), row(), "codex:clean-live");
  assert.equal(store.stats().liveRepositoryValidations, 0);
  assert.deepEqual(served(store, "repository").repository.files, [{ status: "modified", path: "app/file.ts" }]);
});

test("the unavailable placeholder is rebuilt only when its row, source, or capabilities change", () => {
  const store = createSessionDomainStore();
  const id = "claude:registry-only";
  const capabilities = { liveSessions: true };
  const base = row({ id, provider: "claude", source: "Claude Code", summaryReadiness: "unavailable", activityStatus: "open" });
  assert.ok(store.commitUnavailable(id, base, "Claude Code", capabilities).length > 0);
  const before = { projections: store.stats().projections, revisions: revisions(store, id) };
  for (let pass = 0; pass < 5; pass += 1) assert.deepEqual(store.commitUnavailable(id, { ...base, title: `Renamed ${pass}` }, "Claude Code", { ...capabilities }), []);
  assert.equal(store.stats().projections, before.projections, "an unchanged placeholder input is not projected");
  assert.deepEqual(revisions(store, id), before.revisions);

  let projections = store.stats().projections;
  for (const [field, { change }] of Object.entries(CATALOG_FIELD_CASES)) {
    assert.ok(store.commitUnavailable(id, { ...base, ...change }, "Claude Code", capabilities).some((event) => event.domain === "session-summary"), field);
    assert.equal(store.stats().projections, projections + 1, `${field} is a placeholder input`);
    store.commitUnavailable(id, base, "Claude Code", capabilities);
    projections = store.stats().projections;
  }

  // The open row expires into history: the same catalog commit replaces the placeholder.
  const expired = store.commitUnavailable(id, { ...base, isLive: false, activityStatus: "stopped" }, "Claude Code", capabilities);
  assert.equal(store.stats().projections, projections + 1);
  assert.ok(expired.some((event) => event.domain === "session-summary"));
  assert.equal(served(store, "session-summary", id).view, "history");
  assert.equal(served(store, "session-summary", id).lifecycle.activityStatus, "stopped");
  projections = store.stats().projections;
  // The observation time alone re-projects, and, as before, advances no revision.
  const settledRevisions = revisions(store, id);
  assert.deepEqual(store.commitUnavailable(id, { ...base, isLive: false, activityStatus: "stopped", updatedAt: LATER }, "Claude Code", capabilities), []);
  assert.equal(store.stats().projections, projections + 1);
  assert.deepEqual(revisions(store, id), settledRevisions);
  assert.ok(store.commitUnavailable(id, { ...base, isLive: false, activityStatus: "stopped", updatedAt: LATER }, "Codex", capabilities).length > 0, "the source label is an input");
  assert.ok(store.commitUnavailable(id, { ...base, isLive: false, activityStatus: "stopped", updatedAt: LATER }, "Codex", { liveSessions: false }).length > 0, "the capabilities are an input");

  // Evidence replaces the placeholder, and the placeholder never comes back over it.
  const evidenceSnapshot = committed(state({ session: { ...state().session, id } }));
  assert.ok(store.commit(id, evidenceSnapshot, base).length > 0);
  assert.deepEqual(store.commitUnavailable(id, base, "Claude Code", capabilities), []);
  assert.equal(served(store, "session-summary", id).session.id, id);
});

test("a commit that moves the event record is not remembered until the record settles", () => {
  const handed = [];
  const store = createSessionDomainStore({ onEventRecord: (sessionId, record) => handed.push(record) });
  const publicState = state();
  publicState.metrics.tokens.cacheEvents = { status: "ready", items: [], possibleFullRefills: [{ agentId: "primary", count: 1, occurrences: [{ observedAt: OBSERVED_AT }], reasons: [], toolChangeAttributions: [] }] };
  const snapshot = committed(publicState);
  store.commit(SESSION_ID, snapshot, row());
  assert.equal(handed.length, 1, "the first commit hands the derived record to the recorder");
  assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
  assert.equal(store.stats().projections, 2, "the next commit still projects, as it did before");
  assert.equal(handed.length, 1, "and hands nothing over, because the record did not move");
  assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
  assert.equal(store.stats().projections, 2, "from then on the unchanged inputs are skipped");
});

test("a recorded kind that the evidence keeps overriding is handed over on every commit, as before", () => {
  // A failed sidecar write leaves the recorder with the older kind. Each commit then derives the
  // newer kind again and hands the union over again; skipping it would drop that retry.
  const recorded = normalizeSessionEventRecord({ version: 1, refills: [{ at: OBSERVED_AT, agentId: "primary", kind: "lifetime_elapsed" }], compactions: [] });
  const handed = [];
  const store = createSessionDomainStore({ eventRecordForSession: () => recorded, onEventRecord: (sessionId, record) => handed.push(record) });
  const publicState = state();
  publicState.metrics.tokens.cacheEvents = { status: "ready", items: [], possibleFullRefills: [{ agentId: "primary", count: 1, occurrences: [{ observedAt: OBSERVED_AT }], reasons: [], toolChangeAttributions: [] }] };
  const snapshot = committed(publicState);
  for (let pass = 1; pass <= 4; pass += 1) {
    store.commit(SESSION_ID, snapshot, row());
    assert.equal(store.stats().projections, pass);
    assert.equal(handed.length, pass);
    assert.equal(handed.at(-1).refills[0].kind, "possible_full");
  }
});

test("an unfrozen snapshot or side-channel value is never taken as unchanged", () => {
  const publicState = state();
  const mutable = { publicState, readiness: publicState.readiness, observedAt: OBSERVED_AT, evidence: { toolCalls: [] } };
  const store = createSessionDomainStore();
  settle(store, mutable, row());
  const before = store.stats().projections;
  publicState.session.title = "Changed in place";
  assert.deepEqual(store.commit(SESSION_ID, mutable, row()).map((event) => event.domain).sort(), ["details", "session-summary"]);
  assert.equal(store.stats().projections, before + 1);

  const resources = { readiness: "loading", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] };
  const side = createSessionDomainStore({ retainedResourcesForSession: () => resources });
  const snapshot = committed();
  settle(side, snapshot, row());
  const sideBefore = side.stats().projections;
  resources.readiness = "unavailable";
  side.commit(SESSION_ID, snapshot, row());
  assert.equal(side.stats().projections, sideBefore + 1, "a mutable block is projected every time");
  assert.equal(served(side, "resources").retained.readiness, "unavailable");
});

test("eviction and clear forget the remembered inputs with the session", () => {
  let clock = 0;
  const store = createSessionDomainStore({ now: () => clock, idleMs: 60_000 });
  const snapshot = committed();
  // Three commits: the third is skipped, which shows the inputs are remembered at this point.
  const remember = () => {
    settle(store, snapshot, row());
    const skipped = store.stats().unchangedInputs;
    assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
    assert.equal(store.stats().unchangedInputs, skipped + 1, "the inputs are remembered");
  };
  remember();
  const before = { projections: store.stats().projections, revision: store.read(SESSION_ID, "session-summary").revision };
  clock += 60_001;
  assert.deepEqual(store.evictIdle(), [SESSION_ID]);
  const published = store.commit(SESSION_ID, snapshot, row());
  assert.equal(store.stats().projections, before.projections + 1, "an evicted session is projected again");
  assert.equal(published.length, SESSION_DOMAIN_NAMES.length);
  assert.ok(store.read(SESSION_ID, "session-summary").revision > before.revision, "its revision moves past the evicted one");

  remember();
  store.clear();
  assert.equal(store.read(SESSION_ID, "session-summary").status, "empty");
  assert.equal(store.commit(SESSION_ID, snapshot, row()).length, SESSION_DOMAIN_NAMES.length, "clear forgets the inputs with the domains");
  assert.equal(store.read(SESSION_ID, "session-summary").status, "ready");
});

test("a projecting commit that does not settle forgets the inputs remembered before it", () => {
  let recorded = null;
  const store = createSessionDomainStore({ eventRecordForSession: () => recorded });
  const snapshot = committed();
  settle(store, snapshot, row());
  assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), [], "remembered: a working row and no event sidecar");

  // The row turns idle while the event sidecar appears. This commit moves the kept event record,
  // so its own inputs are not remembered, and the earlier ones must not stay remembered either.
  recorded = normalizeSessionEventRecord({ version: 1, refills: [], compactions: [{ at: OBSERVED_AT, agentId: "primary", trigger: "manual" }] });
  assert.ok(store.commit(SESSION_ID, snapshot, row({ activityStatus: "idle" })).some((event) => event.domain === "session-summary"));
  assert.equal(served(store, "session-summary").lifecycle.activityStatus, "idle");

  // The row and the sidecar answer return to their earlier values: the inputs of the commit
  // before last, not of the retained domains.
  recorded = null;
  const before = store.stats().projections;
  const published = store.commit(SESSION_ID, snapshot, row());
  assert.equal(store.stats().projections, before + 1, "the commit is projected, not skipped");
  assert.deepEqual(published.map((event) => event.domain), ["session-summary"]);
  assert.equal(served(store, "session-summary").lifecycle.activityStatus, "working");
  assert.ok(served(store, "session-summary").events.items.some((item) => item.kind === "context_compacted"), "the recorded compaction stays");
});

test("a placeholder that is displaced at once is not remembered, so a later request can admit it", () => {
  let clock = 0;
  const live = "codex:live-session";
  const id = "codex:registry-only";
  const store = createSessionDomainStore({ now: () => clock, maxSessions: 1, isProtected: (sessionId) => sessionId === live });
  store.read(live, "session-summary");
  store.commit(live, committed(state({ session: { ...state().session, id: live } })), row({ id: live }));
  clock += 1;
  const placeholder = row({ id, summaryReadiness: "unavailable", activityStatus: "open" });
  assert.deepEqual(store.commitUnavailable(id, placeholder, "Codex", {}), [], "the soft bound displaces a never-requested placeholder at once");
  assert.equal(store.has(id), false);

  clock += 1;
  assert.equal(store.read(id, "session-summary").status, "empty", "a request records demand for it");
  const before = store.stats();
  const published = store.commitUnavailable(id, placeholder, "Codex", {});
  assert.equal(store.stats().projections, before.projections + 1, "the same row is projected again: nothing is remembered for a session the store did not keep");
  assert.equal(store.stats().unchangedInputs, before.unchangedInputs);
  assert.ok(published.some((event) => event.domain === "session-summary"));
  const admitted = store.read(id, "session-summary");
  assert.equal(admitted.status, "ready");
  assert.equal(admitted.snapshot.value.readiness, "unavailable");
  assert.equal(store.has(live), true, "the protected live session stays");
  assert.deepEqual(store.commitUnavailable(id, placeholder, "Codex", {}), [], "now that it is kept, the unchanged placeholder is skipped");
  assert.equal(store.stats().unchangedInputs, before.unchangedInputs + 1);
});

test("a missing snapshot is never taken as unchanged, even after the remembered one was collected", () => {
  // The store holds the snapshot weakly. This stand-in lets the test collect it on demand,
  // which a real collection would do at a time no test can choose.
  const RealWeakRef = globalThis.WeakRef;
  let collected = false;
  globalThis.WeakRef = class { #target; constructor(target) { this.#target = target; } deref() { return collected ? undefined : this.#target; } };
  try {
    const store = createSessionDomainStore();
    const snapshot = committed();
    settle(store, snapshot, row());
    assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), []);
    assert.equal(store.stats().unchangedInputs, 1, "the snapshot is remembered through the weak reference");
    const serialized = store.read(SESSION_ID, "session-summary").snapshot.serialized;

    collected = true;
    for (const missing of [undefined, null]) {
      assert.throws(() => store.commit(SESSION_ID, missing, row()), /requires committed public state/u);
    }
    assert.equal(store.stats().unchangedInputs, 1);
    assert.equal(store.read(SESSION_ID, "session-summary").snapshot.serialized, serialized, "the retained domains are untouched");
    const before = store.stats().projections;
    assert.deepEqual(store.commit(SESSION_ID, snapshot, row()), [], "the same evidence is projected again and changes nothing");
    assert.equal(store.stats().projections, before + 1);
  } finally {
    globalThis.WeakRef = RealWeakRef;
  }
});

test("a skipped commit neither evicts an idle session nor enforces the session bound", () => {
  let clock = 0;
  const kept = "codex:kept-until-a-change";
  const committedTwice = "codex:committed-again";
  const protectedIds = new Set([kept, committedTwice]);
  const store = createSessionDomainStore({ now: () => clock, maxSessions: 1, idleMs: 1_000, isProtected: (id) => protectedIds.has(id) });
  const snapshots = new Map([kept, committedTwice].map((id) => [id, committed(state({ session: { ...state().session, id } }))]));
  // Neither session is ever requested, so both are retained only by their protection.
  for (const id of [kept, committedTwice]) settle(store, snapshots.get(id), row({ id }), id);
  assert.deepEqual(store.sessionIds(), [kept, committedTwice]);

  // Both sat idle past the idle window, and one lost its protection above the soft bound.
  clock += 5_000;
  protectedIds.delete(kept);
  const before = store.stats();
  assert.deepEqual(store.commit(committedTwice, snapshots.get(committedTwice), row({ id: committedTwice })), []);
  assert.equal(store.stats().unchangedInputs, before.unchangedInputs + 1, "the commit was skipped");
  assert.deepEqual(store.sessionIds(), [kept, committedTwice], "a skipped commit runs neither idle eviction nor the bound, like the no-op it replaces");

  // A real change does both, as before.
  assert.ok(store.commit(committedTwice, snapshots.get(committedTwice), row({ id: committedTwice, activityStatus: "idle" })).length > 0);
  assert.deepEqual(store.sessionIds(), [committedTwice]);
});
