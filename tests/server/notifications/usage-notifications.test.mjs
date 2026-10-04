import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNotificationLedger } from "../../../server/notifications/notification-ledger.mjs";
import { createNotificationPersistence, normalizeNotificationPersistence } from "../../../server/notifications/notification-persistence.mjs";
import { createNotificationObservation } from "../../../server/runtime/notification-observation.mjs";
import { normalizeNativeNotificationSnapshot, nativeNotificationPayload, notificationTarget } from "../../../desktop/runtime/notifications.mjs";
import { reduceUsageNotifications } from "../../../server/notifications/usage-notifications.mjs";
import { createCodexUsageLimitsCoordinator } from "../../../server/providers/codex/usage-limits.mjs";
import { usageNotificationSource } from "../../../server/normalize/usage-notification-facts.mjs";

const START = Date.parse("2026-10-03T12:00:00.000Z");
const iso = (offset) => new Date(START + offset).toISOString();
const scope = "a".repeat(64);
function facts(at = 0, changes = {}) {
  const { provider = "claude", percent = 100, weekly = 100, reset = 60_000, count = null, ...other } = changes;
  const usageLimits = { available: true, fetchedAt: iso(at), attemptedAt: iso(at), failureKind: null, error: "",
    origin: "provider_api", freshness: "fresh", limits: [
      { id: provider === "claude" ? "current-session" : "codex-primary", window: "5 hours", percent, active: percent >= 100, resetsAt: iso(reset) },
      { id: provider === "claude" ? "all-models" : "codex-secondary", window: "7 days", percent: weekly, active: weekly >= 100, resetsAt: iso(7 * 86400_000) },
    ], resetCredits: { status: count === null ? "unknown" : "supported", availableCount: count, observedAt: iso(at) }, ...other };
  return { providers: [{ provider, usageLimits, comparison: { sourceScope: scope, complete: true,
    windows: provider === "codex" ? usageLimits.limits.map((limit, index) => ({ id: limit.id, key: (index ? "f" : "e").repeat(64), window: index ? "secondary" : "primary" })) : null,
  } }] };
}
function transition(before, after, now = START + 120_000) {
  const baseline = reduceUsageNotifications(before, null, START);
  return reduceUsageNotifications(after, baseline.state, now);
}

test("deadline crossing and repeated observations never confirm a reset, including sleep and clock jumps", () => {
  const input = facts();
  assert.equal(transition(input, input, START + 7 * 86400_000).items.length, 0);
  assert.equal(transition(input, facts(120_000), START + 120_000).items.length, 0);
  assert.equal(transition(input, facts(30_000, { reset: 300_000 }), START + 30_000).items.length, 0);
  assert.equal(transition(input, facts(120_000, { percent: 0, reset: 300_000 }), START - 1000).items.length, 0);
});

test("fresh rollover coalesces capacity recovery and names the still-exhausted other window", () => {
  const result = transition(facts(), facts(120_000, { percent: 0, reset: 300_000 }));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "usage_window_reset");
  assert.deepEqual(result.items[0].data, { window: "five_hour", origin: "provider_api", otherExhausted: true });
  assert.equal(result.items[0].at, iso(120_000));
});

test("same-window recovery does not claim rollover or general account usability", () => {
  const result = transition(facts(0, { reset: 600_000 }), facts(120_000, { percent: 35, reset: 600_000 }));
  assert.equal(result.items[0].kind, "usage_capacity_restored");
  assert.equal(result.items[0].data.otherExhausted, true);
  assert.equal(transition(facts(0, { percent: 80 }), facts(30_000, { percent: 25 }), START + 30_000).items.length, 0);
});

test("local Claude evidence keeps its original timestamp and provenance", () => {
  const before = facts(0, { origin: "local_observation" });
  const after = facts(120_000, { origin: "local_observation", percent: 0, reset: 500_000 });
  const result = transition(before, after, START + 180_000);
  assert.equal(result.items[0].at, iso(120_000));
  assert.equal(result.items[0].data.origin, "local_observation");
  assert.equal(reduceUsageNotifications(after, result.state, START + 181_000).items.length, 0);
});

