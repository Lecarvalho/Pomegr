import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import {
  assertNoSystemNodeInPath,
  keepOnlyRuntimeEnvironment,
  minimalRuntimeEnvironment,
  monitorPrivateEnvironment,
} from "./environment-policy.mjs";
import {
  DESKTOP_CSP,
  installSessionSecurity,
  installWebContentsSecurity,
  secureBrowserWindowOptions,
} from "./security-policy.mjs";
import { stopChild, waitForMessage } from "./utility-lifecycle.mjs";
import { withDeadline } from "./bounded-lifecycle.mjs";
import { focusShellWindow, startShellRuntime } from "./shell-orchestrator.mjs";
import { startupErrorDocument } from "./startup-error.mjs";
import { desktopUserDataOverride, resolveDesktopPaths } from "./paths.mjs";
import { createDesktopSettingsStore, settingsForWindowClose } from "./settings.mjs";
import { createReportSaveHandler, DESKTOP_REPORT_CHANNEL } from "./report-save.mjs";

for (const method of ["debug", "error", "info", "log", "warn"]) {
  Object.defineProperty(globalThis.console, method, {
    configurable: false,
    value() {},
    writable: false,
  });
}

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 5_000;
const authorizationToken = randomBytes(32).toString("base64url");
const userDataOverride = desktopUserDataOverride(process.env);
if (userDataOverride) app.setPath("userData", userDataOverride);
let mainWindow;
let monitorChild;
let webHandle;
let runtimeState = "idle";
let stopPromise;
let startupFailed = false;
let focusRequested = false;
let desktopPaths;
let desktopSettings;
let settingsLoad;
let settingsStore;
let settingsSavePromise = Promise.resolve();

function workerEntrypoint() {
  const entrypoint = path.join(desktopPaths.unpackedRoot, "desktop", "workers", "monitor-host.cjs");
  if (!existsSync(entrypoint)) throw new Error("DESKTOP_MONITOR_TARGET_MISSING");
  return entrypoint;
}

function createMonitorWorker(privateEnvironment) {
  const worker = new Worker(workerEntrypoint(), {
    env: minimalRuntimeEnvironment(process.env, {
      THREADLIGHT_RESOURCE_ROOT: desktopPaths.applicationRoot,
    }),
    execArgv: [],
    name: "threadlight-monitor",
    workerData: { authorizationToken, privateEnvironment, smoke: false },
  });
  const child = new EventEmitter();
  let alive = true;
  Object.defineProperty(child, "pid", { get: () => alive ? worker.threadId : undefined });
  child.send = (message) => worker.postMessage(message);
  child.postMessage = child.send;
  child.kill = () => { void worker.terminate(); return true; };
  child.forceKill = child.kill;
  worker.once("online", () => child.emit("spawn"));
  worker.on("message", (message) => child.emit("message", message));
  worker.once("error", () => child.emit("error", new Error("DESKTOP_MONITOR_FAILED")));
  worker.once("exit", (code) => { alive = false; child.emit("exit", code); });
  return child;
}

function createSecureWindow(browserSession, windowState) {
  const window = new BrowserWindow(secureBrowserWindowOptions({
    preloadPath: path.join(desktopPaths.applicationRoot, "desktop", "preload.cjs"),
    browserSession,
    windowState,
  }));
  window.removeMenu();
  return window;
}

