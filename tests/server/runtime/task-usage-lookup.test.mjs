import assert from "node:assert/strict";
import test from "node:test";
import { createTaskLookups } from "../../../server/runtime/task-start-lookup.mjs";

const now = Date.parse("2026-10-25T12:00:00.000Z");
const usage = (limits, overrides = {}) => ({ available: true, fetchedAt: new Date(now - 60_000).toISOString(), attemptedAt: new Date(now - 60_000).toISOString(), failureKind: null, limits, ...overrides });
const lookup = (usageLimits) => createTaskLookups({
  observationStore: {}, catalogSessions: () => [], repositoryInventory: {},
  gateSources: { usageLimits: () => ({ providers: [
    { provider: "claude", usageLimits: usageLimits.claude },
    { provider: "codex", usageLimits: usageLimits.codex },
  ] }), now: () => now },
});

test("task usage is the maximum across current provider windows", () => {
  const resolve = lookup({
    claude: usage([{ window: "5 hours", percent: 21 }, { window: "7 days", percent: 64 }, { window: "1 day", percent: 82 }]),
    codex: usage([{ window: "5 hours", percent: 13 }, { window: "7 days", percent: 77 }]),
  }).resolveTaskUsage;
  assert.equal(resolve("claude"), 82);
  assert.equal(resolve("codex"), 77);
});

test("task usage is unknown for absent, stale, failed, or expired readings", () => {
  const resolve = lookup({
    claude: usage([{ window: "5 hours", percent: 90 }], { fetchedAt: new Date(now - 11 * 60_000).toISOString() }),
    codex: usage([{ window: "7 days", percent: 90 }], { attemptedAt: new Date(now - 30_000).toISOString(), failureKind: "unavailable" }),
  }).resolveTaskUsage;
  assert.equal(resolve("unknown"), null);
  assert.equal(resolve("claude"), null);
  assert.equal(resolve("codex"), null);
  assert.equal(lookup({ claude: usage([{ window: "5 hours", percent: 90, resetsAt: new Date(now - 1).toISOString() }]) }).resolveTaskUsage("claude"), null);
  const sameAttempt = new Date(now - 60_000).toISOString();
  assert.equal(lookup({ claude: usage([{ window: "5 hours", percent: 90 }], { attemptedAt: sameAttempt, failureKind: "unavailable" }) }).resolveTaskUsage("claude"), null);
  assert.equal(lookup({ claude: usage([{ window: "5 hours", percent: 90 }, { window: "7 days", percent: 101 }]) }).resolveTaskUsage("claude"), null);
  assert.equal(lookup({ claude: usage([{ window: "5 hours", percent: 20 }, { window: "7 days", percent: 95, resetsAt: new Date(now - 1).toISOString() }]) }).resolveTaskUsage("claude"), null);
});
