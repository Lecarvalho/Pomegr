import test from "node:test";
import assert from "node:assert/strict";
import { createNotificationObservation } from "../../../server/runtime/notification-observation.mjs";
import { createNativeNotificationController } from "../../../desktop/runtime/notifications.mjs";
import { createNotificationCatalog } from "../../../server/notifications/notification-catalog.mjs";
import { createNotificationLedger } from "../../../server/notifications/notification-ledger.mjs";
import { initialCodexRecordedLifecycle, reduceCodexRecordedLifecycle, codexRecordedLiveness } from "../../../server/providers/codex/recorded-lifecycle.mjs";
import { createNotificationDeliveryStore } from "../../../desktop/runtime/notification-delivery-store.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexSessionReference } from "../../../server/providers/codex/session-discovery.mjs";
import { parseProviderSessionReference } from "../../../server/providers/provider-contract.mjs";
import { publicCatalogEntry } from "../../../server/sessions/catalog/session-catalog-runtime.mjs";
import { withInputNotificationTime, inputNotificationTime } from "../../../server/normalize/input-notification-facts.mjs";
const at = "2026-10-03T12:00:00.000Z";
const scope = "a".repeat(64);

test("private original input time survives validation and committed visibility projection without rewinding public activity", () => {
  const activityAt = "2026-10-03T12:05:00.000Z";
  const oldestAt = "2026-10-03T12:00:10.000Z";
  const nextAt = "2026-10-03T12:00:20.000Z";
  const catalog = createNotificationCatalog({ projectVisibility: (row) => ({ ...row }) });
  const observed = createNotificationObservation({ now: () => Date.parse(activityAt), sourceScope: scope });
  const commit = (questionAt, revision) => {
    const row = publicCatalogEntry("codex", "Codex", parseProviderSessionReference(withInputNotificationTime({
      localId: "late-question", title: "Late question", project: "Fixture", createdAt: at, updatedAt: activityAt,
      isLive: true, needsInput: true, activityStatus: "needs_input",
    }, questionAt)));
    assert.equal(row.updatedAt, activityAt);
    assert.equal(inputNotificationTime(row), questionAt);
    assert.equal(inputNotificationTime(JSON.parse(JSON.stringify(row))), null);
    catalog.acceptProvider("codex", [row], "ready");
    return observed.acceptCatalogCommit(catalog.commit({ revision, readiness: "ready", checkedAt: Date.parse(activityAt) })).occurrences[0];
  };
  const first = commit(oldestAt, 1);
  const next = commit(nextAt, 2);
  assert.equal(first.occurredAt, oldestAt, "initial discovery uses question time despite newer activity");
  assert.equal(next.id, first.id);
  assert.equal(next.occurredAt, oldestAt, "removing the oldest question preserves active occurrence time");
});

test("async lifecycle feeds one private-safe tray occurrence and native claim, then uncertainty and recurrence", async (context) => {
  let clock = Date.parse(at);
  let state = initialCodexRecordedLifecycle();
  const observed = createNotificationObservation({ now: () => clock, sourceScope: scope });
  const catalog = createNotificationCatalog({ projectVisibility: (row) => row });
  let revision = 0;
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-async-notification-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "claims.json");
  const shown = []; const opened = [];
  const native = () => createNativeNotificationController({
    store: createNotificationDeliveryStore({ file, profileScope: scope, now: () => clock }), now: () => clock,
    getPreferences: () => ({ enabled: true }),
    notify: (payload, click) => { shown.push({ payload, click }); return true; },
    openTarget: (target) => opened.push(target),
  });
  const delivery = native();
  await delivery.start();
  const commit = () => {
    const liveness = codexRecordedLiveness(state, { now: clock });
    const reference = codexSessionReference({ localId: "async-fixture", title: "Async input fixture", project: "Fixture",
      createdAt: at, updatedAt: new Date(clock).toISOString() }, { isLive: liveness?.live === true,
      needsInput: liveness?.needsInput === true, activityStatus: liveness?.status || "unknown", observedAt: liveness?.observedAt });
    const row = publicCatalogEntry("codex", "Codex", parseProviderSessionReference(reference));
    assert.equal(row.updatedAt, new Date(clock).toISOString(), "activity clock must not rewind to the question");
    assert.doesNotMatch(JSON.stringify(row), /observedAt|questionTime|PRIVATE_/);
    catalog.acceptProvider("codex", [row], "ready");
    return observed.acceptCatalogCommit(catalog.commit({ revision: ++revision, readiness: "ready", checkedAt: clock }));
  };
  const add = (type, payload) => {
    clock += 1_000;
    state = reduceCodexRecordedLifecycle(state, { timestamp: new Date(clock).toISOString(), type, payload });
  };
  await delivery.observe(commit()); // Empty startup baseline.
  add("event_msg", { type: "task_started", turn_id: "async-turn" });
  add("response_item", { type: "function_call", name: "request_user_input_async", call_id: "PRIVATE_CALL",
    arguments: '{"questions":[{"title":"PRIVATE_QUESTION","options":["PRIVATE_OPTION"]}]}' });
  const pendingAt = new Date(clock).toISOString();
  add("response_item", { type: "function_call_output", call_id: "PRIVATE_CALL", output: '{"accepted":true}' });
  const pending = commit();
  assert.equal(pending.occurrences.length, 1);
  const occurrence = pending.occurrences[0];
  assert.equal(occurrence.kind, "needs_input");
  assert.equal(occurrence.occurredAt, pendingAt);
  assert.equal(occurrence.deliveryEligible, true);
  assert.equal(await delivery.observe(pending), 1);
  add("response_item", { type: "function_call", name: "exec", call_id: "work", arguments: "PRIVATE_RESULT" });
  add("response_item", { type: "function_call_output", call_id: "PRIVATE_CALL", output: '{"accepted":true}' });
  const continued = commit();
  assert.equal(continued.occurrences[0].id, occurrence.id);
  assert.equal(continued.occurrences[0].occurredAt, pendingAt);
  assert.equal(await delivery.observe(continued), 0);
  shown[0].click();
  assert.deepEqual(opened, ["/sessions/codex-async-fixture"]);
  const restarted = native();
  await restarted.start();
  assert.equal(await restarted.observe(continued), 0, "durable claim prevents replay");
  add("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_ANSWER" }],
    internal_chat_message_metadata_passthrough: { turn_id: "async-turn", content_item_kinds: ["user.text"] } });
  const uncertain = commit();
  assert.equal(codexRecordedLiveness(state, { now: clock }).status, "unknown");
  assert.equal(uncertain.occurrences[0].lifecycle, "resolved", "the Needs input condition ended; no answer is asserted");
  add("event_msg", { type: "task_complete", turn_id: "async-turn" });
  add("event_msg", { type: "task_started", turn_id: "next-turn" });
  add("response_item", { type: "function_call", name: "request_user_input_async", call_id: "PRIVATE_CALL_2" });
  add("response_item", { type: "function_call_output", call_id: "PRIVATE_CALL_2", output: '{"accepted":true}' });
  const recurrence = commit();
  assert.notEqual(recurrence.occurrences.find((row) => row.lifecycle === "active").id, occurrence.id);
  assert.equal(await restarted.observe(recurrence), 1);
  assert.equal(shown.length, 2);
  assert.doesNotMatch(JSON.stringify([recurrence, shown.map((entry) => entry.payload)]), /PRIVATE_|accepted|questions|arguments/);
  assert.doesNotMatch(await readFile(file, "utf8"), /PRIVATE_|Async input fixture|codex:async-fixture/);
});

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
