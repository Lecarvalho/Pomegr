import assert from "node:assert/strict";
import test from "node:test";
import { createUsageLimitsCoordinator, retryAfterDelay, USAGE_REFRESH_INTERVAL_MS } from "../../../server/normalize/usage-limits.mjs";
import { clampUsageLimitPercent, usageLimitSeverity } from "../../../shared/usage-limit-severity.mjs";

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

test("native sign-in retries rejected authentication immediately and waits for the new result", async () => {
  let calls = 0;
  let complete;
  const coordinator = createUsageLimitsCoordinator({
    request: async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 401 });
      return new Promise((resolve) => { complete = resolve; });
    },
  });
  assert.equal((await coordinator.get()).failureKind, "authentication_required");
  await coordinator.get();
  assert.equal(calls, 1);
  const recovered = coordinator.get({ afterSignIn: true });
  const concurrent = coordinator.get({ afterSignIn: true });
  assert.equal(calls, 2);
  complete(usageResponse());
  for (const value of await Promise.all([recovered, concurrent])) {
    assert.equal(value.failureKind, null);
    assert.equal(value.limits[0].percent, 12);
  }
});

test("native sign-in preserves successful-check and provider-throttle cooldowns", async () => {
  for (const status of [200, 429]) {
    let calls = 0;
    const coordinator = createUsageLimitsCoordinator({
      request: async () => {
        calls += 1;
        return status === 200 ? usageResponse() : new Response("", { status: 429, headers: { "retry-after": "3600" } });
      },
    });
    const initial = await coordinator.get();
    assert.deepEqual(await coordinator.get({ afterSignIn: true }), initial);
    assert.equal(calls, 1);
  }
});

test("native recovery retries authentication rejected by an older pending account check", async () => {
  let calls = 0;
  let complete;
  const coordinator = createUsageLimitsCoordinator({
    request: () => {
      calls += 1;
      return calls === 1 ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(usageResponse());
    },
  });
  const old = coordinator.get();
  const recovery = coordinator.get({ afterSignIn: true });
  complete(new Response("", { status: 401 }));
  assert.equal((await old).failureKind, "authentication_required");
  assert.equal((await recovery).failureKind, null);
  assert.equal(calls, 2);
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

test("consecutive failures grow the full-jitter window up to one hour", async () => {
  let currentTime = Date.parse("2026-10-25T12:00:00.000Z");
  let calls = 0;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    random: () => 0.75,
    request: async () => {
      calls += 1;
      return new Response("", { status: calls % 2 ? 503 : 429 });
    },
  });

  for (const minutes of [5, 7.5, 15, 30, 45, 45]) {
    await coordinator.get({ afterSignIn: true });
    const retryAt = Date.parse(coordinator.peek().retryAt);
    assert.equal(retryAt - currentTime, minutes * 60_000);
    const previousCalls = calls;
    currentTime = retryAt - 1;
    await coordinator.get();
    assert.equal(calls, previousCalls);
    currentTime = retryAt;
  }
  assert.equal(calls, 6);
});

test("full jitter samples the entire capped window while retaining the five-minute floor", async () => {
  let currentTime = Date.parse("2026-10-25T12:00:00.000Z");
  let sample = 0.5;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    random: () => sample,
    request: async () => { throw new Error("Synthetic unavailable read"); },
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await coordinator.get({ afterSignIn: true });
    currentTime = Date.parse(coordinator.peek().retryAt);
  }
  for (const [random, delay] of [[0, 5 * 60_000], [0.25, 15 * 60_000], [0.999999, 3_599_996]]) {
    sample = random;
    await coordinator.get({ afterSignIn: true });
    const retryAt = Date.parse(coordinator.peek().retryAt);
    assert.equal(retryAt - currentTime, delay);
    currentTime = retryAt;
  }
});

