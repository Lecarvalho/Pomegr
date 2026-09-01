import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAUDE_USAGE_INTEGRATION_CHANNELS,
  createClaudeUsageIntegration,
  installClaudeUsageIntegrationIpc,
  resolveClaudeUsageShells,
} from "../desktop/claude-usage-setup.mjs";
import { buildDesktopServiceBundles } from "../desktop/service-bundles.mjs";

const POWERSHELL_PREFIX = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-usage-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "Claude settings");
  await mkdir(configRoot);
  const integration = createClaudeUsageIntegration({
    configRoot,
    dataRoot: "C:\\Users\\Ana O'Hare\\AppData\\Roaming\\pomegr",
    feedRoot: "C:\\Users\\Ana O'Hare\\AppData\\Roaming\\pomegr\\usage-snapshots",
    appExecutable: "C:\\Program Files\\Pomegr\\Pomegr.exe",
    bridgePath: "C:\\Program Files\\Pomegr\\resources\\app.asar.unpacked\\desktop\\workers\\claude-statusline-bridge.cjs",
    powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    gitBashExecutable: options.gitBashExecutable,
    confirm: options.confirm || (async () => true),
    beforeCommit: options.beforeCommit,
  });
  return { configRoot, settingsFile: path.join(configRoot, "settings.json"), integration };
}

function decodeCommand(command) {
  assert.ok(command.startsWith(POWERSHELL_PREFIX));
  return Buffer.from(command.slice(POWERSHELL_PREFIX.length), "base64").toString("utf16le");
}

test("resolves only fixed PowerShell and Git Bash executables", () => {
  const files = new Set([
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "D:\\Tools\\Git Bash\\bash.exe",
  ]);
  const fileExists = (candidate) => files.has(candidate);
  assert.deepEqual(resolveClaudeUsageShells({
    SystemRoot: "C:\\Windows",
    CLAUDE_CODE_GIT_BASH_PATH: "D:\\Tools\\Git Bash\\bash.exe",
  }, fileExists), {
    powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    gitBashExecutable: "D:\\Tools\\Git Bash\\bash.exe",
  });
  assert.deepEqual(resolveClaudeUsageShells({ SystemRoot: "C:\\Windows" }, fileExists), {
    powershellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    gitBashExecutable: null,
  });
  assert.equal(resolveClaudeUsageShells({ SystemRoot: "D:\\Unknown" }, fileExists), null);
});

test("the native IPC boundary rejects untrusted calls without reading or writing Claude settings", async () => {
  const handlers = new Map();
  const ipcMain = {
    removeHandler(channel) { handlers.delete(channel); },
    handle(channel, handler) { handlers.set(channel, handler); },
  };
  let reads = 0;
  let writes = 0;
  const integration = {
    async getStatus() { reads += 1; return { status: "disabled", private: "never exposed" }; },
    async enable() { writes += 1; return { status: "enabled", private: "never exposed" }; },
  };
  const cleanup = installClaudeUsageIntegrationIpc({
    ipcMain,
    isTrustedEvent: (event) => event?.trusted === true,
    integration,
  });
  assert.deepEqual(await handlers.get(CLAUDE_USAGE_INTEGRATION_CHANNELS.getStatus)({ trusted: false }), { status: "unavailable" });
  assert.deepEqual(await handlers.get(CLAUDE_USAGE_INTEGRATION_CHANNELS.enable)({ trusted: false }), { status: "unavailable" });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(await handlers.get(CLAUDE_USAGE_INTEGRATION_CHANNELS.getStatus)({ trusted: true }), { status: "disabled" });
  assert.deepEqual(await handlers.get(CLAUDE_USAGE_INTEGRATION_CHANNELS.enable)({ trusted: true }), { status: "enabled" });
  cleanup();
  assert.equal(handlers.size, 0);
});

test("enables a new local feed with the packaged Electron runtime and no system Node", async (t) => {
  const { settingsFile, integration } = await fixture(t);
  assert.deepEqual(await integration.getStatus(), { status: "disabled" });
  assert.deepEqual(await integration.enable(), { status: "enabled" });
  assert.deepEqual(await integration.getStatus(), { status: "enabled" });

  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(settings.statusLine.type, "command");
  const script = decodeCommand(settings.statusLine.command);
  assert.match(script, /ELECTRON_RUN_AS_NODE='1'/);
  assert.match(script, /POMEGR_CLAUDE_USAGE_BRIDGE='v1'/);
  assert.match(script, /POMEGR_USAGE_SNAPSHOTS_DIR='C:\\Users\\Ana O''Hare\\AppData\\Roaming\\pomegr\\usage-snapshots'/);
  assert.match(script, /POMEGR_COST_SNAPSHOTS_DIR='C:\\Users\\Ana O''Hare\\AppData\\Roaming\\pomegr\\cost-snapshots'/);
  assert.match(script, /POMEGR_DATA_DIR='C:\\Users\\Ana O''Hare\\AppData\\Roaming\\pomegr'/);
  assert.match(script, /Pomegr\.exe/);
  assert.match(script, /claude-statusline-bridge\.cjs/);
  assert.doesNotMatch(script, /\bnode(?:\.exe)?\b/i);
});

