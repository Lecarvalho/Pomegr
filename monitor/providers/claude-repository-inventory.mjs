import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { contextMachineryFromNativeJson } from "../context-machinery.mjs";

export const CLAUDE_REPOSITORY_INVENTORY_ARGS = Object.freeze([
  "-p",
  "/context",
  "--output-format",
  "json",
  "--no-session-persistence",
  "--permission-prompts",
  "none",
]);

const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const SAFE_ENVIRONMENT_NAMES = Object.freeze([
  "APPDATA", "CLAUDE_CONFIG_DIR", "HOME", "HOMEDRIVE", "HOMEPATH", "LANG",
  "LANGUAGE", "LC_ALL", "LC_CTYPE", "LOCALAPPDATA", "OS", "PATH", "PATHEXT",
  "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ", "USERPROFILE", "WINDIR",
]);

function environmentValue(environment, name) {
  const key = Object.keys(environment || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

function safeExecutable(value, platform = process.platform) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000\r\n"]/u.test(value)) return null;
  const basename = path.basename(value).toLowerCase();
  if (basename !== (platform === "win32" ? "claude.exe" : "claude") && basename !== "claude.exe") return null;
  return path.resolve(value);
}

export function resolveClaudeRepositoryInventoryExecutable(environment = {}, options = {}) {
  const platform = options.platform || process.platform;
  const fileExists = options.fileExists || existsSync;
  const configured = environmentValue(environment, "POMEGR_CLAUDE_EXECUTABLE");
  if (configured !== undefined) {
    const candidate = safeExecutable(configured, platform);
    return candidate && fileExists(candidate) ? candidate : null;
  }
  const home = environmentValue(environment, "USERPROFILE") || environmentValue(environment, "HOME") || os.homedir();
  const installed = safeExecutable(path.join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude"), platform);
  if (installed && fileExists(installed)) return installed;
  const executableName = platform === "win32" ? "claude.exe" : "claude";
  for (const directory of String(environmentValue(environment, "PATH") || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory) || /[\u0000\r\n"]/u.test(directory)) continue;
    const candidate = safeExecutable(path.join(directory, executableName), platform);
    if (candidate && fileExists(candidate)) return candidate;
  }
  return null;
}

export function claudeRepositoryInventoryEnvironment(source = {}) {
  const environment = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = environmentValue(source, name);
    if (typeof value === "string" && value) environment[name] = value;
  }
  return environment;
}

export function createClaudeRepositoryInventoryCapture(options = {}) {
  const sourceEnvironment = options.environment || process.env;
  const spawn = options.spawn || spawnChild;
  const fileExists = options.fileExists || existsSync;
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  return async function captureRepositoryContextInventory(
    /** @type {{ cwd?: string }} */ input = {},
  ) {
    const { cwd } = input;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\u0000\r\n]/u.test(cwd)) return { status: "failed", failureKind: "invalid_output" };
    const executable = resolveClaudeRepositoryInventoryExecutable(sourceEnvironment, { fileExists, platform: options.platform });
    if (!executable) return { status: "unavailable", failureKind: "executable_unavailable" };
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timedOut = false;
      let overflow = false;
      let timer;
      let stdout = Buffer.alloc(0);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdout = Buffer.alloc(0);
        resolve(result);
      };
      try {
        child = spawn(executable, [...CLAUDE_REPOSITORY_INVENTORY_ARGS], {
          cwd: path.resolve(cwd),
          env: claudeRepositoryInventoryEnvironment(sourceEnvironment),
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        finish({ status: "failed", failureKind: "runtime_unavailable" });
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* already exited */ }
        finish({ status: "timed_out", failureKind: "timed_out" });
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => {
        if (overflow) return;
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stdout.length + next.length > MAX_OUTPUT_BYTES) {
          overflow = true;
          stdout = Buffer.alloc(0);
          try { child.kill(); } catch { /* already exited */ }
          return;
        }
        stdout = Buffer.concat([stdout, next]);
      });
      // Drain stderr without retaining or inspecting provider-authored content.
      child.stderr?.resume?.();
      child.once("error", () => finish({ status: "failed", failureKind: "runtime_unavailable" }));
      child.once("exit", (code) => {
        if (timedOut) { finish({ status: "timed_out", failureKind: "timed_out" }); return; }
        if (overflow || code !== 0) { finish({ status: "failed", failureKind: overflow ? "invalid_output" : "runtime_unavailable" }); return; }
        const observedAt = new Date((options.now || Date.now)()).toISOString();
        const inventory = contextMachineryFromNativeJson(stdout.toString("utf8"), observedAt);
        if (!inventory) { finish({ status: "failed", failureKind: "invalid_output" }); return; }
        finish({ status: "completed", inventory });
      });
    });
  };
}

export function claudeRepositoryInventoryCaptureFromProviderOptions(options = {}) {
  return createClaudeRepositoryInventoryCapture({
    environment: options.env || process.env,
    spawn: options.repositoryInventorySpawn,
    fileExists: options.repositoryInventoryFileExists,
    timeoutMs: options.repositoryInventoryTimeoutMs,
    now: options.now,
    platform: options.platform,
  });
}
