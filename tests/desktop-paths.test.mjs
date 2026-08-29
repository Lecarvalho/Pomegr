import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MONITOR_PRIVATE_ENVIRONMENT_NAMES,
  monitorPrivateEnvironment,
} from "../desktop/environment-policy.mjs";
import { desktopUserDataOverride, resolveDesktopPaths } from "../desktop/paths.mjs";
import { createReportSaveHandler, normalizeReportSaveRequest } from "../desktop/report-save.mjs";
import { createDesktopSettingsStore, DESKTOP_SETTINGS_VERSION, normalizeDesktopSettings, settingsForWindowClose } from "../desktop/settings.mjs";
import { createClaudeProvider } from "../monitor/providers/claude.mjs";
import { createCodexProvider, resolveCodexHome } from "../monitor/providers/codex.mjs";
import { resolveCodexLivenessRoot } from "../monitor/providers/codex-liveness.mjs";
import { resolvePomegrDataRoot } from "../shared/pomegr-paths.mjs";

test("installed and portable desktop paths ignore cwd and preserve spaces and non-ASCII", () => {
  const previous = process.cwd();
  process.chdir(path.parse(previous).root);
  try {
    const installed = resolveDesktopPaths({
      appPath: "C:\\Program Files\\Pomegr\\resources\\app.asar",
      resourcesPath: "C:\\Program Files\\Pomegr\\resources",
      userDataPath: "C:\\Users\\José Silva\\AppData\\Roaming\\pomegr",
      environment: {},
    });
    assert.equal(installed.mode, "installed");
    assert.equal(installed.unpackedRoot, "C:\\Program Files\\Pomegr\\resources\\app.asar.unpacked");
    assert.equal(installed.settingsFile, "C:\\Users\\José Silva\\AppData\\Roaming\\pomegr\\settings.json");
    assert.equal(installed.costSnapshotsRoot, path.join(installed.dataRoot, "cost-snapshots"));

    const portable = resolveDesktopPaths({
      appPath: "D:\\Apps Portáteis\\Pomegr\\resources\\app.asar",
      resourcesPath: "D:\\Apps Portáteis\\Pomegr\\resources",
      userDataPath: "C:\\ignored",
      environment: { PORTABLE_EXECUTABLE_DIR: "D:\\Apps Portáteis\\Pomegr" },
    });
    assert.equal(portable.mode, "portable");
    assert.equal(portable.dataRoot, "D:\\Apps Portáteis\\Pomegr\\PomegrData");
    assert.equal(desktopUserDataOverride({ PORTABLE_EXECUTABLE_DIR: "D:\\Apps Portáteis\\Pomegr" }), portable.dataRoot);
    assert.doesNotMatch(JSON.stringify(portable), /ignored/);
  } finally {
    process.chdir(previous);
  }
});

test("Pomegr-owned roots use stable Windows app data and explicit overrides", () => {
  const environment = { APPDATA: "C:\\Users\\José\\AppData\\Roaming" };
  assert.equal(resolvePomegrDataRoot({ environment, platform: "win32", homeDir: "C:\\Users\\José" }), "C:\\Users\\José\\AppData\\Roaming\\pomegr");
  assert.equal(resolvePomegrDataRoot({ environment: { ...environment, POMEGR_DATA_DIR: "D:\\Pomegr Data" }, platform: "win32" }), "D:\\Pomegr Data");
  assert.equal(resolveCodexLivenessRoot({ env: environment, platform: "win32", homeDir: "C:\\Users\\José" }), "C:\\Users\\José\\AppData\\Roaming\\pomegr\\codex-liveness");
});

test("provider defaults and overrides remain provider-owned", () => {
  const homeDir = "C:\\Users\\José";
  const claudeDefault = createClaudeProvider({ homeDir, env: {}, usageRequest: async () => ({}) });
  assert.deepEqual(claudeDefault.watchTargets, [path.join(homeDir, ".claude", "projects")]);
  const claudeOverride = createClaudeProvider({ homeDir, env: { CLAUDE_PROJECTS_DIR: "D:\\Claude Sessions", CLAUDE_SESSION_FILE: "D:\\Claude Sessions\\one.jsonl" }, usageRequest: async () => ({}) });
  assert.equal(claudeOverride.watchTargets[0], "D:\\Claude Sessions");
  assert.equal(resolveCodexHome({ homeDir, env: {} }), path.join(homeDir, ".codex"));
  assert.equal(resolveCodexHome({ homeDir, env: { CODEX_HOME: "D:\\Codex Records" } }), "D:\\Codex Records");
  const codex = createCodexProvider({ codexHome: "D:\\Codex Records", homeDir, env: {}, includeArchived: true });
  assert.equal(codex.watchTargets[0], "D:\\Codex Records\\sessions");
  assert.equal(codex.watchTargets[1], "D:\\Codex Records\\archived_sessions");
});