test("preserves a configured status line exactly through fixed PowerShell argv", async (t) => {
  const { settingsFile, integration } = await fixture(t);
  const existing = " Write-Output 'Résumé `\"visible`\"' ; $($env:MODE) ";
  const original = {
    featureFlag: true,
    statusLine: { type: "command", command: existing, padding: 3, extra: { alignment: "right" } },
    unrelated: { retained: true },
  };
  await writeFile(settingsFile, JSON.stringify(original, null, 4), "utf8");
  assert.deepEqual(await integration.enable(), { status: "enabled" });
  const rewritten = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(rewritten.featureFlag, true);
  assert.deepEqual(rewritten.unrelated, original.unrelated);
  assert.equal(rewritten.statusLine.padding, 3);
  assert.deepEqual(rewritten.statusLine.extra, original.statusLine.extra);
  assert.doesNotMatch(rewritten.statusLine.command, /Résumé|visible|MODE/);
  const script = decodeCommand(rewritten.statusLine.command);
  assert.match(script, /StartInfo\.Arguments=.*-- C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe -NoProfile -NonInteractive -Command/);
  assert.match(script, /Résumé/);
  assert.match(script, /\$\(\$env:MODE\)/);
  const first = await readFile(settingsFile, "utf8");
  assert.deepEqual(await integration.enable(), { status: "enabled" });
  assert.equal(await readFile(settingsFile, "utf8"), first, "idempotency never nests the wrapper");
});

test("uses the resolved Git Bash executable for a status line Claude runs in Bash", async (t) => {
  const { settingsFile, integration } = await fixture(t, { gitBashExecutable: "C:\\Program Files\\Git\\bin\\bash.exe" });
  await writeFile(settingsFile, JSON.stringify({ statusLine: { type: "command", command: "printf '%s' \"$(whoami)\" `date` 'Été'" } }), "utf8");
  assert.deepEqual(await integration.enable(), { status: "enabled" });
  const script = decodeCommand(JSON.parse(await readFile(settingsFile, "utf8")).statusLine.command);
  assert.match(script, /StartInfo\.Arguments=.*-- "C:\\Program Files\\Git\\bin\\bash\.exe" -c/);
  assert.match(script, /whoami/);
  assert.match(script, /Été/);
});

test("preserves settings when the wrapped command would exceed the native command bound", async (t) => {
  const { settingsFile, integration } = await fixture(t);
  const original = JSON.stringify({ statusLine: { type: "command", command: "x".repeat(16_000) } });
  await writeFile(settingsFile, original, "utf8");
  assert.deepEqual(await integration.enable(), { status: "unavailable" });
  assert.equal(await readFile(settingsFile, "utf8"), original);
});

test("never overwrites malformed, oversized, conflicting, or user-cancelled Claude settings", async (t) => {
  const cancelled = await fixture(t, { confirm: async () => false });
  assert.deepEqual(await cancelled.integration.enable(), { status: "cancelled" });
  await assert.rejects(readFile(cancelled.settingsFile), { code: "ENOENT" });

  const malformed = await fixture(t);
  await writeFile(malformed.settingsFile, "{ private malformed source", "utf8");
  assert.deepEqual(await malformed.integration.getStatus(), { status: "unavailable" });
  assert.deepEqual(await malformed.integration.enable(), { status: "unavailable" });
  assert.equal(await readFile(malformed.settingsFile, "utf8"), "{ private malformed source");

  const oversized = await fixture(t);
  const tooLarge = "x".repeat(256 * 1024 + 1);
  await writeFile(oversized.settingsFile, tooLarge, "utf8");
  assert.deepEqual(await oversized.integration.enable(), { status: "unavailable" });
  assert.equal((await readFile(oversized.settingsFile)).length, tooLarge.length);

  let concurrent;
  const conflict = await fixture(t, {
    beforeCommit: async () => writeFile(concurrent, JSON.stringify({ statusLine: { type: "command", command: "user edited" } }), "utf8"),
  });
  concurrent = conflict.settingsFile;
  await writeFile(conflict.settingsFile, JSON.stringify({ untouched: true }), "utf8");
  assert.deepEqual(await conflict.integration.enable(), { status: "failed" });
  assert.deepEqual(JSON.parse(await readFile(conflict.settingsFile, "utf8")), { statusLine: { type: "command", command: "user edited" } });
});

