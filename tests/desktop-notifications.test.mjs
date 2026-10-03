import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNativeNotificationController, createNotificationPoller, isAllowedNotificationTarget,
  loadCommittedNotificationSnapshot, nativeNotificationPayload, normalizeNativeNotificationSnapshot, notificationTarget,
} from "../desktop/runtime/notifications.mjs";
import { createNotificationDeliveryStore, notificationDeliveryProfile } from "../desktop/runtime/notification-delivery-store.mjs";

const START = Date.parse("2026-10-03T12:00:00.000Z");
const id = (number) => number.toString(16).padStart(32, "0");
const scope = (text) => createHash("sha256").update(text).digest("hex");
const occurrence = (number, options = {}) => ({
  id: id(number), kind: "needs_input", category: "attention", severity: "warning", lifecycle: "active",
  priority: 100, occurredAt: new Date(START).toISOString(), timeBasis: "recorded",
  deliveryEligible: true, action: "open_session", provider: "codex",
  data: { sessionId: `codex:session-${number}`, sessionTitle: `Session ${number}` },
  ...options,
});
const snapshot = (records, revision = 1) => ({
  version: 1, revision, generatedAt: new Date(START).toISOString(),
  readiness: { catalog: "ready", providerStatus: "ready" }, occurrences: records, activeSessionOverflow: 0,
});

async function fixture(context, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-native-notifications-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "notification-delivery-v1.json");
  const profileScope = scope("profile-a");
  const store = (extra = {}) => createNotificationDeliveryStore({
    file, profileScope, now: () => options.clock?.() ?? START, ...extra,
  });
  return { file, profileScope, store };
}

function controller(store, options = {}) {
  const shown = [];
  const opened = [];
  const instance = createNativeNotificationController({
    store, now: options.clock || (() => START),
    getPreferences: options.preferences || (() => ({ enabled: true })),
    present: options.present,
    notify(payload, onClick) {
      shown.push({ payload, onClick });
      return options.notifyResult === undefined ? true : options.notifyResult;
    },
    openTarget(target) { opened.push(target); },
  });
  return { instance, shown, opened };
}

test("first valid observation consumes retained conditions; new recurrence claims before dispatch and survives restart", async (context) => {
  const { file, store } = await fixture(context);
  const first = controller(store());
  assert.equal(await first.instance.start(), "missing");
  assert.equal(await first.instance.observe(snapshot([occurrence(1)])), 0);
  assert.equal(first.shown.length, 0);
  const storedBaseline = await fs.readFile(file, "utf8");
  assert.equal(JSON.parse(storedBaseline).claims[0].id, id(1));
  assert.doesNotMatch(storedBaseline, /Session 1|codex:session|profile-a/u);

  assert.equal(await first.instance.observe(snapshot([occurrence(1), occurrence(2)], 2)), 1);
  assert.equal(first.shown.length, 1);
  first.shown[0].onClick();
  assert.deepEqual(first.opened, ["/sessions/codex-session-2"]);
  assert.equal(await first.instance.observe(snapshot([occurrence(1), occurrence(2)], 2)), 0);

  const restarted = controller(store());
  assert.equal(await restarted.instance.start(), "restored");
  assert.equal(await restarted.instance.observe(snapshot([occurrence(1), occurrence(2)], 1)), 0);
  assert.equal(restarted.shown.length, 0, "a retained occurrence is never replayed by a second owner or restart");
  assert.equal(await restarted.instance.observe(snapshot([occurrence(3)], 2)), 1);
  assert.equal(restarted.shown.length, 1);
});

test("quiet, disabled, category-disabled and stale observations consume transitions without backlog", async (context) => {
  let clock = START;
  const { store } = await fixture(context, { clock: () => clock });
  let mode = { enabled: false };
  const native = controller(store(), { clock: () => clock, preferences: () => mode });
  await native.instance.start();
  await native.instance.observe(snapshot([occurrence(1)]));
  assert.equal(await native.instance.observe(snapshot([occurrence(1), occurrence(2)], 2)), 0);
  mode = { enabled: true, quietUntil: new Date(START + 60_000).toISOString() };
  assert.equal(await native.instance.observe(snapshot([occurrence(3)], 3)), 0);
  mode = { enabled: true, categories: { attention: false } };
  assert.equal(await native.instance.observe(snapshot([occurrence(4)], 4)), 0);
  mode = { enabled: true };
  clock += 16 * 60_000;
  assert.equal(await native.instance.observe(snapshot([occurrence(5)], 5)), 0);
  assert.equal(await native.instance.observe(snapshot([occurrence(2), occurrence(3), occurrence(4), occurrence(5)], 6)), 0);
  assert.equal(native.shown.length, 0);
  assert.equal(await native.instance.observe(snapshot([occurrence(6, { occurredAt: new Date(clock).toISOString() })], 7)), 1);
});

