import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { USAGE_REFRESH_INTERVAL_MS } from "../monitor/usage-limits.mjs";
import { createMonitorRuntime, createMonitorServer } from "../monitor/server.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import { normalizeCodexRateLimits } from "../monitor/providers/codex-usage-limits.mjs";
import { createDefaultProviderRegistry } from "../monitor/providers/index.mjs";
import { createProviderRegistry } from "../monitor/providers/registry.mjs";
import { defineProvider, PROVIDER_CAPABILITY_KEYS } from "../monitor/providers/provider-contract.mjs";
import { createEmptyUsageLimits } from "../shared/monitor-state.mjs";

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
      severity: "normal",
      active: true,
    },
  ]);
  const serialized = JSON.stringify(limits);
  for (const sentinel of [
    "ACCOUNT", "WORKSPACE", "CREDIT", "ENTITLEMENT", "PLAN_MUST_NOT_LEAK", "AUTH_MUST_NOT_LEAK",
  ]) assert.doesNotMatch(serialized, new RegExp(sentinel));
});

test("keeps a seven-day-only Codex response as a usable normalized window", () => {
  const limits = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 64, windowDurationMins: 10_080, resetsAt: RESET_B },
        secondary: null,
        rateLimitReachedType: null,
      },
    },
  });

  assert.deepEqual(limits, [{
    id: "codex-primary",
    label: "Codex",
    window: "7 days",
    percent: 64,
    resetsAt: "2026-08-18T13:00:00.000Z",
    severity: "normal",
    active: false,
  }]);
});

test("bounds final normalized Codex windows after primary and secondary expansion", () => {
  const rateLimitsByLimitId = Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
    const id = `bucket-${String(index + 1).padStart(2, "0")}`;
    return [id, {
      limitId: id,
      limitName: `Bucket ${index + 1}`,
      primary: { usedPercent: index, windowDurationMins: 300, resetsAt: RESET_A },
      secondary: { usedPercent: index + 10, windowDurationMins: 10_080, resetsAt: RESET_B },
      rateLimitReachedType: null,
    }];
  }));

  const limits = normalizeCodexRateLimits({ rateLimitsByLimitId });

  assert.equal(limits.length, 12);
  assert.deepEqual(limits.map((limit) => limit.id), [
    "bucket-01-primary", "bucket-01-secondary",
    "bucket-02-primary", "bucket-02-secondary",
    "bucket-03-primary", "bucket-03-secondary",
    "bucket-04-primary", "bucket-04-secondary",
    "bucket-05-primary", "bucket-05-secondary",
    "bucket-06-primary", "bucket-06-secondary",
  ]);
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

