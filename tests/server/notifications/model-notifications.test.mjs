import test from "node:test";
import assert from "node:assert/strict";
import { reduceModelNotifications } from "../../../server/notifications/model-notifications.mjs";
import { createNotificationLedger } from "../../../server/notifications/notification-ledger.mjs";
import { normalizeNotificationPersistence } from "../../../server/notifications/notification-persistence.mjs";
import { normalizeNativeNotificationSnapshot, nativeNotificationPayload } from "../../../desktop/runtime/notifications.mjs";
import { createNotificationObservation } from "../../../server/runtime/notification-observation.mjs";
import { createReleaseObservation } from "../../../server/runtime/release-observation.mjs";
import { createCodexModelObservation } from "../../../server/providers/codex/model-observation.mjs";
const T0 = "2026-10-03T12:00:00.000Z";
const T1 = "2026-10-03T13:00:00.000Z";
const scope = "a".repeat(64);
const catalog = (ids, observedAt = T0, extra = {}) => ({ provider: "codex", status: "ready", complete: true,
  observedAt, sourceScope: scope, knownIds: ids, models: ids.map((id) => ({ id, label: id })), ...extra });
const facts = (row) => ({ catalogs: [row], announcements: [] });
test("an adapter source gap breaks comparison before the original account returns", async () => {
  let source = scope; let clock = Date.parse(T0); let ids = ["gpt-5"];
  const adapter = createCodexModelObservation({ sourceScope: () => source, now: () => clock,
    catalogReader: { readCatalog: async () => ({ pages: [{ nextCursor: null,
      data: ids.map((id) => ({ id, model: id, displayName: id, hidden: false })) }] }) } });
  const first = reduceModelNotifications(facts(await adapter.read()), null, clock);
  clock += 60 * 60_000; source = null;
  const unknown = reduceModelNotifications(facts(await adapter.read()), first.state, clock);
  assert.equal(unknown.state.catalogs.codex, null);
  source = scope; ids = ["gpt-5", "gpt-6"]; clock += 60 * 60_000;
  const returned = reduceModelNotifications(facts(await adapter.read()), unknown.state, clock);
  assert.equal(returned.items.length, 0);
});
test("complete catalogs announce visible new identities; hidden and alias identities never create novelty", () => {
  const first = reduceModelNotifications(facts(catalog(["gpt-5"], T0, { knownIds: ["gpt-5", "gpt-hidden", "gpt-alias"] })), null, Date.parse(T0));
  assert.equal(first.items.length, 0);
  const next = reduceModelNotifications(facts(catalog(["gpt-5", "gpt-hidden", "gpt-alias", "gpt-6"], T1)), first.state, Date.parse(T1));
  assert.deepEqual(next.items.map((row) => row.data.modelId), ["gpt-6"]);
  assert.equal(next.items[0].kind, "model_client_listed");
  const absent = reduceModelNotifications(facts(catalog([], "2026-10-03T14:00:00.000Z")), next.state, Date.parse("2026-10-03T14:00:00.000Z"));
  assert.equal(absent.items.length, 0);
  assert.equal(absent.state.catalogs.codex.known.includes("gpt-6"), true);
});
test("partial, invalid, stale, changed-profile and old cached interleavings cannot manufacture listing events", () => {
  const first = reduceModelNotifications(facts(catalog(["gpt-5"])), null, Date.parse(T0));
  for (const extra of [{ complete: false }, { status: "unavailable" }, { sourceScope: "b".repeat(64) },
    { models: [{ id: ["gpt-6"], label: "gpt-6" }] }, { models: [{ id: "gpt-6", label: "<unsafe>" }] }]) {
    assert.equal(reduceModelNotifications(facts(catalog(["gpt-5", "gpt-6"], T1, extra)), first.state, Date.parse(T1)).items.length, 0);
  }
  const current = reduceModelNotifications(facts(catalog(["gpt-5", "gpt-6"], T1)), first.state, Date.parse(T1));
  assert.deepEqual(reduceModelNotifications(facts(catalog(["gpt-5"], T0)), current.state, Date.parse(T1)).state, current.state);
  assert.equal(reduceModelNotifications(facts(catalog(["gpt-7"], "2026-10-03T18:00:00.000Z")), current.state,
    Date.parse("2026-10-03T18:00:00.000Z")).items.length, 0);
});
test("only explicit fresh official publication creates announcement or retirement; absence is inert", () => {
  const news = (announcements, observedAt) => ({ catalogs: [], announcements: [{ provider: "codex", status: "ready",
    complete: true, sourceScope: scope, observedAt, announcements }] });
  const first = reduceModelNotifications(news([], T0), null, Date.parse(T0));
  const entries = ["model_announced", "model_deprecated"].map((kind) => ({ kind, modelId: "gpt-6", label: "GPT-6", publishedAt: T1 }));
  const next = reduceModelNotifications(news(entries, T1), first.state, Date.parse(T1));
  assert.deepEqual(next.items.map((row) => row.kind), ["model_announced", "model_deprecated"]);
  assert.equal(reduceModelNotifications(news(entries, T1), next.state, Date.parse(T1)).items.length, 0);
  assert.equal(reduceModelNotifications(news([], "2026-10-03T14:00:00.000Z"), next.state, Date.parse("2026-10-03T14:00:00.000Z")).items.length, 0);
});
test("model occurrences persist and survive source revision restart without replay or private serialization", () => {
  let at = Date.parse(T0);
  const observation = createNotificationObservation({ now: () => at, sourceScope: scope });
  observation.acceptModelObservations([catalog(["gpt-5"])]);
  at = Date.parse(T1);
  observation.acceptModelObservations([catalog(["gpt-5", "gpt-6"], T1)]);
  const ledger = createNotificationLedger({ now: () => at });
  ledger.acceptFacts({ models: { revision: 500, sourceScope: scope, ...facts(catalog(["gpt-5"])) } });
  ledger.acceptFacts({ models: { revision: 501, sourceScope: scope, ...facts(catalog(["gpt-5", "gpt-6"], T1)) } });
  const saved = { version: 1, profileScope: scope, ...ledger.exportState() };
  const restored = normalizeNotificationPersistence(saved, scope, at);
  assert.ok(restored);
  const fresh = createNotificationLedger({ now: () => at }); fresh.restore(restored.state);
  const oldId = fresh.readSnapshot().occurrences[0].id;
  fresh.acceptFacts({ models: { revision: 1, sourceScope: scope, ...facts(catalog(["gpt-5", "gpt-6"], T1)) } });
  assert.equal(fresh.readSnapshot().occurrences.length, 1);
  assert.equal(fresh.readSnapshot().occurrences[0].id, oldId);
  assert.equal(normalizeNativeNotificationSnapshot(observation.readSnapshot()).occurrences.length, 1);
  assert.match(nativeNotificationPayload(observation.readSnapshot().occurrences[0]).body, /does not confirm account access/);
  assert.doesNotMatch(JSON.stringify(observation.readSnapshot()), /sourceScope|knownIds|config|auth|https:/);
  for (const invalid of [["gpt-6"], "../gpt-6", "C:secret", "<gpt-6>"]) {
    const bad = structuredClone(saved); bad.snapshot.occurrences[0].data.modelId = invalid;
    assert.equal(normalizeNotificationPersistence(bad, scope, at), null);
  }
});
test("one low-priority scheduler coalesces hourly catalog and six-hour news while cached reads stay independent", async () => {
  let clock = Date.parse(T0); let callback; let catalogs = 0; let news = 0; let releases = 0;
  const scheduler = createReleaseObservation({ now: () => clock, readers: [() => { releases++; return null; }],
    modelReaders: { catalogs: [() => { catalogs++; return catalog([]); }], announcements: [() => { news++; return null; }] },
    accept: () => {}, acceptModels: () => {}, setTimer: (fn) => { callback = fn; return 1; }, clearTimer: () => {}, jitter: () => 0 });
  scheduler.start(); callback(); await scheduler.refresh();
  assert.deepEqual([catalogs, news, releases], [1, 1, 1]);
  clock += 60 * 60_000; await scheduler.refresh();
  assert.deepEqual([catalogs, news, releases], [2, 1, 1]);
  clock += 5 * 60 * 60_000; await scheduler.refresh();
  assert.deepEqual([catalogs, news, releases], [3, 2, 2]);
  await scheduler.stop();
});
