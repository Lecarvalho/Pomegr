import assert from "node:assert/strict";
import test from "node:test";
import { createCommittedResponseCache } from "../monitor/committed-response-cache.mjs";

test("committed response cache publishes immutable revisions and reuses serialization", () => {
  let serializations = 0;
  const cache = createCommittedResponseCache({
    now: () => Date.parse("2026-08-28T12:00:00.000Z"),
    serialize(value) {
      serializations += 1;
      return JSON.stringify(value);
    },
  });
  const input = { readiness: "ready", sessions: [{ id: "codex:one" }] };
  const first = cache.commit(input);
  input.sessions.push({ id: "codex:two" });

  assert.equal(first.revision, 1);
  assert.equal(first.serialized, '{"readiness":"ready","sessions":[{"id":"codex:one"}]}');
  assert.equal(cache.read(1).status, "unchanged");
  assert.equal(cache.read(0).snapshot.serialized, first.serialized);
  assert.equal(serializations, 1);
  assert.throws(() => first.value.sessions.push({ id: "codex:three" }), TypeError);
});

test("failed candidate construction cannot replace the last committed response", () => {
  const cache = createCommittedResponseCache();
  const first = cache.commit({ value: "known-good" });
  assert.throws(() => cache.commit({ value: 1n }), TypeError);
  assert.equal(cache.current(), first);
  assert.equal(cache.read().snapshot.value.value, "known-good");
});

test("response bodies may carry the same revision used for conditional serving", () => {
  const cache = createCommittedResponseCache({ includeRevision: true });
  const committed = cache.commit({ readiness: "loading" });
  assert.equal(committed.value.revision, committed.revision);
  assert.equal(JSON.parse(committed.serialized).revision, committed.revision);
});