test("shares one separate Codex account read across concurrent polls and enforces cooldown", async () => {
  let currentTime = Date.parse("2026-08-11T13:00:00.000Z");
  let calls = 0;
  let finishRequest;
  const provider = createCodexProvider({
    now: () => currentTime,
    rateLimitsReader: {
      readRateLimits() {
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

test("sanitizes separate Codex rate-limit failure independently from session discovery", async () => {
  let limitCalls = 0;
  let catalogCalls = 0;
  const provider = createCodexProvider({
    codexHome: MISSING_CODEX_HOME,
    rateLimitsReader: {
      async readRateLimits() {
        limitCalls += 1;
        throw new Error("AUTH_TOKEN_AND_BACKEND_DETAILS_MUST_NOT_LEAK");
      },
    },
    appServer: {
      async request(method) {
        if (method === "thread/list") {
          catalogCalls += 1;
          return { result: { data: [] } };
        }
        return null;
      },
    },
  });

  const limits = await provider.readUsageLimits();
  assert.deepEqual(limits, {
    available: false,
    fetchedAt: null,
    attemptedAt: limits.attemptedAt,
    failureKind: "unavailable",
    retryAt: limits.retryAt,
    limits: [],
    error: "Codex usage limits are temporarily unavailable.",
  });
  assert.doesNotMatch(JSON.stringify(limits), /AUTH_TOKEN|BACKEND_DETAILS/);
  assert.deepEqual(await provider.listSessions(), []);
  assert.equal(limitCalls, 1);
  assert.equal(catalogCalls, 2);
});

test("disables only the usage-limit capability when the native Codex CLI is unavailable", async () => {
  let availabilityCalls = 0;
  let limitCalls = 0;
  const provider = createCodexProvider({
    rateLimitsReader: {
      async isAvailable() { availabilityCalls += 1; return false; },
      async readRateLimits() { limitCalls += 1; return rateLimitResponse(); },
    },
  });
  const registry = createProviderRegistry([provider]);

  assert.deepEqual(await registry.resolveReadiness(provider), {
    approvalMode: { status: "ready" },
    automaticCompactions: { status: "ready" },
    contextMachinery: { status: "not_applicable" },
    estimatedCost: { status: "not_applicable" },
    liveSessions: { status: "ready" },
    needsInput: { status: "ready" },
    planTasks: { status: "ready" },
    cacheWriteUsage: { status: "not_applicable" },
    cacheUsageClassification: { status: "not_applicable" },
    sessionSummary: { status: "not_applicable" },
    signals: { status: "ready" },
    usageLimits: { status: "unavailable", reason: "runtime_unavailable" },
    workflows: { status: "not_applicable" },
  });
  const capabilities = await registry.resolveCapabilities(provider);
  assert.equal(capabilities.usageLimits, false);
  assert.equal(capabilities.liveSessions, true);
  assert.equal(capabilities.planTasks, true);
  assert.deepEqual(await registry.readUsageLimits(provider, { capabilities }), {
    available: false,
    fetchedAt: null,
    attemptedAt: null,
    failureKind: "runtime_unavailable",
    retryAt: null,
    limits: [],
    error: "Usage limits are unavailable.",
  });
  assert.equal(availabilityCalls, 2);
  assert.equal(limitCalls, 0);
});

test("settles a missing Codex CLI as unavailable in the committed usage cache without affecting another provider", async (context) => {
  let accountCalls = 0;
  const codex = createCodexProvider({
    codexHome: MISSING_CODEX_HOME,
    rateLimitsReader: {
      async isAvailable() { return false; },
      async readRateLimits() { accountCalls += 1; throw new Error("account read must not start"); },
    },
  });
  const claude = defineProvider({
    id: "claude",
    source: "Claude Code",
    capabilityManifest: Object.fromEntries(PROVIDER_CAPABILITY_KEYS.map((key) => [key,
      key === "usageLimits"
        ? { status: "supported" }
        : { status: "unsupported", limitation: { code: "monitor_not_implemented", documentation: `Synthetic test does not implement ${key}.` } },
    ])),
    listSessions: async () => [],
    readSession: async () => null,
    async readUsageLimits() {
      return {
        available: true,
        fetchedAt: "2026-08-11T13:00:00.000Z",
        attemptedAt: "2026-08-11T13:00:00.000Z",
        failureKind: null,
        retryAt: null,
        limits: [{
          id: "claude-primary", label: "Claude", window: "5 hours", percent: 12,
          resetsAt: "2026-08-11T18:00:00.000Z", severity: "normal", active: false,
        }],
        error: "",
      };
    },
  });
  const registry = createProviderRegistry([claude, codex]);
  const runtime = createMonitorRuntime({
    providerRegistry: registry,
    checkpointStore: false,
    resourceUsageSampler: { async sample() {}, get() { return null; } },
  });
  await runtime.startObservation();
  context.after(() => runtime.stopObservation());

  for (let attempt = 0; attempt < 50 && runtime.serveUsageLimits().snapshot?.value?.providers?.length !== 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const committed = runtime.serveUsageLimits().snapshot.value;
  const codexEntry = committed.providers.find((entry) => entry.provider === "codex");
  const claudeEntry = committed.providers.find((entry) => entry.provider === "claude");
  assert.equal(committed.readiness.codex, "unavailable");
  assert.equal(codexEntry.readiness, "unavailable");
  assert.equal(codexEntry.usageLimits.failureKind, "runtime_unavailable");
  assert.equal(codexEntry.usageLimits.error, "Usage limits are unavailable.");
  assert.equal(claudeEntry.readiness, "ready");
  assert.equal(claudeEntry.usageLimits.available, true);
  assert.equal(accountCalls, 0);

  const server = createMonitorServer({ runtime });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/usage-limits`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.readiness.codex, "unavailable");
  assert.equal(body.providers.find((entry) => entry.provider === "claude").usageLimits.available, true);
  assert.equal(accountCalls, 0);
  const revision = response.headers.get("x-pomegr-revision");
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/usage-limits?revision=${revision}`)).status, 204);

  assert.deepEqual(await registry.readUsageLimits(codex, { historical: true }), createEmptyUsageLimits());
});

test("keeps usage-limit capability enabled when the CLI exists but the account read fails", async () => {
  const provider = createCodexProvider({
    rateLimitsReader: {
      async isAvailable() { return true; },
      async readRateLimits() { throw new Error("PRIVATE_AUTH_FAILURE_MUST_NOT_LEAK"); },
    },
  });
  const registry = createProviderRegistry([provider]);

  const capabilities = await registry.resolveCapabilities(provider);
  const limits = await registry.readUsageLimits(provider, { capabilities });
  assert.equal(capabilities.usageLimits, true);
  assert.equal(limits.available, false);
  assert.equal(limits.error, "Codex usage limits are temporarily unavailable.");
  assert.doesNotMatch(JSON.stringify(limits), /PRIVATE_AUTH_FAILURE/);
});

test("default registry injects the account-only reader without routing it through the owning app-server seam", async () => {
  let rateLimitCalls = 0;
  let owningAppServerCalls = 0;
  const registry = createDefaultProviderRegistry({
    codexRateLimitsReader: {
      async readRateLimits() {
        rateLimitCalls += 1;
        return rateLimitResponse();
      },
    },
    codexOptions: {
      appServer: {
        async request() {
          owningAppServerCalls += 1;
          throw new Error("The account reader must not use the owning app-server seam");
        },
      },
    },
  });
  const codex = registry.providers.find((provider) => provider.id === "codex");

  const limits = await registry.readUsageLimits(codex);
  assert.equal(rateLimitCalls, 1);
  assert.equal(owningAppServerCalls, 0);
  assert.equal(limits.available, true);
  assert.equal(limits.limits.length, 3);
});

test("provider registry never reads current Codex limits for historical state", async () => {
  let calls = 0;
  const provider = createCodexProvider({
    rateLimitsReader: {
      async readRateLimits() {
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
    failureKind: null,
    retryAt: null,
    limits: [],
    error: "",
  });
  assert.equal(calls, 0);
});