test("monitor environment keeps only allowlisted provider configuration and defaults Pomegr-owned state", () => {
  const source = {
    APPDATA: "private-app-data",
    CLAUDE_PROJECTS_DIR: "D:\\provider-owned\\claude",
    CODEX_HOME: "D:\\provider-owned\\codex",
    POMEGR_CODEX_EXECUTABLE: "D:\\Codex CLI\\codex.exe",
    POMEGR_COST_SNAPSHOTS_DIR: "D:\\explicit-cost",
    CODEX_AUTH_TOKEN: "MUST_NOT_PROPAGATE",
  };
  const snapshot = monitorPrivateEnvironment(source, { pomegrDataRoot: "D:\\PomegrData" });
  assert.equal(snapshot.CLAUDE_PROJECTS_DIR, source.CLAUDE_PROJECTS_DIR);
  assert.equal(snapshot.CODEX_HOME, source.CODEX_HOME);
  assert.equal(snapshot.POMEGR_CODEX_EXECUTABLE, source.POMEGR_CODEX_EXECUTABLE);
  assert.equal(MONITOR_PRIVATE_ENVIRONMENT_NAMES.includes("POMEGR_CODEX_EXECUTABLE"), true);
  assert.equal(snapshot.POMEGR_COST_SNAPSHOTS_DIR, source.POMEGR_COST_SNAPSHOTS_DIR);
  assert.equal(snapshot.POMEGR_DATA_DIR, "D:\\PomegrData");
  assert.equal(Object.hasOwn(snapshot, "CODEX_AUTH_TOKEN"), false);
});

