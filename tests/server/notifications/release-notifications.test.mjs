import test from "node:test";
import assert from "node:assert/strict";
import { reduceReleaseNotifications } from "../../../server/notifications/release-notifications.mjs";
import { createNotificationLedger } from "../../../server/notifications/notification-ledger.mjs";
import { normalizeNotificationPersistence } from "../../../server/notifications/notification-persistence.mjs";
import { normalizeNativeNotificationSnapshot, nativeNotificationPayload } from "../../../desktop/runtime/notifications.mjs";
import { createReleaseObservation } from "../../../server/runtime/release-observation.mjs";
import { createNotificationObservation } from "../../../server/runtime/notification-observation.mjs";
import { releaseNotificationPayload } from "../../../shared/release-notification.mjs";

const T0 = "2026-10-03T12:00:00.000Z";
const T1 = "2026-10-03T13:00:00.000Z";
const scope = "a".repeat(64);
const cli = (version, observedAt, installation = null) => ({ provider: "codex", product: "codex_cli", version,
  channel: "latest", observedAt, installation });
test("newer releases require baseline and current comparable installation for update wording", () => {
  const baseline = reduceReleaseNotifications({ observations: [cli("1.0.0", T0)] }, null, Date.parse(T0));
  assert.equal(baseline.items.length, 0);
  const newer = reduceReleaseNotifications({ observations: [cli("1.1.0", T1)] }, baseline.state, Date.parse(T1));
  assert.equal(newer.items[0].kind, "release_published");
  const qualified = reduceReleaseNotifications({ observations: [cli("1.2.0", "2026-10-03T14:00:00.000Z",
    { status: "installed", version: "1.1.0", channel: "latest" })] }, newer.state, Date.parse("2026-10-03T14:00:00.000Z"));
  assert.equal(qualified.items[0].kind, "installation_update_available");
  assert.equal(reduceReleaseNotifications({ observations: [cli("1.2.0", "2026-10-03T15:00:00.000Z")] }, qualified.state,
    Date.parse("2026-10-03T15:00:00.000Z")).items.length, 0);
  const older = reduceReleaseNotifications({ observations: [cli("1.1.0", "2026-10-03T16:00:00.000Z")] }, qualified.state,
    Date.parse("2026-10-03T16:00:00.000Z"));
  assert.equal(older.items.length, 0);
  assert.equal(older.state.codex_cli.version, "1.2.0");
  assert.equal(reduceReleaseNotifications({ observations: [cli("1.2.0", "2026-10-03T17:00:00.000Z")] }, older.state,
    Date.parse("2026-10-03T17:00:00.000Z")).items.length, 0);
});
test("array-shaped versions and products cannot pass release boundaries", () => {
  const invalid = reduceReleaseNotifications({ observations: [cli(["1.0.0"], T0)] }, null, Date.parse(T0));
  assert.equal(invalid.items.length, 0);
  assert.equal(invalid.state.codex_cli, null);
  const baseline = reduceReleaseNotifications({ observations: [cli("1.0.0", T0)] }, null, Date.parse(T0));
  const suspicious = reduceReleaseNotifications({ observations: [cli("1.1.0", T1,
    { status: "installed", version: ["1.0.0"], channel: "latest" })] }, baseline.state, Date.parse(T1));
  assert.equal(suspicious.items[0].kind, "release_published");
  const ledger = createNotificationLedger({ now: () => Date.parse(T1) });
  ledger.acceptFacts({ releases: { sourceScope: scope, observations: [cli("1.0.0", T0)] } });
  const persisted = { version: 1, profileScope: scope, ...ledger.exportState() };
  persisted.releaseState.codex_cli.version = ["1.0.0"];
  assert.equal(normalizeNotificationPersistence(persisted, scope, Date.parse(T1)), null);
});
test("one plugin occurrence survives durable and native validation without repository paths", () => {
  let at = Date.parse(T0);
  const ledger = createNotificationLedger({ now: () => at });
  const plugin = (version, time, count) => ({ provider: null, product: "pomegr_plugin", version, channel: "main",
    observedAt: time, installation: { status: "installed", version: "0.6.0", channel: "main", affectedRepositories: count } });
  ledger.acceptFacts({ releases: { revision: 1, sourceScope: scope, observations: [plugin("0.7.0", T0, 2)] } });
  at = Date.parse(T1);
  ledger.acceptFacts({ releases: { revision: 2, sourceScope: scope, observations: [plugin("0.8.0", T1, 2)] } });
  const row = ledger.readSnapshot().occurrences[0];
  assert.equal(row.kind, "installation_update_available");
  assert.equal(row.data.affectedRepositories, 2);
  assert.match(nativeNotificationPayload(row).body, /2 repositories/);
  assert.equal(normalizeNativeNotificationSnapshot(ledger.readSnapshot()).occurrences.length, 1);
  const saved = { version: 1, profileScope: scope, ...ledger.exportState() };
  assert.ok(normalizeNotificationPersistence(saved, scope, at));
  assert.doesNotMatch(JSON.stringify(saved), /repo-[a-f0-9]{24}|sourceKey|github\.com/);
});
test("plugin refresh aggregates two repositories into one current setup occurrence", () => {
  let at = Date.parse(T0);
  const observation = createNotificationObservation({ now: () => at, sourceScope: scope });
  const setups = (version, checkedAt) => ["1", "2"].map((digit) => ({
    repositoryId: `repo-${digit.repeat(24)}`, provider: "claude", pinned: false,
    setup: { readiness: "ready", installation: "installed", version: "0.6.0", enabled: true,
      scope: "user", checkedAt, update: { status: "available", version, checkedAt }, canInstall: false, canUpdate: true },
  }));
  observation.acceptPluginSetupCommits(setups("0.7.0", T0));
  at = Date.parse(T1);
  observation.acceptPluginSetupCommits(setups("0.8.0", T1));
  const rows = observation.readSnapshot().occurrences;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.affectedRepositories, 2);
});
test("scheduler coalesces reads, stops timers, and does not wait in GET paths", async () => {
  let resolve;
  let calls = 0;
  let callback = null;
  const read = () => { calls++; return new Promise((done) => { resolve = done; }); };
  const scheduler = createReleaseObservation({ readers: [read], modelReaders: { catalogs: [], announcements: [] }, accept: () => {}, setTimer: (fn) => { callback = fn; return 1; }, clearTimer: () => {}, initialDelayMs: 1 });
  scheduler.start();
  callback();
  const pending = scheduler.refresh();
  assert.equal(calls, 1);
  resolve(cli("1.0.0", T0));
  await pending;
  await scheduler.stop();
  assert.equal(calls, 1);
});
const claude = (version, observedAt, excerpt) => ({ provider: "claude", product: "claude_code", version,
  channel: "latest", observedAt, installation: null, ...(excerpt === undefined ? {} : { excerpt }) });
