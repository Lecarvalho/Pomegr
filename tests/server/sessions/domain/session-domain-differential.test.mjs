import assert from "node:assert/strict";
import test from "node:test";
import { createSessionDomainStore, SESSION_DOMAIN_NAMES } from "../../../../server/sessions/domain/session-domain-store.mjs";
import { mergeSessionEventRecord, normalizeSessionEventRecord, sessionEventRecordIsEmpty } from "../../../../server/sessions/domain/session-event-record.mjs";
import { createEmptyMonitorState } from "../../../../shared/monitor-state.mjs";

// A scripted run over two stores that receive the same commits, requests, side-channel answers,
// and clock. The skipping store is given what the runtime gives it: deep-frozen snapshots, so it
// recognizes unchanged inputs. The projecting store is given equal unfrozen copies, and
// placeholder capabilities it cannot serialize, so it projects every commit, as the store did
// before unchanged inputs were skipped. Everything observable must match after every step.

const at = (minute) => new Date(Date.UTC(2026, 8, 14, 12, minute)).toISOString();
const IDS = Array.from({ length: 9 }, (_, index) => `codex:run-${String(index).padStart(2, "0")}`);
const REGISTRY_ONLY = new Set(IDS.slice(7));
const IDLE_MS = 5_000;
const MAX_SESSIONS = 3;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// A small generator with well-mixed low bits; a plain multiplicative one repeats `% bound`.
function generator(seed) {
  let state = seed;
  return (bound) => {
    state = (state + 0x6D2B79F5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) % bound;
  };
}

function publicState(id, variant) {
  const base = createEmptyMonitorState({ connected: true, source: "Codex", view: variant.historical ? "history" : "live" });
  const refills = Array.from({ length: variant.refills }, (_, index) => ({ observedAt: at(10 + index), ...(index % 2 ? { kind: "provider_diagnosed" } : {}) }));
  return {
    ...base,
    session: {
      id, title: `Title ${variant.title}`, project: "Pomegr", startedAt: at(0), updatedAt: at(variant.title % 50), durationMs: 1,
      cost: null, summary: null, progress: null, pomegrPlugin: null, signal: null, repositoryId: "repo-1", contextInventoryRef: null,
      repository: variant.historical
        ? { available: true, branch: "main", files: [{ status: "modified", path: "app/file.ts" }], comparison: null, historical: true }
        : { available: variant.title % 4 !== 0, branch: "main", files: [], comparison: null, historical: false },
      pullRequests: null,
    },
    agents: [{ id: "primary", parentId: null, label: "Primary", role: "orchestrator", customType: null, model: "test", status: variant.title % 3 ? "active" : "idle", currentActivity: null,
      tokens: { total: 20 }, lastSeen: at(0), startedAt: at(0), updatedAt: at(0), cacheLifetime: null, signal: null,
      executionTasks: [{ id: "task-1", kind: "shell", workKind: "test", status: variant.title % 2 ? "running" : "completed", background: false, backgroundId: null,
        startedAt: at(0), finishedAt: variant.title % 2 ? null : at(1), exitCode: null, failureCause: null }] }],
    metrics: { ...base.metrics, agents: 1, activeAgents: 1, tokens: { ...base.metrics.tokens, allAgents: 20,
      contextHistory: { bucketMs: 60_000, buckets: [], boundaries: Array.from({ length: variant.boundaries }, (_, index) => ({ id: `b${index}`, agentId: "primary", timestamp: at(30 + index),
        kind: index % 2 ? "manual_compaction" : "automatic_compaction", preTokens: 10 })) },
      cacheEvents: { status: "ready", items: [], possibleFullRefills: refills.length ? [{ agentId: "primary", count: refills.length, occurrences: refills, reasons: [], toolChangeAttributions: [] }] : [] } } },
    readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "ready", usageLimits: "ready" },
  };
}