for (const variant of ["stale", "partial", "out-of-order", "source-switch", "origin-switch", "unknown-scope", "failure", "changed-windows"]) {
  test(`${variant} evidence cannot manufacture a usage transition`, () => {
    const after = facts(120_000, { percent: 0, reset: 300_000 });
    const row = after.providers[0];
    if (variant === "stale") row.usageLimits.freshness = "stale";
    if (variant === "partial") row.usageLimits.limits.pop();
    if (variant === "out-of-order") row.usageLimits.fetchedAt = iso(-1000);
    if (variant === "source-switch") row.comparison.sourceScope = "b".repeat(64);
    if (variant === "origin-switch") row.usageLimits.origin = "local_observation";
    if (variant === "unknown-scope") row.comparison.sourceScope = null;
    if (variant === "failure") row.usageLimits.failureKind = "authentication_required";
    if (variant === "changed-windows") row.usageLimits.limits[0].window = "1 hour";
    assert.equal(transition(facts(), after).items.length, 0);
  });
}

test("an unknown count breaks comparison and old data cannot rewind a newer count", () => {
  const baseline = reduceUsageNotifications(facts(0, { provider: "codex", count: 0 }), null, START);
  const unknown = reduceUsageNotifications(facts(10_000, { provider: "codex", count: null }), baseline.state, START + 10_000);
  const next = reduceUsageNotifications(facts(120_000, { provider: "codex", count: 2 }), unknown.state, START + 120_000);
  assert.equal(next.items.length, 0);
  const old = reduceUsageNotifications(facts(0, { provider: "codex", count: 0 }), next.state, START + 120_000);
  assert.equal(old.state.codex.count, 2);
});

test("unchanged cached windows aging out do not erase the last accepted fresh baseline", () => {
  const first = facts(0, { provider: "codex", count: 0 });
  const baseline = reduceUsageNotifications(first, null, START);
  const cached = structuredClone(first); cached.providers[0].usageLimits.freshness = "stale";
  const stale = reduceUsageNotifications(cached, baseline.state, START + 300_001);
  assert.equal(stale.items.length, 0);
  const fresh = reduceUsageNotifications(facts(300_002, { provider: "codex", count: 1, percent: 0, reset: 600_000 }), stale.state, START + 300_002);
  assert.deepEqual(fresh.items.map((item) => item.kind), ["usage_window_reset", "usage_reset_available"]);
});

test("reset count establishes a baseline; only known zero-to-positive or later increases emit", () => {
  let state = null;
  const observed = [];
  for (const [index, count] of [2, 2, null, 3, 0, 1, 1, 2].entries()) {
    const result = reduceUsageNotifications(facts(index * 1000, { provider: "codex", count }), state, START + index * 1000);
    state = result.state;
    observed.push(...result.items);
  }
  assert.deepEqual(observed.map((item) => [item.kind, item.data.availableCount]), [["usage_reset_available", 1], ["usage_reset_available", 2]]);
});

