import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { DESKTOP_AUTH_HEADER } from "../../shared/local-auth.mjs";
import { claudeDiscoveryEnvironment, resolveClaudeExecutable } from "./claude-auth.mjs";
import { userSessionEnvironment } from "./environment-policy.mjs";
import { resolveCodexExecutable } from "./plugin-cli.mjs";
import { createTaskQueueRunner } from "./task-queue-runner.mjs";
import { createTaskWorktrees } from "./task-worktree.mjs";
import { createTerminalController, installTerminalIpc } from "./terminal.mjs";

export const TASK_WORKTREE_OPEN_CHANNEL = "pomegr:task-worktree-open";
export const TASK_WORKTREE_OPEN_STATUSES = Object.freeze(["opened", "not_found", "invalid", "unavailable"]);

export const TASK_START_CHANNEL = "pomegr:task-start";
export const TASK_REVIEW_START_CHANNEL = "pomegr:task-review-start";
export const TASK_START_STATUSES = Object.freeze([
  "started", "cancelled", "unsupported_platform", "cli_missing", "plugin_missing", "not_startable", "gate_held",
  "unsupported_provider", "not_found", "busy", "invalid", "unavailable", "failed", "worktree_dirty", "tree_dirty",
]);

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const MONITOR_ERRORS = new Set(["invalid", "not_found", "not_startable", "unsupported_provider", "plugin_missing", "gate_held", "tree_dirty", "unavailable"]);
const PROMPT_MAX = 8000;
const IMAGE_MAX = 4;
const IMAGE_FILE = /^img-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/u;

export function taskStartConfirmation({ taskId, separateWorktree } = {}) {
  return separateWorktree === true
    ? {
      message: `Start task ${taskId} in a separate worktree?`,
      detail: "A session will open in the Pomegr Terminal tab in a worktree of the task's own, on the task's branch at this repository's current commit, on the provider set in the task's Run on (Claude Code when none is set). The uncommitted changes in this repository are not part of it and are left untouched.",
    }
    : {
      message: `Start task ${taskId}?`,
      detail: "A session will open in the Pomegr Terminal tab in this repository, or in the task's own worktree when it runs in a parallel group, on the provider set in the task's Run on (Claude Code when none is set).",
    };
}

