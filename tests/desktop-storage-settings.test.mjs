import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createStorageSettingsController,
  effectiveStorageSettings,
  installStorageSettingsIpc,
  storageSettingsEnvironment,
  STORAGE_SETTINGS_CHANNELS,
  validStorageSetting,
} from "../desktop/storage-settings.mjs";
import { createDesktopSettingsStore, normalizeDesktopSettings } from "../desktop/settings.mjs";

function harness(overrides = {}) {
  const writes = [];
  const confirmations = [];
  let restarts = 0;
  const controller = createStorageSettingsController({
    storage: { retentionDays: null, storeMaxMb: null },
    environment: {},
    canPersist: true,
    confirm: async (options) => { confirmations.push(options); return true; },
    persist: async (value) => { writes.push(value); },
    restart: async () => { restarts++; },
    ...overrides,
  });
  return { controller, writes, confirmations, restarts: () => restarts };
}

test("enum validation rejects strings, floats, unknown keys, and out-of-range numbers", () => {
  assert.equal(validStorageSetting("retentionDays", 90), true);
  assert.equal(validStorageSetting("retentionDays", 0), true);
  assert.equal(validStorageSetting("retentionDays", "90"), false);
  assert.equal(validStorageSetting("retentionDays", 90.5), false);
  assert.equal(validStorageSetting("retentionDays", 45), false);
  assert.equal(validStorageSetting("storeMaxMb", 500), true);
  assert.equal(validStorageSetting("storeMaxMb", "500"), false);
  assert.equal(validStorageSetting("storeMaxMb", 500.1), false);
  assert.equal(validStorageSetting("bogusKey", 90), false);
  assert.equal(validStorageSetting("retentionDays", null), false);
});

test("effective values prefer saved, then a valid launch environment, then defaults", () => {
  assert.deepEqual(effectiveStorageSettings({ retentionDays: null, storeMaxMb: null }, {}), { retentionDays: 90, storeMaxMb: 500 });
  assert.deepEqual(
    effectiveStorageSettings({ retentionDays: null, storeMaxMb: null }, { POMEGR_RETENTION_DAYS: "30", POMEGR_STORE_MAX_MB: "1024" }),
    { retentionDays: 30, storeMaxMb: 1024 },
  );
  assert.deepEqual(effectiveStorageSettings({ retentionDays: null, storeMaxMb: null }, { POMEGR_RETENTION_DAYS: "all" }), { retentionDays: 0, storeMaxMb: 500 });
  assert.deepEqual(
    effectiveStorageSettings({ retentionDays: 365, storeMaxMb: null }, { POMEGR_RETENTION_DAYS: "30" }),
    { retentionDays: 365, storeMaxMb: 500 },
  );
  // Malformed or out-of-enum environment values degrade to the default rather than being coerced.
  assert.deepEqual(
    effectiveStorageSettings({ retentionDays: null, storeMaxMb: null }, { POMEGR_RETENTION_DAYS: "45", POMEGR_STORE_MAX_MB: "not-a-number" }),
    { retentionDays: 90, storeMaxMb: 500 },
  );
});

test("storage environment mapping encodes keep-all and leaves untouched fields inherited", () => {
  const inherited = { POMEGR_RETENTION_DAYS: "30", pomegr_store_max_mb: "250" };
  const env = storageSettingsEnvironment(inherited, { retentionDays: 0, storeMaxMb: null });
  assert.equal(env.POMEGR_RETENTION_DAYS, "all");
  assert.equal(env.pomegr_store_max_mb, "250");
  assert.equal(env.POMEGR_STORE_MAX_MB, undefined);
  const both = storageSettingsEnvironment({}, { retentionDays: 90, storeMaxMb: 1024 });
  assert.equal(both.POMEGR_RETENTION_DAYS, "90");
  assert.equal(both.POMEGR_STORE_MAX_MB, "1024");
  assert.deepEqual(storageSettingsEnvironment({ FOO: "bar" }, { retentionDays: null, storeMaxMb: null }), { FOO: "bar" });
});