test("usage events survive durable restart and native validation without repeated-positive replay", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-usage-notifications-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = START;
  const make = () => createNotificationObservation({ now: () => clock, sourceScope: "profile",
    persistence: createNotificationPersistence({ directory, profileScope: scope, now: () => clock }) });
  const first = make();
  await first.start();
  first.acceptUsageCommit({ revision: 1, ...facts(0, { provider: "codex", count: 0 }) });
  clock += 120_000;
  first.acceptUsageCommit({ revision: 2, ...facts(120_000, { provider: "codex", count: 1, percent: 0, reset: 300_000 }) });
  const snapshot = first.readSnapshot();
  assert.equal(snapshot.occurrences.length, 2);
  const native = normalizeNativeNotificationSnapshot(snapshot);
  assert.equal(native.occurrences.length, 2);
  for (const record of native.occurrences) {
    assert.equal(notificationTarget(record), "/usage-limits");
    assert.ok(nativeNotificationPayload(record));
  }
  assert.match(nativeNotificationPayload(native.occurrences.find((row) => row.kind === "usage_window_reset")).body, /Another usage window remains exhausted/);
  await first.stop();
  const second = make();
  assert.equal(await second.start(), "restored");
  second.acceptUsageCommit({ revision: 1, ...facts(120_000, { provider: "codex", count: 1, percent: 0, reset: 300_000 }) });
  assert.deepEqual(second.readSnapshot(), snapshot);
  await second.stop();
  const stored = JSON.parse(await fs.readFile(path.join(directory, "notifications-v1.json"), "utf8"));
  assert.equal(stored.usageState.codex.count, 1);
  stored.usageState.codex.creditId = "PRIVATE_CREDIT";
  assert.equal(normalizeNotificationPersistence(stored, scope, clock), null);
  assert.doesNotMatch(JSON.stringify(snapshot), /sourceScope|signature|windows|"count"/);
});

test("a missing usage provider does not clear the other provider baseline", () => {
  let clock = START;
  const ledger = createNotificationLedger({ now: () => clock });
  ledger.acceptFacts({ usage: { revision: 1, ...facts() } });
  ledger.acceptFacts({ usage: { revision: 2, ...facts(0, { provider: "codex", count: 0 }) } });
  clock += 120_000;
  ledger.acceptFacts({ usage: { revision: 3, ...facts(120_000, { percent: 0, reset: 300_000 }) } });
  assert.equal(ledger.readSnapshot().occurrences[0].kind, "usage_window_reset");
});

for (const shape of ["legacy", "multi-bucket"]) {
  test(`adapter-to-reducer ${shape} windows retain private stable identities`, async () => {
    let time = START;
    let recovered = false;
    let reset = 600_000;
    const primary = (percent) => ({ usedPercent: percent, windowDurationMins: 300, resetsAt: Math.floor((START + reset) / 1000) });
    const coordinator = createCodexUsageLimitsCoordinator({ now: () => time, sourceScope: () => scope,
      request: async () => shape === "legacy"
        ? { rateLimits: { primary: primary(recovered ? 10 : 100) } }
        : { rateLimitsByLimitId: { alternate: { primary: primary(recovered ? 10 : 100) }, another: { primary: primary(100) } } },
    });
    const input = (usageLimits) => ({ providers: [{ provider: "codex", usageLimits, comparison: usageNotificationSource(usageLimits) }] });
    const baseline = reduceUsageNotifications(input(await coordinator.get()), null, time);
    time += 300_000; recovered = true;
    await coordinator.get(); await new Promise((resolve) => setImmediate(resolve));
    const next = reduceUsageNotifications(input(coordinator.peek()), baseline.state, time);
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].kind, "usage_capacity_restored");
    assert.equal(next.items[0].data.window, "primary");
    assert.equal(next.items[0].data.otherExhausted, shape === "multi-bucket");
    assert.match(next.items[0].key, /^codex:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(next.state), /alternate|another|usage-1/);
    if (shape === "multi-bucket") assert.notEqual(next.state.codex.windows[0].key, next.state.codex.windows[1].key);
    time += 600_000; reset = 1200_000;
    await coordinator.get(); await new Promise((resolve) => setImmediate(resolve));
    const rolled = reduceUsageNotifications(input(coordinator.peek()), next.state, time);
    assert.equal(rolled.items.length, shape === "legacy" ? 1 : 2);
    assert.ok(rolled.items.every((item) => item.kind === "usage_window_reset"));
    assert.equal(new Set(rolled.items.map((item) => item.key)).size, rolled.items.length);
  });
}

