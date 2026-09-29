import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  chronological,
  foldSessionEvidence,
  mergeByKey,
} from "../monitor/providers/session-fold.mjs";
import {
  createCodexIncrementalObserver,
  mergeCodexObservationEvidence,
} from "../monitor/providers/codex-observation.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { readProviderFixture } from "./helpers/provider-fixtures.mjs";

// ---------------------------------------------------------------------------
// Helpers for hand-built evidence objects.
// ---------------------------------------------------------------------------
function baseEvidence(overrides = {}) {
  return {
    localId: "fixture",
    historical: false,
    session: { pomegrPlugin: null },
    agents: [{ id: "primary", label: "Primary agent", assignment: null, skills: [], toolCalls: 0 }],
    usageSnapshots: [],
    toolCalls: [],
    activity: [],
    compactions: [],
    pullRequestCreations: [],
    efficiencyRuleEvidence: {},
    ...overrides,
  };
}

// ===========================================================================
// 1. Generic session-fold.mjs primitives.
// ===========================================================================

test("chronological orders items by timestamp, falling back to observedAt", () => {
  const items = [
    { observedAt: "2026-09-01T00:00:02.000Z" },
    { timestamp: "2026-09-01T00:00:01.000Z" },
    { timestamp: "2026-09-01T00:00:03.000Z" },
  ];
  assert.deepStrictEqual(
    [...items].sort(chronological).map((item) => item.timestamp || item.observedAt),
    ["2026-09-01T00:00:01.000Z", "2026-09-01T00:00:02.000Z", "2026-09-01T00:00:03.000Z"],
  );
});

test("mergeByKey unions by key and lets current win a collision by default", () => {
  const previous = [{ id: "a", timestamp: "2026-09-01T00:00:01.000Z", tag: "old" }];
  const current = [
    { id: "a", timestamp: "2026-09-01T00:00:02.000Z", tag: "new" },
    { id: "b", timestamp: "2026-09-01T00:00:03.000Z", tag: "new" },
  ];
  const merged = mergeByKey(previous, current, (item) => item.id, 10);
  assert.deepStrictEqual(merged, [
    { id: "a", timestamp: "2026-09-01T00:00:02.000Z", tag: "new" },
    { id: "b", timestamp: "2026-09-01T00:00:03.000Z", tag: "new" },
  ]);
});

test("mergeByKey respects a custom prefer function on collision", () => {
  const previous = [{ id: "a", timestamp: "2026-09-01T00:00:01.000Z", strength: 5 }];
  const current = [{ id: "a", timestamp: "2026-09-01T00:00:02.000Z", strength: 1 }];
  const preferStronger = (older, newer) => (newer.strength >= older.strength ? newer : older);
  const merged = mergeByKey(previous, current, (item) => item.id, 10, preferStronger);
  assert.deepStrictEqual(merged, previous);
});

test("mergeByKey keeps only the newest N and drops the oldest once the bound is exceeded", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: `item-${index}`,
    timestamp: `2026-09-01T00:00:0${index}.000Z`,
  }));
  const merged = mergeByKey(items.slice(0, 3), items.slice(3), (item) => item.id, 3);
  assert.deepStrictEqual(merged.map((item) => item.id), ["item-2", "item-3", "item-4"]);
});

// ===========================================================================
// 2. foldSessionEvidence: every declared policy kind.
// ===========================================================================

test("foldSessionEvidence returns current unchanged when previous is null or undefined", () => {
  const current = { a: 1 };
  assert.strictEqual(foldSessionEvidence({ a: { kind: "current" } }, null, current), current);
  assert.strictEqual(foldSessionEvidence({ a: { kind: "current" } }, undefined, current), current);
});

test("foldSessionEvidence returns a new object for a non-null previous, and undeclared fields take current", () => {
  const current = { a: 9, b: 8, c: 7 };
  const result = foldSessionEvidence({}, { a: 1, b: 2 }, current);
  assert.deepStrictEqual(result, current);
  assert.notStrictEqual(result, current, "a non-null previous must always yield a new object");
});