// The frozen answers each side channel can give, as its real owner would: replaced, never changed.
const RESOURCES = [null,
  deepFreeze({ readiness: "loading", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] }),
  deepFreeze({ readiness: "unavailable", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] }),
  deepFreeze({ readiness: "ready", minutes: [], minutesTruncated: false, curveRemoval: null,
    peaks: [{ id: "p1", field: "cpu_cores", observedAt: at(5), value: 4, matchedTaskIds: ["task-1"], matchedTaskCount: 1, window: { status: "not_retained", samples: [], minute: null } }] })];
const FILES = [null,
  deepFreeze({ readiness: "loading", files: [], truncated: false }),
  deepFreeze({ readiness: "ready", truncated: false, files: [{ fileId: "f1", path: "app/file.ts", kind: "edited", changeCount: 1, lastObservedAt: at(4), agents: [{ agentId: "primary", changeCount: 1 }] }] })];
const RECORDS = [null,
  deepFreeze({ gitObserved: null, commitTimes: null }),
  deepFreeze({ gitObserved: null, commitTimes: [at(40)] }),
  deepFreeze({ gitObserved: { files: [{ path: "docs/notes.md", source: "committed", change: "modified" }], truncated: false }, commitTimes: [at(40), at(41)] })];
const STATUSES = ["working", "idle", "needs_input", "stopped", "open"];
const ACTIVITIES = [null, { label: "Running tests", observedAt: at(7), state: "current" }];
const FALLBACKS = [null, { label: "test run", observedAt: at(8), state: "last_observed", source: "execution_task", actor: "primary" }];

const ACTIONS = ["catalogPass", "evidence", "equalEvidence", "rowChange", "flipBack", "unsettledRoundTrip", "read", "clockJump", "evictIdle", "placeholder", "sideInput", "compareAll", "clear"];
const WEIGHTS = [60, 22, 8, 24, 16, 8, 14, 12, 12, 12, 30, 5, 1];

