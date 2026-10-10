import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { environmentValue, userSessionEnvironment } from "./environment-policy.mjs";

export const TASK_ISSUES_CHANNEL = "pomegr:task-issues";
export const TASK_ISSUES_OPERATIONS = Object.freeze(["status", "list", "promote", "create", "sign_in"]);
export const TASK_ISSUES_SIGN_IN_STATUSES = Object.freeze([
  "opened", "cancelled", "cli_missing", "unsupported_platform", "unavailable",
]);
export const TASK_ISSUES_PAYLOAD_MAX_BYTES = 16 * 1024;
export const TASK_ISSUES_SIGN_IN_ARGUMENTS = Object.freeze(["auth", "login", "--hostname", "github.com", "--web"]);
// The GitHub CLI needs a console to show its one-time code, and a windowless app has none. One fixed PowerShell
// command opens it; the executable and its arguments travel only as environment variables, read as values.
export const TASK_ISSUES_LAUNCH_ARGUMENTS = Object.freeze([
  "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  "$ErrorActionPreference='Stop';"
    + "$f=$env:POMEGR_START_FILE;$a=$env:POMEGR_START_ARGUMENTS;"
    + "Remove-Item Env:POMEGR_START_FILE,Env:POMEGR_START_ARGUMENTS;"
    + "Start-Process -FilePath $f -ArgumentList $a",
]);

const ROUTES = Object.freeze({ status: "github-status", list: "issues-list", promote: "issue-promote", create: "issue-create" });
// The fixed failures of a create: GitHub's own refusals travel as these strings and nothing else.
const CREATE_ERRORS = new Set(["cli_missing", "not_signed_in", "no_access", "issues_disabled", "failed"]);
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
// One create is a GitHub write behind the monitor's 20 second deadline, so it gets a longer wait than a read.
const CREATE_TIMEOUT_MS = 30_000;
const OPERATION_SET = new Set(TASK_ISSUES_OPERATIONS);
const MONITOR_ERRORS = new Set(["invalid", "not_found", "conflict", "limit", "unavailable"]);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const INVALID = Object.freeze({ ok: false, error: "invalid" });
const UNAVAILABLE = Object.freeze({ ok: false, error: "unavailable" });
const signInResult = (status) => Object.freeze({ ok: true, status });

function trustedMonitorOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "::1"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Serialized payload when it is a plain object of the right shape for the operation, otherwise null. */
function validPayload(operation, payload) {
  if (!isPlainObject(payload)) return null;
  const keys = Object.keys(payload);
  if (operation === "promote") {
    if (keys.length !== 2 || !keys.includes("number") || !keys.includes("digest")) return null;
    const { number, digest } = payload;
    if (!Number.isInteger(number) || number < 1 || number > 999_999_999) return null;
    if (typeof digest !== "string" || !DIGEST.test(digest)) return null;
  } else if (operation === "create") {
    if (keys.length !== 1 || !keys.includes("taskId") || typeof payload.taskId !== "string" || !TASK_ID.test(payload.taskId)) return null;
  } else if (keys.length !== 0) return null;
  try {
    const serialized = JSON.stringify(payload);
    return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= TASK_ISSUES_PAYLOAD_MAX_BYTES ? serialized : null;
  } catch { return null; }
}

/** The monitor's answer is the one place issue text crosses to the renderer; a refusal keeps only its fixed error. */
function boundedResult(response, body, operation) {
  if (!isPlainObject(body)) return UNAVAILABLE;
  if (body.ok === true && operation === "create") {
    // Only the issue number crosses: anything else the monitor said is dropped.
    return response.ok && Number.isInteger(body.number) && body.number >= 1 && body.number <= 999_999_999
      ? Object.freeze({ ok: true, number: body.number })
      : UNAVAILABLE;
  }
  if (body.ok === true) return response.ok ? body : UNAVAILABLE;
  if (body.ok === false && typeof body.error === "string"
    && (MONITOR_ERRORS.has(body.error) || (operation === "create" && CREATE_ERRORS.has(body.error)))) {
    return Object.freeze({ ok: false, error: body.error });
  }
  return UNAVAILABLE;
}

function safeDirectory(value) {
  return typeof value === "string" && value && !/[\u0000\r\n"]/u.test(value) && path.isAbsolute(value) ? path.resolve(value) : null;
}

/** The GitHub CLI executable on PATH or in its standard install folder; null when it cannot be found. */
function resolveGitHubCli(environment, fileExists) {
  const directories = (environmentValue(environment, "PATH") || "").split(path.delimiter);
  for (const name of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const root = environmentValue(environment, name);
    if (typeof root === "string" && root) directories.push(path.join(root, "GitHub CLI"));
  }
  for (const directory of directories) {
    const safe = safeDirectory(directory);
    if (!safe) continue;
    const candidate = path.join(safe, "gh.exe");
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function powershellExecutable(environment, fileExists) {
  const systemRoot = safeDirectory(environmentValue(environment, "SystemRoot"));
  if (!systemRoot) return null;
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fileExists(candidate) ? candidate : null;
}

function waitForLaunch(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || typeof child.once !== "function") { resolve(false); return; }
    let timer;
    const finish = (started) => {
      clearTimeout(timer);
      child.removeListener?.("exit", onExit);
      child.removeListener?.("error", onError);
      resolve(started);
    };
    const onExit = (code) => finish(code === 0);
    const onError = () => finish(false);
    child.once("exit", onExit);
    child.once("error", onError);
    // Only the short-lived launcher is stopped here, never the sign-in itself.
    timer = setTimeout(() => { try { child.kill?.(); } catch { /* already gone */ } finish(false); }, timeoutMs);
  });
}