test("Retry-After is a floor even beyond the exponential cap", async () => {
  let currentTime = Date.parse("2026-10-25T12:00:00.000Z");
  let retryAfter = "7200";
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    random: () => 0.75,
    request: async () => new Response("", { status: 429, headers: { "retry-after": retryAfter } }),
  });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    retryAfter = attempt % 2 ? new Date(currentTime + 7_200_000).toUTCString() : "7200";
    await coordinator.get({ afterSignIn: true });
    assert.equal(Date.parse(coordinator.peek().retryAt) - currentTime, 7_200_000);
    currentTime += 7_200_000;
  }
  retryAfter = "30";
  await coordinator.get({ afterSignIn: true });
  assert.equal(Date.parse(coordinator.peek().retryAt) - currentTime, 45 * 60_000);
});

test("a successful read resets exponential backoff and the normal refresh interval", async () => {
  let currentTime = Date.parse("2026-10-25T12:00:00.000Z");
  let succeeds = false;
  let saved;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    random: () => 0.75,
    request: async () => succeeds ? usageResponse(23) : new Response("", { status: 503 }),
    onUpdate: (value, nextAttemptAt) => { saved = { value, nextAttemptAt }; },
  });
  for (const minutes of [5, 7.5, 15]) {
    await coordinator.get({ afterSignIn: true });
    assert.equal(saved.nextAttemptAt - currentTime, minutes * 60_000);
    currentTime = saved.nextAttemptAt;
  }
  succeeds = true;
  const good = await coordinator.get({ afterSignIn: true });
  assert.equal(good.retryAt, null);
  assert.equal(saved.nextAttemptAt - currentTime, USAGE_REFRESH_INTERVAL_MS);
  currentTime = saved.nextAttemptAt;
  succeeds = false;
  await coordinator.get({ afterSignIn: true });
  assert.equal(saved.nextAttemptAt - currentTime, USAGE_REFRESH_INTERVAL_MS);
  assert.deepEqual(saved.value.limits, good.limits);
  assert.equal(saved.value.fetchedAt, good.fetchedAt);
});

test("restart preserves the persisted jittered deadline without sampling or reading early", async () => {
  let currentTime = Date.parse("2026-10-25T12:00:00.000Z");
  let persisted;
  const coordinator = createUsageLimitsCoordinator({
    now: () => currentTime,
    random: () => 0.7654321,
    request: async () => new Response("", { status: 503 }),
    onUpdate: (value, nextAttemptAt) => { persisted = JSON.stringify({ value, nextAttemptAt }); },
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await coordinator.get({ afterSignIn: true });
    if (attempt < 3) currentTime = JSON.parse(persisted).nextAttemptAt;
  }
  const initialState = JSON.parse(persisted);
  assert.equal(initialState.nextAttemptAt - currentTime, 1_837_037);
  assert.equal(Number.isInteger(initialState.nextAttemptAt), true);
  assert.equal(Date.parse(initialState.value.retryAt), initialState.nextAttemptAt);
  let calls = 0;
  const restarted = createUsageLimitsCoordinator({
    initialState,
    now: () => currentTime,
    random: () => { assert.fail("A restored deadline must not be resampled"); },
    request: async () => { calls += 1; return usageResponse(); },
  });
  currentTime = initialState.nextAttemptAt - 1;
  assert.deepEqual(await restarted.get(), initialState.value);
  assert.equal(calls, 0);
  currentTime += 1;
  assert.equal((await restarted.get({ afterSignIn: true })).failureKind, null);
  assert.equal(calls, 1);
});


test("retains the last good observation when a successful response has no complete limits array", async () => {
  let currentTime = Date.parse("2026-08-10T14:00:00.000Z");
  let requests = 0;
  const reader = createUsageLimitsCoordinator({
    now: () => currentTime,
    request: async () => ++requests === 1 ? usageResponse(23) : new Response('{"private":"PRIVATE_RESPONSE"}'),
  });
  const first = await reader.get();
  currentTime += USAGE_REFRESH_INTERVAL_MS;
  await reader.get();
  await new Promise((resolve) => setImmediate(resolve));
  const retained = await reader.get();
  assert.equal(retained.available, true);
  assert.deepEqual(retained.limits, first.limits);
  assert.equal(retained.fetchedAt, first.fetchedAt);
  assert.equal(retained.failureKind, "unavailable");
  assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_RESPONSE/);
});
