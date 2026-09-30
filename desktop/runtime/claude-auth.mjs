import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { environmentValue, nativeClaudeEnvironment } from "./environment-policy.mjs";

export const CLAUDE_SIGN_IN_CHANNEL = "pomegr:start-claude-sign-in";
export const CLAUDE_SIGN_IN_STATUSES = Object.freeze([
  "completed",
  "cancelled",
  "failed",
  "unavailable",
  "busy",
  "timed_out",
]);

const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

const DISCOVERY_ENVIRONMENT_NAMES = Object.freeze([
  "HOME",
  "PATH",
  "POMEGR_CLAUDE_EXECUTABLE",
  "USERPROFILE",
]);

export function claudeDiscoveryEnvironment(source = {}) {
  const environment = {};
  for (const name of DISCOVERY_ENVIRONMENT_NAMES) {
    const value = environmentValue(source, name);
    if (typeof value === "string" && value) environment[name] = value;
  }
  return environment;
}

function safeAbsoluteDirectory(value) {
  if (typeof value !== "string" || !value || /[\u0000\r\n"]/u.test(value)) return null;
  if (!path.isAbsolute(value)) return null;
  const resolved = path.resolve(value);
  if (resolved !== value && resolved.toLowerCase() !== value.toLowerCase()) return null;
  const segments = resolved.toLowerCase().split(/[\\/]+/u);
  if (segments.includes("node_modules") || segments.includes(".bin")) return null;
  return resolved;
}

export function isSafeClaudeExecutable(value) {
  if (typeof value !== "string" || /[\u0000\r\n"]/u.test(value)) return false;
  if (!path.isAbsolute(value) || path.basename(value).toLowerCase() !== "claude.exe") return false;
  const resolved = path.resolve(value);
  if (resolved !== value && resolved.toLowerCase() !== value.toLowerCase()) return false;
  return safeAbsoluteDirectory(path.dirname(resolved)) !== null;
}

export function resolveClaudeExecutable(environment = {}, fileExists = existsSync) {
  const configured = environmentValue(environment, "POMEGR_CLAUDE_EXECUTABLE");
  if (configured !== undefined) {
    return isSafeClaudeExecutable(configured) && fileExists(configured) ? path.resolve(configured) : null;
  }

  const home = environmentValue(environment, "USERPROFILE") || environmentValue(environment, "HOME");
  const installed = typeof home === "string" && home
    ? path.join(home, ".local", "bin", "claude.exe")
    : null;
  if (installed && isSafeClaudeExecutable(installed) && fileExists(installed)) return installed;

  const searchPath = environmentValue(environment, "PATH") || "";
  for (const directory of searchPath.split(path.delimiter)) {
    const safeDirectory = safeAbsoluteDirectory(directory);
    if (!safeDirectory) continue;
    const candidate = path.join(safeDirectory, "claude.exe");
    if (isSafeClaudeExecutable(candidate) && fileExists(candidate)) return candidate;
  }
  return null;
}

function observeChild(child, { timeoutMs, shutdownTimeoutMs }) {
  let timedOut = false;
  let settled = false;
  let timer;
  let shutdownTimer;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(shutdownTimer);
    child?.removeListener?.("exit", onExit);
    child?.removeListener?.("error", onError);
  };
  const finish = (status) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveResult(status);
  };
  const onExit = (code) => finish(timedOut ? "timed_out" : code === 0 ? "completed" : "failed");
  const onError = () => {
    if (!timedOut) finish("failed");
  };
  const terminate = () => {
    if (settled || timedOut) return result;
    timedOut = true;
    shutdownTimer = setTimeout(() => finish("timed_out"), shutdownTimeoutMs);
    try { child?.kill?.(); } catch { /* The native child may already have exited. */ }
    return result;
  };
  child?.once?.("exit", onExit);
  child?.once?.("error", onError);
  timer = setTimeout(terminate, timeoutMs);
  return Object.freeze({ result, terminate });
}

export function createClaudeSignInAction(options = {}) {
  const sourceEnvironment = options.environment || process.env;
  const discoveryEnvironment = Object.freeze(claudeDiscoveryEnvironment(sourceEnvironment));
  const nativeEnvironment = Object.freeze({ ...(options.nativeEnvironment || nativeClaudeEnvironment(sourceEnvironment)) });
  const fileExists = options.fileExists || existsSync;
  const spawn = options.spawn || spawnChild;
  const confirm = options.confirm || (async () => false);
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let active;
  let disposed = false;

  async function start() {
    if (disposed) return "unavailable";
    if (active) return "busy";
    const executable = resolveClaudeExecutable(discoveryEnvironment, fileExists);
    if (!executable) return "unavailable";
    active = Object.freeze({ child: null, observer: null });
    try {
      if (await confirm() !== true) return "cancelled";
      if (disposed) return "cancelled";
      let child;
      try {
        child = spawn(executable, ["auth", "login", "--claudeai"], {
          env: nativeEnvironment,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        return "failed";
      }
      const observer = observeChild(child, { timeoutMs, shutdownTimeoutMs });
      active = Object.freeze({ child, observer });
      return await observer.result;
    } catch {
      return "failed";
    } finally {
      active = undefined;
    }
  }

  async function dispose() {
    disposed = true;
    const observer = active?.observer;
    if (observer) await observer.terminate();
  }

  return Object.freeze({ start, dispose });
}

// The renderer supplies no action data. Other deliberate native control actions
// can reuse this narrow trusted-and-confirmed IPC boundary.
export function installConfirmedTrustedActionIpcHandler({ ipcMain, channel, isTrustedEvent, action }) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event) => {
    if (!isTrustedEvent(event)) return { status: "unavailable" };
    try {
      const status = await action.start();
      return { status: CLAUDE_SIGN_IN_STATUSES.includes(status) ? status : "failed" };
    } catch { return { status: "failed" }; }
  });
  return () => ipcMain.removeHandler(channel);
}
