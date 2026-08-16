import assert from "node:assert/strict";
import test from "node:test";
import { buildCacheEvents } from "../monitor/cache-events.mjs";
import { parseClaudeContextRecords } from "../monitor/providers/claude-context.mjs";

function assistant(id, timestamp, usage, model = "claude-test") {
  return { type: "assistant", timestamp, message: { id, model, usage, content: [] } };
}

test("strictly normalizes bounded Claude request usage and cache comparability", () => {
  const snapshots = parseClaudeContextRecords([
    assistant("one", "2026-08-10T10:00:00.000Z", {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_creation_input_tokens: 8_000,
      cache_read_input_tokens: 0,
      cache_creation: { private_ttl_breakdown: "PRIVATE_MUST_NOT_LEAK" },
    }),
    assistant("two", "2026-08-10T10:05:00.000Z", {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 9_000,
    }),
  ], { actorId: "primary", sourceKey: "source" });

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.every((snapshot) => snapshot.cacheComparable), true);
  assert.equal(snapshots[0].model, "claude-test");
  assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE|cache_creation[^I]/);
});

test("missing or malformed cache evidence breaks comparison without losing valid context", () => {
  const snapshots = parseClaudeContextRecords([
    assistant("before", "2026-08-10T10:00:00.000Z", {
      input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 9_000,
    }),
    assistant("legacy", "2026-08-10T10:05:00.000Z", { input_tokens: 2_000, output_tokens: 10 }),
    assistant("malformed", "2026-08-10T10:10:00.000Z", {
      input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: "invalid",
    }),
    assistant("after", "2026-08-10T11:00:00.000Z", {
      input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0,
    }),
  ], { actorId: "primary", sourceKey: "source" });

  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[1].cacheComparable, false);
  assert.notEqual(snapshots[0].comparisonGroup, snapshots[2].comparisonGroup);
  assert.equal(snapshots[1].input, 2_000);
});

test("an assistant record without a usable usage object breaks cache comparison fail-closed", () => {
  const unusableMessages = [
    { id: "missing", model: "claude-test" },
    { id: "non-object", model: "claude-test", usage: "invalid" },
    { id: "invalid", model: "claude-test", usage: { input_tokens: "invalid", output_tokens: 10 } },
  ];
  for (const [index, message] of unusableMessages.entries()) {
    const snapshots = parseClaudeContextRecords([
      assistant("before", "2026-08-10T10:00:00.000Z", {
        input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 9_000,
      }),
      { type: "assistant", timestamp: "2026-08-10T10:10:00.000Z", message },
      assistant("after", "2026-08-10T10:30:00.000Z", {
        input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0,
      }),
    ], { actorId: "primary", sourceKey: `source-${index}` });

    assert.equal(snapshots.length, 2);
    assert.notEqual(snapshots[0].comparisonGroup, snapshots[1].comparisonGroup);
    const feed = buildCacheEvents({
      agents: [{ id: "primary", kind: "orchestrator" }],
      usageSnapshots: snapshots,
      enabled: true,
    });
    assert.equal(feed.items.some((event) => event.kind === "miss_refill"), false);
  }
});

test("deduplicates message identities and bounds observations per agent", () => {
  const records = Array.from({ length: 105 }, (_, index) => assistant(
    `message-${index}`,
    new Date(Date.parse("2026-08-10T10:00:00.000Z") + index).toISOString(),
    { input_tokens: 100 + index, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ));
  records.push({ ...records.at(-1), timestamp: "2026-08-10T11:00:00.000Z" });
  const snapshots = parseClaudeContextRecords(records, { actorId: "primary", sourceKey: "source" });
  assert.equal(snapshots.length, 100);
  assert.equal(snapshots.at(-1).timestamp, "2026-08-10T11:00:00.000Z");
});
