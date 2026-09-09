import { parseClaudeContextRecords } from "../../monitor/providers/claude-context.mjs";
import { buildCacheEvents } from "../../monitor/cache-events.mjs";
import { buildRequestSnapshots } from "../../monitor/request-snapshots.mjs";

/** Fabricated provider records: request 44 resumes after a synthetic message. */
export function claudeCacheRefillRecords() {
  const base = Date.parse("2026-08-10T10:00:00.000Z");
  const request = (index, offset, read, write) => ({
    type: "assistant",
    timestamp: new Date(base + offset).toISOString(),
    message: {
      id: `fixture-request-${index}`, model: "claude-test", content: [],
      usage: {
        input_tokens: 2, output_tokens: 100,
        cache_read_input_tokens: read, cache_creation_input_tokens: write,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
      },
    },
  });
  const before = Array.from({ length: 43 }, (_, index) => request(index + 1, index * 1_000, 100_000, 1_000));
  const synthetic = request("synthetic", 5 * 60 * 60 * 1_000, 0, 0);
  synthetic.message.model = "<synthetic>";
  synthetic.message.usage.input_tokens = 0;
  synthetic.message.usage.output_tokens = 0;
  const refill = request(44, 6 * 60 * 60 * 1_000, 0, 120_000);
  refill.message.diagnostics = { cache_miss_reason: { type: "previous_message_not_found" } };
  // Later large writes exceed the detail cap, without creating full-refill transitions.
  const growth = Array.from({ length: 22 }, (_, index) => request(45 + index,
    6 * 60 * 60 * 1_000 + (index + 1) * 1_000, 120_000 + index * 9_000, 9_000));
  return [...before, synthetic, refill, ...growth];
}

/** Exercise the real parser and serializers before passing evidence to React. */
export function claudeCacheRefillFeeds() {
  const evidence = {
    sessionId: "synthetic-refill-fixture", agents: [{ id: "primary" }],
    usageSnapshots: parseClaudeContextRecords(claudeCacheRefillRecords()),
  };
  return {
    requestSnapshots: buildRequestSnapshots(evidence),
    cacheEvents: buildCacheEvents({ ...evidence, enabled: true }),
  };
}
