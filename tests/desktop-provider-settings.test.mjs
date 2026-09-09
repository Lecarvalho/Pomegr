import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderSettingsController, installProviderSettingsIpc, normalizeProviderFolders, providerSettingsEnvironment, PROVIDER_SETTINGS_CHANNELS, resolveProviderFolders, restartProviderSettingsApp } from "../desktop/provider-settings.mjs";
import { createDesktopSettingsStore, normalizeDesktopSettings } from "../desktop/settings.mjs";
import { createDesktopBehaviorController } from "../desktop/desktop-behavior.mjs";
import { minimalRuntimeEnvironment, monitorPrivateEnvironment, nativeClaudeEnvironment, nativeCodexEnvironment } from "../desktop/environment-policy.mjs";

const homeDir = path.resolve("synthetic-provider-home");
const profile = path.join(homeDir, "private-profile");
const dataRoot = path.join(homeDir, "pomegr-data");
const defaults = normalizeProviderFolders();

function harness(overrides = {}) {
  const writes = [], confirmations = [];
  let restarts = 0;
  const controller = createProviderSettingsController({ folders: defaults, environment: {}, homeDir, canPersist: true,
    chooseDirectory: async () => ({ canceled: false, filePaths: [profile] }),
    canonicalDirectory: async (value) => value,
    directoryAvailable: async () => true,
    confirm: async (options) => { confirmations.push(options); return true; },
    persist: async (value) => { writes.push(value); }, restart: async () => { restarts++; }, ...overrides });
  return { controller, writes, confirmations, restarts: () => restarts };
}

test("folder settings migrate v4 without discarding phone preferences and reject malformed paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-provider-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "settings.json");
  await writeFile(file, JSON.stringify({ ...normalizeDesktopSettings(), version: 4, providerFolders: { claudeConfigDir: profile }, lanSharingAutoStart: true }));
  const store = createDesktopSettingsStore(file);
  const loaded = await store.load();
  assert.equal(loaded.status, "migrated");
  assert.equal(loaded.settings.lanSharingAutoStart, true);
  assert.deepEqual(loaded.settings.providerFolders, defaults);
  await store.save({ ...loaded.settings, providerFolders: { ...defaults, claudeConfigDir: profile, secret: "PRIVATE_SECRET" } });
  const persisted = await readFile(file, "utf8");
  assert.equal(JSON.parse(persisted).providerFolders.claudeConfigDir, profile);
  assert.doesNotMatch(persisted, /PRIVATE_SECRET/);
  for (const invalid of ["relative/folder", "https://invalid.test", "C:\nprivate", 42]) {
    const contents = JSON.stringify({ ...normalizeDesktopSettings(), providerFolders: { ...defaults, codexHome: invalid } });
    await writeFile(file, contents);
    const bad = await createDesktopSettingsStore(file).load();
    assert.equal(bad.canPersist, false);
    assert.equal(await readFile(file, "utf8"), contents);
  }
});

test("effective profile roots align native and monitor readers without entering runtime environment", () => {
  const inherited = { claude_config_dir: path.join(homeDir, "inherited"), CODEX_HOME: path.join(homeDir, "codex-inherited"), CLAUDE_SESSION_FILE: "private-pin.jsonl" };
  const folders = { ...defaults, claudeConfigDir: profile };
  const env = providerSettingsEnvironment(inherited, folders, { homeDir, dataRoot });
  assert.equal(env.claude_config_dir, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, profile);
  assert.equal(env.CLAUDE_PROJECTS_DIR, path.join(profile, "projects"));
  assert.equal(env.CLAUDE_SESSION_FILE, undefined);
  assert.equal(env.CODEX_HOME, inherited.CODEX_HOME);
  for (const variable of ["POMEGR_USAGE_SNAPSHOTS_DIR", "POMEGR_COST_SNAPSHOTS_DIR"]) {
    assert.match(env[variable], /profiles/);
    assert.notEqual(env[variable], providerSettingsEnvironment({}, { ...defaults, claudeConfigDir: profile + "-other" }, { homeDir, dataRoot })[variable]);
  }
  assert.equal(monitorPrivateEnvironment(env).CLAUDE_CONFIG_DIR, profile);
  assert.equal(nativeClaudeEnvironment(env, {}, () => false).CLAUDE_CONFIG_DIR, profile);
  assert.equal(nativeCodexEnvironment(env, {}, () => false).CODEX_HOME, inherited.CODEX_HOME);
  const publicRuntime = JSON.stringify(minimalRuntimeEnvironment(env, {}, () => false));
  assert.doesNotMatch(publicRuntime, /private-profile|CLAUDE_CONFIG_DIR|CODEX_HOME|profiles/);
  const explicit = path.join(homeDir, "explicit-projects");
  assert.equal(resolveProviderFolders(folders, { CLAUDE_PROJECTS_DIR: explicit }, homeDir).claudeProjectsDir, explicit);
  const standard = providerSettingsEnvironment({}, defaults, { homeDir, dataRoot });
  assert.equal(standard.POMEGR_USAGE_SNAPSHOTS_DIR, undefined);
  assert.equal(providerSettingsEnvironment({ POMEGR_USAGE_SNAPSHOTS_DIR: explicit }, folders, { homeDir, dataRoot }).POMEGR_USAGE_SNAPSHOTS_DIR, explicit);
  const desktop = createDesktopBehaviorController({ settings: { ...normalizeDesktopSettings(), providerFolders: folders } });
  assert.doesNotMatch(JSON.stringify(desktop.snapshot()), /private-profile|providerFolders/);
});