test("priority, coalescing and three-per-minute budget apply after durable batch claims", async (context) => {
  const { file, store } = await fixture(context);
  const native = controller(store(), {
    preferences: () => ({ enabled: true, categories: { provider_news: true, model_news: true } }),
    present: (row) => ({ title: "Pomegr", body: `Update ${row.id}` }),
  });
  await native.instance.start();
  await native.instance.observe(snapshot([occurrence(1)]));
  const news = (number, category, priority) => occurrence(number, { kind: "release", category, priority, action: "open_workspace", data: {} });
  const batch = [news(2, "provider_news", 50), news(3, "provider_news", 55),
    news(4, "model_news", 40), occurrence(5, { priority: 99 }), occurrence(6, { priority: 80 })];
  assert.equal(await native.instance.observe(snapshot(batch, 2)), 3);
  assert.deepEqual(native.shown.map((item) => item.payload.body), [
    `Update ${id(5)}`, `Update ${id(6)}`, `Update ${id(3)}`,
  ]);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).claims.length, 6, "all coalesced and budgeted IDs were claimed");
  assert.equal(await native.instance.observe(snapshot([occurrence(7)], 3)), 0);
});

test("news coalesces across polls and OS rejection consumes the occurrence", async (context) => {
  let clock = START;
  const { store } = await fixture(context, { clock: () => clock });
  let supported = true;
  const shown = [];
  const native = createNativeNotificationController({
    store: store(), now: () => clock,
    getPreferences: () => ({ enabled: true, categories: { provider_news: true } }),
    present: () => ({ title: "Pomegr", body: "Provider release published." }),
    notify(payload) { if (!supported) return false; shown.push(payload); return true; },
    openTarget() {},
  });
  const news = (number) => occurrence(number, { kind: "release", category: "provider_news", priority: 50, data: {}, action: "open_workspace",
    occurredAt: new Date(clock).toISOString() });
  await native.start();
  await native.observe(snapshot([occurrence(1)]));
  assert.equal(await native.observe(snapshot([news(2)], 2)), 1);
  assert.equal(await native.observe(snapshot([news(3)], 3)), 0);
  clock += 61_000;
  supported = false;
  assert.equal(await native.observe(snapshot([news(4)], 4)), 0);
  supported = true;
  assert.equal(await native.observe(snapshot([news(4)], 5)), 0);
  assert.equal(await native.observe(snapshot([news(5)], 6)), 1);
  assert.equal(shown.length, 2);
});

test("write failure cannot dispatch and recovery consumes the failed transition", async (context) => {
  const { file, profileScope } = await fixture(context);
  let fail = false;
  const filesystem = { ...fs, async rename(from, to) { if (fail) throw new Error("synthetic failure"); return fs.rename(from, to); } };
  const store = createNotificationDeliveryStore({ file, profileScope, now: () => START, filesystem });
  const native = controller(store);
  await native.instance.start();
  await native.instance.observe(snapshot([occurrence(1)]));
  const before = await fs.readFile(file, "utf8");
  fail = true;
  assert.equal(await native.instance.observe(snapshot([occurrence(2)], 2)), 0);
  assert.equal(native.shown.length, 0);
  assert.equal(await fs.readFile(file, "utf8"), before);
  fail = false;
  assert.equal(await native.instance.observe(snapshot([occurrence(2)], 2)), 0);
  assert.equal(await native.instance.observe(snapshot([occurrence(3)], 3)), 1);
});

test("invalid and newer claim files stay protected and disable native dispatch", async (context) => {
  const { file, store } = await fixture(context);
  for (const content of ["{broken", JSON.stringify({ version: 99, profileScope: scope("profile-a"), initialized: true, claims: [] })]) {
    await fs.writeFile(file, content);
    const native = controller(store());
    assert.equal(await native.instance.start(), "invalid");
    assert.equal(await native.instance.observe(snapshot([occurrence(1)])), 0);
    assert.equal(await fs.readFile(file, "utf8"), content);
  }
});

test("profile switch rebaselines and the file contains only opaque bounded claim metadata", async (context) => {
  const { file, store } = await fixture(context);
  const old = controller(store());
  await old.instance.start();
  await old.instance.observe(snapshot([occurrence(1)]));
  await old.instance.observe(snapshot([occurrence(2)], 2));
  const changedStore = store({ profileScope: scope("profile-b") });
  const changed = controller(changedStore);
  assert.equal(await changed.instance.start(), "profile_changed");
  assert.equal(await changed.instance.observe(snapshot([occurrence(2)], 3)), 0);
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.keys(record).sort(), ["claims", "initialized", "profileScope", "version"]);
  assert.equal(record.profileScope, scope("profile-b"));
  assert.deepEqual(record.claims.map((claim) => claim.id), [id(2)]);
  assert.deepEqual(notificationDeliveryProfile({ claudeConfigDir: "C:/private/claude", claudeProjectsDir: "C:/private/projects", codexHome: "C:/private/codex" }).length, 64);
  assert.doesNotMatch(JSON.stringify(record), /C:\/private|Session|codex:session/u);
});

