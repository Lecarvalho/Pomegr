import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { USAGE_REFRESH_INTERVAL_MS } from "../../../../server/normalize/usage-limits.mjs";
import { captureClaudeStatuslineUsage } from "../../../../server/providers/claude/usage-feed.mjs";
import { CLAUDE_PROVIDER_USAGE_FRESH_MS, createClaudeUsageLimitsReader } from "../../../../server/providers/claude/usage-limits.mjs";
import { createCodexUsageLimitsCoordinator } from "../../../../server/providers/codex/usage-limits.mjs";
import { buildAgentQueryProjection } from "../../../../server/sessions/domain/agent-query-projection.mjs";
import { evaluateUsageGuard, normalizeUsageGuardConfig, USAGE_GUARD_USAGE_MAX_AGE_MS } from "../../../../shared/usage-guard-policy.mjs";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
// The monitor asks each reader once a minute and commits what it answers; the guard reads that row at any later moment.
const USAGE_POLL_MS = 60_000;
const TIMER_DRIFT_MS = 40;
const config = normalizeUsageGuardConfig({ version: 1, mode: "advisory" });
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The usage row the guard and `get_usage_limits` receive for one committed reading. */
function committedRow(provider, usageLimits, at) {
  return buildAgentQueryProjection({
    usageLimits: { revision: 1, generatedAt: new Date(at).toISOString(), providers: [{ provider, readiness: "ready", usageLimits }] },
    now: () => at,
  }).usageLimits({ provider });
}

/** Polls a real usage reader for `minutes` and returns each committed row with the guard's reading of it until the next poll. */
async function pollUsage(provider, read, clock, minutes) {
  const rows = [];
  for (let poll = 0; poll <= minutes; poll += 1) {
    const usageLimits = await read();
    await settle();
    const snapshot = committedRow(provider, usageLimits, clock.now);
    rows.push({
      usageLimits, snapshot, entry: snapshot.providers[0],
      atPoll: evaluateUsageGuard(snapshot, provider, config, clock.now),
      beforeNextPoll: evaluateUsageGuard(snapshot, provider, config, clock.now + USAGE_POLL_MS + TIMER_DRIFT_MS - 1),
    });
    clock.now += USAGE_POLL_MS + TIMER_DRIFT_MS;
  }
  return rows;
}

