import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { app } from "electron";
import {
  assertNoSystemNodeInPath,
  environmentValue,
  keepOnlyRuntimeEnvironment,
  minimalRuntimeEnvironment,
} from "./environment-policy.mjs";
import { stopChild, waitForMessage } from "./utility-lifecycle.mjs";

app.disableHardwareAcceleration();
for (const commandLineSwitch of [
  "disable-breakpad",
  "disable-crash-reporter",
  "disable-gpu",
  "disable-gpu-compositing",
  "disable-software-rasterizer",
  "noerrdialogs",
]) app.commandLine.appendSwitch(commandLineSwitch);

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 5_000;
const OVERALL_TIMEOUT_MS = 75_000;
const children = [];
let webHandle;
let finishing = false;
let watchdog;

function recordStage(stage) {
  const stagePath = environmentValue(process.env, "THREADLIGHT_SMOKE_MAIN_STAGE_PATH");
  if (!stagePath) return;
  try { writeFileSync(stagePath, stage, "utf8"); } catch { /* Fixed smoke diagnostics are best-effort. */ }
}

recordStage("MODULE_LOADED");

function readGitVersion() {
  return new Promise((resolve, reject) => {
    execFile("git", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    }, (error, stdout) => {
      if (error) reject(new Error("DESKTOP_GIT_EXEC_FAILED"));
      else resolve(stdout);
    });
  });
}

function forkUtility(filename, args, environment, stagePrefix) {
  const entrypoint = path.join(`${app.getAppPath()}.unpacked`, "desktop", "workers", filename);
  if (!existsSync(entrypoint)) {
    recordStage(`${stagePrefix}_TARGET_MISSING`);
    throw new Error("DESKTOP_UTILITY_TARGET_MISSING");
  }
  recordStage(`${stagePrefix}_TARGET_PRESENT`);
  const worker = new Worker(entrypoint, {
    argv: args,
    env: { ...environment, THREADLIGHT_SMOKE_RESOURCE_ROOT: app.getAppPath() },
    execArgv: [],
    name: `threadlight-${stagePrefix.toLowerCase()}`,
  });
  const child = new EventEmitter();
  let alive = true;
  Object.defineProperty(child, "pid", {
    enumerable: true,
    get: () => alive ? worker.threadId : undefined,
  });
  child.send = (message) => worker.postMessage(message);
  child.postMessage = child.send;
  child.kill = () => {
    void worker.terminate();
    return true;
  };
  child.forceKill = child.kill;
  worker.once("online", () => child.emit("spawn"));
  worker.on("message", (message) => child.emit("message", message));
  worker.once("error", (error) => child.emit("error", error));
  worker.once("exit", (code) => {
    alive = false;
    child.emit("exit", code);
  });
  child.once("error", () => recordStage(`${stagePrefix}_FATAL_ERROR`));
  child.once("exit", (code) => {
    if (code === 0) return;
    if (code === 0xc0000135 || code === -1073741515) recordStage(`${stagePrefix}_EXIT_MISSING_DLL`);
    else recordStage(`${stagePrefix}_EXIT_NONZERO`);
  });
  children.push(child);
  return child;
}

async function startService(filename, args, environment, stagePrefix) {
  recordStage(`${stagePrefix}_FORKING`);
  const child = forkUtility(filename, args, environment, stagePrefix);
  recordStage(`${stagePrefix}_CREATED`);
  child.once("spawn", () => recordStage(`${stagePrefix}_SPAWNED`));
  const ready = await waitForMessage(child, "ready", START_TIMEOUT_MS);
  recordStage(`${stagePrefix}_READY`);
  return { child, ready };
}

async function stopAll() {
  let failed = false;
  for (const child of [...children].reverse()) {
    try {
      await stopChild(child, { gracefulTimeoutMs: STOP_TIMEOUT_MS, killTimeoutMs: KILL_TIMEOUT_MS });
    } catch {
      failed = true;
    }
  }
  try {
    await webHandle?.close();
  } catch {
    failed = true;
  }
  if (failed) throw new Error("DESKTOP_CLEANUP_FAILED");
}