test("persistent recognized authentication needs a completed retry and emits only once until recovery", () => {
  const failure = (at, failureKind = "authentication_required", source = scope) => {
    const value = facts(at, { fetchedAt: null, available: false, limits: [], failureKind, retryAt: iso(at + 300_000) });
    value.providers[0].comparison.sourceScope = source;
    return value;
  };
  const first = reduceUsageNotifications(failure(0), null, START);
  assert.equal(first.items.length, 0);
  assert.equal(reduceUsageNotifications(failure(0), first.state, START + 300_000).items.length, 0);
  assert.equal(reduceUsageNotifications(failure(60_000), first.state, START + 60_000).items.length, 0);
  const retry = reduceUsageNotifications(failure(300_000), first.state, START + 300_000);
  assert.equal(retry.items[0].kind, "usage_authentication_required");
  assert.deepEqual(retry.items[0].data, {});
  assert.equal(reduceUsageNotifications(failure(600_000), retry.state, START + 600_000).items.length, 0);
  assert.equal(reduceUsageNotifications(failure(300_000, "unavailable"), first.state, START + 300_000).items.length, 0);
  assert.equal(reduceUsageNotifications(failure(300_000, "rate_limited"), first.state, START + 300_000).items.length, 0);
  assert.equal(reduceUsageNotifications(failure(300_000, "authentication_required", "b".repeat(64)), first.state, START + 300_000).items.length, 0);
  const cleared = reduceUsageNotifications(failure(100_000, null), first.state, START + 100_000);
  const delayed = reduceUsageNotifications(failure(0), cleared.state, START + 100_000);
  assert.equal(reduceUsageNotifications(failure(300_000), delayed.state, START + 300_000).items.length, 0,
    "an older authentication failure cannot undo a newer successful attempt");
  let clock = START;
  const ledger = createNotificationLedger({ now: () => clock });
  ledger.acceptFacts({ usage: { revision: 1, ...failure(0) } });
  clock += 300_000;
  ledger.acceptFacts({ usage: { revision: 2, ...failure(300_000) } });
  const stored = { version: 1, profileScope: scope, ...ledger.exportState() };
  const normalized = normalizeNotificationPersistence(stored, scope, clock);
  assert.ok(normalized);
  const restored = createNotificationLedger({ now: () => clock });
  restored.restore(normalized.state);
  clock += 300_000;
  restored.acceptFacts({ usage: { revision: 1, ...failure(600_000) } });
  assert.equal(restored.readSnapshot().occurrences.length, 1);
  assert.equal(restored.readSnapshot().occurrences[0].category, "provider_news");
  assert.ok(normalizeNativeNotificationSnapshot(restored.readSnapshot()));
});

test("another provider's commit with stale cached auth preserves pending and notified episodes", () => {
  const failure = (at) => facts(at, { fetchedAt: null, available: false, limits: [],
    failureKind: "authentication_required", retryAt: iso(at + 300_000) }).providers[0];
  let clock = START;
  const ledger = createNotificationLedger({ now: () => clock });
  ledger.acceptFacts({ usage: { revision: 1, providers: [failure(0)] } });
  clock += 300_001;
  ledger.acceptFacts({ usage: { revision: 2, providers: [failure(0), ...facts(300_001, { provider: "codex" }).providers] } });
  assert.equal(ledger.readSnapshot().occurrences.length, 0);
  assert.equal(ledger.exportState().usageState.authentication.claude.retryAt, iso(300_000));
  clock += 1;
  ledger.acceptFacts({ usage: { revision: 3, providers: [failure(300_002)] } });
  assert.equal(ledger.readSnapshot().occurrences.length, 1, "fresh failed retry is still recognized after cached evidence aged out");
  const id = ledger.readSnapshot().occurrences[0].id;
  clock = START + 600_003;
  ledger.acceptFacts({ usage: { revision: 4, providers: [failure(300_002), ...facts(600_003, { provider: "codex" }).providers] } });
  assert.equal(ledger.exportState().usageState.authentication.claude.notified, true);
  clock += 1;
  ledger.acceptFacts({ usage: { revision: 5, providers: [failure(600_004)] } });
  assert.deepEqual(ledger.readSnapshot().occurrences.map((row) => row.id), [id], "stale cached commits do not re-arm an emitted episode");
});
