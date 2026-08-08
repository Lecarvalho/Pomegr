import assert from "node:assert/strict";
import test from "node:test";
import { latestSessionSummary, sessionSummaryFromRecord } from "../monitor/session-summary.mjs";

test("normalizes a recognized provider session summary", () => {
  assert.deepEqual(sessionSummaryFromRecord({
    type: "system",
    subtype: "away_summary",
    content: "  Working the outbox card.\n\tWaiting on review.  ",
    timestamp: "2026-08-08T15:03:28.432Z",
  }), {
    text: "Working the outbox card. Waiting on review.",
    observedAt: "2026-08-08T15:03:28.432Z",
    source: "provider",
  });
});

test("uses the latest valid summary and ignores other transcript content", () => {
  const summary = latestSessionSummary([
    { type: "user", content: "PRIVATE PROMPT" },
    { type: "system", subtype: "away_summary", content: "Earlier summary", timestamp: "2026-08-08T15:00:00Z" },
    { type: "assistant", message: { content: "PRIVATE RESPONSE" } },
    { type: "system", subtype: "stop_hook_summary", content: "PRIVATE HOOK CONTENT" },
    { type: "system", subtype: "away_summary", content: "Latest summary", timestamp: "invalid" },
  ]);

  assert.deepEqual(summary, {
    text: "Latest summary",
    observedAt: null,
    source: "provider",
  });
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE/);
});

test("rejects empty summaries and bounds exposed text", () => {
  assert.equal(sessionSummaryFromRecord({ type: "system", subtype: "away_summary", content: "\n\t" }), null);
  const summary = sessionSummaryFromRecord({ type: "system", subtype: "away_summary", content: "a".repeat(500) });
  assert.equal(summary.text.length, 360);
});

