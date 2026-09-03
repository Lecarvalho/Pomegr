import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { app, BrowserWindow, session } from "electron";
import {
  assertNoSystemNodeInPath,
  environmentValue,
  keepOnlyRuntimeEnvironment,
  minimalRuntimeEnvironment,
} from "./environment-policy.mjs";
import { stopChild, waitForMessage } from "./utility-lifecycle.mjs";
import { withDeadline } from "./bounded-lifecycle.mjs";
import {
  DESKTOP_CSP,
  installSessionSecurity,
  installWebContentsSecurity,
  secureBrowserWindowOptions,
} from "./security-policy.mjs";
import { resolveDesktopPaths } from "./paths.mjs";
import {
  createAgentQueryCapability,
  fetchAgentQuery,
  resolveAgentQueryDescriptorPath,
} from "../shared/agent-query-transport.mjs";

app.disableHardwareAcceleration();
for (const commandLineSwitch of [
  "disable-breakpad",
  "disable-crash-reporter",
  "disable-gpu",
  "disable-gpu-compositing",
  "noerrdialogs",
]) app.commandLine.appendSwitch(commandLineSwitch);

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 5_000;
const OVERALL_TIMEOUT_MS = 75_000;
const children = [];
let webHandle;
let agentQueryDescriptorPath;
let smokeWindow;
let finishing = false;
let watchdog;
let runtimePaths;
let lastStage = "MODULE_LOADING";
const rendererMode = environmentValue(process.env, "POMEGR_SMOKE_RENDERER_MODE") === "runtime"
  ? "runtime"
  : "window";