function run(seed, steps) {
  const random = generator(seed);
  const pick = (list) => list[random(list.length)];
  let clock = 0;
  const world = new Map(IDS.map((id) => [id, { reason: null, resources: null, files: null, record: null, events: null,
    variant: { title: 0, refills: 0, boundaries: 0, historical: false }, version: 0,
    row: { present: 1, status: 0, activity: 0, fallback: 0, updated: 0 } }]));
  const handed = { skipping: [], projecting: [] };
  const hooks = (list) => ({
    now: () => clock, maxSessions: MAX_SESSIONS, idleMs: IDLE_MS,
    // As in the runtime, protection follows the catalog row, so it changes without any commit.
    isProtected: (id) => { const { row } = world.get(id); return row.present === 1 && row.status !== 3; },
    repositoryUnavailableReasonForSession: (id) => world.get(id).reason,
    retainedResourcesForSession: (id) => world.get(id).resources,
    fileHistoryForSession: (id) => world.get(id).files,
    repositoryRecordForSession: (id) => world.get(id).record,
    eventRecordForSession: (id) => world.get(id).events,
    onEventRecord: (id, record) => list.push([id, JSON.stringify(record)]),
  });
  const skipping = createSessionDomainStore(hooks(handed.skipping));
  const projecting = createSessionDomainStore(hooks(handed.projecting));
  const events = { skipping: [], projecting: [] };
  skipping.subscribe((event) => events.skipping.push(event));
  projecting.subscribe((event) => events.projecting.push(event));

  const snapshots = new Map();
  const snapshotFor = (id) => {
    const entry = world.get(id);
    const key = `${id}#${entry.version}`;
    if (!snapshots.has(key)) {
      const state = publicState(id, entry.variant);
      snapshots.set(key, deepFreeze({ publicState: state, readiness: state.readiness, observedAt: at(entry.variant.title % 50),
        evidence: { toolCalls: [], userMessageTimes: [at(1)], pullRequestCreations: [] } }));
    }
    return snapshots.get(key);
  };
  const rowFor = (id) => {
    const { row } = world.get(id);
    if (row.present === 0) return null;
    // A session outside the shell feed has only its inventory identity.
    if (row.present === 2) return { id, provider: "codex", summaryReadiness: "loading", isLive: false, needsInput: false, activityStatus: "unknown" };
    return { id, provider: "codex", source: "Codex", title: `Row at ${clock}`, updatedAt: at(row.updated % 50), agentCount: clock, summaryReadiness: "ready",
      isLive: row.status !== 3, needsInput: row.status === 2, activityStatus: STATUSES[row.status],
      currentActivity: ACTIVITIES[row.activity], activityFallback: FALLBACKS[row.fallback] };
  };

  // Sometimes kept before a change, so that a later step can put a session's row and sources
  // back exactly as they were: the inputs of an earlier commit, not of the retained domains.
  const inputsOf = (entry) => ({ row: entry.row, reason: entry.reason, resources: entry.resources, files: entry.files, record: entry.record, events: entry.events });
  const keepEarlier = (entry) => { if (!entry.earlier || random(3) === 0) entry.earlier = inputsOf(entry); };

  const tally = Object.fromEntries(ACTIONS.map((name) => [name, 0]));
  const seen = { idleEvictions: 0, catalogPassChanges: 0, rowChangeCommits: 0, placeholderEvents: 0, sideInputChanges: 0, handovers: 0, placeholdersSkipped: 0, flipBacks: 0, roundTrips: 0, passesAboveBound: 0 };

  function placeholderBoth(id, label) {
    const skippedBefore = skipping.stats().unchangedInputs;
    const left = skipping.commitUnavailable(id, rowFor(id), "Codex", { liveSessions: true });
    const right = projecting.commitUnavailable(id, rowFor(id), "Codex", { liveSessions: true, unserializable: 1n });
    assert.deepEqual(left, right, `${label}: commitUnavailable ${id}`);
    seen.placeholderEvents += left.length;
    seen.placeholdersSkipped += skipping.stats().unchangedInputs - skippedBefore;
    return left;
  }
  function commitBoth(id, label) {
    // A registry-only session never has evidence: the runtime commits its placeholder instead.
    if (REGISTRY_ONLY.has(id)) return placeholderBoth(id, label);
    const left = skipping.commit(id, snapshotFor(id), rowFor(id));
    const right = projecting.commit(id, structuredClone(snapshotFor(id)), rowFor(id));
    assert.deepEqual(left, right, `${label}: commit result for ${id}`);
    return left;
  }
  // The recorder merges a handed record into the sidecar and recommits; a write can fail.
  function applyHandovers(label) {
    assert.deepEqual(handed.skipping, handed.projecting, `${label}: recorder hand-overs`);
    const pending = handed.skipping.splice(0);
    handed.projecting.length = 0;
    for (const [id, json] of pending) {
      seen.handovers += 1;
      if (random(4) === 0) continue;
      const entry = world.get(id);
      const merged = mergeSessionEventRecord(entry.events, normalizeSessionEventRecord(JSON.parse(json)));
      if (!sessionEventRecordIsEmpty(merged)) entry.events = merged;
      if (skipping.has(id)) commitBoth(id, label);
    }
    return pending.length;
  }
  function compareAll(label) {
    for (const id of IDS) {
      for (const domain of SESSION_DOMAIN_NAMES) {
        const left = skipping.read(id, domain, "primary");
        const right = projecting.read(id, domain, "primary");
        assert.deepEqual([left.status, left.revision, left.snapshot?.serialized, left.snapshot?.committedAt],
          [right.status, right.revision, right.snapshot?.serialized, right.snapshot?.committedAt], `${label}: ${id} ${domain}`);
      }
    }
  }
  function chooseAction() {
    let ticket = random(WEIGHTS.reduce((sum, weight) => sum + weight, 0));
    for (const [index, weight] of WEIGHTS.entries()) {
      if (ticket < weight) return ACTIONS[index];
      ticket -= weight;
    }
    return ACTIONS[0];
  }

  for (let step = 0; step < steps; step += 1) {
    const label = `seed ${seed} step ${step}`;
    const id = pick(IDS);
    const entry = world.get(id);
    const action = chooseAction();
    tally[action] += 1;
    if (action === "catalogPass") {
      // Every retained session recommits with its current row and whatever its sources now answer.
      // Protected sessions can hold the store above its soft bound; a skipped commit must leave it there.
      if (skipping.size() > MAX_SESSIONS) seen.passesAboveBound += 1;
      for (const retained of skipping.sessionIds()) {
        const dirty = world.get(retained).rowDirty === true;
        world.get(retained).rowDirty = false;
        const published = commitBoth(retained, label);
        if (published.length > 0) seen.catalogPassChanges += 1;
        if (published.length > 0 && dirty) seen.rowChangeCommits += 1;
      }
    } else if (action === "evidence") {
      entry.version += 1;
      entry.variant = { title: entry.variant.title + random(2), refills: random(4) ? entry.variant.refills : random(4), boundaries: random(4) ? entry.variant.boundaries : random(3),
        historical: random(6) === 0 };
      commitBoth(id, label);
    } else if (action === "equalEvidence") {
      entry.version += 1;
      commitBoth(id, label);
    } else if (action === "rowChange") {
      // Mostly the row of a retained session, where only the next catalog pass can notice it.
      const retained = skipping.sessionIds();
      const target = world.get(retained.length && random(4) ? pick(retained) : id);
      keepEarlier(target);
      target.row = { present: random(5) === 0 ? random(3) : target.row.present, status: random(STATUSES.length), activity: random(ACTIVITIES.length), fallback: random(FALLBACKS.length),
        updated: target.row.updated + random(2) };
      target.rowDirty = true;
    } else if (action === "flipBack") {
      const retained = skipping.sessionIds();
      const target = world.get(retained.length && random(4) ? pick(retained) : id);
      if (target.earlier) {
        const current = inputsOf(target);
        Object.assign(target, target.earlier, { earlier: current, rowDirty: true });
        seen.flipBacks += 1;
      }
    } else if (action === "unsettledRoundTrip") {
      // Settle a session, commit it once with a changed row while a new sidecar entry appears and
      // its write fails, then put the row and the sidecar answer back as they were.
      const candidates = skipping.sessionIds().filter((retained) => !REGISTRY_ONLY.has(retained));
      if (candidates.length) {
        const target = pick(candidates);
        const settledInputs = world.get(target);
        commitBoth(target, label);
        commitBoth(target, label);
        const { row, events: recorded } = settledInputs;
        settledInputs.row = { ...row, status: (row.status + 1 + random(STATUSES.length - 1)) % STATUSES.length };
        settledInputs.events = mergeSessionEventRecord(recorded, normalizeSessionEventRecord({ version: 1, refills: [],
          compactions: [{ at: new Date(Date.UTC(2026, 8, 15, 0, 0, seen.roundTrips)).toISOString(), agentId: "primary", trigger: "manual" }] }));
        commitBoth(target, label);
        assert.deepEqual(handed.skipping, handed.projecting, `${label}: recorder hand-overs`);
        handed.skipping.length = 0;
        handed.projecting.length = 0;
        settledInputs.row = row;
        settledInputs.events = recorded;
        if (skipping.has(target)) commitBoth(target, label);
        seen.roundTrips += 1;
      }
    } else if (action === "read") {
      const domain = pick(SESSION_DOMAIN_NAMES);
      const retainedBefore = skipping.size();
      const left = skipping.read(id, domain, "primary");
      const right = projecting.read(id, domain, "primary");
      assert.deepEqual([left.status, left.revision, left.snapshot?.serialized], [right.status, right.revision, right.snapshot?.serialized], `${label}: read ${id} ${domain}`);
      // A request evicts what sat idle, and nothing else.
      seen.idleEvictions += retainedBefore - skipping.size();
    } else if (action === "clockJump") {
      clock += random(IDLE_MS * 2);
    } else if (action === "evictIdle") {
      const left = skipping.evictIdle();
      assert.deepEqual(left, projecting.evictIdle(), `${label}: evictIdle`);
      seen.idleEvictions += left.length;
    } else if (action === "placeholder") {
      // For a session with evidence this also checks that a placeholder never replaces it.
      placeholderBoth(id, label);
    } else if (action === "sideInput") {
      keepEarlier(entry);
      const before = JSON.stringify([entry.reason, entry.resources, entry.files, entry.record, entry.events]);
      const which = random(6);
      if (which === 0) entry.reason = entry.reason ? null : "branch_changed";
      if (which === 1) entry.resources = pick(RESOURCES);
      if (which === 2) entry.files = pick(FILES);
      if (which === 3) entry.record = pick(RECORDS);
      // The recorder evicted the sidecar, or read back an equal record in a new object.
      if (which === 4) entry.events = entry.events && random(2) ? normalizeSessionEventRecord(JSON.parse(JSON.stringify(entry.events))) : null;
      // A recorded kind that conflicts with what the evidence derives for the same agent and time.
      if (which === 5) entry.events = normalizeSessionEventRecord({ version: 1, refills: [{ at: at(10), agentId: "primary", kind: "lifetime_elapsed" }], compactions: [] });
      if (before !== JSON.stringify([entry.reason, entry.resources, entry.files, entry.record, entry.events])) seen.sideInputChanges += 1;
      // Half of the sources announce a change with a commit; the rest wait for a catalog pass.
      if (random(2) === 0 && skipping.has(id)) commitBoth(id, label);
    } else if (action === "compareAll") {
      compareAll(label);
    } else {
      skipping.clear();
      projecting.clear();
    }
    for (let round = 0; round < 3 && applyHandovers(label) > 0; round += 1);
    handed.skipping.length = 0;
    handed.projecting.length = 0;
    clock += 1;
    assert.deepEqual(skipping.sessionIds(), projecting.sessionIds(), `${label}: retention order after ${action}`);
    assert.deepEqual(events.skipping, events.projecting, `${label}: events after ${action}`);
    events.skipping.length = 0;
    events.projecting.length = 0;
  }
  compareAll(`seed ${seed} end`);
  return { tally, seen, skipping: skipping.stats(), projecting: projecting.stats() };
}