export async function confirmTaskStart(dialog, getWindow, request) {
  const window = getWindow();
  if (!window || window.isDestroyed()) return false;
  const answer = await dialog.showMessageBox(window, {
    type: "question",
    title: "Start a session",
    ...taskStartConfirmation(request),
    buttons: ["Start session", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return answer.response === 0;
}

const result = (status) => Object.freeze({ status });

export async function confirmTaskReviewStart(dialog, getWindow, { taskId }) {
  const window = getWindow();
  if (!window || window.isDestroyed()) return false;
  const answer = await dialog.showMessageBox(window, {
    type: "question",
    title: "Start a review session?",
    message: `Pomegr starts a separate session that reviews ${taskId}'s work in its folder and reports a verdict. It changes no code and does not move the task.`,
    buttons: ["Start review", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return answer.response === 0;
}

// One entry per startable provider; a flag is passed only when the task sets it.
const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    executable: (environment, fileExists) => resolveClaudeExecutable(claudeDiscoveryEnvironment(environment), fileExists),
    flags: (plan) => [...(plan.model ? ["--model", plan.model] : []), ...(plan.effort ? ["--effort", plan.effort] : [])],
    // The prompt names the image files; the folder that holds them is opened to the session's read tools.
    imageFlags: (plan) => ["--add-dir", path.dirname(plan.images[0])],
    // `--remote-control` takes an optional name, so it follows the prompt: before it, it would take the prompt as the name.
    remoteControlFlags: () => ["--remote-control"],
  }),
  codex: Object.freeze({
    executable: (environment, fileExists, platform) => resolveCodexExecutable(environment, fileExists, { platform }),
    flags: (plan) => [...(plan.model ? ["--model", plan.model] : []), ...(plan.effort ? ["-c", `model_reasoning_effort=${plan.effort}`] : [])],
    imageFlags: (plan) => ["--image", ...plan.images],
  }),
});

export function resolveSessionExecutable(provider, environment, fileExists = existsSync, platform = process.platform) {
  return Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider].executable(environment, fileExists, platform) : null;
}

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

function planImages(images, prompt, fileExists) {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > IMAGE_MAX) return null;
  for (const file of images) {
    if (typeof file !== "string" || /[\u0000\r\n"]/u.test(file) || !path.isAbsolute(file) || path.resolve(file) !== file) return null;
    if (!IMAGE_FILE.test(path.basename(file)) || path.dirname(file) !== path.dirname(images[0]) || !prompt.includes(file)) return null;
    let exists = false;
    try { exists = fileExists(file) === true; } catch { exists = false; }
    if (!exists) return null;
  }
  return new Set(images).size === images.length ? [...images] : null;
}

function validatePlan(plan, taskId, directoryExists, fileExists) {
  if (!isPlainObject(plan) || !Object.hasOwn(PROVIDERS, plan.provider) || plan.taskId !== taskId) return null;
  if (!(plan.model === null || (typeof plan.model === "string" && MODEL.test(plan.model)))) return null;
  if (!(plan.effort === null || (typeof plan.effort === "string" && EFFORTS.has(plan.effort)))) return null;
  if (typeof plan.token !== "string" || !TOKEN.test(plan.token)) return null;
  if (!(plan.worktree === undefined || typeof plan.worktree === "boolean")) return null;
  if (!(plan.sendBack === undefined || typeof plan.sendBack === "boolean")) return null;
  if (!(plan.remoteControl === undefined || typeof plan.remoteControl === "boolean")) return null;
  if (plan.remoteControl === true && typeof PROVIDERS[plan.provider].remoteControlFlags !== "function") return null;
  const { prompt, repositoryRoot: root } = plan;
  if (typeof prompt !== "string" || !prompt || prompt.length > PROMPT_MAX || prompt.includes("\u0000") || prompt.startsWith("-")) return null;
  if (typeof root !== "string" || /[\u0000\r\n"]/u.test(root) || !path.isAbsolute(root) || path.resolve(root) !== root) return null;
  let exists = false;
  try { exists = directoryExists(root) === true; } catch { exists = false; }
  if (!exists) return null;
  const images = planImages(plan.images, prompt, fileExists);
  if (images === null) return null;
  return { provider: plan.provider, model: plan.model, effort: plan.effort, token: plan.token, prompt, root, worktree: plan.worktree === true, sendBack: plan.sendBack === true, remoteControl: plan.remoteControl === true, images };
}

/** Native-only start of one session for one task. Manual and queued starts share one in-flight slot; only a fixed status reaches the renderer. */
export function createTaskStart(options = {}) {
  const isTrustedEvent = options.isTrustedEvent || (() => false);
  const fetchImpl = options.fetch || fetch;
  const monitorOrigin = trustedMonitorOrigin(options.monitorOrigin);
  const authorizationToken = options.authorizationToken;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const platform = options.platform || process.platform;
  const sourceEnvironment = options.environment || process.env;
  const fileExists = options.fileExists || existsSync;
  const directoryExists = options.directoryExists || defaultDirectoryExists;
  const terminal = options.terminal || createTerminalController(options);
  const confirm = options.confirm || (async () => false);
  const worktrees = options.worktrees
    || (options.worktreeRoot ? createTaskWorktrees({ root: options.worktreeRoot, environment: sourceEnvironment, platform }) : null);
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

  async function run(repositoryId, taskId, { confirmRequired, separateWorktree = false, isAuthorized, grant = false }) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return result("invalid");
    if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return result("invalid");
    if (disposed || !monitorOrigin || !authorizationToken) return result("unavailable");
    if (platform !== "win32") return result("unsupported_platform");
    const executables = {};
    for (const name of Object.keys(PROVIDERS)) {
      try { executables[name] = resolveSessionExecutable(name, sourceEnvironment, fileExists, platform) || null; } catch { executables[name] = null; }
    }
    if (!Object.values(executables).some(Boolean)) return result("cli_missing");
    if (confirmRequired && await confirm({ taskId, separateWorktree }) !== true) return result("cancelled");
    if (disposed) return result("cancelled");
    const authorized = async () => {
      if (disposed) return false;
      if (typeof isAuthorized !== "function") return true;
      try { return await isAuthorized() === true && !disposed; } catch { return false; }
    };
    if (!await authorized()) return result("cancelled");

    let answer;
    try { answer = await post("start-plan", repositoryId, { id: taskId, ...(separateWorktree ? { worktree: true } : {}), ...(grant ? { grant: true } : {}) }); } catch { return result("unavailable"); }
    if (!isPlainObject(answer)) return result("unavailable");
    if (answer.ok !== true) {
      return result(typeof answer.error === "string" && MONITOR_ERRORS.has(answer.error) ? answer.error : "unavailable");
    }
    const rawToken = isPlainObject(answer.plan) && typeof answer.plan.token === "string" && TOKEN.test(answer.plan.token)
      ? answer.plan.token : null;
    if (!await authorized()) {
      if (rawToken) await abort(repositoryId, taskId, rawToken);
      return result("cancelled");
    }
    const validated = validatePlan(answer.plan, taskId, directoryExists, fileExists);
    // A start the owner confirmed for a separate worktree never runs in the repository root.
    const plan = separateWorktree && validated?.worktree !== true ? null : validated;
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
    let directory = plan.root;
    let made = null;
    const place = { repositoryRoot: plan.root, repositoryId, taskId };
    let located = null;
    if (plan.sendBack && worktrees?.locate) {
      try { located = await worktrees.locate(place); } catch { located = undefined; }
      if (located === undefined || (located !== null && (typeof located !== "string" || !path.isAbsolute(located) || /[\u0000\r\n"]/u.test(located)))) {
        await abort(repositoryId, taskId, plan.token);
        return result("failed");
      }
      if (located !== null) directory = located;
    }
    if (plan.worktree && located === null) {
      try { made = worktrees ? await worktrees.ensure(place) : null; } catch { made = null; }
      if (made?.ok !== true || typeof made.directory !== "string" || !path.isAbsolute(made.directory) || /[\u0000\r\n"]/u.test(made.directory)) {
        await abort(repositoryId, taskId, plan.token);
        return result(made?.ok === false && made.reason === "dirty" ? "worktree_dirty" : "failed");
      }
      directory = made.directory;
    }
    // Both image flags take a list of values, so they follow the prompt: a flag before it would swallow it.
    const args = [
      ...provider.flags(plan), plan.prompt,
      ...(plan.remoteControl ? provider.remoteControlFlags(plan) : []),
      ...(plan.images.length > 0 ? provider.imageFlags(plan) : []),
    ];
    let started = false;
    if (!await authorized()) {
      await abort(repositoryId, taskId, plan.token);
      if (made?.created === true) {
        try { await worktrees.remove({ repositoryRoot: plan.root, repositoryId, taskId, deleteBranch: made.branchCreated === true }); } catch { /* kept */ }
      }
      return result("cancelled");
    }
    try {
      await terminal.ensureHost();
      if (!await authorized()) {
        await abort(repositoryId, taskId, plan.token);
        if (made?.created === true) {
          try { await worktrees.remove({ repositoryRoot: plan.root, repositoryId, taskId, deleteBranch: made.branchCreated === true }); } catch { /* kept */ }
        }
        return result("cancelled");
      }
      await terminal.create({
        key: `${repositoryId}/${taskId}/${randomBytes(16).toString("hex")}`,
        executable, args, cwd: directory, env: { ...userSessionEnvironment(sourceEnvironment), POMEGR_TASK_TOKEN: plan.token }, cols: 80, rows: 24,
      });
      started = true;
    } catch { started = false; }
    if (!started) {
      await abort(repositoryId, taskId, plan.token);
      if (made?.created === true) {
        try { await worktrees.remove({ repositoryRoot: plan.root, repositoryId, taskId, deleteBranch: made.branchCreated === true }); } catch { /* kept */ }
      }
      return result("failed");
    }
    return result("started");
  }

  // The monitor's root of the repository, for a worktree inside it; null when it has none.
  async function repositoryRoot(repositoryId) {
    if (!monitorOrigin || !authorizationToken) return null;
    try {
      const answer = await post("worktree-root", repositoryId, {});
      return isPlainObject(answer) && answer.ok === true && typeof answer.root === "string" ? answer.root : null;
    } catch { return null; }
  }

  /** Removes a done task's worktree and branch when nothing would be lost; answers the fixed outcome of the removal. */
  async function cleanWorktree(repositoryId, taskId, root) {
    if (disposed || !worktrees?.remove) return "failed";
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || typeof taskId !== "string" || !TASK_ID.test(taskId)) return "failed";
    try { return await worktrees.remove({ repositoryRoot: root, repositoryId, taskId, deleteBranch: true }); } catch { return "failed"; }
  }

  async function exclusive(mode, repositoryId, taskId) {
    if (active) return result("busy");
    active = true;
    try { return await (mode.review ? runReview(repositoryId, taskId, mode) : run(repositoryId, taskId, mode)); } catch { return result("failed"); } finally { active = false; }
  }

  async function runReview(repositoryId, taskId, { confirmRequired, isAuthorized, run }) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return result("invalid");
    if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return result("invalid");
    if (disposed || !monitorOrigin || !authorizationToken) return result("unavailable");
    if (platform !== "win32") return result("unsupported_platform");
    const executables = {};
    for (const name of Object.keys(PROVIDERS)) {
      try { executables[name] = resolveSessionExecutable(name, sourceEnvironment, fileExists, platform) || null; } catch { executables[name] = null; }
    }
    if (!Object.values(executables).some(Boolean)) return result("cli_missing");
    if (confirmRequired && await options.confirmReview?.({ taskId }) !== true) return result("cancelled");
    const authorized = async () => {
      if (disposed) return false;
      if (typeof isAuthorized !== "function") return true;
      try { return await isAuthorized() === true && !disposed; } catch { return false; }
    };
    if (!await authorized()) return result("cancelled");
    let answer;
    try { answer = await post("review-plan", repositoryId, { id: taskId, ...(run ? { provider: run.provider, model: run.model, effort: run.effort } : {}) }); } catch { return result("unavailable"); }
    if (!isPlainObject(answer)) return result("unavailable");
    if (answer.ok !== true) return result(typeof answer.error === "string" && MONITOR_ERRORS.has(answer.error) ? answer.error : "unavailable");
    const raw = isPlainObject(answer.plan) ? answer.plan : {};
    const token = typeof raw.token === "string" && TOKEN.test(raw.token) ? raw.token : null;
    if (!await authorized()) {
      if (token) { try { await post("review-abort", repositoryId, { id: taskId, token }); } catch { /* best effort */ } }
      return result("cancelled");
    }
    let status = "failed";
    try {
      const { provider, model, effort, prompt, repositoryRoot } = raw;
      const plan = validatePlan({ taskId: raw.taskId, provider, model, effort, prompt, repositoryRoot, token }, taskId, directoryExists, fileExists);
      if (disposed) status = "cancelled";
      else if (plan) {
        const executable = executables[plan.provider];
        if (!executable) status = "cli_missing";
        else {
          const located = await worktrees?.locate({ repositoryRoot: plan.root, repositoryId, taskId });
          const cwd = typeof located === "string" && path.isAbsolute(located) && !/[\u0000\r\n"]/u.test(located)
            && directoryExists(located) ? located : plan.root;
          if (!await authorized()) status = "cancelled";
          else {
            await terminal.ensureHost();
            if (!await authorized()) status = "cancelled";
            else {
              await terminal.create({
                key: `${repositoryId}/${taskId}/review-${randomBytes(16).toString("hex")}`,
                executable, args: [...PROVIDERS[plan.provider].flags(plan), plan.prompt], cwd,
                env: { ...userSessionEnvironment(sourceEnvironment), POMEGR_TASK_TOKEN: plan.token }, cols: 80, rows: 24,
              });
              return result("started");
            }
          }
        }
      }
    } catch { status = "failed"; }
    if (token) {
      try { await post("review-abort", repositoryId, { id: taskId, token }); } catch { /* best effort */ }
    }
    return result(status);
  }

  async function startReview(event, repositoryId, taskId) {
    if (!isTrustedEvent(event)) return result("invalid");
    return exclusive({ review: true, confirmRequired: true }, repositoryId, taskId);
  }

  async function start(event, repositoryId, taskId, separateWorktree) {
    if (!isTrustedEvent(event)) return result("invalid");
    if (separateWorktree !== undefined && separateWorktree !== true) return result("invalid");
    return exclusive({ confirmRequired: true, separateWorktree: separateWorktree === true }, repositoryId, taskId);
  }

  // Apply approves the stored chat proposal. The ordinary manual start still owns native confirmation and every gate.
  async function startApproved(event, repositoryId, taskId) {
    return start(event, repositoryId, taskId);
  }

  function startQueued(repositoryId, taskId) {
    return exclusive({ confirmRequired: false }, repositoryId, taskId);
  }

  function startGranted(repositoryId, taskId, isAuthorized) {
    if (typeof isAuthorized !== "function") return Promise.resolve(result("invalid"));
    return exclusive({ confirmRequired: false, isAuthorized, grant: true }, repositoryId, taskId);
  }

  function startGrantedReview(repositoryId, taskId, isAuthorized, run) {
    if (typeof isAuthorized !== "function") return Promise.resolve(result("invalid"));
    return exclusive({ review: true, confirmRequired: false, isAuthorized, run }, repositoryId, taskId);
  }

  function startPaired(repositoryId, taskId, separateWorktree, isAuthorized) {
    if (separateWorktree !== undefined && separateWorktree !== true) return Promise.resolve(result("invalid"));
    if (typeof isAuthorized !== "function") return Promise.resolve(result("invalid"));
    return exclusive({ confirmRequired: false, separateWorktree: separateWorktree === true, isAuthorized }, repositoryId, taskId);
  }

  async function openWorktree(event, repositoryId, taskId) {
    if (!isTrustedEvent(event)) return result("invalid");
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return result("invalid");
    if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return result("invalid");
    if (disposed || platform !== "win32" || !worktrees?.locate || typeof options.openPath !== "function") return result("unavailable");
    let directory = null;
    try { directory = await worktrees.locate({ repositoryRoot: await repositoryRoot(repositoryId), repositoryId, taskId }); } catch { directory = null; }
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return result("not_found");
    try {
      const failure = await options.openPath(directory);
      return result(failure === "" ? "opened" : "unavailable");
    } catch { return result("unavailable"); }
  }

  // A started session is never touched: dispose only refuses further starts.
  return Object.freeze({ start, startReview, startApproved, startQueued, startGranted, startGrantedReview, startPaired, openWorktree, cleanWorktree, terminal, dispose() { disposed = true; terminal.dispose?.(); } });
}

export function installTaskStartIpc(options = {}) {
  const ipcMain = options.ipcMain;
  if (!ipcMain?.handle || !ipcMain?.removeHandler) throw new TypeError("Task start requires ipcMain");
  ipcMain.removeHandler(TASK_START_CHANNEL);
  const starter = options.starter || createTaskStart(options);
  const runner = options.queueRunner === false ? null : options.queueRunner || createTaskQueueRunner({
    starter, fetch: options.fetch, monitorOrigin: options.monitorOrigin, authorizationToken: options.authorizationToken, grantWrite: options.grantWrite, repositoryGithub: options.repositoryGithub,
  });
  ipcMain.handle(TASK_START_CHANNEL, async (event, repositoryId, taskId, separateWorktree) => {
    try { return await starter.start(event, repositoryId, taskId, separateWorktree); } catch { return result("failed"); }
  });
  ipcMain.removeHandler(TASK_REVIEW_START_CHANNEL);
  ipcMain.handle(TASK_REVIEW_START_CHANNEL, async (event, repositoryId, taskId) => {
    try { return await starter.startReview(event, repositoryId, taskId); } catch { return result("failed"); }
  });
  ipcMain.removeHandler(TASK_WORKTREE_OPEN_CHANNEL);
  ipcMain.handle(TASK_WORKTREE_OPEN_CHANNEL, async (event, repositoryId, taskId) => {
    try { return await starter.openWorktree(event, repositoryId, taskId); } catch { return result("unavailable"); }
  });
  const removeTerminal = starter.terminal ? installTerminalIpc({ ipcMain, controller: starter.terminal }) : () => {};
  runner?.start();
  return () => { ipcMain.removeHandler(TASK_START_CHANNEL); ipcMain.removeHandler(TASK_REVIEW_START_CHANNEL); ipcMain.removeHandler(TASK_WORKTREE_OPEN_CHANNEL); runner?.dispose(); removeTerminal(); starter.dispose?.(); };
}
