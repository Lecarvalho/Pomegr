import assert from "node:assert/strict";
import test from "node:test";
import { createUsageLimitsCoordinator, retryAfterDelay, USAGE_REFRESH_INTERVAL_MS } from "../monitor/usage-limits.mjs";

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

  currentTime += 10 * 60_000 - 1;
  await coordinator.get();
  assert.equal(calls, 1);

  currentTime += 1;
  await coordinator.get();
  assert.equal(calls, 2);
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

  await coordinator.get();
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