for (const seed of [1, 20_261_007, 77]) {
  test(`skipping unchanged inputs changes no event, revision, retention order, or eviction (seed ${seed})`, () => {
    const steps = 2_500;
    const result = run(seed, steps);
    // Every action ran, in about its share of the steps.
    const weightTotal = WEIGHTS.reduce((sum, weight) => sum + weight, 0);
    for (const [index, name] of ACTIONS.entries()) {
      const expected = steps * WEIGHTS[index] / weightTotal;
      assert.ok(result.tally[name] >= Math.max(3, expected / 2), `${name} ran ${result.tally[name]} times, expected about ${Math.round(expected)}`);
    }
    // And the run reached the states the comparison is about.
    assert.ok(result.seen.idleEvictions >= 20, `idle evictions: ${result.seen.idleEvictions}`);
    assert.ok(result.seen.rowChangeCommits >= 40, `catalog passes that published a changed row: ${result.seen.rowChangeCommits}`);
    assert.ok(result.seen.catalogPassChanges >= result.seen.rowChangeCommits + 10, `catalog passes that published for another reason: ${result.seen.catalogPassChanges - result.seen.rowChangeCommits}`);
    assert.ok(result.seen.sideInputChanges >= 100, `side-channel changes: ${result.seen.sideInputChanges}`);
    assert.ok(result.seen.placeholderEvents >= 100, `placeholder revisions: ${result.seen.placeholderEvents}`);
    assert.ok(result.seen.placeholdersSkipped >= 100, `unchanged placeholders skipped: ${result.seen.placeholdersSkipped}`);
    assert.ok(result.seen.flipBacks >= 50, `rows and sources put back as they were: ${result.seen.flipBacks}`);
    assert.ok(result.seen.roundTrips >= 30, `round trips through an unsettled commit: ${result.seen.roundTrips}`);
    assert.ok(result.seen.passesAboveBound >= 20, `catalog passes above the soft bound: ${result.seen.passesAboveBound}`);
    assert.ok(result.seen.handovers >= 50, `event-record hand-overs: ${result.seen.handovers}`);
    assert.equal(result.projecting.unchangedInputs, 0, "the reference store projected every commit");
    assert.ok(result.skipping.unchangedInputs >= 1_000, `skipped commits: ${result.skipping.unchangedInputs}`);
    assert.ok(result.skipping.projections * 2 < result.projecting.projections, "the skipping store ran less than half of the reference store's projections");
  });
}
