import assert from "node:assert/strict";
import test from "node:test";
import { NOTIFICATION_RULES, createNotificationRuleRegistry, deriveNeedsInput, deriveProviderStatus, isSafeSessionId, safeSessionTitle } from "../../../server/notifications/notification-rules.mjs";

const at = "2026-10-03T12:00:00.000Z";

test("registry declares identity, freshness, transition, resolution and fixed action", () => {
  assert.deepEqual(NOTIFICATION_RULES.map((rule) => rule.kind), ["needs_input", "provider_incident"]);
  for (const rule of NOTIFICATION_RULES) for (const key of ["capability", "scope", "identity", "freshness", "transition", "resolution", "retentionDays", "category", "delivery", "action"]) assert.ok(rule[key]);
  assert.throws(() => createNotificationRuleRegistry([...NOTIFICATION_RULES, NOTIFICATION_RULES[0]]));
});

test("Needs input accepts normalized ready rows and rejects unsafe identity and title", () => {
  assert.equal(isSafeSessionId("codex:abc"), true);
  assert.equal(isSafeSessionId("codex:../path"), false);
  assert.equal(safeSessionTitle("<script>"), "Session");
  const rows = deriveNeedsInput({ readiness: "ready", sessions: [
    { id: "codex:one", provider: "codex", title: "  One  ", isLive: true, needsInput: true, updatedAt: at },
    { id: "codex:two", provider: "codex", title: "Two", isLive: true, needsInput: false, updatedAt: at },
    { id: "codex:../secret", provider: "codex", isLive: true, needsInput: true },
    { id: "codex:incomplete", provider: "codex", isLive: true, needsInput: true, summaryReadiness: "unavailable" },
    { id: "codex:unavailable", provider: "codex", isLive: true, needsInput: true, detailReadiness: "unavailable" },
  ] });
  assert.deepEqual(rows.map((row) => [row.key, row.active]), [["codex:one", true], ["codex:two", false]]);
  assert.deepEqual(deriveNeedsInput({ readiness: "partial", sessions: [{ id: "codex:one" }] }), []);
});

test("provider incident and recovery require fresh ready observations", () => {
  const row = { provider: "claude", status: "outage", readiness: "ready", freshness: "fresh", checkedAt: at, updatedAt: at };
  assert.deepEqual(deriveProviderStatus({ providers: [row] }).map((fact) => fact.active), [true]);
  assert.deepEqual(deriveProviderStatus({ providers: [{ ...row, status: "operational" }] }).map((fact) => fact.active), [false]);
  assert.deepEqual(deriveProviderStatus({ providers: [{ ...row, freshness: "stale" }] }), []);
  assert.deepEqual(deriveProviderStatus({ providers: [{ ...row, readiness: "unavailable" }] }), []);
});