test("draft updates stage a private value, invalid set is rejected, and discard restores saved values", async () => {
  const h = harness();
  const initial = await h.controller.snapshot();
  assert.equal(initial.pendingChanges, false);
  assert.deepEqual(initial.values, { retentionDays: 90, storeMaxMb: 500 });
  assert.equal((await h.controller.set("retentionDays", 45)).status, "unavailable");
  assert.equal((await h.controller.set("bogusKey", 90)).status, "unavailable");
  assert.equal((await h.controller.set("retentionDays", "90")).status, "unavailable");
  const set = await h.controller.set("retentionDays", 30);
  assert.equal(set.status, "ready");
  assert.equal(set.state.pendingChanges, true);
  assert.equal(set.state.values.retentionDays, 30);
  assert.deepEqual(h.writes, []);
  await h.controller.discard();
  const afterDiscard = await h.controller.snapshot();
  assert.equal(afterDiscard.pendingChanges, false);
  assert.equal(afterDiscard.values.retentionDays, 90);
});

test("confirmation owns commit: save persists both explicit values and restarts, then reports busy", async () => {
  const h = harness();
  await h.controller.set("retentionDays", 30);
  await h.controller.set("storeMaxMb", 1024);
  assert.equal((await h.controller.save()).status, "restarting");
  assert.deepEqual(h.writes, [{ retentionDays: 30, storeMaxMb: 1024 }]);
  assert.equal(h.restarts(), 1);
  assert.equal(h.confirmations[0].title, "Apply storage settings?");
  assert.match(h.confirmations[0].detail, /Retention age: 30 days/);
  assert.match(h.confirmations[0].detail, /Resource history cleanup threshold: 1 GB/);
  assert.deepEqual(h.confirmations[0].buttons, ["Cancel", "Save and restart Pomegr"]);
  assert.equal((await h.controller.save()).status, "busy");
});

test("cancelling the confirmation persists nothing and keeps the pending draft", async () => {
  const cancelled = harness({ confirm: async () => false });
  await cancelled.controller.set("storeMaxMb", 250);
  assert.equal((await cancelled.controller.save()).status, "cancelled");
  assert.equal((await cancelled.controller.snapshot()).pendingChanges, true);
  assert.deepEqual(cancelled.writes, []);
  assert.equal(cancelled.restarts(), 0);
});

test("saving with no pending change reports ready without confirming or restarting", async () => {
  const h = harness();
  assert.equal((await h.controller.save()).status, "ready");
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.restarts(), 0);
});

test("an in-flight save reports busy, a failed restart reports failed, and disposal blocks further saves", async () => {
  let finishConfirm;
  const pending = harness({ confirm: () => new Promise((resolve) => { finishConfirm = resolve; }) });
  await pending.controller.set("retentionDays", 180);
  const operation = pending.controller.save();
  assert.equal((await pending.controller.discard()).status, "busy");
  finishConfirm(true);
  assert.equal((await operation).status, "restarting");

  // A failed restart still committed the persisted values, so the draft matches
  // the newly saved settings and no pending change remains.
  const failedRestart = harness({ restart: async () => { throw new Error("SECRET_RESTART_DETAIL"); } });
  await failedRestart.controller.set("storeMaxMb", 2048);
  const failed = await failedRestart.controller.save();
  assert.equal(failed.status, "failed");
  assert.equal(failed.state.pendingChanges, false);
  assert.deepEqual(failedRestart.writes, [{ retentionDays: null, storeMaxMb: 2048 }]);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_RESTART_DETAIL/);
  assert.equal(failedRestart.restarts(), 0);

  // A failed persist, by contrast, leaves the draft pending because save never committed.
  const failedPersist = harness({ persist: async () => { throw new Error("SECRET_PERSIST_DETAIL"); } });
  await failedPersist.controller.set("retentionDays", 365);
  const persistFailure = await failedPersist.controller.save();
  assert.equal(persistFailure.status, "failed");
  assert.equal(persistFailure.state.pendingChanges, true);
  assert.doesNotMatch(JSON.stringify(persistFailure), /SECRET_PERSIST_DETAIL/);
  assert.equal(failedPersist.restarts(), 0);

  const closing = harness({ persist: async () => closing.controller.dispose() });
  await closing.controller.set("retentionDays", 0);
  assert.equal((await closing.controller.save()).status, "unavailable");
  assert.equal(closing.restarts(), 0);
  assert.equal(await closing.controller.snapshot(), null);
});