test("a Claude Code release carries its bounded excerpt and a derived tag page through every store", () => {
  let at = Date.parse(T0);
  const observation = createNotificationObservation({ now: () => at, sourceScope: scope });
  const source = (version, observedAt, excerpt) => ({ ...claude(version, observedAt, excerpt),
    publishedAt: observedAt, sourceKey: "anthropics/claude-code" });
  observation.acceptReleaseObservations([source("2.1.0", T0, "Older notes.")]);
  at = Date.parse(T1);
  observation.acceptReleaseObservations([source("2.1.5", T1, "Added the review command. Fixed a crash.")]);
  const snapshot = observation.readSnapshot();
  const [row] = snapshot.occurrences;
  assert.deepEqual(row.data, { product: "claude_code", version: "2.1.5", channel: "latest", excerpt: "Added the review command. Fixed a crash." });
  const native = normalizeNativeNotificationSnapshot(snapshot);
  assert.equal(native.occurrences[0].data.excerpt, row.data.excerpt);
  assert.deepEqual(nativeNotificationPayload(native.occurrences[0]), { title: "Claude Code 2.1.5 published", body: row.data.excerpt });
  assert.equal(releaseNotificationPayload(row).link, "https://github.com/anthropics/claude-code/releases/tag/v2.1.5");
  const ledger = createNotificationLedger({ now: () => at });
  ledger.acceptFacts({ releases: { revision: 1, sourceScope: scope, observations: [claude("2.1.0", T0, "Older notes.")] } });
  ledger.acceptFacts({ releases: { revision: 2, sourceScope: scope, observations: [claude("2.1.5", T1, "Notes.")] } });
  const saved = { version: 1, profileScope: scope, ...ledger.exportState() };
  assert.equal(saved.releaseState.claude_code.excerpt, "Notes.");
  assert.ok(normalizeNotificationPersistence(saved, scope, at));
  assert.doesNotMatch(JSON.stringify(saved), /github\.com|https?:/);
});
test("a baseline without an excerpt still reads and unsafe or misplaced excerpts never persist", () => {
  const ledger = createNotificationLedger({ now: () => Date.parse(T1) });
  ledger.acceptFacts({ releases: { revision: 1, sourceScope: scope, observations: [claude("2.1.0", T0)] } });
  const saved = { version: 1, profileScope: scope, ...ledger.exportState() };
  assert.deepEqual(Object.keys(saved.releaseState.claude_code).sort(), ["channel", "observedAt", "version"]);
  assert.ok(normalizeNotificationPersistence(saved, scope, Date.parse(T1)));
  for (const excerpt of ["See https://example.test", "<b>bold</b>", "x".repeat(281), "line\nbreak", ""]) {
    const copy = structuredClone(saved);
    copy.releaseState.claude_code.excerpt = excerpt;
    assert.equal(normalizeNotificationPersistence(copy, scope, Date.parse(T1)), null, excerpt);
  }
  const codex = structuredClone(saved);
  codex.releaseState.codex_cli = { version: "1.0.0", channel: "latest", observedAt: T0, excerpt: "Notes." };
  assert.equal(normalizeNotificationPersistence(codex, scope, Date.parse(T1)), null);
  const reduced = reduceReleaseNotifications({ observations: [{ ...cli("1.0.0", T0), excerpt: "Codex notes." }] }, null, Date.parse(T0));
  assert.equal(Object.hasOwn(reduced.state.codex_cli, "excerpt"), false);
  const unsafe = reduceReleaseNotifications({ observations: [claude("2.1.1", T1, "Visit www.example.test")] },
    reduceReleaseNotifications({ observations: [claude("2.1.0", T0)] }, null, Date.parse(T0)).state, Date.parse(T1));
  assert.deepEqual(unsafe.items[0].data, { product: "claude_code", version: "2.1.1", channel: "latest" });
});
test("a Codex CLI release yields the derived link only and keeps the fixed wording", () => {
  const baseline = reduceReleaseNotifications({ observations: [cli("1.0.0", T0)] }, null, Date.parse(T0));
  const [item] = reduceReleaseNotifications({ observations: [cli("1.1.0", T1)] }, baseline.state, Date.parse(T1)).items;
  const record = { kind: item.kind, provider: item.provider, data: item.data };
  assert.deepEqual(releaseNotificationPayload(record), { title: "Codex CLI 1.1.0 published",
    link: "https://github.com/openai/codex/releases/tag/rust-v1.1.0",
    body: "This is a Codex CLI release; desktop and IDE updates are separate." });
  assert.equal(nativeNotificationPayload({ ...record, lifecycle: "resolved" }).body, "This is a Codex CLI release; desktop and IDE updates are separate.");
  assert.equal(releaseNotificationPayload({ kind: "release_published", provider: null,
    data: { product: "pomegr_plugin", version: "0.8.0", channel: "main" } }).link, null);
});
test("a native toast fits a long excerpt within the OS body limit", () => {
  const excerpt = `${"word ".repeat(55).trim()}.`;
  const payload = nativeNotificationPayload({ kind: "release_published", provider: "claude", lifecycle: "resolved",
    data: { product: "claude_code", version: "2.1.5", channel: "latest", excerpt } });
  assert.ok(payload.body.length <= 200);
  assert.ok(payload.body.endsWith(String.fromCodePoint(0x2026)));
});