async function finish(exitCode) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  try {
    await stopAll();
  } catch {
    exitCode = 1;
    recordStage("CLEANUP_FAILED");
  }
  if (exitCode === 0) recordStage("FINISHED_PASS");
  if (exitCode === 0) console.log("Threadlight desktop runtime compatibility: PASS");
  else console.error("Threadlight desktop runtime compatibility: FAIL (DESKTOP_SMOKE_FAILED)");
  process.exit(exitCode);
}

async function executeSmoke() {
  try {
    const expectedProfile = environmentValue(process.env, "THREADLIGHT_SMOKE_PROFILE_ROOT");
    if (!expectedProfile || path.resolve(app.getPath("userData")) !== path.resolve(expectedProfile)) {
      throw new Error("DESKTOP_PROFILE_NOT_ISOLATED");
    }
    app.setPath("crashDumps", path.join(expectedProfile, "crash-dumps"));
    app.setPath("logs", path.join(expectedProfile, "logs"));
    recordStage("APP_READY");

    assertNoSystemNodeInPath(process.env);
    recordStage("MAIN_NODE_GUARD_VERIFIED");

    const require = createRequire(import.meta.url);
    const sharp = require("sharp");
    if (!sharp?.versions?.vips) throw new Error("DESKTOP_NATIVE_MODULE_FAILED");
    recordStage("NATIVE_RUNTIME_VERIFIED");

    recordStage("MAIN_GIT_EXECUTING");
    const gitVersion = await readGitVersion();
    if (!/^git version /i.test(gitVersion)) throw new Error("DESKTOP_GIT_EXEC_FAILED");
    recordStage("MAIN_GIT_VERIFIED");

    const monitorEnvironmentPath = environmentValue(process.env, "THREADLIGHT_SMOKE_MONITOR_ENV_PATH");
    if (!monitorEnvironmentPath) throw new Error("DESKTOP_MONITOR_ENV_MISSING");
    const monitor = await startService(
      "monitor-host.cjs",
      [],
      minimalRuntimeEnvironment(process.env, {
        THREADLIGHT_SMOKE_MONITOR_ENV_PATH: monitorEnvironmentPath,
      }),
      "MONITOR",
    );
    recordStage("MONITOR_READY");

    keepOnlyRuntimeEnvironment(process.env, {
      THREADLIGHT_MONITOR_ORIGIN: monitor.ready.origin,
    });
    assertNoSystemNodeInPath(process.env);
    recordStage("WEB_ENVIRONMENT_STRIPPED");
    recordStage("WEB_IMPORTING");
    const { startWebServer } = await import("../web/server.mjs");
    recordStage("WEB_IMPORTED");
    recordStage("WEB_SERVER_STARTING");
    webHandle = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      monitorOrigin: monitor.ready.origin,
      outDir: path.join(`${app.getAppPath()}.unpacked`, "dist"),
      logger: Object.freeze({ log() {} }),
    });
    recordStage("WEB_SERVER_READY");

    recordStage("WEB_HEALTH_CHECKING");
    const [page, sessions] = await Promise.all([
      fetch(webHandle.origin),
      fetch(`${webHandle.origin}/api/sessions`),
    ]);
    if (page.status !== 200 || !/<title>Threadlight<\/title>/i.test(await page.text())) {
      throw new Error("DESKTOP_WEB_RUNTIME_FAILED");
    }
    if (sessions.status !== 200 || !Array.isArray((await sessions.json()).sessions)) {
      throw new Error("DESKTOP_PROVIDER_DISCOVERY_FAILED");
    }
    recordStage("WEB_HEALTH_VERIFIED");
    recordStage("RUNTIME_VERIFIED");
    await finish(0);
  } catch {
    await finish(1);
  }
}

watchdog = setTimeout(() => {
  recordStage("WATCHDOG_TIMEOUT");
  void finish(1);
}, OVERALL_TIMEOUT_MS);
app.on("before-quit", (event) => {
  if (finishing || !children.some((child) => child.pid)) return;
  event.preventDefault();
  recordStage("UNEXPECTED_QUIT");
  void finish(1);
});
process.once("uncaughtException", () => {
  recordStage("UNCAUGHT_EXCEPTION");
  void finish(1);
});
process.once("unhandledRejection", () => {
  recordStage("UNHANDLED_REJECTION");
  void finish(1);
});
void app.whenReady().then(executeSmoke, () => finish(1));
