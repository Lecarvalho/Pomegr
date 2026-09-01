import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { environmentValue } from "./environment-policy.mjs";

export const CLAUDE_USAGE_INTEGRATION_STATUSES = Object.freeze([
  "enabled",
  "disabled",
  "unavailable",
]);

export const CLAUDE_USAGE_INTEGRATION_ENABLE_STATUSES = Object.freeze([
  "enabled",
  "cancelled",
  "failed",
  "unavailable",
  "busy",
]);

export const CLAUDE_USAGE_INTEGRATION_CHANNELS = Object.freeze({
  getStatus: "pomegr:claude-usage-integration",
  enable: "pomegr:enable-claude-usage-integration",
});

const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 32 * 1024;
const MANAGED_MARKER = "POMEGR_CLAUDE_USAGE_BRIDGE='v1'";
const POWERSHELL_PREFIX = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_COMMAND_BYTES
    && !/[\u0000\r\n]/u.test(value);
}

function safeAbsolutePath(value) {
  if (!isSafeValue(value)) return null;
  // The desktop product currently packages for Windows, while focused tests can run on
  // another host. Accept either host-native or Windows absolute paths here.
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) return null;
  return value;
}

function safeExecutable(value, basename, fileExists) {
  const candidate = safeAbsolutePath(value);
  if (!candidate || path.win32.basename(candidate).toLowerCase() !== basename || !fileExists(candidate)) return null;
  return candidate;
}

// Claude Code runs Windows status lines in Git Bash when it is available and in
// Windows PowerShell otherwise.  Resolve only fixed executable candidates; a shell
// command from settings never participates in this selection.
export function resolveClaudeUsageShells(environment = {}, fileExists = existsSync) {
  const systemRoot = environmentValue(environment, "SystemRoot") || environmentValue(environment, "WINDIR") || "C:\\Windows";
  const powershellExecutable = safeExecutable(
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
    fileExists,
  );
  if (!powershellExecutable) return null;

  const configuredBash = environmentValue(environment, "CLAUDE_CODE_GIT_BASH_PATH");
  const programRoots = [
    environmentValue(environment, "ProgramW6432"),
    environmentValue(environment, "ProgramFiles"),
    environmentValue(environment, "ProgramFiles(x86)"),
    "C:\\Program Files",
  ];
  const candidates = [
    configuredBash,
    ...programRoots.filter(Boolean).map((root) => path.win32.join(root, "Git", "bin", "bash.exe")),
    ...(environmentValue(environment, "PATH") || "").split(path.delimiter).filter(Boolean).map((directory) => path.win32.join(directory, "bash.exe")),
  ];
  const gitBashExecutable = candidates
    .map((candidate) => safeExecutable(candidate, "bash.exe", fileExists))
    .find(Boolean) || null;
  return Object.freeze({ powershellExecutable, gitBashExecutable });
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

// Windows command-line parsing is performed by the native Electron process, never by
// a shell.  This is the documented backslash/quote encoding for CreateProcess argv.
function windowsArgument(value) {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\*)$/u, "$1$1")}"`;
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function decodeManagedCommand(command) {
  if (typeof command !== "string" || !command.startsWith(POWERSHELL_PREFIX)) return null;
  const encoded = command.slice(POWERSHELL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length > MAX_COMMAND_BYTES * 4) return null;
  try {
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    return script.includes(MANAGED_MARKER) ? script : null;
  } catch {
    return null;
  }
}

function inspectSettings(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SETTINGS_BYTES) return { state: "unavailable" };
  let settings;
  try { settings = JSON.parse(bytes.toString("utf8")); } catch { return { state: "unavailable" }; }
  if (!isRecord(settings)) return { state: "unavailable" };
  if (!Object.hasOwn(settings, "statusLine")) return { state: "disabled", settings, command: null };
  const statusLine = settings.statusLine;
  if (!isRecord(statusLine) || statusLine.type !== "command" || !isSafeValue(statusLine.command)) {
    return { state: "unavailable" };
  }
  return {
    state: decodeManagedCommand(statusLine.command) ? "enabled" : "disabled",
    settings,
    command: statusLine.command,
  };
}