test("kind 'keyed': unions by key, resolves a collision via prefer, and keeps a bounded newest N", () => {
  const policy = {
    items: {
      kind: "keyed",
      key: (item) => item.id,
      maximum: 2,
      prefer: (_older, newer) => ({ ...newer, merged: true }),
    },
  };
  const previous = { items: [
    { id: "a", timestamp: "2026-09-01T00:00:01.000Z" },
    { id: "b", timestamp: "2026-09-01T00:00:02.000Z" },
  ] };
  const current = { items: [
    { id: "b", timestamp: "2026-09-01T00:00:03.000Z" },
    { id: "c", timestamp: "2026-09-01T00:00:04.000Z" },
  ] };
  const result = foldSessionEvidence(policy, previous, current);
  assert.deepStrictEqual(result.items, [
    { id: "b", timestamp: "2026-09-01T00:00:03.000Z", merged: true },
    { id: "c", timestamp: "2026-09-01T00:00:04.000Z" },
  ]);
});

test("kind 'current': takes the delta's value, including an explicit clearing", () => {
  const policy = { status: { kind: "current" } };
  const result = foldSessionEvidence(policy, { status: "active" }, { status: null });
  assert.strictEqual(result.status, null, "a value cleared in the delta must stay cleared, never retained");
});

test("kind 'or-flags': ORs previous and current over current's keys only", () => {
  const policy = { flags: { kind: "or-flags" } };
  const previous = { flags: { a: true, b: false, z: true } };
  const current = { flags: { a: false, b: false, c: true } };
  const result = foldSessionEvidence(policy, previous, current);
  assert.deepStrictEqual(result.flags, { a: true, b: false, c: true });
});

test("kind 'retain-if-absent': keeps the previous value when the delta is missing it, and accepts a real update", () => {
  const policy = { "session.marker": { kind: "retain-if-absent" } };
  const withoutMarker = foldSessionEvidence(
    policy,
    { session: { marker: { v: 1 } } },
    { session: { other: 2 } },
  );
  assert.deepStrictEqual(withoutMarker.session, { other: 2, marker: { v: 1 } });
  const withUpdatedMarker = foldSessionEvidence(
    policy,
    { session: { marker: { v: 1 } } },
    { session: { marker: { v: 2 }, other: 3 } },
  );
  assert.deepStrictEqual(withUpdatedMarker.session, { other: 3, marker: { v: 2 } });
});

test("kind 'custom': receives already-folded dependencies in declaration order", () => {
  const policy = {
    a: { kind: "current" },
    b: {
      kind: "custom",
      dependsOn: ["a"],
      merge: (previousB, currentB, folded) => ({ fromA: folded.a, combined: (previousB || 0) + (currentB || 0) }),
    },
  };
  const result = foldSessionEvidence(policy, { a: 1, b: 2 }, { a: 5, b: 3 });
  assert.deepStrictEqual(result.b, { fromA: 5, combined: 5 });
});

test("kind 'custom': throws when its declared dependency was not folded earlier in the policy", () => {
  const policy = {
    b: { kind: "custom", dependsOn: ["a"], merge: () => null },
  };
  assert.throws(
    () => foldSessionEvidence(policy, { b: 1 }, { b: 2 }),
    /depends on unfolded field "a"/,
  );
});

test("foldSessionEvidence throws on an unrecognized policy kind", () => {
  assert.throws(
    () => foldSessionEvidence({ x: { kind: "not-a-real-kind" } }, { x: 1 }, { x: 2 }),
    /unknown policy kind/,
  );
});

// ===========================================================================
// 3. Codex evidence merge: hand-built collisions.
// ===========================================================================

test("codex merge: fileChanges are retained on a toolCalls collision only when the newer call did not fail", () => {
  const previous = baseEvidence({
    toolCalls: [{ id: "call-1", timestamp: "2026-09-01T00:00:01.000Z", status: "completed", fileChanges: [{ path: "a.ts" }], actor: { id: "primary" } }],
  });
  const retained = baseEvidence({
    toolCalls: [{ id: "call-1", timestamp: "2026-09-01T00:00:02.000Z", status: "completed", fileChanges: null, actor: { id: "primary" } }],
  });
  const merged = mergeCodexObservationEvidence(previous, retained);
  assert.deepStrictEqual(merged.toolCalls[0].fileChanges, [{ path: "a.ts" }], "a completed rereplay retains the prior fileChanges");

  const failed = baseEvidence({
    toolCalls: [{ id: "call-1", timestamp: "2026-09-01T00:00:02.000Z", status: "failed", fileChanges: null, actor: { id: "primary" } }],
  });
  const mergedFailed = mergeCodexObservationEvidence(previous, failed);
  assert.strictEqual(mergedFailed.toolCalls[0].fileChanges, null, "a failed call never inherits the prior fileChanges");
});