test("native selection stages a private path, cancel/discard preserve persisted settings, and confirmation owns commit", async () => {
  const h = harness();
  const initial = await h.controller.snapshot();
  assert.equal(initial.pendingChanges, false);
  const selected = await h.controller.choose("claudeConfigDir");
  assert.equal(selected.state.folders.claudeConfigDir.selection, "custom");
  assert.equal(selected.state.pendingChanges, true);
  assert.doesNotMatch(JSON.stringify(selected), /private-profile|synthetic-provider-home/);
  assert.deepEqual(h.writes, []);
  await h.controller.discard();
  assert.equal((await h.controller.snapshot()).pendingChanges, false);
  await h.controller.choose("claudeConfigDir");
  assert.equal((await h.controller.save()).status, "restarting");
  assert.deepEqual(h.writes, [{ ...defaults, claudeConfigDir: profile }]);
  assert.equal(h.restarts(), 1);
  assert.ok(h.confirmations[0].detail.includes(profile));
  assert.equal((await h.controller.save()).status, "busy");
  const cancelled = harness({ confirm: async () => false });
  await cancelled.controller.choose("codexHome");
  assert.equal((await cancelled.controller.save()).status, "cancelled");
  assert.equal((await cancelled.controller.snapshot()).pendingChanges, true);
  assert.deepEqual(cancelled.writes, []);
  assert.equal(cancelled.restarts(), 0);
  const cancelledPicker = harness({ chooseDirectory: async () => ({ canceled: true, filePaths: [] }) });
  assert.equal((await cancelledPicker.controller.choose("codexHome")).status, "cancelled");
  assert.equal((await cancelledPicker.controller.snapshot()).pendingChanges, false);
});

test("Use default restores inherited selection; disappearing folders, failed writes and shutdown never restart", async () => {
  const h = harness({ folders: { ...defaults, codexHome: profile }, environment: { CODEX_HOME: path.join(homeDir, "inherited") } });
  const reset = await h.controller.reset("codexHome");
  assert.equal(reset.state.folders.codexHome.selection, "environment");
  assert.equal(reset.state.pendingChanges, true);
  let available = true;
  const lost = harness({ directoryAvailable: async () => available, confirm: async () => { available = false; return true; } });
  await lost.controller.choose("codexHome");
  assert.equal((await lost.controller.save()).status, "unavailable");
  assert.equal(lost.writes.length, 0);
  assert.equal(lost.restarts(), 0);
  const missingClaude = path.join(homeDir, "missing-claude");
  const independent = harness({ folders: { ...defaults, claudeConfigDir: missingClaude }, directoryAvailable: async (directory) => directory !== missingClaude });
  await independent.controller.choose("codexHome");
  assert.equal((await independent.controller.save()).status, "restarting");
  assert.equal(independent.writes[0].claudeConfigDir, missingClaude);
  const failed = harness({ persist: async () => { throw new Error("SECRET_PRIVATE_PATH"); } });
  await failed.controller.choose("codexHome");
  const result = await failed.controller.save();
  assert.equal(result.status, "failed");
  assert.equal(result.state.pendingChanges, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_PRIVATE_PATH/);
  assert.equal(failed.restarts(), 0);
  const closing = harness({ persist: async () => closing.controller.dispose() });
  await closing.controller.choose("codexHome");
  assert.equal((await closing.controller.save()).status, "unavailable");
  assert.equal(closing.restarts(), 0);
  let finish;
  const pending = harness({ chooseDirectory: () => new Promise((resolve) => { finish = resolve; }) });
  const operation = pending.controller.choose("codexHome");
  assert.equal((await pending.controller.reset("codexHome")).status, "busy");
  pending.controller.dispose();
  finish({ canceled: false, filePaths: [profile] });
  assert.equal((await operation).status, "unavailable");
  assert.equal(await pending.controller.snapshot(), null);
});

