import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { USAGE_REFRESH_INTERVAL_MS } from "../monitor/usage-limits.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { normalizeCodexRateLimits } from "../monitor/providers/codex-usage-limits.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";

const RESET_A = Date.parse("2026-08-11T18:00:00.000Z") / 1000;
const RESET_B = Date.parse("2026-08-18T13:00:00.000Z") / 1000;
const MISSING_CODEX_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "providers", "codex", "missing-home");

function rateLimitResponse() {
  return {
    result: {
      rateLimits: {
        limitId: "legacy",
        limitName: "Legacy",
        primary: { usedPercent: 99, windowDurationMins: 60, resetsAt: RESET_A },
      },
      rateLimitsByLimitId: {
        review: {
          limitId: "ACCOUNT_IDENTITY_MUST_NOT_LEAK",
          limitName: "WORKSPACE_IDENTITY_MUST_NOT_LEAK",
          primary: { usedPercent: 12, windowDurationMins: 60, resetsAt: RESET_A },
          secondary: null,
          credits: { balance: "CREDIT_BALANCE_MUST_NOT_LEAK", unlimited: false },
          individualLimit: { limit: "ENTITLEMENT_MUST_NOT_LEAK" },
          planType: "PLAN_MUST_NOT_LEAK",
          rateLimitReachedType: "workspace_member_usage_limit_reached",
        },
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 37.5, windowDurationMins: 300, resetsAt: RESET_A },
          secondary: { usedPercent: 82, windowDurationMins: 10_080, resetsAt: RESET_B },
          credits: null,
          individualLimit: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
      rateLimitResetCredits: {
        availableCount: 4,
        credits: [{ id: "RESET_CREDIT_MUST_NOT_LEAK" }],
      },
      account: "ACCOUNT_MUST_NOT_LEAK",
      workspace: "WORKSPACE_MUST_NOT_LEAK",
      entitlements: ["ENTITLEMENT_LIST_MUST_NOT_LEAK"],
      authentication: "AUTH_MUST_NOT_LEAK",
    },
  };
}

test("normalizes deterministic Codex primary and secondary rate-limit windows", () => {
  const limits = normalizeCodexRateLimits(rateLimitResponse());

  assert.deepEqual(limits, [
    {
      id: "codex-primary",
      label: "Codex",
      window: "5 hours",
      percent: 37.5,
      resetsAt: "2026-08-11T18:00:00.000Z",
      severity: "normal",
      active: false,
    },
    {
      id: "codex-secondary",
      label: "Codex",
      window: "7 days",
      percent: 82,
      resetsAt: "2026-08-18T13:00:00.000Z",
      severity: "warning",
      active: false,
    },
    {
      id: "review-primary",
      label: "Usage bucket 2",
      window: "1 hour",
      percent: 12,
      resetsAt: "2026-08-11T18:00:00.000Z",
      severity: "danger",
      active: true,
    },
  ]);
  const serialized = JSON.stringify(limits);
  for (const sentinel of [
    "ACCOUNT", "WORKSPACE", "CREDIT", "ENTITLEMENT", "PLAN_MUST_NOT_LEAK", "AUTH_MUST_NOT_LEAK",
  ]) assert.doesNotMatch(serialized, new RegExp(sentinel));
});

test("validates and bounds percentages, durations, reset timestamps, IDs, and labels", () => {
  const limits = normalizeCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: -20, windowDurationMins: 9_999_999, resetsAt: 9_999_999_999 },
      secondary: { usedPercent: Number.POSITIVE_INFINITY, windowDurationMins: 60, resetsAt: RESET_A },
      rateLimitReachedType: "unknown_future_value",
    },
    rateLimitsByLimitId: null,
  });

  assert.deepEqual(limits, [{
    id: "codex-primary",
    label: "Codex",
    window: "Usage window",
    percent: 0,
    resetsAt: null,
    severity: "normal",
    active: false,
  }]);
  assert.equal(normalizeCodexRateLimits({ result: { credits: { balance: "secret" } } }), null);
});

test("shares one Codex app-server read across concurrent polls and enforces cooldown", async () => {
  let currentTime = Date.parse("2026-08-11T13:00:00.000Z");
  let calls = 0;
  let finishRequest;
  const provider = createCodexProvider({
    now: () => currentTime,
    appServer: {
      request(method, params) {
        assert.equal(method, "account/rateLimits/read");
        assert.equal(params, undefined);
        calls += 1;
        return new Promise((resolve) => { finishRequest = resolve; });
      },
    },
  });

  assert.equal(provider.capabilities.usageLimits, true);
  const clients = Array.from({ length: 10 }, () => provider.readUsageLimits());
  assert.equal(calls, 1);
  finishRequest(rateLimitResponse());
  const values = await Promise.all(clients);
  assert.equal(values.every((value) => value.available && value.limits.length === 3), true);

  currentTime += USAGE_REFRESH_INTERVAL_MS - 1;
  await provider.readUsageLimits();
  assert.equal(calls, 1);

  currentTime += 1;
  void provider.readUsageLimits();
  assert.equal(calls, 2);
  finishRequest(rateLimitResponse());
});

test("sanitizes Codex rate-limit failure independently from session discovery", async () => {
  let calls = 0;
  const provider = createCodexProvider({
    codexHome: MISSING_CODEX_HOME,
    appServer: {
      async request(method) {
        calls += 1;
        if (method === "account/rateLimits/read") throw new Error("AUTH_TOKEN_AND_BACKEND_DETAILS_MUST_NOT_LEAK");
        if (method === "thread/list") return { result: { data: [] } };
        return null;
      },
    },
  });

  const limits = await provider.readUsageLimits();
  assert.deepEqual(limits, {
    available: false,
    fetchedAt: null,
    attemptedAt: limits.attemptedAt,
    limits: [],
    error: "Codex usage limits are temporarily unavailable.",
  });
  assert.doesNotMatch(JSON.stringify(limits), /AUTH_TOKEN|BACKEND_DETAILS/);
  assert.deepEqual(await provider.listSessions(), []);
  assert.equal(calls >= 2, true);
});

test("provider registry never reads current Codex limits for historical state", async () => {
  let calls = 0;
  const provider = createCodexProvider({
    appServer: {
      async request() {
        calls += 1;
        return rateLimitResponse();
      },
    },
  });
  const registry = createProviderRegistry([provider]);

  assert.deepEqual(await registry.readUsageLimits(provider, { historical: true }), {
    available: false,
    fetchedAt: null,
    attemptedAt: null,
    limits: [],
    error: "",
  });
  assert.equal(calls, 0);
});