test("an in-flight native confirmation reports busy without touching settings", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { settingsFile, integration } = await fixture(t, { confirm: async () => waiting });
  const first = integration.enable();
  assert.deepEqual(await integration.enable(), { status: "busy" });
  release(true);
  assert.deepEqual(await first, { status: "enabled" });
  assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).statusLine.type, "command");
});

test("disposing during a native confirmation prevents a later settings write", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { settingsFile, integration } = await fixture(t, { confirm: async () => waiting });
  const pending = integration.enable();
  integration.dispose();
  release(true);
  assert.deepEqual(await pending, { status: "unavailable" });
  await assert.rejects(readFile(settingsFile), { code: "ENOENT" });
});

test("the generated command runs the standalone bridge and forwards status-line stdin through PowerShell", async (t) => {
  const shells = resolveClaudeUsageShells(process.env);
  assert.ok(shells?.powershellExecutable, "Windows PowerShell is required for the desktop setup command");
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-usage-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await buildDesktopServiceBundles(path.resolve("."), root);
  const configRoot = path.join(root, "claude");
  const dataRoot = path.join(root, "data");
  await mkdir(configRoot);
  const settingsFile = path.join(configRoot, "settings.json");
  const marker = 'Powershell "quotes" $() `backtick` Résumé';
  const original = `$body=[Console]::In.ReadToEnd(); Write-Output $body; Write-Output '${marker}'`;
  await writeFile(settingsFile, JSON.stringify({ statusLine: { type: "command", command: original } }), "utf8");
  const integration = createClaudeUsageIntegration({
    configRoot,
    dataRoot,
    feedRoot: path.join(dataRoot, "usage-snapshots"),
    appExecutable: path.resolve("node_modules", "electron", "dist", "electron.exe"),
    bridgePath: path.join(root, "desktop", "workers", "claude-statusline-bridge.cjs"),
    powershellExecutable: shells.powershellExecutable,
    confirm: async () => true,
  });
  assert.deepEqual(await integration.enable(), { status: "enabled" });
  const command = JSON.parse(await readFile(settingsFile, "utf8")).statusLine.command;
  const sentinel = '{"session_id":"runtime-feed","cost":{"total_cost_usd":0.25}}';
  const direct = spawnSync(shells.powershellExecutable, ["-NoProfile", "-NonInteractive", "-Command", original], {
    input: sentinel,
    windowsHide: true,
    timeout: 30_000,
  });
  const result = spawnSync(shells.powershellExecutable, ["-NoProfile", "-NonInteractive", "-Command", command], {
    input: sentinel,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(result.stdout, direct.stdout, "the wrapper must preserve the configured PowerShell status line bytes");
  assert.equal(result.stdout.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
});

test("the generated command delegates the original Git Bash status line when Git Bash is available", async (t) => {
  const shells = resolveClaudeUsageShells(process.env);
  if (!shells?.gitBashExecutable) return t.skip("Git Bash is not installed");
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-claude-usage-bash-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await buildDesktopServiceBundles(path.resolve("."), root);
  const configRoot = path.join(root, "claude");
  const dataRoot = path.join(root, "data");
  await mkdir(configRoot);
  const settingsFile = path.join(configRoot, "settings.json");
  const marker = 'Bash "quotes" $() `backtick` Résumé';
  await writeFile(settingsFile, JSON.stringify({ statusLine: { type: "command", command: `cat; printf '%s' '${marker}'` } }), "utf8");
  const integration = createClaudeUsageIntegration({
    configRoot,
    dataRoot,
    appExecutable: path.resolve("node_modules", "electron", "dist", "electron.exe"),
    bridgePath: path.join(root, "desktop", "workers", "claude-statusline-bridge.cjs"),
    powershellExecutable: shells.powershellExecutable,
    gitBashExecutable: shells.gitBashExecutable,
    confirm: async () => true,
  });
  assert.deepEqual(await integration.enable(), { status: "enabled" });
  const command = JSON.parse(await readFile(settingsFile, "utf8")).statusLine.command;
  const sentinel = '{"session_id":"runtime-bash","cost":{"total_cost_usd":0.5}}';
  const direct = spawnSync(shells.gitBashExecutable, ["-c", `cat; printf '%s' '${marker}'`], {
    input: sentinel,
    windowsHide: true,
    timeout: 30_000,
  });
  const result = spawnSync(shells.powershellExecutable, ["-NoProfile", "-NonInteractive", "-Command", command], {
    input: sentinel,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(result.stdout, direct.stdout, "the wrapper must preserve the configured Git Bash status line bytes");
});
