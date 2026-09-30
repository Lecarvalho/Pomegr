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
const MANAGED_SCRIPT_PREFIX = `$env:ELECTRON_RUN_AS_NODE='1';$env:${MANAGED_MARKER};`;
const POWERSHELL_LITERAL_PATTERN = "'(?:[^']|'')*'";

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
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.length > MAX_COMMAND_BYTES || bytes.length % 2 !== 0) return null;
    return bytes.toString("utf16le");
  } catch {
    return null;
  }
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const MANAGED_SCRIPT_PATTERN = new RegExp(
  `^${escapePattern(MANAGED_SCRIPT_PREFIX)}`
  + `\\$env:POMEGR_USAGE_SNAPSHOTS_DIR=(${POWERSHELL_LITERAL_PATTERN});`
  + `\\$env:POMEGR_COST_SNAPSHOTS_DIR=(${POWERSHELL_LITERAL_PATTERN});`
  + `\\$env:POMEGR_DATA_DIR=(${POWERSHELL_LITERAL_PATTERN});`
  + `${escapePattern("$utf8=New-Object System.Text.UTF8Encoding($false);[Console]::OutputEncoding=$utf8;$OutputEncoding=$utf8;$inputStream=[Console]::OpenStandardInput();$child=New-Object System.Diagnostics.Process;$child.StartInfo.FileName=")}`
  + `(${POWERSHELL_LITERAL_PATTERN});`
  + `${escapePattern("$child.StartInfo.Arguments=")}`
  + `(${POWERSHELL_LITERAL_PATTERN});`
  + `${escapePattern("$child.StartInfo.UseShellExecute=$false;$child.StartInfo.RedirectStandardInput=$true;$child.StartInfo.RedirectStandardOutput=$true;$child.StartInfo.RedirectStandardError=$true;if(-not $child.Start()){exit 1};$stdoutTask=$child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$stderrTask=$child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError());$inputStream.CopyTo($child.StandardInput.BaseStream);$child.StandardInput.Close();$child.WaitForExit();[void]$stdoutTask.GetAwaiter().GetResult();[void]$stderrTask.GetAwaiter().GetResult();exit $child.ExitCode")}$`,
  "u",
);

function powerShellLiteralValue(value) {
  if (typeof value !== "string" || !new RegExp(`^${POWERSHELL_LITERAL_PATTERN}$`, "u").test(value)) return null;
  return value.slice(1, -1).replaceAll("''", "'");
}

function managedRootsPrefix({ feedRoot, costRoot, dataRoot }) {
  return `${MANAGED_SCRIPT_PREFIX}$env:POMEGR_USAGE_SNAPSHOTS_DIR=${powershellLiteral(feedRoot)};`
    + `$env:POMEGR_COST_SNAPSHOTS_DIR=${powershellLiteral(costRoot)};`
    + `$env:POMEGR_DATA_DIR=${powershellLiteral(dataRoot)};`;
}

function sameManagedPath(left, right) {
  if (!safeAbsolutePath(left) || !safeAbsolutePath(right)) return false;
  if (path.win32.isAbsolute(left) || path.win32.isAbsolute(right)) {
    return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  }
  return path.resolve(left) === path.resolve(right);
}

// The status-line command is never run while inspecting it. A managed command is
// recognized only when its complete decoded bridge skeleton has one bounded set of
// generated root assignments. A marker alone is deliberately insufficient.
function inspectManagedCommand(command, configured) {
  const script = decodeManagedCommand(command);
  if (!script || !script.includes(MANAGED_MARKER)) return null;
  const match = MANAGED_SCRIPT_PATTERN.exec(script);
  if (!match) return { state: "unavailable" };
  const [feedRoot, costRoot, dataRoot] = match.slice(1, 4).map(powerShellLiteralValue);
  const appExecutable = powerShellLiteralValue(match[4]);
  const argumentsLine = powerShellLiteralValue(match[5]);
  const bridgeArgument = configured && windowsArgument(configured.bridgePath);
  if (!feedRoot || !costRoot || !dataRoot || !appExecutable || !argumentsLine
    || !sameManagedPath(appExecutable, configured?.appExecutable)
    || !bridgeArgument || (argumentsLine !== bridgeArgument && !argumentsLine.startsWith(`${bridgeArgument} `))) {
    return { state: "unavailable" };
  }
  const prefix = managedRootsPrefix({ feedRoot, costRoot, dataRoot });
  if (!script.startsWith(prefix)) return { state: "unavailable" };
  return { state: "managed", script, prefix, feedRoot, costRoot, dataRoot };
}

