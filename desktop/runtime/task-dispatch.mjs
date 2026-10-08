import { spawn as spawnChild } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { claudeDiscoveryEnvironment, resolveClaudeExecutable } from "./claude-auth.mjs";
import { environmentValue, nativeClaudeEnvironment, nativeCodexEnvironment } from "./environment-policy.mjs";
import { resolveCodexExecutable } from "./plugin-cli.mjs";
import { createTaskQueueRunner } from "./task-queue-runner.mjs";

export const TASK_START_CHANNEL = "pomegr:task-start";
export const TASK_START_STATUSES = Object.freeze([
  "started", "cancelled", "unsupported_platform", "cli_missing", "plugin_missing", "not_startable", "gate_held",
  "unsupported_provider", "not_found", "busy", "invalid", "unavailable", "failed",
]);

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const MONITOR_ERRORS = new Set(["invalid", "not_found", "not_startable", "unsupported_provider", "plugin_missing", "gate_held", "unavailable"]);
const PROMPT_MAX = 8000;
const LAUNCH_TIMEOUT_MS = 15_000;

// A detached child of a windowless app gets no console, so the session is opened through one fixed
// PowerShell command. The executable, its argument string and the directory travel only as environment
// variables: PowerShell reads them as values and never parses them as script.
export const TASK_START_LAUNCH_ARGUMENTS = Object.freeze([
  "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  "$ErrorActionPreference='Stop';"
    + "$f=$env:POMEGR_START_FILE;$a=$env:POMEGR_START_ARGUMENTS;$d=$env:POMEGR_START_DIRECTORY;"
    + "Remove-Item Env:POMEGR_START_FILE,Env:POMEGR_START_ARGUMENTS,Env:POMEGR_START_DIRECTORY;"
    + "Start-Process -FilePath $f -ArgumentList $a -WorkingDirectory $d",
]);

