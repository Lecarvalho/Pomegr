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
  "THREADLIGHT_SMOKE_MAIN_STAGE_PATH",
  "THREADLIGHT_SMOKE_PROFILE_ROOT",
  "TMP",
  "TZ",
  "WINDIR",
]);

export const MONITOR_PRIVATE_ENVIRONMENT_NAMES = Object.freeze([
  "APPDATA",
  "CLAUDE_PROJECTS_DIR",
  "CLAUDE_SESSION_FILE",
  "CODEX_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "THREADLIGHT_CODEX_LIVENESS_DIR",
  "THREADLIGHT_CODEX_OWNER_PID",
  "THREADLIGHT_COST_SNAPSHOTS_DIR",
  "THREADLIGHT_DATA_DIR",
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
    THREADLIGHT_SMOKE_NO_SYSTEM_NODE: "1",
  };
  for (const name of RUNTIME_ENVIRONMENT_NAMES) {
    const value = environmentValue(source, name);
    if (value !== undefined) environment[name] = value;
  }
  return Object.assign(environment, overrides);
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
  if (options.threadlightDataRoot) {
    environment.THREADLIGHT_DATA_DIR = options.threadlightDataRoot;
  }
  return environment;
}