test("codex merge: compaction strength ties keep the newer preTokens, but never downgrade an already-resolved value", () => {
  const previousResolved = baseEvidence({
    compactions: [{ actorId: "primary", timestamp: "2026-09-01T00:00:01.000Z", trigger: "auto", preTokens: 200_000 }],
  });
  const currentUnresolved = baseEvidence({
    compactions: [{ actorId: "primary", timestamp: "2026-09-01T00:00:01.000Z", trigger: "auto", preTokens: null }],
  });
  const keepsResolved = mergeCodexObservationEvidence(previousResolved, currentUnresolved);
  assert.strictEqual(keepsResolved.compactions[0].preTokens, 200_000, "an unresolved delta never downgrades a resolved preTokens");

  const previousUnresolved = baseEvidence({
    compactions: [{ actorId: "primary", timestamp: "2026-09-01T00:00:01.000Z", trigger: "auto", preTokens: null }],
  });
  const currentResolved = baseEvidence({
    compactions: [{ actorId: "primary", timestamp: "2026-09-01T00:00:01.000Z", trigger: "auto", preTokens: 150_000 }],
  });
  const resolves = mergeCodexObservationEvidence(previousUnresolved, currentResolved);
  assert.strictEqual(resolves.compactions[0].preTokens, 150_000, "preTokens null -> value resolves on an equal-strength tie");

  const previousInferred = baseEvidence({
    compactions: [{ actorId: "primary", timestamp: "2026-09-01T00:00:01.000Z", trigger: "auto", inferred: true, preTokens: 90_000 }],
  });
  const currentStronger = baseEvidence({
    compactions: [{ actorId: "primary", timestamp: "2026-09-01T00:00:01.000Z", trigger: "explicit", preTokens: null }],
  });
  const stronger = mergeCodexObservationEvidence(previousInferred, currentStronger);
  assert.strictEqual(stronger.compactions[0].trigger, "explicit", "a stronger compaction wins even without preTokens");
});

test("codex merge: a SessionStart plugin marker absent from the delta is retained, and a present one wins", () => {
  const previous = baseEvidence({ session: { pomegrPlugin: { status: "active", version: "1.0.0" } } });
  const currentAbsent = baseEvidence({ session: { pomegrPlugin: null } });
  const retained = mergeCodexObservationEvidence(previous, currentAbsent);
  assert.deepStrictEqual(retained.session.pomegrPlugin, { status: "active", version: "1.0.0" }, "an absent marker in the delta is missing evidence, not a clear");

  const currentPresent = baseEvidence({ session: { pomegrPlugin: { status: "active", version: "1.1.0" } } });
  const updated = mergeCodexObservationEvidence(previous, currentPresent);
  assert.deepStrictEqual(updated.session.pomegrPlugin, { status: "active", version: "1.1.0" }, "a marker present in the delta always wins");
});

// ===========================================================================
// 4. Codex incremental == full, through the real incremental observer.
// ===========================================================================

async function waitForPublication(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex observer publication");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function publishFullRead(root, fixtureLines) {
  const directory = path.join(root, "sessions");
  await mkdir(directory);
  const file = path.join(directory, "rollout-full.jsonl");
  await writeFile(file, fixtureLines.join("\n") + "\n");
  const provider = createCodexProvider({
    codexHome: root, cacheMs: 0, includeArchived: false,
    writerPresence: { async refresh() {}, current() { return null; }, close() {} },
  });
  const published = [];
  const observer = createCodexIncrementalObserver({
    list: async () => [{ localId: "codex-fixture-parent", isLive: true, activityStatus: "working" }],
    discoveredMetadata: async () => [{ localId: "codex-fixture-parent", sessionId: "codex-fixture-parent", rolloutFile: file }],
    readEvidence: async (id, options) => provider.readSession(id, options),
    transcriptPathsBySessionId: new Map(), intervalMs: 60_000,
    watchTargets: [directory], watchSource() { return { close() {} }; },
  });
  const controller = new AbortController();
  await observer.start({
    publishCatalog() {}, publishSession(_id, candidate) { published.push(candidate); }, invalidateSession() {},
  }, controller.signal);
  await waitForPublication(() => published.length > 0);
  controller.abort();
  return published.at(-1);
}

