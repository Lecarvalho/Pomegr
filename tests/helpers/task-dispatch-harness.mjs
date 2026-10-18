import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTaskStart } from "../../desktop/runtime/task-dispatch.mjs";

export const repositoryId = "repo-0123456789abcdef01234567";
export const trusted = { trusted: true };
export const origin = "http://127.0.0.1:4317";
export const exe = "C:\\Users\\tester\\.local\\bin\\claude.exe";
export const codexExe = "C:\\Users\\tester\\.local\\bin\\codex.exe";
export const root = "C:\\Work\\repo";
export const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export const token = "A".repeat(43);
// The session gets the user's environment as inherited; only this app's own runtime variables are left out.
export const sessionEnvironment = { USERPROFILE: "C:\\Users\\tester", PATH: "C:\\Windows;C:\\Program Files\\nodejs", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\tester\\AppData\\Roaming", HTTPS_PROXY: "http://proxy.test:8080" };
export const environment = { ...sessionEnvironment, ELECTRON_RUN_AS_NODE: "1", POMEGR_MONITOR_TOKEN: "app-private", POMEGR_SMOKE_NO_SYSTEM_NODE: "1", POMEGR_TASK_TOKEN: "stale" };

export const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
export const basePlan = () => ({ taskId: "T-3", provider: "claude", model: null, effort: null, repositoryRoot: root, prompt: "Do the thing", token });

/** The launcher process: exits with `outcome` as its code, emits an error, or never ends ("hang"). */
export function fakeChild(outcome = 0) {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  if (outcome === "error") queueMicrotask(() => child.emit("error", new Error("x")));
  else if (outcome !== "hang") queueMicrotask(() => child.emit("exit", outcome));
  return child;
}

export function harness({ plan = basePlan(), answer, spawnImpl, confirmImpl, overrides = {} } = {}) {
  const log = [];
  const calls = [];
  const spawns = [];
  const start = createTaskStart({
    isTrustedEvent: (e) => e?.trusted === true,
    monitorOrigin: origin,
    authorizationToken: "secret",
    platform: "win32",
    environment,
    fileExists: (f) => f === exe || f === powershell,
    directoryExists: (d) => d === root,
    confirm: confirmImpl || (async (info) => { log.push("confirm"); assert.deepEqual(info, { taskId: "T-3", separateWorktree: false }); return true; }),
    fetch: async (url, options) => {
      log.push(url.split("/").pop());
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url.endsWith("start-abort")) return json({ ok: true });
      if (typeof answer === "function") return answer(url, options);
      return answer || json({ ok: true, plan });
    },
    spawn: spawnImpl || ((...args) => { spawns.push(args); return fakeChild(); }),
    ...overrides,
  });
  return { start, log, calls, spawns };
}

export const go = (h, id = "T-3", repo = repositoryId, event = trusted) => h.start.start(event, repo, id);
export const aborted = (h) => h.calls.filter((c) => c.url.endsWith("start-abort"));