/**
 * Native-only bridge for GitHub issues. The three monitor operations pass fixed, validated inputs and return the
 * monitor's bounded answer. Sign-in opens the GitHub CLI's own terminal sign-in after a native confirmation and
 * never reads, stores or forwards a GitHub credential, nor waits for the sign-in to finish.
 */
export function createTaskIssues(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const createTimeoutMs = options.createTimeoutMs ?? CREATE_TIMEOUT_MS;
  const launchTimeoutMs = options.launchTimeoutMs ?? 15_000;
  const platform = options.platform || process.platform;
  const sourceEnvironment = options.environment || process.env;
  const fileExists = options.fileExists || existsSync;
  const spawn = options.spawn || spawnChild;
  const dialog = options.dialog;
  const getWindow = options.getWindow || (() => null);
  // The native confirmation: the renderer supplies none of its text, and no window or dialog means no sign-in.
  const confirm = options.confirm || (async () => {
    const window = getWindow();
    if (!dialog?.showMessageBox || !window || window.isDestroyed?.()) return false;
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      title: "Sign in to GitHub",
      message: "Sign in to GitHub?",
      detail: "Pomegr opens the GitHub CLI's own sign-in in a terminal. Pomegr never reads or stores your GitHub credentials.",
      buttons: ["Sign in", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return answer.response === 0;
  });
  let disposed = false;
  let signingIn = false;

  async function signIn() {
    if (platform !== "win32") return signInResult("unsupported_platform");
    if (disposed || signingIn) return signInResult("unavailable");
    signingIn = true;
    try {
      const executable = resolveGitHubCli(sourceEnvironment, fileExists);
      if (!executable) return signInResult("cli_missing");
      const launcher = powershellExecutable(sourceEnvironment, fileExists);
      if (!launcher) return signInResult("unavailable");
      if (await confirm() !== true) return signInResult("cancelled");
      if (disposed) return signInResult("cancelled");
      let started = false;
      try {
        const child = spawn(launcher, [...TASK_ISSUES_LAUNCH_ARGUMENTS], {
          env: {
            ...userSessionEnvironment(sourceEnvironment),
            POMEGR_START_FILE: executable,
            POMEGR_START_ARGUMENTS: TASK_ISSUES_SIGN_IN_ARGUMENTS.join(" "),
          },
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
        started = await waitForLaunch(child, launchTimeoutMs);
      } catch { started = false; }
      return signInResult(started ? "opened" : "unavailable");
    } finally {
      signingIn = false;
    }
  }

  async function run(event, repositoryId, operation, payload) {
    if (!isTrustedEvent(event)) return INVALID;
    if (typeof operation !== "string" || !OPERATION_SET.has(operation)) return INVALID;
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return INVALID;
    const serialized = validPayload(operation, payload);
    if (serialized === null) return INVALID;
    if (operation === "sign_in") {
      try { return await signIn(); } catch { return signInResult("unavailable"); }
    }
    if (!monitorOrigin || !authorizationToken || disposed) return UNAVAILABLE;
    try {
      const response = await fetchImpl(`${monitorOrigin}/internal/tasks/${ROUTES[operation]}`, {
        method: "POST",
        cache: "no-store",
        headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": "application/json" },
        body: `{"repositoryId":${JSON.stringify(repositoryId)},"payload":${serialized}}`,
        signal: AbortSignal.timeout(operation === "create" ? createTimeoutMs : timeoutMs),
        redirect: "error",
      });
      let parsed = null;
      try { parsed = await response.json(); } catch { return UNAVAILABLE; }
      return boundedResult(response, parsed, operation);
    } catch {
      return UNAVAILABLE;
    }
  }

  return Object.freeze({ run, dispose() { disposed = true; } });
}

export function installTaskIssuesIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Task issues require ipcMain");
  ipcMain.removeHandler(TASK_ISSUES_CHANNEL);
  const action = options.action || createTaskIssues(options);
  ipcMain.handle(TASK_ISSUES_CHANNEL, async (event, repositoryId, operation, payload) => {
    try { return await action.run(event, repositoryId, operation, payload); } catch { return UNAVAILABLE; }
  });
  return () => { ipcMain.removeHandler(TASK_ISSUES_CHANNEL); action.dispose?.(); };
}