/** Quotes one argument the way the Windows C runtime parses a command line, so it arrives unchanged. */
export function windowsArgument(value) {
  if (value !== "" && !/[\s"]/u.test(value)) return value;
  let quoted = "\"";
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") { slashes += 1; continue; }
    quoted += character === "\"" ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${character}`;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

function powershellExecutable(environment, fileExists) {
  const systemRoot = environmentValue(environment, "SystemRoot");
  if (typeof systemRoot !== "string" || /[\u0000\r\n"]/u.test(systemRoot) || !path.isAbsolute(systemRoot)) return null;
  const candidate = path.join(path.resolve(systemRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fileExists(candidate) ? candidate : null;
}

const result = (status) => Object.freeze({ status });

// One entry per startable provider: where its CLI is, the environment it runs in, and its flags. A flag is
// passed only when the task sets it. Codex takes the effort as a configuration override and accepts every
// task effort by name, `xhigh` included.
const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    executable: (environment, fileExists) => resolveClaudeExecutable(claudeDiscoveryEnvironment(environment), fileExists),
    environment: nativeClaudeEnvironment,
    flags: (plan) => [...(plan.model ? ["--model", plan.model] : []), ...(plan.effort ? ["--effort", plan.effort] : [])],
  }),
  codex: Object.freeze({
    executable: (environment, fileExists, platform) => resolveCodexExecutable(environment, fileExists, { platform }),
    environment: nativeCodexEnvironment,
    flags: (plan) => [...(plan.model ? ["--model", plan.model] : []), ...(plan.effort ? ["-c", `model_reasoning_effort=${plan.effort}`] : [])],
  }),
});

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

function defaultDirectoryExists(directory) {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}

/** Returns a validated plan, or null when anything about it is unsafe to use. */
function validatePlan(plan, taskId, directoryExists) {
  if (!isPlainObject(plan) || !Object.hasOwn(PROVIDERS, plan.provider) || plan.taskId !== taskId) return null;
  if (!(plan.model === null || (typeof plan.model === "string" && MODEL.test(plan.model)))) return null;
  if (!(plan.effort === null || (typeof plan.effort === "string" && EFFORTS.has(plan.effort)))) return null;
  if (typeof plan.token !== "string" || !TOKEN.test(plan.token)) return null;
  const { prompt, repositoryRoot: root } = plan;
  if (typeof prompt !== "string" || !prompt || prompt.length > PROMPT_MAX || prompt.includes("\u0000") || prompt.startsWith("-")) return null;
  if (typeof root !== "string" || /[\u0000\r\n"]/u.test(root) || !path.isAbsolute(root) || path.resolve(root) !== root) return null;
  let exists = false;
  try { exists = directoryExists(root) === true; } catch { exists = false; }
  if (!exists) return null;
  return { provider: plan.provider, model: plan.model, effort: plan.effort, token: plan.token, prompt, root };
}

/** Resolves true when the launcher exits with code 0 in time, false otherwise. Never throws. */
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
    // Only the short-lived launcher is ever stopped here, never a started session.
    timer = setTimeout(() => { try { child.kill?.(); } catch { /* already gone */ } finish(false); }, timeoutMs);
  });
}

/**
 * Native-only start of one Claude Code or Codex session for one task. The confirmation precedes the plan
 * request because the monitor mints a single-use token with the plan, so the provider is known only after it:
 * a start is refused before the confirmation when no provider CLI is installed, and after the plan when the
 * task's own provider CLI is missing. The session runs in its own terminal window and is never killed or
 * tracked by Pomegr. Nothing but a fixed status reaches the renderer. The queue runner starts the next task
 * through `startQueued`, the same path without a renderer event or a confirmation, because the user turned the
 * queue on; both entry points share one in-flight slot, so a manual and a queued start never overlap.
 */
export function createTaskStart(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const launchTimeoutMs = options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
  const platform = options.platform || process.platform;
  const sourceEnvironment = options.environment || process.env;
  const fileExists = options.fileExists || existsSync;
  const directoryExists = options.directoryExists || defaultDirectoryExists;
  const spawn = options.spawn || spawnChild;
  const confirm = options.confirm || (async () => false);
  let disposed = false;
  let active = false;

  async function post(route, repositoryId, payload) {
    const response = await fetchImpl(`${monitorOrigin}/internal/tasks/${route}`, {
      method: "POST",
      cache: "no-store",
      headers: { [DESKTOP_AUTH_HEADER]: authorizationToken, "content-type": "application/json" },
      body: JSON.stringify({ repositoryId, payload }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    return response.json();
  }

  async function abort(repositoryId, taskId, token) {
    try { await post("start-abort", repositoryId, { id: taskId, token }); } catch { /* best effort */ }
  }

  async function run(repositoryId, taskId, { confirmRequired }) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return result("invalid");
    if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return result("invalid");
    if (disposed || !monitorOrigin || !authorizationToken) return result("unavailable");
    if (platform !== "win32") return result("unsupported_platform");
    const executables = {};
    for (const [name, provider] of Object.entries(PROVIDERS)) {
      try { executables[name] = provider.executable(sourceEnvironment, fileExists, platform) || null; } catch { executables[name] = null; }
    }
    if (!Object.values(executables).some(Boolean)) return result("cli_missing");
    const launcher = powershellExecutable(sourceEnvironment, fileExists);
    if (!launcher) return result("unavailable");
    if (confirmRequired && await confirm({ taskId }) !== true) return result("cancelled");
    if (disposed) return result("cancelled");

    let answer;
    try { answer = await post("start-plan", repositoryId, { id: taskId }); } catch { return result("unavailable"); }
    if (!isPlainObject(answer)) return result("unavailable");
    if (answer.ok !== true) {
      return result(typeof answer.error === "string" && MONITOR_ERRORS.has(answer.error) ? answer.error : "unavailable");
    }
    const rawToken = isPlainObject(answer.plan) && typeof answer.plan.token === "string" && TOKEN.test(answer.plan.token)
      ? answer.plan.token : null;
    const plan = validatePlan(answer.plan, taskId, directoryExists);
    if (!plan) {
      if (rawToken) await abort(repositoryId, taskId, rawToken);
      return result("failed");
    }

    const provider = PROVIDERS[plan.provider];
    const executable = executables[plan.provider];
    if (!executable) {
      await abort(repositoryId, taskId, plan.token);
      return result("cli_missing");
    }
    const args = [...provider.flags(plan), plan.prompt];
    let started = false;
    try {
      const child = spawn(launcher, [...TASK_START_LAUNCH_ARGUMENTS], {
        cwd: plan.root,
        env: {
          ...provider.environment(sourceEnvironment),
          POMEGR_TASK_TOKEN: plan.token,
          POMEGR_START_FILE: executable,
          POMEGR_START_ARGUMENTS: args.map(windowsArgument).join(" "),
          POMEGR_START_DIRECTORY: plan.root,
        },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      started = await waitForLaunch(child, launchTimeoutMs);
    } catch { started = false; }
    if (!started) {
      await abort(repositoryId, taskId, plan.token);
      return result("failed");
    }
    return result("started");
  }

  async function exclusive(mode, repositoryId, taskId) {
    if (active) return result("busy");
    active = true;
    try { return await run(repositoryId, taskId, mode); } catch { return result("failed"); } finally { active = false; }
  }

  async function start(event, repositoryId, taskId) {
    if (!isTrustedEvent(event)) return result("invalid");
    return exclusive({ confirmRequired: true }, repositoryId, taskId);
  }

  // Only the queue runner calls this, and only for a repository whose queue the user turned on.
  function startQueued(repositoryId, taskId) {
    return exclusive({ confirmRequired: false }, repositoryId, taskId);
  }

  // A started session is never touched: dispose only refuses further starts.
  return Object.freeze({ start, startQueued, dispose() { disposed = true; } });
}

export function installTaskStartIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Task start requires ipcMain");
  ipcMain.removeHandler(TASK_START_CHANNEL);
  const starter = options.starter || createTaskStart(options);
  // The runner is optional: an injected object replaces it and `false` turns it off. It arms no timer until
  // `start()`, and then only with a trusted monitor origin and a token.
  const runner = options.queueRunner === false ? null : options.queueRunner || createTaskQueueRunner({
    starter, fetch: options.fetch, monitorOrigin: options.monitorOrigin, authorizationToken: options.authorizationToken,
  });
  ipcMain.handle(TASK_START_CHANNEL, async (event, repositoryId, taskId) => {
    try { return await starter.start(event, repositoryId, taskId); } catch { return result("failed"); }
  });
  runner?.start();
  return () => { ipcMain.removeHandler(TASK_START_CHANNEL); runner?.dispose(); starter.dispose?.(); };
}
