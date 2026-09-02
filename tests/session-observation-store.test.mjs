import assert from "node:assert/strict";
import test from "node:test";
import { SessionObservationStore } from "../monitor/session-observation-store.mjs";

function candidate(providerId, localSessionId, value, extra = {}) {
  return {
    providerId,
    localSessionId,
    evidence: { value },
    readiness: { core: "ready" },
    publicState: { session: localSessionId, value },
    observedAt: "2026-08-28T12:00:00.000Z",
    source: { fingerprint: `fingerprint-${localSessionId}`, completeOffset: value },
    ...extra,
  };
}

test("publishes immutable atomic revisions and retains last-known-good state on rejection", () => {
  let serializations = 0;
  const store = new SessionObservationStore({
    serialize(value) {
      serializations += 1;
      return JSON.stringify(value);
    },
    validateCandidate(value) {
      return value.evidence.value !== "reject";
    },
  });

  const first = store.publish(candidate("provider-a", "session-1", 1));
  assert.equal(first.accepted, true);
  assert.equal(first.snapshot.revision, 1);
  assert.equal(Object.isFrozen(first.snapshot), true);
  assert.equal(Object.isFrozen(first.snapshot.evidence), true);
  assert.throws(() => { first.snapshot.evidence.value = 2; }, TypeError);
  const serialized = store.getSerialized("provider-a", "session-1");

  const rejected = store.publish(candidate("provider-a", "session-1", "reject"));
  assert.deepEqual(rejected, { accepted: false, snapshot: null, reason: "rejected" });
  assert.strictEqual(store.get("provider-a", "session-1"), first.snapshot);
  assert.strictEqual(store.getSerialized("provider-a", "session-1"), serialized);
  assert.equal(serializations, 2, "the rejected candidate never replaces the cached serialization");

  const replacement = store.publish(candidate("provider-a", "session-1", 3));
  assert.equal(replacement.snapshot.revision, 2);
  assert.equal(store.get("provider-a", "session-1").publicState.value, 3);
});

test("isolates providers and evicts only unpinned least-recently-used historical entries", () => {
  let tick = 0;
  const store = new SessionObservationStore({ maxEntries: 2, maxBytes: 10_000, now: () => ++tick });
  store.publish(candidate("provider-a", "same-local-id", 1));
  store.setPinned("provider-a", "same-local-id", true);
  store.publish(candidate("provider-b", "same-local-id", 2));
  store.publish(candidate("provider-b", "old", 3));

  assert.equal(store.get("provider-a", "same-local-id").publicState.value, 1);
  assert.equal(store.get("provider-b", "same-local-id"), null, "provider B cannot replace provider A and is LRU evicted");
  assert.equal(store.get("provider-b", "old").publicState.value, 3);
  assert.deepEqual(store.stats(), {
    entries: 2,
    bytes: store.stats().bytes,
    maxEntries: 2,
    maxBytes: 10_000,
    pinnedEntries: 1,
  });
});

test("rejects snapshots that cannot fit the bounded normalized-memory budget", () => {
  const store = new SessionObservationStore({ maxBytes: 20 });
  const result = store.publish(candidate("provider-a", "session-1", "a value larger than the memory budget"));
  assert.equal(result.accepted, false);
  assert.equal(store.get("provider-a", "session-1"), null);
});

test("restores a checkpoint revision without decreasing a newer committed revision", () => {
  const store = new SessionObservationStore();
  const restored = store.restore(candidate("provider-a", "session-1", 1, { revision: 7 }));
  assert.equal(restored.accepted, true);
  assert.equal(restored.snapshot.revision, 7);
  store.publish(candidate("provider-a", "session-1", 2));
  const stale = store.restore(candidate("provider-a", "session-1", 1, { revision: 7 }));
  assert.equal(stale.accepted, false);
  assert.equal(store.get("provider-a", "session-1").revision, 8);
});

test("accepts repeated normalized references while still rejecting actual cycles", () => {
  const store = new SessionObservationStore();
  const shared = { id: "task-1" };
  const accepted = store.publish(candidate("codex", "shared", 1, {
    publicState: { agents: [{ tasks: [shared] }], tasks: [shared] },
  }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.snapshot.publicState.agents[0].tasks[0], accepted.snapshot.publicState.tasks[0]);

  const cycle = {};
  cycle.self = cycle;
  const rejected = store.publish(candidate("codex", "cycle", 1, { publicState: cycle }));
  assert.equal(rejected.accepted, false);
});

test("does not advance a revision for an identical committed candidate", () => {
  const store = new SessionObservationStore();
  const first = store.publish(candidate("codex", "stable", 1, { pinned: true }));
  const second = store.publish(candidate("codex", "stable", 1, { pinned: true }));
  assert.equal(second.accepted, true);
  assert.equal(second.unchanged, true);
  assert.strictEqual(second.snapshot, first.snapshot);
  assert.equal(store.stats().pinnedEntries, 1);
});

test("recovered entries never reuse revisions after eviction or checkpoint restore", () => {
  const store = new SessionObservationStore({ maxEntries: 1 });
  const restored = store.restore(candidate("claude", "old", 1, { revision: 7 }));
  store.publish(candidate("codex", "other", 1));
  assert.equal(store.get("claude", "old"), null);
  const recovered = store.publish(candidate("claude", "old", 1));
  assert.ok(recovered.snapshot.revision > restored.snapshot.revision);
  const unchanged = store.publish(candidate("claude", "old", 1));
  assert.equal(unchanged.snapshot.revision, recovered.snapshot.revision);
});