async function regularDirectory(directory) {
  try {
    const details = await lstat(directory);
    return details.isDirectory() && !details.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readSettingsFile(filename) {
  try {
    const details = await lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_SETTINGS_BYTES) return { kind: "unavailable" };
    const bytes = await readFile(filename);
    if (bytes.length !== details.size) return { kind: "unavailable" };
    return { kind: "present", bytes };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing", bytes: null };
    return { kind: "unavailable" };
  }
}

function sameSnapshot(before, after) {
  return before.kind === after.kind && (before.kind !== "present" || before.bytes.equals(after.bytes));
}

function managedCommand({ appExecutable, bridgePath, dataRoot, feedRoot, delegate }) {
  const argumentsLine = [bridgePath, ...delegate].map(windowsArgument).join(" ");
  const script = [
    "$env:ELECTRON_RUN_AS_NODE='1'",
    `$env:${MANAGED_MARKER}`,
    `$env:POMEGR_USAGE_SNAPSHOTS_DIR=${powershellLiteral(feedRoot)}`,
    `$env:POMEGR_COST_SNAPSHOTS_DIR=${powershellLiteral(path.join(dataRoot, "cost-snapshots"))}`,
    `$env:POMEGR_DATA_DIR=${powershellLiteral(dataRoot)}`,
    "$utf8=New-Object System.Text.UTF8Encoding($false)",
    "[Console]::OutputEncoding=$utf8",
    "$OutputEncoding=$utf8",
    "$inputStream=[Console]::OpenStandardInput()",
    "$child=New-Object System.Diagnostics.Process",
    `$child.StartInfo.FileName=${powershellLiteral(appExecutable)}`,
    `$child.StartInfo.Arguments=${powershellLiteral(argumentsLine)}`,
    "$child.StartInfo.UseShellExecute=$false",
    "$child.StartInfo.RedirectStandardInput=$true",
    "$child.StartInfo.RedirectStandardOutput=$true",
    "$child.StartInfo.RedirectStandardError=$true",
    "if(-not $child.Start()){exit 1}",
    "$stdoutTask=$child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())",
    "$stderrTask=$child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())",
    "$inputStream.CopyTo($child.StandardInput.BaseStream)",
    "$child.StandardInput.Close()",
    "$child.WaitForExit()",
    "[void]$stdoutTask.GetAwaiter().GetResult()",
    "[void]$stderrTask.GetAwaiter().GetResult()",
    "exit $child.ExitCode",
  ].join(";");
  return `${POWERSHELL_PREFIX}${encodePowerShell(script)}`;
}

function validOptions(options) {
  const configRoot = safeAbsolutePath(options.configRoot);
  const appExecutable = safeAbsolutePath(options.appExecutable);
  const bridgePath = safeAbsolutePath(options.bridgePath);
  const dataRoot = safeAbsolutePath(options.dataRoot);
  const feedRoot = safeAbsolutePath(options.feedRoot || (dataRoot && path.join(dataRoot, "usage-snapshots")));
  const powershellExecutable = safeAbsolutePath(options.powershellExecutable);
  const gitBashExecutable = options.gitBashExecutable == null ? null : safeAbsolutePath(options.gitBashExecutable);
  if (!configRoot || !appExecutable || !bridgePath || !dataRoot || !feedRoot || !powershellExecutable
    || (options.gitBashExecutable != null && !gitBashExecutable)) return null;
  return { configRoot, appExecutable, bridgePath, dataRoot, feedRoot, powershellExecutable, gitBashExecutable };
}

function delegateArguments(configured, command) {
  if (!command) return [];
  if (configured.gitBashExecutable) return ["--", configured.gitBashExecutable, "-c", command];
  return ["--", configured.powershellExecutable, "-NoProfile", "-NonInteractive", "-Command", command];
}

export function createClaudeUsageIntegration(options = {}) {
  const configured = validOptions(options);
  const confirm = options.confirm || (async () => false);
  const beforeCommit = options.beforeCommit || (async () => {});
  let pending = false;
  let disposed = false;

  async function getStatus() {
    if (disposed || !configured || !await regularDirectory(configured.configRoot)) return { status: "unavailable" };
    const snapshot = await readSettingsFile(path.join(configured.configRoot, "settings.json"));
    if (snapshot.kind === "unavailable") return { status: "unavailable" };
    if (snapshot.kind === "missing") return { status: "disabled" };
    return { status: inspectSettings(snapshot.bytes).state };
  }

  async function enable() {
    if (pending) return { status: "busy" };
    pending = true;
    try {
      if (disposed || !configured || !await regularDirectory(configured.configRoot)) return { status: "unavailable" };
      if (await confirm() !== true) return { status: "cancelled" };
      if (disposed) return { status: "unavailable" };
      const settingsFile = path.join(configured.configRoot, "settings.json");
      const before = await readSettingsFile(settingsFile);
      if (before.kind === "unavailable") return { status: "unavailable" };
      const inspected = before.kind === "missing"
        ? { state: "disabled", settings: {}, command: null }
        : inspectSettings(before.bytes);
      if (inspected.state === "unavailable") return { status: "unavailable" };
      if (inspected.state === "enabled") return { status: "enabled" };
      const next = {
        ...inspected.settings,
        statusLine: {
          ...inspected.settings.statusLine,
          type: "command",
          command: managedCommand({ ...configured, delegate: delegateArguments(configured, inspected.command) }),
        },
      };
      if (!isSafeValue(next.statusLine.command)) return { status: "unavailable" };
      const serialized = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      if (serialized.length > MAX_SETTINGS_BYTES) return { status: "unavailable" };

      const current = await readSettingsFile(settingsFile);
      if (!sameSnapshot(before, current)) return { status: "failed" };
      const temporary = path.join(configured.configRoot, `.pomegr-statusline-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
        // A final recheck makes an edit made while the confirmation dialog was open a
        // safe refusal rather than an overwrite.
        await beforeCommit();
        if (disposed) return { status: "unavailable" };
        const finalCurrent = await readSettingsFile(settingsFile);
        if (!sameSnapshot(before, finalCurrent)) return { status: "failed" };
        await rename(temporary, settingsFile);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return { status: "enabled" };
    } catch {
      return { status: "failed" };
    } finally {
      pending = false;
    }
  }

  function dispose() { disposed = true; }

  return Object.freeze({ getStatus, enable, dispose });
}

function boundedResult(result, allowed) {
  return result && allowed.includes(result.status) ? { status: result.status } : { status: "unavailable" };
}

// The renderer supplies no paths, commands, or confirmation data.  Native shell code
// owns both the trusted-frame check and the confirmation callback passed to the action.
export function installClaudeUsageIntegrationIpc({ ipcMain, isTrustedEvent, integration }) {
  const { getStatus, enable } = CLAUDE_USAGE_INTEGRATION_CHANNELS;
  ipcMain.removeHandler(getStatus);
  ipcMain.removeHandler(enable);
  ipcMain.handle(getStatus, async (event) => {
    if (!isTrustedEvent(event)) return { status: "unavailable" };
    try { return boundedResult(await integration.getStatus(), CLAUDE_USAGE_INTEGRATION_STATUSES); } catch { return { status: "unavailable" }; }
  });
  ipcMain.handle(enable, async (event) => {
    if (!isTrustedEvent(event)) return { status: "unavailable" };
    try { return boundedResult(await integration.enable(), CLAUDE_USAGE_INTEGRATION_ENABLE_STATUSES); } catch { return { status: "unavailable" }; }
  });
  return () => {
    ipcMain.removeHandler(getStatus);
    ipcMain.removeHandler(enable);
  };
}

export const createClaudeUsageIntegrationCommand = managedCommand;