async function showStartupError() {
  try { mainWindow?.destroy(); } catch { /* A failed renderer may already be gone. */ }
  const errorSession = session.fromPartition(`threadlight-error-${randomUUID()}`);
  installSessionSecurity(errorSession, {
    webOrigin: "http://127.0.0.1:1",
    authorizationToken,
  });
  mainWindow = createSecureWindow(errorSession);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  await withDeadline(
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupErrorDocument())}`),
    START_TIMEOUT_MS,
    "DESKTOP_ERROR_PAGE_TIMEOUT",
  );
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.show();
  if (focusRequested) mainWindow.focus();
}

async function stopRuntime() {
  if (stopPromise) return stopPromise;
  runtimeState = "stopping";
  stopPromise = (async () => {
    try {
      if (monitorChild?.pid) {
        await stopChild(monitorChild, {
          gracefulTimeoutMs: STOP_TIMEOUT_MS,
          killTimeoutMs: KILL_TIMEOUT_MS,
        });
      }
    } catch { /* Cleanup continues for the other owned service. */ }
    try {
      if (webHandle) {
        await withDeadline(webHandle.close(), STOP_TIMEOUT_MS, "DESKTOP_WEB_STOP_TIMEOUT");
      }
    } catch { /* Shutdown is best-effort after a bounded stop. */ }
    try { await settingsSavePromise; } catch { /* Settings persistence never blocks shutdown. */ }
    runtimeState = "stopped";
  })();
  return stopPromise;
}

async function handleRuntimeFailure() {
  if (runtimeState !== "running") return;
  await stopRuntime();
  await showStartupError();
}

async function startDesktop() {
  desktopPaths = resolveDesktopPaths({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    environment: process.env,
  });
  settingsStore = createDesktopSettingsStore(desktopPaths.settingsFile);
  settingsLoad = await settingsStore.load();
  desktopSettings = settingsLoad.settings;
  ipcMain.removeHandler(DESKTOP_REPORT_CHANNEL);
  ipcMain.handle(DESKTOP_REPORT_CHANNEL, createReportSaveHandler({
    defaultDirectory: app.getPath("documents"),
    isTrustedEvent: (event) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || !webHandle?.origin) return false;
      try { return new URL(event.senderFrame.url).origin === webHandle.origin; } catch { return false; }
    },
    showSaveDialog: (options) => dialog.showSaveDialog(mainWindow, options),
    writeFile,
  }));
  let privateEnvironment = monitorPrivateEnvironment(process.env, {
    threadlightDataRoot: desktopPaths.dataRoot,
  });
  runtimeState = "starting";
  try {
    await startShellRuntime({
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS + KILL_TIMEOUT_MS,
      startMonitor() {
        monitorChild = createMonitorWorker(privateEnvironment);
        privateEnvironment = undefined;
        const monitorFailed = () => {
          if (runtimeState === "starting") startupFailed = true;
          else void handleRuntimeFailure();
        };
        monitorChild.once("exit", monitorFailed);
        monitorChild.once("error", monitorFailed);
        return monitorChild;
      },
      waitForMonitor: (child) => waitForMessage(child, "ready", START_TIMEOUT_MS),
      async startWeb(monitorReady) {
        if (startupFailed || !monitorChild.pid) throw new Error("DESKTOP_MONITOR_EXITED");
        keepOnlyRuntimeEnvironment(process.env, {
          THREADLIGHT_MONITOR_ORIGIN: monitorReady.origin,
          THREADLIGHT_MONITOR_TOKEN: authorizationToken,
        });
        assertNoSystemNodeInPath(process.env);
        const { startWebServer } = await withDeadline(
          import("../web/server.mjs"),
          START_TIMEOUT_MS,
          "DESKTOP_WEB_IMPORT_TIMEOUT",
        );
        const outDir = path.join(desktopPaths.unpackedRoot, "dist");
        webHandle = await startWebServer({
          host: "127.0.0.1",
          port: 0,
          monitorOrigin: monitorReady.origin,
          authorizationToken,
          outDir,
          responseHeaders: {
            "Content-Security-Policy": DESKTOP_CSP,
            "Cross-Origin-Opener-Policy": "same-origin",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
          logger: Object.freeze({ log() {} }),
        });
        void webHandle.exit.then(({ code }) => {
          if (code !== "WEB_EXIT_UNEXPECTED") return;
          if (runtimeState === "starting") startupFailed = true;
          else void handleRuntimeFailure();
        });
        return webHandle;
      },
      createWindow({ web }) {
        if (startupFailed) throw new Error("DESKTOP_SERVICE_EXITED");
        const browserSession = session.fromPartition(`threadlight-${randomUUID()}`, { cache: false });
        installSessionSecurity(browserSession, {
          webOrigin: web.origin,
          authorizationToken,
        });
        mainWindow = createSecureWindow(browserSession, desktopSettings.window);
        if (desktopSettings.window.maximized) mainWindow.maximize();
        mainWindow.on("close", () => {
          if (mainWindow?.isDestroyed()) return;
          const bounds = mainWindow.getNormalBounds();
          const closingSettings = settingsForWindowClose(settingsLoad, desktopSettings, bounds, mainWindow.isMaximized());
          if (!closingSettings) return;
          desktopSettings = closingSettings;
          settingsSavePromise = settingsStore.save(desktopSettings).catch(() => {});
        });
        installWebContentsSecurity(mainWindow.webContents, {
          webOrigin: web.origin,
          openExternal: (url) => shell.openExternal(url),
        });
        mainWindow.once("ready-to-show", () => {
          mainWindow?.show();
          if (focusRequested) mainWindow?.focus();
        });
        return mainWindow;
      },
      loadWindow: (window, origin) => window.loadURL(origin),
      stopMonitor: (child) => stopChild(child, {
        gracefulTimeoutMs: STOP_TIMEOUT_MS,
        killTimeoutMs: KILL_TIMEOUT_MS,
      }),
      stopWeb: (web) => web.close(),
    });
    if (startupFailed) throw new Error("DESKTOP_SERVICE_EXITED");
    runtimeState = "running";
    if (!mainWindow.isVisible()) mainWindow.show();
  } catch {
    privateEnvironment = undefined;
    await stopRuntime();
    await showStartupError();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusRequested = true;
    focusShellWindow(mainWindow);
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (runtimeState === "stopped" || runtimeState === "idle") return;
    event.preventDefault();
    void stopRuntime().then(() => app.exit(0));
  });
  process.once("uncaughtException", () => { void stopRuntime().then(() => app.exit(1)); });
  process.once("unhandledRejection", () => { void stopRuntime().then(() => app.exit(1)); });
  void app.whenReady().then(startDesktop, async () => {
    await stopRuntime();
    app.exit(1);
  });
}