test("desktop settings persist only the bounded allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-settings-é-"));
  const file = path.join(root, "Data With Spaces", "settings.json");
  try {
    const normalized = normalizeDesktopSettings({ version: 99, window: { width: 1400, height: 900, x: -20, y: 45, maximized: true, transcriptPath: "PRIVATE" }, launchAtLogin: true, notifications: false, updates: false, displayPreferences: { contextHistory: false, estimatedCost: true, arbitraryPanel: false, sessionId: "PRIVATE" }, oauthToken: "SECRET", providerPath: "PRIVATE", prompt: "PRIVATE", response: "PRIVATE", command: "PRIVATE" });
    assert.deepEqual(Object.keys(normalized), ["version", "window", "launchAtLogin", "closeBehavior", "notifications", "updates", "displayPreferences"]);
    assert.deepEqual(normalized.displayPreferences, { contextHistory: false, estimatedCost: true });
    const store = createDesktopSettingsStore(file);
    assert.deepEqual(await store.load(), { settings: normalizeDesktopSettings(), status: "missing", canPersist: true });
    await store.save(normalized);
    const serialized = await readFile(file, "utf8");
    assert.doesNotMatch(serialized, /SECRET|PRIVATE|oauth|provider|prompt|response|command|transcript/i);
    assert.deepEqual(await store.load(), { settings: normalized, status: "loaded", canPersist: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed settings are preserved until explicit quarantined recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-settings-invalid-"));
  const file = path.join(root, "settings.json");
  try {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "{malformed PRIVATE ORIGINAL", "utf8"));
    const store = createDesktopSettingsStore(file);
    const loaded = await store.load();
    assert.equal(loaded.status, "invalid");
    assert.equal(loaded.canPersist, false);
    await assert.rejects(store.save(loaded.settings), /DESKTOP_SETTINGS_RECOVERY_REQUIRED/);
    assert.equal(await readFile(file, "utf8"), "{malformed PRIVATE ORIGINAL");
    const recovered = await store.recover({ ...loaded.settings, notifications: false });
    assert.match(path.basename(recovered.quarantineFile), /^settings\.json\.invalid-\d+-[a-f0-9]{8}$/);
    assert.equal(await readFile(recovered.quarantineFile, "utf8"), "{malformed PRIVATE ORIGINAL");
    assert.equal((await store.load()).settings.notifications, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed settings schemas and unsafe shell fallbacks are not persisted", async () => {
  let writes = 0;
  const malformedSchema = JSON.stringify({ ...normalizeDesktopSettings(), notifications: "yes" });
  const store = createDesktopSettingsStore("C:\\Pomegr\\settings.json", {
    async readFile() { return malformedSchema; },
    async writeFile() { writes += 1; },
  });
  const loaded = await store.load();
  assert.equal(loaded.status, "invalid");
  assert.equal(settingsForWindowClose(loaded, loaded.settings, { width: 1400, height: 900, x: 1, y: 2 }, true), null);
  assert.equal(writes, 0);
});

test("transient settings read failures cannot be overwritten", async () => {
  for (const code of ["EACCES", "EIO"]) {
    let writes = 0;
    const error = Object.assign(new Error(code), { code });
    const store = createDesktopSettingsStore("C:\\Pomegr\\settings.json", {
      async readFile() { throw error; },
      async writeFile() { writes += 1; },
    });
    const loaded = await store.load();
    assert.deepEqual({ status: loaded.status, canPersist: loaded.canPersist }, { status: "unavailable", canPersist: false });
    await assert.rejects(store.save(loaded.settings), /DESKTOP_SETTINGS_RECOVERY_REQUIRED/);
    assert.equal(writes, 0);
    await assert.rejects(store.recover(loaded.settings), /DESKTOP_SETTINGS_RECOVERY_NOT_ALLOWED/);
  }
});

test("unknown newer settings versions remain untouched", async () => {
  const newer = JSON.stringify({ ...normalizeDesktopSettings(), version: DESKTOP_SETTINGS_VERSION + 1 });
  let writes = 0;
  const store = createDesktopSettingsStore("C:\\Pomegr\\settings.json", {
    async readFile() { return newer; },
    async writeFile() { writes += 1; },
  });
  const loaded = await store.load();
  assert.deepEqual({ status: loaded.status, canPersist: loaded.canPersist }, { status: "future-version", canPersist: false });
  await assert.rejects(store.save(loaded.settings), /DESKTOP_SETTINGS_RECOVERY_REQUIRED/);
  assert.equal(writes, 0);
});

test("version-one settings migrate in memory without unsafe fields or destructive overwrite", async () => {
  const versionOne = {
    version: 1,
    window: { width: 1280, height: 800, x: 4, y: 8, maximized: false },
    launchAtLogin: true,
    notifications: false,
    updates: true,
  };
  let writes = 0;
  const store = createDesktopSettingsStore("C:\\Pomegr\\settings.json", {
    async readFile() { return JSON.stringify(versionOne); },
    async writeFile() { writes += 1; },
  });
  const loaded = await store.load();
  assert.equal(loaded.status, "migrated");
  assert.equal(loaded.canPersist, true);
  assert.equal(loaded.settings.version, DESKTOP_SETTINGS_VERSION);
  assert.equal(loaded.settings.closeBehavior, "ask");
  assert.deepEqual(loaded.settings.displayPreferences, { contextHistory: true, estimatedCost: true });
  assert.equal(writes, 0, "migration waits for an ordinary explicit settings save");
});

test("version-two settings migrate with visible display defaults", async () => {
  const versionTwo = {
    version: 2,
    window: { width: 1280, height: 800, x: null, y: null, maximized: false },
    launchAtLogin: false,
    closeBehavior: "tray",
    notifications: true,
    updates: true,
  };
  let writes = 0;
  const store = createDesktopSettingsStore("C:\\Pomegr\\settings.json", {
    async readFile() { return JSON.stringify(versionTwo); },
    async writeFile() { writes += 1; },
  });
  const loaded = await store.load();
  assert.equal(loaded.status, "migrated");
  assert.equal(loaded.canPersist, true);
  assert.equal(loaded.settings.version, DESKTOP_SETTINGS_VERSION);
  assert.equal(loaded.settings.closeBehavior, "tray");
  assert.deepEqual(loaded.settings.displayPreferences, { contextHistory: true, estimatedCost: true });
  assert.equal(writes, 0);
});

test("desktop report save is explicit, bounded, and rejects untrusted IPC", async () => {
  const content = "# Pomegr Session Report\n\nSafe normalized report.\n";
  const request = { filename: "pomegr-safe-session-2026-08-11.md", content };
  assert.deepEqual(normalizeReportSaveRequest(request), request);
  assert.equal(normalizeReportSaveRequest({ ...request, filename: "..\\private.md" }), null);
  assert.equal(normalizeReportSaveRequest({ ...request, credential: "SECRET" }), null);
  const writes = [];
  let dialogs = 0;
  const handler = createReportSaveHandler({
    defaultDirectory: "C:\\Users\\José\\Documents",
    isTrustedEvent: (event) => event?.trusted === true,
    async showSaveDialog(options) { dialogs += 1; assert.equal(options.defaultPath, "C:\\Users\\José\\Documents\\pomegr-safe-session-2026-08-11.md"); return { canceled: false, filePath: "D:\\Reports\\chosen.md" }; },
    async writeFile(...args) { writes.push(args); },
  });
  assert.deepEqual(await handler({ trusted: false }, request), { status: "rejected" });
  assert.equal(dialogs, 0);
  assert.deepEqual(await handler({ trusted: true }, request), { status: "saved" });
  assert.equal(dialogs, 1);
  assert.deepEqual(writes[0].slice(0, 2), ["D:\\Reports\\chosen.md", content]);
});

test("packaged monitor restores private environment before creating its provider registry", async () => {
  const source = await readFile(new URL("../desktop/monitor-host.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf("installMonitorPrivateEnvironment()") < source.indexOf("createDefaultProviderRegistry()"));
});