function rebindManagedCommand(managed, configured) {
  if (managed?.state !== "managed") return null;
  return `${POWERSHELL_PREFIX}${encodePowerShell(`${managedRootsPrefix(configured)}${managed.script.slice(managed.prefix.length)}`)}`;
}

function inspectSettings(bytes, configured) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SETTINGS_BYTES) return { state: "unavailable" };
  let settings;
  try { settings = JSON.parse(bytes.toString("utf8")); } catch { return { state: "unavailable" }; }
  if (!isRecord(settings)) return { state: "unavailable" };
  if (!Object.hasOwn(settings, "statusLine")) return { state: "disabled", settings, command: null };
  const statusLine = settings.statusLine;
  if (!isRecord(statusLine) || statusLine.type !== "command" || !isSafeValue(statusLine.command)) {
    return { state: "unavailable" };
  }
  const managed = inspectManagedCommand(statusLine.command, configured);
  if (managed?.state === "unavailable") return { state: "unavailable" };
  if (managed?.state === "managed") {
    const rootsMatch = configured
      && sameManagedPath(managed.feedRoot, configured.feedRoot)
      && sameManagedPath(managed.costRoot, configured.costRoot)
      && sameManagedPath(managed.dataRoot, configured.dataRoot);
    return { state: rootsMatch ? "enabled" : "disabled", settings, command: statusLine.command, managed };
  }
  return { state: "disabled", settings, command: statusLine.command, managed: null };
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

function managedCommand({ appExecutable, bridgePath, dataRoot, feedRoot, costRoot = path.join(dataRoot, "cost-snapshots"), delegate }) {
  const argumentsLine = [bridgePath, ...delegate].map(windowsArgument).join(" ");
  const script = [
    "$env:ELECTRON_RUN_AS_NODE='1'",
    `$env:${MANAGED_MARKER}`,
    `$env:POMEGR_USAGE_SNAPSHOTS_DIR=${powershellLiteral(feedRoot)}`,
    `$env:POMEGR_COST_SNAPSHOTS_DIR=${powershellLiteral(costRoot)}`,
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
  const costRoot = safeAbsolutePath(options.costRoot || (dataRoot && path.join(dataRoot, "cost-snapshots")));
  const powershellExecutable = safeAbsolutePath(options.powershellExecutable);
  const gitBashExecutable = options.gitBashExecutable == null ? null : safeAbsolutePath(options.gitBashExecutable);
  if (!configRoot || !appExecutable || !bridgePath || !dataRoot || !feedRoot || !costRoot || !powershellExecutable
    || (options.gitBashExecutable != null && !gitBashExecutable)) return null;
  return { configRoot, appExecutable, bridgePath, dataRoot, feedRoot, costRoot, powershellExecutable, gitBashExecutable };
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
    return { status: inspectSettings(snapshot.bytes, configured).state };
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
        : inspectSettings(before.bytes, configured);
      if (inspected.state === "unavailable") return { status: "unavailable" };
      if (inspected.state === "enabled") return { status: "enabled" };
      const next = {
        ...inspected.settings,
        statusLine: {
          ...inspected.settings.statusLine,
          type: "command",
          command: inspected.managed
            ? rebindManagedCommand(inspected.managed, configured)
            : managedCommand({ ...configured, delegate: delegateArguments(configured, inspected.command) }),
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
