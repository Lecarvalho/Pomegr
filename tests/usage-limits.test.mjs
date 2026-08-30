import assert from "node:assert/strict";
import test from "node:test";
import { createUsageLimitsCoordinator, retryAfterDelay, USAGE_REFRESH_INTERVAL_MS } from "../monitor/usage-limits.mjs";
import { clampUsageLimitPercent, usageLimitSeverity } from "../shared/usage-limit-severity.mjs";

function usageResponse(percent = 12) {
  return new Response(JSON.stringify({
    limits: [{
      kind: "session",
      percent,
      resets_at: "2026-08-10T18:00:00.000Z",
      severity: "normal",
      is_active: true,
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("parses Retry-After seconds and HTTP dates", () => {
  const now = Date.parse("2026-08-10T14:00:00.000Z");
  assert.equal(retryAfterDelay("120", now), 120_000);
  assert.equal(retryAfterDelay("1.5", now), 1_500);
  assert.equal(retryAfterDelay("Sun, 10 Aug 2026 14:07:00 GMT", now), 7 * 60_000);
  assert.equal(retryAfterDelay("invalid", now), null);
  assert.equal(retryAfterDelay(null, now), null);
});

test("deduplicates concurrent clients and caches a success for five minutes", async () => {
  let currentTime = Date.parse("2026-08-10T14:00:00.000Z");
  let calls = 0;
  let finishRequest;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    request: () => {
      calls += 1;
      return new Promise((resolve) => { finishRequest = resolve; });
    },
  });

  const clients = Array.from({ length: 10 }, () => coordinator.get());
  assert.equal(calls, 1);
  finishRequest(usageResponse());
  const values = await Promise.all(clients);
  assert.equal(values.every((value) => value.available && value.limits[0]?.percent === 12), true);

  currentTime += USAGE_REFRESH_INTERVAL_MS - 1;
  await coordinator.get();
  assert.equal(calls, 1);

  currentTime += 1;
  void coordinator.get();
  assert.equal(calls, 2);
});

test("retains last-known-good limits while recording a later refresh failure", async () => {
  let currentTime = Date.parse("2026-08-10T14:00:00.000Z");
  let calls = 0;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    request: async () => {
      calls += 1;
      return calls === 1
        ? usageResponse(23)
        : new Response("", { status: 429, headers: { "retry-after": "600" } });
    },
  });

  const successful = await coordinator.get();
  currentTime += USAGE_REFRESH_INTERVAL_MS;
  await coordinator.get();
  await new Promise((resolve) => setImmediate(resolve));
  const retained = await coordinator.get();

  assert.equal(retained.available, true);
  assert.deepEqual(retained.limits, successful.limits);
  assert.equal(retained.fetchedAt, successful.fetchedAt);
  assert.equal(retained.attemptedAt, "2026-08-10T14:05:00.000Z");
  assert.equal(retained.failureKind, "rate_limited");
  assert.equal(retained.retryAt, "2026-08-10T14:15:00.000Z");
  assert.equal(retained.error, "Anthropic usage endpoint returned 429");
});

test("honors Retry-After before allowing another provider call", async () => {
  let currentTime = Date.parse("2026-08-10T14:00:00.000Z");
  let calls = 0;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    request: async () => {
      calls += 1;
      return calls === 1
        ? new Response("", { status: 429, headers: { "retry-after": "600" } })
        : usageResponse(18);
    },
  });

  const failed = await coordinator.get();
  assert.equal(failed.available, false);
  assert.equal(failed.error, "Anthropic usage endpoint returned 429");
  assert.equal(failed.failureKind, "rate_limited");
  assert.equal(failed.retryAt, "2026-08-10T14:10:00.000Z");

  currentTime += 10 * 60_000 - 1;
  await coordinator.get();
  assert.equal(calls, 1);

  currentTime += 1;
  await coordinator.get();
  assert.equal(calls, 2);
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = await coordinator.get();
  assert.equal(recovered.failureKind, null);
  assert.equal(recovered.retryAt, null);
});

test("classifies authentication failures without exposing provider response content", async () => {
  const coordinator = createUsageLimitsCoordinator({
    request: async () => new Response("PRIVATE_PROVIDER_BODY", { status: 401 }),
    now: () => Date.parse("2026-08-10T14:00:00.000Z"),
  });

  const failed = await coordinator.get();
  assert.equal(failed.failureKind, "authentication_required");
  assert.equal(failed.retryAt, "2026-08-10T14:05:00.000Z");
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_BODY/);
});

test("uses the five-minute cooldown when Retry-After is unavailable", async () => {
  let currentTime = Date.parse("2026-08-10T14:00:00.000Z");
  let calls = 0;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    request: async () => {
      calls += 1;
      return new Response("", { status: 503 });
    },
  });

  const failed = await coordinator.get();
  assert.equal(failed.failureKind, "unavailable");
  assert.equal(failed.retryAt, "2026-08-10T14:05:00.000Z");
  currentTime += USAGE_REFRESH_INTERVAL_MS - 1;
  await coordinator.get();
  assert.equal(calls, 1);

  currentTime += 1;
  await coordinator.get();
  assert.equal(calls, 2);
});

test("does not let a short Retry-After reduce the five-minute cooldown", async () => {
  let currentTime = Date.parse("2026-08-10T14:00:00.000Z");
  let calls = 0;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    request: async () => {
      calls += 1;
      return new Response("", { status: 429, headers: { "retry-after": "30" } });
    },
  });

  await coordinator.get();
  currentTime += 30_000;
  await coordinator.get();
  assert.equal(calls, 1);

  currentTime += USAGE_REFRESH_INTERVAL_MS - 30_000;
  await coordinator.get();
  assert.equal(calls, 2);
});

test("derives usage severity from percentage thresholds independently of provider fields and active state", async () => {
  const coordinator = createUsageLimitsCoordinator({
    request: async () => new Response(JSON.stringify({
      limits: [
        { kind: "session", percent: 74, severity: "danger", is_active: false },
        { kind: "weekly_all", percent: 75, severity: "normal", is_active: false },
        {
          kind: "weekly_scoped",
          percent: 85,
          severity: "future-private-value",
          is_active: true,
          scope: { model: { display_name: "Fable" } },
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  const result = await coordinator.get();
  assert.deepEqual(result.limits.map(({ severity, active }) => ({ severity, active })), [
    { severity: "normal", active: false },
    { severity: "warning", active: false },
    { severity: "critical", active: true },
  ]);
});

test("uses blue through 74, yellow from 75 through 84, and red from 85", () => {
  assert.deepEqual([0, 74, 75, 84, 85, 100].map(usageLimitSeverity), [
    "normal", "normal", "warning", "warning", "critical", "critical",
  ]);
  assert.equal(clampUsageLimitPercent(-1), 0);
  assert.equal(clampUsageLimitPercent(101), 100);
});
