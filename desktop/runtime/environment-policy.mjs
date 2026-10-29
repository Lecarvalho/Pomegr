import { existsSync } from "node:fs";
import path from "node:path";

export const RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "POMEGR_SMOKE_MAIN_STAGE_PATH",
  "POMEGR_SMOKE_PROFILE_ROOT",
  "TMP",
  "TZ",
  "WINDIR",
]);

export const MONITOR_PRIVATE_ENVIRONMENT_NAMES = Object.freeze([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECTS_DIR",
  "CLAUDE_SESSION_FILE",
  "CODEX_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "POMEGR_CODEX_EXECUTABLE",
  "POMEGR_CLAUDE_EXECUTABLE",
  "POMEGR_COST_SNAPSHOTS_DIR",
  "POMEGR_DATA_DIR",
  "POMEGR_RETENTION_DAYS",
  "POMEGR_STORE_MAX_MB",
  "POMEGR_USAGE_SNAPSHOTS_DIR",
  "USERPROFILE",
]);

export const NATIVE_CLAUDE_ENVIRONMENT_NAMES = Object.freeze([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "USERPROFILE",
]);

export const NATIVE_CODEX_ENVIRONMENT_NAMES = Object.freeze([
  "APPDATA",
  "CODEX_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "POMEGR_CODEX_EXECUTABLE",
  "USERPROFILE",
]);

export function environmentValue(environment, name) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

export function withoutSystemNode(searchPath = "", fileExists = existsSync) {
  return searchPath
    .split(path.delimiter)
    .filter(Boolean)
    .filter((directory) => !fileExists(path.join(directory, "node.exe")))
    .join(path.delimiter);
}

export function assertNoSystemNodeInPath(environment, fileExists = existsSync) {
  const searchPath = environmentValue(environment, "PATH") || "";
  if (searchPath.split(path.delimiter).filter(Boolean).some((directory) => fileExists(path.join(directory, "node.exe")))) {
    throw new Error("DESKTOP_SYSTEM_NODE_VISIBLE");
  }
}

export function executableOnPath(environment, filename, fileExists = existsSync) {
  const searchPath = environmentValue(environment, "PATH") || "";
  return searchPath.split(path.delimiter).filter(Boolean).some((directory) => fileExists(path.join(directory, filename)));
}

export function minimalRuntimeEnvironment(source, overrides = {}, fileExists = existsSync) {
  const environment = {
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "production",
    PATH: withoutSystemNode(environmentValue(source, "PATH") || "", fileExists),
    POMEGR_SMOKE_NO_SYSTEM_NODE: "1",
  };
  for (const name of RUNTIME_ENVIRONMENT_NAMES) {
    const value = environmentValue(source, name);
    if (value !== undefined) environment[name] = value;
  }
  return Object.assign(environment, overrides);
}

// A provider session the user starts from the task board is the user's own terminal session: it gets the
// environment the app inherited (its hooks and MCP servers need the user's Node, tools, and settings), without the
// variables that belong to this app's own runtime or to one start. Stays in the Electron main process.
// When the app was started from inside a Claude Code or Codex session, the variables that session set about itself
// are left out too: a new session that gets them thinks it runs inside the other one (Claude Code then drops its colors).
// Owner settings such as CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK, or CODEX_HOME stay.
const SESSION_EXCLUDED_ENVIRONMENT = /^(?:ELECTRON_.*|POMEGR_SMOKE_.*|POMEGR_START_.*|POMEGR_MONITOR_TOKEN|POMEGR_MONITOR_ORIGIN|POMEGR_TASK_TOKEN|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(?:CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|SESSION_ID|SSE_PORT|FORCE_SESSION_PERSISTENCE|DISABLE_BG_SHELL_PRESSURE_REAP)|CODEX_SANDBOX|CODEX_SANDBOX_NETWORK_DISABLED|CODEX_THREAD_ID)$/iu;
export function userSessionEnvironment(source) {
  const environment = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (typeof value === "string" && !SESSION_EXCLUDED_ENVIRONMENT.test(name)) environment[name] = value;
  }
  return environment;
}

// The terminal host's limits for one session's environment (desktop/terminal-host/host.mjs). Desktop main checks them
// first, so an environment the host would refuse fails the start with its own reason and is never cut to fit.
export function sessionEnvironmentFits(environment) {
  const entries = Object.entries(environment || {});
  return entries.length <= 512
    && entries.every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_()]{0,127}$/u.test(key)
      && typeof value === "string" && value.length <= 32767 && !value.includes("\0"))
    && Buffer.byteLength(JSON.stringify(environment)) <= 48 * 1024;
}

export function keepOnlyRuntimeEnvironment(environment, overrides = {}, fileExists = existsSync) {
  const kept = minimalRuntimeEnvironment(environment, overrides, fileExists);
  for (const name of Object.keys(environment)) delete environment[name];
  Object.assign(environment, kept);
  return environment;
}

export function monitorPrivateEnvironment(source, options = {}) {
  const environment = {};
  for (const name of MONITOR_PRIVATE_ENVIRONMENT_NAMES) {
    const value = environmentValue(source, name);
    if (typeof value === "string" && value) environment[name] = value;
  }
  if (options.pomegrDataRoot) {
    environment.POMEGR_DATA_DIR = options.pomegrDataRoot;
  }
  return environment;
}

// Native provider tools need their normal profile and provider configuration, but
// the renderer and in-main web host never receive this environment.
export function nativeClaudeEnvironment(source, overrides = {}, fileExists = existsSync) {
  const environment = minimalRuntimeEnvironment(source, {}, fileExists);
  for (const name of NATIVE_CLAUDE_ENVIRONMENT_NAMES) {
    const value = environmentValue(source, name);
    if (typeof value === "string" && value) environment[name] = value;
  }
  return Object.assign(environment, overrides);
}

// Keep a provider's normal profile and user-level npm location for an explicitly
// confirmed native action. This remains private to the Electron main process.
export function nativeCodexEnvironment(source, overrides = {}, fileExists = existsSync) {
  const environment = minimalRuntimeEnvironment(source, {}, fileExists);
  for (const name of NATIVE_CODEX_ENVIRONMENT_NAMES) {
    const value = environmentValue(source, name);
    if (typeof value === "string" && value) environment[name] = value;
  }
  return Object.assign(environment, overrides);
}