test("claim ledger retains at most 512 IDs and validates the complete stored record", async (context) => {
  const { file, store } = await fixture(context);
  const ledger = store();
  assert.equal(await ledger.load(), "missing");
  for (let batch = 0; batch < 4; batch++) {
    assert.equal(await ledger.claim(Array.from({ length: 200 }, (_, index) => id(batch * 200 + index + 1))), true);
  }
  const bytes = await fs.readFile(file, "utf8");
  assert.ok(Buffer.byteLength(bytes) < 64 * 1024);
  assert.equal(JSON.parse(bytes).claims.length, 512);
  const broken = JSON.parse(bytes);
  broken.claims[0].sessionTitle = "PRIVATE";
  await fs.writeFile(file, JSON.stringify(broken));
  assert.equal(await store().load(), "invalid");
});

test("native validators reject singleton arrays in opaque identity fields", async (context) => {
  const { file, store } = await fixture(context);
  const ledger = store();
  await ledger.load();
  await ledger.claim([id(1)]);
  const valid = JSON.parse(await fs.readFile(file, "utf8"));
  for (const mutate of [
    (record) => { record.profileScope = [record.profileScope]; },
    (record) => { record.claims[0].id = [record.claims[0].id]; },
  ]) {
    const record = structuredClone(valid);
    mutate(record);
    await fs.writeFile(file, JSON.stringify(record));
    assert.equal(await store().load(), "invalid");
  }
  assert.equal(normalizeNativeNotificationSnapshot(snapshot([occurrence(1, { id: [id(1)] })])), null);
  assert.equal(normalizeNativeNotificationSnapshot(snapshot([occurrence(1, { kind: ["needs_input"] })])), null);
  assert.equal(normalizeNativeNotificationSnapshot(snapshot([occurrence(1, { category: ["attention"] })])), null);
  assert.equal(normalizeNativeNotificationSnapshot(snapshot([occurrence(1, { data: { sessionId: ["codex:session-1"], sessionTitle: "Safe" } })])), null);
});

test("native copy and targets are fixed, bounded and reject arbitrary URLs", () => {
  assert.equal(normalizeNativeNotificationSnapshot(snapshot([occurrence(1, { data: { sessionId: "codex:session-1", sessionTitle: "Safe", prompt: "PRIVATE" }, url: "https://evil.example" })])).occurrences[0].data.prompt, undefined);
  assert.deepEqual(nativeNotificationPayload(occurrence(1)), {
    title: "Session 1", body: "Needs input. This live session is waiting for your action.",
  });
  assert.equal(notificationTarget(occurrence(1, { data: { sessionId: "codex:../private", sessionTitle: "Unsafe" } })), "/sessions");
  assert.equal(notificationTarget(occurrence(1, { action: "open_providers", url: "https://evil.example" })), "/usage-limits");
  assert.equal(notificationTarget(occurrence(1, { action: "open_workspace" })), "/");
  for (const target of ["/", "/sessions", "/sessions/codex-session-1", "/usage-limits"]) assert.equal(isAllowedNotificationTarget(target), true);
  for (const target of ["//evil.example", "https://evil.example", "/settings", "/sessions/../private", "/sessions/codex-a?x=1", "/sessions/claude-a/"]) assert.equal(isAllowedNotificationTarget(target), false);
});

test("one poller starts once, consumes committed snapshots and stops an in-flight request", async (context) => {
  const { store } = await fixture(context);
  const native = controller(store());
  const scheduled = [];
  let loads = 0;
  const poller = createNotificationPoller({
    controller: native.instance,
    loadSnapshot: async () => { loads++; return snapshot([occurrence(1)]); },
    schedule: (task) => { scheduled.push(task); return task; }, cancel: () => {},
  });
  await Promise.all([poller.start(), poller.start()]);
  for (let attempt = 0; attempt < 20 && !scheduled.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(loads, 1);
  await poller.refresh();
  assert.equal(loads, 2);
  poller.stop();
  assert.equal(await poller.refresh(), false);
});

test("native reader requests only the bounded committed notification GET with local authorization", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const value = snapshot([occurrence(1)]);
  const read = (response) => loadCommittedNotificationSnapshot({
    origin: "http://127.0.0.1:4317", authorizationToken: "local-token", signal,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response; },
  });
  assert.deepEqual(await read(new Response(JSON.stringify(value))), value);
  assert.equal(calls[0].url, "http://127.0.0.1:4317/api/notifications");
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error", "local authorization must not follow a redirect");
  assert.equal(Object.values(calls[0].options.headers)[0], "local-token");
  assert.equal(await read(new Response("unavailable", { status: 503 })), null);
  assert.equal(await read(new Response(null, { status: 302, headers: { location: "https://external.example/" } })), null);
  assert.equal(await read(new Response("x".repeat(1024 * 1024 + 1))), null);
  assert.equal(await loadCommittedNotificationSnapshot({ origin: "https://evil.example", authorizationToken: "local-token", signal,
    fetchImpl: () => assert.fail("unsafe origin must not fetch") }), null);
});
