import { readFileSync, writeFileSync } from "node:fs";

export const SHELL_STARTUP_STAGES = Object.freeze([
  "SHELL_PATHS_READY",
  "SHELL_SETTINGS_READY",
  "SHELL_MONITOR_STARTING",
  "SHELL_MONITOR_READY",
  "SHELL_WEB_IMPORTING",
  "SHELL_WEB_IMPORTED",
  "SHELL_WEB_STARTING",
  "SHELL_WEB_OUT_DIR_VALIDATING",
  "SHELL_WEB_OUT_DIR_READY",
  "SHELL_WEB_VINEXT_LOADING",
  "SHELL_WEB_VINEXT_LOADED",
  "SHELL_WEB_ENTRY_LOADING",
  "SHELL_WEB_ENTRY_READY",
  "SHELL_WEB_LISTENER_STARTING",
  "SHELL_WEB_LISTENER_READY",
  "SHELL_WEB_AUTH_READY",
  "SHELL_WEB_HANDLE_READY",
  "SHELL_WEB_READY",
  "SHELL_WINDOW_CREATED",
  "SHELL_WINDOW_LOADING",
  "SHELL_WINDOW_READY",
  "SHELL_RUNTIME_READY",
]);

export const SHELL_LIFECYCLE_STAGES = Object.freeze([
  "SHELL_START_FAILED",
  "SHELL_CLEANUP_STARTED",
  "SHELL_CLEANUP_COMPLETE",
  "SHELL_ERROR_LOADING",
  "SHELL_ERROR_READY",
]);

const ALLOWED_SHELL_STAGES = new Set([...SHELL_STARTUP_STAGES, ...SHELL_LIFECYCLE_STAGES]);
const EARLIER_RUNTIME_STAGE = /^(?:MAIN|MONITOR|WEB)_[A-Z_]{1,30}$/;
const MAXIMUM_STAGE_LINES = 32;

function environmentValue(environment, name) {
  const key = Object.keys(environment || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

export function isAllowedShellStage(stage) {
  return ALLOWED_SHELL_STAGES.has(stage);
}

export function recordShellStage(environment, stage, io = {}) {
  if (!isAllowedShellStage(stage)) return false;
  const stagePath = environmentValue(environment, "THREADLIGHT_SMOKE_MAIN_STAGE_PATH");
  if (!stagePath) return false;
  const read = io.readFileSync || readFileSync;
  const write = io.writeFileSync || writeFileSync;
  let current = "";
  try { current = read(stagePath, "utf8"); } catch { /* The first shell stage creates the file. */ }
  const safeLines = String(current || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => EARLIER_RUNTIME_STAGE.test(line) || isAllowedShellStage(line));
  if (safeLines.at(-1) !== stage) safeLines.push(stage);
  try {
    write(stagePath, safeLines.slice(-MAXIMUM_STAGE_LINES).join("\n"), "utf8");
    return true;
  } catch {
    return false;
  }
}