test("canPersist false reports unavailable for set, discard, and save", async () => {
  const h = harness({ canPersist: false });
  assert.equal((await h.controller.set("retentionDays", 30)).status, "unavailable");
  assert.equal((await h.controller.discard()).status, "unavailable");
  assert.equal((await h.controller.save()).status, "unavailable");
});

test("storage settings IPC rejects untrusted callers, invalid values, and extra arguments", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  const h = harness();
  const trusted = {};
  const dispose = installStorageSettingsIpc({ ipcMain, controller: h.controller, isTrustedEvent: (event) => event === trusted });
  for (const [operation, channel] of Object.entries(STORAGE_SETTINGS_CHANNELS)) {
    const handler = handlers.get(channel);
    assert.equal(operation === "get" ? await handler({}) : (await handler({})).status, operation === "get" ? null : "unavailable");
    const extra = operation === "set" ? ["retentionDays", 90, "extra"] : ["extra"];
    const result = await handler(trusted, ...extra);
    assert.equal(operation === "get" ? result : result.status, operation === "get" ? null : "unavailable");
  }
  assert.equal((await handlers.get(STORAGE_SETTINGS_CHANNELS.set)(trusted, "retentionDays", 45)).status, "unavailable");
  assert.equal((await handlers.get(STORAGE_SETTINGS_CHANNELS.set)(trusted, "retentionDays", "90")).status, "unavailable");
  const ok = await handlers.get(STORAGE_SETTINGS_CHANNELS.set)(trusted, "retentionDays", 30);
  assert.equal(ok.status, "ready");
  assert.equal(ok.state.values.retentionDays, 30);
  dispose();
  assert.equal(handlers.size, 0);
});

test("desktop settings migrate v5 to v6 with null storage and preserve provider folders", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-storage-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "settings.json");
  const providerFolders = { claudeConfigDir: path.join(root, "claude-profile"), claudeProjectsDir: null, codexHome: null };
  await writeFile(file, JSON.stringify({ ...normalizeDesktopSettings(), version: 5, providerFolders }));
  const store = createDesktopSettingsStore(file);
  const loaded = await store.load();
  assert.equal(loaded.status, "migrated");
  assert.equal(loaded.settings.version, 6);
  assert.deepEqual(loaded.settings.storage, { retentionDays: null, storeMaxMb: null });
  assert.deepEqual(loaded.settings.providerFolders, providerFolders);
});

test("invalid v6 storage settings load as invalid and leave the file untouched", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-storage-settings-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "settings.json");
  const invalidStorageValues = [
    { retentionDays: 45, storeMaxMb: 500 },
    { retentionDays: 90, storeMaxMb: 750 },
    { retentionDays: "90", storeMaxMb: 500 },
    "not-an-object",
  ];
  for (const storage of invalidStorageValues) {
    const contents = JSON.stringify({ ...normalizeDesktopSettings(), storage });
    await writeFile(file, contents);
    const loaded = await createDesktopSettingsStore(file).load();
    assert.equal(loaded.status, "invalid");
    assert.equal(loaded.canPersist, false);
    assert.deepEqual(loaded.settings.storage, { retentionDays: null, storeMaxMb: null });
    assert.equal(await readFile(file, "utf8"), contents);
  }
});