async function publishIncrementalReads(root, fixtureLines, splitPoints) {
  const directory = path.join(root, "sessions");
  await mkdir(directory);
  const file = path.join(directory, "rollout-incremental.jsonl");
  await writeFile(file, fixtureLines.slice(0, splitPoints[0]).join("\n") + "\n");
  const provider = createCodexProvider({
    codexHome: root, cacheMs: 0, includeArchived: false,
    writerPresence: { async refresh() {}, current() { return null; }, close() {} },
  });
  const published = [];
  const observer = createCodexIncrementalObserver({
    list: async () => [{ localId: "codex-fixture-parent", isLive: true, activityStatus: "working" }],
    discoveredMetadata: async () => [{ localId: "codex-fixture-parent", sessionId: "codex-fixture-parent", rolloutFile: file }],
    readEvidence: async (id, options) => provider.readSession(id, options),
    transcriptPathsBySessionId: new Map(), intervalMs: 60_000,
    watchTargets: [directory], watchSource() { return { close() {} }; },
  });
  const controller = new AbortController();
  await observer.start({
    publishCatalog() {}, publishSession(_id, candidate) { published.push(candidate); }, invalidateSession() {},
  }, controller.signal);
  await waitForPublication(() => published.length > 0);
  for (let index = 1; index < splitPoints.length; index += 1) {
    await writeFile(file, fixtureLines.slice(0, splitPoints[index]).join("\n") + "\n");
    const before = published.length;
    await observer.hydrate("codex-fixture-parent");
    await waitForPublication(() => published.length > before).catch(() => {});
  }
  controller.abort();
  return published;
}

// Every agent field EXCEPT status/liveness is governed by CODEX_FOLD_POLICY
// (directly, or by taking "current" as the default). status and liveness are
// decorated onto agents by owningRuntime/liveness detection *before* the fold
// ever runs, from real native writer-presence and observation-recency signals
// that are independent of record content. Investigating this test found that
// a session observed through several live reads (as the incremental path
// does) can legitimately be decorated "active" with structured_lifecycle
// evidence, while a session read exactly once (the one-shot full read) is
// decorated "idle"/null -- purely because it was only ever observed once.
// That is a real property of native liveness detection, not something
// session-fold.mjs folds, so it is excluded here rather than asserted on.
function withoutNativeLivenessFields(evidence) {
  const { observationSource: _observationSource, ...rest } = evidence;
  return {
    ...rest,
    agents: rest.agents.map(({ status: _status, liveness: _liveness, ...agent }) => agent),
  };
}

test("Codex incremental folds converge to the same evidence as one complete read, for every field the fold governs", async (context) => {
  const fixtureText = await readProviderFixture("codex/parent.jsonl");
  const fixtureLines = fixtureText.trim().split("\n");
  const fullRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pomegr-session-fold-full-")));
  const incrementalRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pomegr-session-fold-incremental-")));
  context.after(() => Promise.all([
    rm(fullRoot, { recursive: true, force: true }),
    rm(incrementalRoot, { recursive: true, force: true }),
  ]));

  const fullEvidence = await publishFullRead(fullRoot, fixtureLines);
  // Several split points, each strictly smaller than the fixture's own tail
  // lookbehind window, so every incremental read still sees the records that
  // established approval mode, plan tasks, and the pomegrPlugin marker.
  const splitPoints = [3, 8, 12, fixtureLines.length];
  const incrementalPublications = await publishIncrementalReads(incrementalRoot, fixtureLines, splitPoints);
  const incrementalEvidence = incrementalPublications.at(-1);

  assert.ok(fullEvidence && incrementalEvidence, "both reads must resolve to real evidence for this check to be meaningful");
  assert.deepStrictEqual(
    withoutNativeLivenessFields(incrementalEvidence),
    withoutNativeLivenessFields(fullEvidence),
    "an incrementally folded Codex session must match a single complete read on every fold-governed field",
  );
});