function recordStage(stage) {
  lastStage = stage;
  const stagePath = environmentValue(process.env, "POMEGR_SMOKE_MAIN_STAGE_PATH");
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

function forkUtility(filename, args, environment, stagePrefix, workerData) {
  const entrypoint = path.join(runtimePaths.unpackedRoot, "desktop", "workers", filename);
  if (!existsSync(entrypoint)) {
    recordStage(`${stagePrefix}_TARGET_MISSING`);
    throw new Error("DESKTOP_UTILITY_TARGET_MISSING");
  }
  recordStage(`${stagePrefix}_TARGET_PRESENT`);
  const worker = new Worker(entrypoint, {
    argv: args,
    env: { ...environment, POMEGR_SMOKE_RESOURCE_ROOT: runtimePaths.applicationRoot },
    execArgv: [],
    name: `pomegr-${stagePrefix.toLowerCase()}`,
    workerData,
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

async function startService(filename, args, environment, stagePrefix, workerData) {
  recordStage(`${stagePrefix}_FORKING`);
  const child = forkUtility(filename, args, environment, stagePrefix, workerData);
  recordStage(`${stagePrefix}_CREATED`);
  child.once("spawn", () => recordStage(`${stagePrefix}_SPAWNED`));
  const ready = await waitForMessage(child, "ready", START_TIMEOUT_MS);
  recordStage(`${stagePrefix}_READY`);
  return { child, ready };
}

async function stopAll() {
  let failed = false;
  recordStage("CLEANUP_WINDOW_CLOSING");
  try { smokeWindow?.destroy(); } catch { failed = true; }
  recordStage("CLEANUP_WINDOW_CLOSED");
  for (const child of [...children].reverse()) {
    recordStage("CLEANUP_WORKER_STOPPING");
    try {
      await stopChild(child, { gracefulTimeoutMs: STOP_TIMEOUT_MS, killTimeoutMs: KILL_TIMEOUT_MS });
    } catch {
      failed = true;
    }
  }
  recordStage("CLEANUP_WORKERS_STOPPED");
  if (agentQueryDescriptorPath && existsSync(agentQueryDescriptorPath)) failed = true;
  try {
    if (webHandle) await withDeadline(webHandle.close(), STOP_TIMEOUT_MS, "DESKTOP_SMOKE_WEB_STOP_TIMEOUT");
  } catch {
    try { webHandle?.server?.closeAllConnections?.(); } catch { /* The fixed cleanup result remains authoritative. */ }
    failed = true;
  }
  recordStage("CLEANUP_WEB_STOPPED");
  if (failed) throw new Error("DESKTOP_CLEANUP_FAILED");
}

function writeResult(message, stream) {
  return new Promise((resolve) => stream.write(`${message}\n`, resolve));
}

async function finish(exitCode) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  const failedAt = exitCode === 0 ? null : lastStage;
  let cleanupFailed = false;
  try {
    await stopAll();
  } catch {
    exitCode = 1;
    cleanupFailed = true;
    recordStage("CLEANUP_FAILED");
  }
  if (exitCode === 0) recordStage("FINISHED_PASS");
  else if (!cleanupFailed && failedAt) recordStage(failedAt);
  if (exitCode === 0) await writeResult(`Pomegr desktop runtime compatibility: PASS (${rendererMode})`, process.stdout);
  else await writeResult("Pomegr desktop runtime compatibility: FAIL (DESKTOP_SMOKE_FAILED)", process.stderr);
  setImmediate(() => process.exit(exitCode));
}

async function executeSmoke() {
  try {
    const authorizationToken = randomBytes(32).toString("base64url");
    const agentAuthorizationToken = createAgentQueryCapability();
    const expectedProfile = environmentValue(process.env, "POMEGR_SMOKE_PROFILE_ROOT");
    if (!expectedProfile || path.resolve(app.getPath("userData")) !== path.resolve(expectedProfile)) {
      throw new Error("DESKTOP_PROFILE_NOT_ISOLATED");
    }
    runtimePaths = resolveDesktopPaths({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
      environment: process.env,
    });
    if (runtimePaths.mode !== "installed" || path.resolve(runtimePaths.dataRoot) !== path.resolve(expectedProfile)) {
      throw new Error("DESKTOP_DATA_ROOT_NOT_ISOLATED");
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

    const electronUpdater = require("electron-updater");
    if (!electronUpdater?.autoUpdater) throw new Error("DESKTOP_UPDATER_RUNTIME_FAILED");
    recordStage("UPDATER_RUNTIME_VERIFIED");

    recordStage("MAIN_GIT_EXECUTING");
    const gitVersion = await readGitVersion();
    if (!/^git version /i.test(gitVersion)) throw new Error("DESKTOP_GIT_EXEC_FAILED");
    recordStage("MAIN_GIT_VERIFIED");

    const monitorEnvironmentPath = environmentValue(process.env, "POMEGR_SMOKE_MONITOR_ENV_PATH");
    if (!monitorEnvironmentPath) throw new Error("DESKTOP_MONITOR_ENV_MISSING");
    agentQueryDescriptorPath = resolveAgentQueryDescriptorPath(runtimePaths.dataRoot);
    const monitor = await startService(
      "monitor-host.cjs",
      [],
      minimalRuntimeEnvironment(process.env, {
        POMEGR_SMOKE_MONITOR_ENV_PATH: monitorEnvironmentPath,
      }),
      "MONITOR",
      {
        authorizationToken,
        agentAuthorizationToken,
        agentQueryDescriptorPath,
        smoke: true,
      },
    );
    if (monitor.ready.gitProof !== "verified") throw new Error("DESKTOP_MONITOR_GIT_PROOF_MISSING");
    const agentQueryProof = await fetchAgentQuery("/api/agent/v1/provider-health", { descriptorPath: agentQueryDescriptorPath });
    if (!agentQueryProof.response?.ok || agentQueryProof.body?.schemaVersion !== 1) {
      throw new Error("DESKTOP_AGENT_QUERY_PROOF_MISSING");
    }
    recordStage("MONITOR_READY");

    keepOnlyRuntimeEnvironment(process.env, {
      POMEGR_MONITOR_ORIGIN: monitor.ready.origin,
      POMEGR_MONITOR_TOKEN: authorizationToken,
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
      authorizationToken,
      responseHeaders: { "Content-Security-Policy": DESKTOP_CSP },
      outDir: path.join(runtimePaths.unpackedRoot, "dist"),
      logger: Object.freeze({ log() {} }),
    });
    recordStage("WEB_SERVER_READY");

    recordStage("WEB_HEALTH_CHECKING");
    const [page, sessions] = await Promise.all([
      fetch(webHandle.origin, { headers: { "x-pomegr-desktop-authorization": authorizationToken } }),
      fetch(`${webHandle.origin}/api/sessions`, { headers: { "x-pomegr-desktop-authorization": authorizationToken } }),
    ]);
    if (page.status !== 200 || !/<title>Pomegr<\/title>/i.test(await page.text())) {
      throw new Error("DESKTOP_WEB_RUNTIME_FAILED");
    }
    if (sessions.status !== 200 || !Array.isArray((await sessions.json()).sessions)) {
      throw new Error("DESKTOP_PROVIDER_DISCOVERY_FAILED");
    }
    recordStage("WEB_HEALTH_VERIFIED");
    if (rendererMode === "runtime") {
      recordStage("RENDERER_UNAVAILABLE");
      recordStage("RUNTIME_VERIFIED");
      await finish(0);
      return;
    }
    recordStage("WINDOW_CREATING");
    const browserSession = session.fromPartition("pomegr-smoke", { cache: false });
    installSessionSecurity(browserSession, {
      webOrigin: webHandle.origin,
      authorizationToken,
    });
    smokeWindow = new BrowserWindow(secureBrowserWindowOptions({
      preloadPath: path.join(runtimePaths.applicationRoot, "desktop", "preload.cjs"),
      browserSession,
    }));
    installWebContentsSecurity(smokeWindow.webContents, {
      webOrigin: webHandle.origin,
      openExternal: async () => {},
    });
    await smokeWindow.loadURL(webHandle.origin);
    const rendererBoundary = await smokeWindow.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const frame = document.querySelector('.appFrame');
        const hydrated = document.documentElement.dataset.pomegrHydrated === 'true';
        if (frame && hydrated && getComputedStyle(frame).display === 'grid') {
          const [response, sessionsResponse] = await Promise.all([
            fetch('/api/state', { cache: 'no-store' }),
            fetch('/api/sessions', { cache: 'no-store' }),
          ]);
          const state = response.ok ? await response.json() : null;
          const sessions = sessionsResponse.ok ? await sessionsResponse.json() : null;
          const privateSentinel = /(?:PROMPT|RESPONSE|COMMAND|STDOUT|STDERR|TOOL_OUTPUT|OAUTH_TOKEN|ENV_SECRET|PRIVATE_PATH|CREDENTIAL|ARBITRARY_EXCEPTION)_MUST_NOT_LEAK/;
          const serializedApi = JSON.stringify({ state, sessions });
          return {
            title: document.title,
            hasNodeProcess: typeof process !== 'undefined',
            hasRequire: typeof require !== 'undefined',
            styled: true,
            hydrated: true,
            stateReady: response.status === 200
              && typeof state?.connected === 'boolean'
              && sessionsResponse.status === 200
              && Array.isArray(sessions?.sessions),
            privacySafe: !privateSentinel.test(serializedApi)
              && !privateSentinel.test(document.documentElement.outerHTML),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { title: document.title, styled: false, hydrated: false, stateReady: false };
    })()`, true);
    if (rendererBoundary?.title !== "Pomegr"
      || rendererBoundary.hasNodeProcess !== false
      || rendererBoundary.hasRequire !== false
      || rendererBoundary.styled !== true
      || rendererBoundary.hydrated !== true
      || rendererBoundary.stateReady !== true
      || rendererBoundary.privacySafe !== true) {
      throw new Error("DESKTOP_RENDERER_BOUNDARY_FAILED");
    }
    recordStage("WINDOW_VERIFIED");
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
// Keep Electron alive while the final BrowserWindow is destroyed before the
// loopback web server, then exit explicitly after the fixed result is flushed.
app.on("window-all-closed", () => {});
process.once("uncaughtException", () => {
  recordStage("UNCAUGHT_EXCEPTION");
  void finish(1);
});
process.once("unhandledRejection", () => {
  recordStage("UNHANDLED_REJECTION");
  void finish(1);
});
void app.whenReady().then(executeSmoke, () => finish(1));