test("the guard never reads unknown on a healthy Claude account, and does after a failed, old, or missing reading", async (context) => {
  for (const bound of [CLAUDE_PROVIDER_USAGE_FRESH_MS, USAGE_GUARD_USAGE_MAX_AGE_MS]) {
    assert.ok(bound > USAGE_REFRESH_INTERVAL_MS + 2 * USAGE_POLL_MS, "the bound must outlast a refresh interval and the poll that publishes it");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-guard-usage-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { now: NOW };
  let healthy = true;
  const reader = createClaudeUsageLimitsReader({
    homeDir: root, usageSnapshotsRoot: root, now: () => clock.now,
    usageRequest: async () => (healthy ? new Response(JSON.stringify({ limits: [
      { kind: "session", percent: 7, resets_at: new Date(NOW + 4 * 3_600_000).toISOString() },
      { kind: "weekly_all", percent: 30, resets_at: new Date(NOW + 6 * 86_400_000).toISOString() },
    ] }), { status: 200 }) : new Response("", { status: 503 })),
  });
  const rows = await pollUsage("claude", reader, clock, 16);
  assert.ok(new Set(rows.map((row) => row.usageLimits.fetchedAt)).size >= 3, "the polls cross several refresh cycles");
  assert.ok(rows.some((row) => Date.parse(row.snapshot.generatedAt) - Date.parse(row.entry.observedAt) > USAGE_REFRESH_INTERVAL_MS),
    "a refresh answers the previous reading while its request runs");
  for (const row of rows) {
    const label = `reading of ${row.usageLimits.fetchedAt} committed at ${row.snapshot.generatedAt}`;
    assert.equal(row.usageLimits.origin, "provider_api");
    assert.equal(row.usageLimits.freshness, "fresh", label);
    assert.equal(row.entry.freshness, "fresh", label);
    assert.equal(row.atPoll.stage, "normal", label);
    assert.equal(row.atPoll.usedPercent, 30);
    assert.equal(row.beforeNextPoll.stage, "normal", label);
  }

  // A reading that no refresh replaced is truly old once the bound has passed.
  const last = rows.at(-1);
  const fetchedAt = Date.parse(last.usageLimits.fetchedAt);
  assert.equal(evaluateUsageGuard(last.snapshot, "claude", config, fetchedAt + USAGE_GUARD_USAGE_MAX_AGE_MS).stage, "normal");
  assert.equal(evaluateUsageGuard(last.snapshot, "claude", config, fetchedAt + USAGE_GUARD_USAGE_MAX_AGE_MS + 1).stage, "unknown");

  healthy = false;
  const failed = (await pollUsage("claude", reader, clock, 12)).filter((row) => row.usageLimits.failureKind !== null);
  assert.ok(failed.length > 0);
  for (const row of failed) {
    assert.equal(row.usageLimits.available, true, "the last good reading is retained for display");
    assert.equal(row.usageLimits.freshness, "stale");
    assert.equal(row.atPoll.stage, "unknown");
    assert.equal(row.beforeNextPoll.stage, "unknown");
  }

  // A local observation keeps its own five-minute bound and the passed-reset rule.
  const pair = (fiveHourReset) => ({ rate_limits: {
    five_hour: { used_percentage: 23, resets_at: fiveHourReset / 1_000 },
    seven_day: { used_percentage: 61, resets_at: (clock.now + 86_400_000) / 1_000 },
  } });
  captureClaudeStatuslineUsage(pair(clock.now + 3_600_000), { root, now: new Date(clock.now) });
  const local = await reader();
  assert.equal(local.origin, "local_observation");
  assert.equal(local.freshness, "fresh", "a fresh local pair is served through a failed provider refresh");
  assert.equal(evaluateUsageGuard(committedRow("claude", local, clock.now), "claude", config, clock.now).stage, "normal");
  clock.now += 5 * 60_000 + 1;
  const agedLocal = await reader();
  assert.equal(agedLocal.freshness, "stale");
  assert.equal(evaluateUsageGuard(committedRow("claude", agedLocal, clock.now), "claude", config, clock.now).stage, "unknown");
  captureClaudeStatuslineUsage(pair(clock.now - 1_000), { root, now: new Date(clock.now) });
  const expired = await reader();
  assert.equal(expired.freshness, "stale");
  assert.equal(evaluateUsageGuard(committedRow("claude", expired, clock.now), "claude", config, clock.now).stage, "unknown");

  const missing = await createClaudeUsageLimitsReader({ homeDir: root, usageSnapshotsRoot: path.join(root, "none"), now: () => clock.now, usageRequest: async () => new Response("", { status: 401 }) })();
  assert.equal(evaluateUsageGuard(committedRow("claude", missing, clock.now), "claude", config, clock.now).stage, "unknown");
});

test("the guard never reads unknown on a healthy Codex account, and does after a failed refresh", async () => {
  const clock = { now: NOW };
  let healthy = true;
  const window = (usedPercent, windowDurationMins) => ({ usedPercent, windowDurationMins, resetsAt: (NOW + windowDurationMins * 60_000) / 1_000 });
  const coordinator = createCodexUsageLimitsCoordinator({ now: () => clock.now, request: async () => {
    if (!healthy) throw new Error("unavailable");
    return { result: { rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "Codex", primary: window(18, 300), secondary: window(9, 10_080) } } } };
  } });
  for (const row of await pollUsage("codex", () => coordinator.get(), clock, 16)) {
    assert.equal(row.atPoll.stage, "normal", row.usageLimits.fetchedAt);
    assert.equal(row.atPoll.usedPercent, 18);
    assert.equal(row.beforeNextPoll.stage, "normal", row.usageLimits.fetchedAt);
  }

  healthy = false;
  const failed = (await pollUsage("codex", () => coordinator.get(), clock, 12)).filter((row) => row.usageLimits.failureKind !== null);
  assert.ok(failed.length > 0);
  for (const row of failed) assert.equal(row.atPoll.stage, "unknown");
});