test("actual picker validation accepts readable directories and refuses files and missing folders", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-provider-picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "profile");
  await mkdir(directory);
  const file = path.join(root, "ordinary-file");
  await writeFile(file, "synthetic");
  for (const [selected, expected] of [[directory, "ready"], [file, "unavailable"], [path.join(root, "missing"), "failed"]]) {
    const h = harness({ directoryAvailable: undefined, canonicalDirectory: undefined, chooseDirectory: async () => ({ canceled: false, filePaths: [selected] }) });
    assert.equal((await h.controller.choose("codexHome")).status, expected);
  }
});

test("provider settings IPC rejects untrusted callers, paths and extra arguments before opening a dialog", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  let dialogs = 0;
  const h = harness({ chooseDirectory: async () => { dialogs++; return { canceled: true }; } });
  const trusted = {};
  const dispose = installProviderSettingsIpc({ ipcMain, controller: h.controller, isTrustedEvent: (event) => event === trusted });
  for (const [operation, channel] of Object.entries(PROVIDER_SETTINGS_CHANNELS)) {
    const handler = handlers.get(channel);
    assert.equal(operation === "get" ? await handler({}) : (await handler({})).status, operation === "get" ? null : "unavailable");
    const extra = operation === "choose" || operation === "reset" ? ["codexHome", profile] : [profile];
    const result = await handler(trusted, ...extra);
    assert.equal(operation === "get" ? result : result.status, operation === "get" ? null : "unavailable");
  }
  assert.equal((await handlers.get(PROVIDER_SETTINGS_CHANNELS.choose)(trusted, profile)).status, "unavailable");
  assert.equal(dialogs, 0);
  assert.equal((await handlers.get(PROVIDER_SETTINGS_CHANNELS.choose)(trusted, "codexHome")).status, "cancelled");
  assert.equal(dialogs, 1);
  dispose();
  assert.equal(handlers.size, 0);
});

test("restart stops owned services before releasing the lock and spawns only the native app with private child environment", async () => {
  const calls = [];
  const executable = path.join(homeDir, "Pomegr-Portable.exe");
  const environment = { CLAUDE_CONFIG_DIR: profile };
  const before = process.env.CLAUDE_CONFIG_DIR;
  const application = { isPackaged: true, releaseSingleInstanceLock: () => calls.push("release"), exit: (code) => calls.push(["exit", code]), requestSingleInstanceLock: () => calls.push("reacquire") };
  await restartProviderSettingsApp({ application, executable, environment, stopRuntime: async () => { calls.push("stop"); }, spawnProcess: (file, args, options) => {
    calls.push("spawn"); assert.equal(file, executable); assert.deepEqual(args, []);
    assert.deepEqual(options, { env: environment, detached: true, windowsHide: true, stdio: "ignore" });
    const child = new EventEmitter(); child.unref = () => calls.push("unref"); queueMicrotask(() => child.emit("spawn")); return child;
  } });
  assert.deepEqual(calls, ["stop", "release", "spawn", "unref", ["exit", 0]]);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, before);
  await assert.rejects(restartProviderSettingsApp({ application, executable, environment, stopRuntime: async () => {}, spawnProcess: () => { throw new Error("PRIVATE_EXECUTABLE"); } }), (error) => error.message === "DESKTOP_RESTART_FAILED");
  assert.equal(calls.at(-1), "reacquire");
});
