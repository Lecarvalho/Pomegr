import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationObservation } from "../../../server/runtime/notification-observation.mjs";
import { createNativeNotificationController } from "../../../desktop/runtime/notifications.mjs";
import { createNotificationCatalog } from "../../../server/notifications/notification-catalog.mjs";
import { createNotificationLedger } from "../../../server/notifications/notification-ledger.mjs";
const at = "2026-10-03T12:00:00.000Z";
const scope = "a".repeat(64);
test("catalog resolves restored Needs input only from explicit ready evidence and permits recurrence", async () => {
  let clock = Date.parse(at);
  const row = (needsInput) => ({ id: "codex:restored", provider: "codex", title: "Restored session",
    isLive: true, needsInput, updatedAt: new Date(clock).toISOString(), summaryReadiness: "ready" });
  const previous = createNotificationLedger({ now: () => clock });
  previous.acceptFacts({ catalog: { revision: 8, readiness: "ready", sessions: [row(true)], sourceScope: scope } });
  const originalId = previous.readSnapshot().occurrences[0].id;
  const observed = createNotificationObservation({ now: () => clock, sourceScope: scope,
    persistence: { load: async () => ({ status: "ready", state: previous.exportState() }), write: async () => {} } });
  await observed.start();
  const catalog = createNotificationCatalog({ projectVisibility: (entry) => entry,
    activeSessionIds: () => observed.readSnapshot().occurrences
      .filter((entry) => entry.kind === "needs_input" && entry.lifecycle === "active")
      .map((entry) => entry.data.sessionId) });
  let revision = 0;
  const commit = (rows, readiness = "ready") => {
    catalog.acceptProvider("codex", rows, readiness);
    return observed.acceptCatalogCommit(catalog.commit({ revision: ++revision, readiness,
      checkedAt: ++clock, incompleteSource: readiness !== "ready" }));
  };
  assert.equal(commit([row(false)], "partial").occurrences[0].lifecycle, "active");
  assert.equal(commit([]).occurrences[0].lifecycle, "active", "absence cannot resolve restored work");
  const resolved = commit([row(false)]).occurrences[0];
  assert.equal(resolved.id, originalId);
  assert.equal(resolved.lifecycle, "resolved");
  const recurrent = commit([row(true)]).occurrences.find((entry) => entry.lifecycle === "active");
  assert.notEqual(recurrent.id, originalId);
  assert.equal(recurrent.deliveryEligible, true);
});
test("a committed synthetic model producer crosses the same policy and delivery seams with native opt-in", async () => {
  let clock = Date.parse(at);
  const observed = createNotificationObservation({ now: () => clock, sourceScope: scope });
  const catalog = (ids) => ({ provider: "codex", status: "ready", complete: true, sourceScope: scope,
    observedAt: new Date(clock).toISOString(), knownIds: ids, models: ids.map((id) => ({ id, label: id })) });
  const claimed = new Set(); let initialized = false; let enabled = false; const shown = [];
  const store = { load: async () => "missing", writable: () => true, initialized: () => initialized,
    has: (id) => claimed.has(id), claim: async (ids) => { initialized = true; ids.forEach((id) => claimed.add(id)); return true; } };
  const controller = createNativeNotificationController({ store, now: () => clock,
    getPreferences: () => ({ enabled: true, categories: { model_news: enabled } }),
    notify: (payload, click) => { shown.push({ payload, click }); return true; }, openTarget: (target) => assert.equal(target, "/usage-limits") });
  await controller.start(); await controller.observe(observed.readSnapshot());
  observed.acceptModelObservations([catalog(["gpt-5"])]);
  await controller.observe(observed.readSnapshot());
  clock += 60_000; observed.acceptModelObservations([catalog(["gpt-5", "gpt-6"])]);
  assert.equal(await controller.observe(observed.readSnapshot()), 0);
  enabled = true;
  assert.equal(await controller.observe(observed.readSnapshot()), 0);
  clock += 60_000; observed.acceptModelObservations([catalog(["gpt-5", "gpt-6", "gpt-7"])]);
  assert.equal(await controller.observe(observed.readSnapshot()), 1);
  assert.match(shown[0].payload.title, /listed in your client/); shown[0].click();
  assert.equal(observed.read().snapshot.serialized, JSON.stringify(observed.readSnapshot()));
});
