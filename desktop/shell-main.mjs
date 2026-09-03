import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, session, shell, Tray } from "electron";
import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import {
  createAgentQueryCapability,
  resolveAgentQueryDescriptorPath,
} from "../shared/agent-query-transport.mjs";
import { encodeSessionRoute } from "../shared/session-route.mjs";
import {
  assertNoSystemNodeInPath,
  environmentValue,
  keepOnlyRuntimeEnvironment,
  minimalRuntimeEnvironment,
  monitorPrivateEnvironment,
  nativeClaudeEnvironment,
} from "./environment-policy.mjs";
import {
  CLAUDE_SIGN_IN_CHANNEL,
  createClaudeSignInAction,
  installConfirmedTrustedActionIpcHandler,
} from "./claude-auth.mjs";
import {
  createClaudeUsageIntegration,
  installClaudeUsageIntegrationIpc,
  resolveClaudeUsageShells,
} from "./claude-usage-setup.mjs";
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
import { createLanSharingController, installPhoneAccessIpc, PHONE_ACCESS_CHANNELS } from "./lan-sharing.mjs";
import {
  createNeedsInputNotificationController,
  createSessionNotificationPoller,
} from "./notifications.mjs";
import { createReportSaveHandler, DESKTOP_REPORT_CHANNEL } from "./report-save.mjs";
import { recordShellStage } from "./shell-stage.mjs";
import { installQuietConsole } from "./quiet-console.mjs";
import { createDesktopUpdaterController, createWindowsUpdateSignatureVerifier } from "./updater.mjs";
import {
  clampWindowState,
  applyDesktopNativeTheme,
  applyTrayLoginToggle,
  createDesktopBehaviorController,
  createDesktopThemeHandler,
  createSerializedSettingsWriter,
  DESKTOP_BEHAVIOR_CHANNELS,
  installDesktopAppLifecycle,
  installDesktopWindowLifecycle,
  installWindowBoundsGuard,
} from "./desktop-behavior.mjs";
import {
  installDesktopBehaviorIpcHandlers,
  installRendererFailureHandler,
  startOptionalDesktopIntegration,
} from "./native-security.mjs";

installQuietConsole();

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 5_000;
const authorizationToken = randomBytes(32).toString("base64url");
const agentAuthorizationToken = createAgentQueryCapability();
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
let settingsWriter;
let behaviorController;
let tray;
let removeWindowBoundsGuard;
let removeWindowLifecycle;
let notificationPoller;
let updaterController;
let claudeSignIn;
let removeClaudeSignInIpc;
let claudeUsageIntegration;
let removeClaudeUsageIpc;
let phoneAccess;
let removePhoneAccessIpc;
const nativeNotifications = new Set();
const recordStage = (stage) => { recordShellStage(process.env, stage); };

function workerEntrypoint() {
  const entrypoint = path.join(desktopPaths.unpackedRoot, "desktop", "workers", "monitor-host.cjs");
  if (!existsSync(entrypoint)) throw new Error("DESKTOP_MONITOR_TARGET_MISSING");
  return entrypoint;
}

function createMonitorWorker(privateEnvironment) {
  const worker = new Worker(workerEntrypoint(), {
    env: minimalRuntimeEnvironment(process.env, {
      POMEGR_RESOURCE_ROOT: desktopPaths.applicationRoot,
    }),
    execArgv: [],
    name: "pomegr-monitor",
    workerData: {
      authorizationToken,
      agentAuthorizationToken,
      agentQueryDescriptorPath: resolveAgentQueryDescriptorPath(),
      privateEnvironment,
      smoke: false,
    },
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
  const window = new BrowserWindow({
    icon: shellIconPath(),
    ...secureBrowserWindowOptions({
      preloadPath: path.join(desktopPaths.applicationRoot, "desktop", "preload.cjs"),
      browserSession,
      windowState,
    }),
  });
  window.removeMenu();
  return window;
}

function queueSettingsUpdate(transform) {
  const operation = settingsWriter.update(transform).then((saved) => {
    desktopSettings = saved;
    return saved;
  });
  settingsSavePromise = operation;
  return operation;
}

function persistCurrentWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  const maximized = mainWindow.isMaximized();
  void queueSettingsUpdate((current) => settingsForWindowClose(
    settingsLoad,
    current,
    bounds,
    maximized,
  ) || current).catch(() => {});
}

function trustedDesktopEvent(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !webHandle?.origin) return false;
  try { return new URL(event.senderFrame.url).origin === webHandle.origin; } catch { return false; }
}

function showShellWindow() {
  if (!focusShellWindow(mainWindow) && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
}

function openAbout() {
  if (!mainWindow || mainWindow.isDestroyed() || !webHandle?.origin) return;
  void mainWindow.loadURL(`${webHandle.origin}/about`).then(showShellWindow, showShellWindow);
}

function openNotificationSession(sessionId) {
  if (!mainWindow || mainWindow.isDestroyed() || !webHandle?.origin) return;
  let target;
  try {
    target = `${webHandle.origin}/sessions/${encodeSessionRoute(sessionId)}`;
  } catch {
    return;
  }
  void mainWindow.loadURL(target).then(showShellWindow, showShellWindow);
}

function showNeedsInputNotification(payload, onClick) {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ ...payload, icon: shellIconPath() });
  const release = () => { nativeNotifications.delete(notification); };
  notification.once("click", () => {
    release();
    onClick();
  });
  notification.once("close", release);
  nativeNotifications.add(notification);
  notification.show();
  return true;
}

async function loadNotificationSessions(signal) {
  if (!webHandle?.origin) return null;
  const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
  const response = await fetch(`${webHandle.origin}/api/sessions`, {
    cache: "no-store",
    headers: { [DESKTOP_AUTH_HEADER]: authorizationToken },
    signal: combinedSignal,
  });
  if (!response.ok) return null;
  const body = await response.json();
  return Array.isArray(body?.sessions) ? body.sessions : null;
}

function startNotificationPolling() {
  const controller = createNeedsInputNotificationController({
    notify: showNeedsInputNotification,
    openSession: openNotificationSession,
  });
  notificationPoller = createSessionNotificationPoller({
    controller,
    loadSessions: loadNotificationSessions,
    getMode: () => {
      const state = behaviorController?.snapshot();
      return { enabled: state?.notifications === true, quietUntil: state?.notificationQuietUntil };
    },
  });
  notificationPoller.start();
}

async function startDesktopUpdates() {
  if (!app.isPackaged || desktopPaths.mode !== "installed" || desktopSettings.updates !== true) return;
  try {
    const electronUpdater = await import("electron-updater");
    if (runtimeState !== "running") return;
    const updater = electronUpdater.autoUpdater || electronUpdater.default?.autoUpdater;
    if (!updater) return;
    updaterController = createDesktopUpdaterController({
      updater,
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      mode: desktopPaths.mode,
      updatesEnabled: desktopSettings.updates,
      verifyUpdateCodeSignature: createWindowsUpdateSignatureVerifier(),
      onState: () => { if (behaviorController) broadcastDesktopState(behaviorController.snapshot()); },
      prepareInstall: () => behaviorController?.prepareForUpdateInstall(),
      cancelInstall: () => behaviorController?.cancelUpdateInstall(),
    });
    void updaterController.start();
  } catch { /* Update availability degrades independently from the dashboard. */ }
}

function updateTrayMenu(state) {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Pomegr", click: showShellWindow },
    { label: state.paused ? "Resume live refresh" : "Pause live refresh", click: () => behaviorController?.togglePaused() },
    { label: "Launch at login", type: "checkbox", checked: state.launchAtLogin, enabled: state.launchAtLoginAvailable, click: (item) => {
      if (behaviorController) void applyTrayLoginToggle(behaviorController, item.checked, updateTrayMenu);
    } },
    { type: "separator" },
    { label: "About Pomegr", click: openAbout },
    { type: "separator" },
    { label: "Quit Pomegr", click: () => behaviorController?.quit() },
  ]));
}

function shellIconPath() {
  const packagedIcon = path.join(process.resourcesPath, "tray-icon.png");
  const developmentIcon = path.join(desktopPaths.applicationRoot, "build", "icon.png");
  return existsSync(packagedIcon) ? packagedIcon : developmentIcon;
}

function createShellTray() {
  const icon = nativeImage.createFromPath(shellIconPath()).resize({ width: 16, height: 16 });
  if (icon.isEmpty()) throw new Error("DESKTOP_TRAY_ICON_MISSING");
  tray = new Tray(icon);
  tray.setToolTip("Pomegr — local read-only observer");
  tray.on("click", showShellWindow);
}

function startOptionalTray() {
  return startOptionalDesktopIntegration({
    start() { createShellTray(); updateTrayMenu(behaviorController.snapshot()); },
    cleanup() { tray?.destroy(); tray = undefined; },
  });
}

function broadcastDesktopState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(DESKTOP_BEHAVIOR_CHANNELS.stateChanged, state);
}

function installDesktopBehaviorIpc() {
  installDesktopBehaviorIpcHandlers({
    ipcMain,
    channels: DESKTOP_BEHAVIOR_CHANNELS,
    isTrustedEvent: trustedDesktopEvent,
    getController: () => behaviorController,
    getUpdater: () => updaterController,
    themeHandler: createDesktopThemeHandler({
      isTrustedEvent: trustedDesktopEvent,
      nativeTheme,
    }),
  });
}

function installClaudeSignInIpc() {
  removeClaudeSignInIpc?.();
  removeClaudeSignInIpc = installConfirmedTrustedActionIpcHandler({
    ipcMain,
    channel: CLAUDE_SIGN_IN_CHANNEL,
    isTrustedEvent: trustedDesktopEvent,
    action: claudeSignIn,
  });
}

async function confirmClaudeSignIn() {
  if (!mainWindow || mainWindow.isDestroyed() || runtimeState !== "running") return false;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Sign in to Claude",
    message: "Open Claude sign-in in your browser?",
    detail: "Pomegr will launch installed Claude Code. Completing sign-in in the browser may change the Claude Code account on this computer.",
    buttons: ["Open sign-in", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0 && runtimeState === "running";
}

async function confirmClaudeUsageSetup() {
  if (!mainWindow || mainWindow.isDestroyed() || runtimeState !== "running") return false;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Enable local Claude usage",
    message: "Receive usage directly from Claude Code?",
    detail: "Pomegr will update this Claude Code profile’s status-line setting and preserve its existing command. The local bridge captures only usage windows and the existing cost estimate. Claude Code still handles your account sign-in.",
    buttons: ["Cancel", "Enable local usage"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1 && runtimeState === "running";
}

async function showStartupError() {
  recordStage("SHELL_ERROR_LOADING");
  // Electron's native theme is process-global. Keep the fixed dark error page and
  // its standard title bar aligned even if startup fails before renderer sync.
  applyDesktopNativeTheme(nativeTheme, "dark");
  behaviorController = undefined;
  try { tray?.destroy(); } catch { /* A partially created tray may already be gone. */ }
  tray = undefined;
  removeWindowBoundsGuard?.();
  removeWindowBoundsGuard = undefined;
  removeWindowLifecycle?.();
  removeWindowLifecycle = undefined;
  try { mainWindow?.destroy(); } catch { /* A failed renderer may already be gone. */ }
  const errorSession = session.fromPartition(`pomegr-error-${randomUUID()}`);
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
  recordStage("SHELL_ERROR_READY");
}

async function stopRuntime() {
  if (stopPromise) return stopPromise;
  runtimeState = "stopping";
  recordStage("SHELL_CLEANUP_STARTED");
  stopPromise = (async () => {
    removePhoneAccessIpc?.();
    removePhoneAccessIpc = undefined;
    try { await withDeadline(phoneAccess?.dispose(), STOP_TIMEOUT_MS, "DESKTOP_PHONE_STOP_TIMEOUT"); } catch { /* Other services still stop. */ }
    phoneAccess = undefined;
    removeClaudeSignInIpc?.();
    removeClaudeSignInIpc = undefined;
    removeClaudeUsageIpc?.();
    removeClaudeUsageIpc = undefined;
    claudeUsageIntegration?.dispose();
    try { await claudeSignIn?.dispose(); } catch { /* Native sign-in cleanup is bounded. */ }
    notificationPoller?.stop();
    notificationPoller = undefined;
    updaterController?.dispose();
    updaterController = undefined;
    behaviorController?.dispose();
    for (const notification of nativeNotifications) {
      try { notification.close(); } catch { /* Native notifications may already be closed. */ }
    }
    nativeNotifications.clear();
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
    recordStage("SHELL_CLEANUP_COMPLETE");
  })();
  return stopPromise;
}

async function handleRuntimeFailure() {
  if (runtimeState !== "running") return;
  await stopRuntime();
  await showStartupError();
}

async function startDesktop() {
  claudeSignIn = createClaudeSignInAction({
    environment: process.env,
    nativeEnvironment: nativeClaudeEnvironment(process.env),
    confirm: confirmClaudeSignIn,
  });
  desktopPaths = resolveDesktopPaths({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    environment: process.env,
  });
  const bridgePath = path.join(desktopPaths.unpackedRoot, "desktop", "workers", "claude-statusline-bridge.cjs");
  const usageShells = process.platform === "win32" ? resolveClaudeUsageShells(process.env) : null;
  claudeUsageIntegration = createClaudeUsageIntegration(desktopPaths.mode === "installed" && usageShells && existsSync(bridgePath) ? {
    configRoot: environmentValue(process.env, "CLAUDE_CONFIG_DIR") || path.join(app.getPath("home"), ".claude"),
    appExecutable: process.execPath,
    bridgePath,
    dataRoot: desktopPaths.dataRoot,
    feedRoot: environmentValue(process.env, "POMEGR_USAGE_SNAPSHOTS_DIR") || path.join(desktopPaths.dataRoot, "usage-snapshots"),
    ...usageShells,
    confirm: confirmClaudeUsageSetup,
  } : {});
  recordStage("SHELL_PATHS_READY");
  settingsStore = createDesktopSettingsStore(desktopPaths.settingsFile);
  settingsLoad = await settingsStore.load();
  desktopSettings = settingsLoad.settings;
  settingsWriter = createSerializedSettingsWriter(desktopSettings, (next) => settingsStore.save(next));
  recordStage("SHELL_SETTINGS_READY");
  ipcMain.removeHandler(DESKTOP_REPORT_CHANNEL);
  ipcMain.handle(DESKTOP_REPORT_CHANNEL, createReportSaveHandler({
    defaultDirectory: app.getPath("documents"),
    isTrustedEvent: trustedDesktopEvent,
    showSaveDialog: (options) => dialog.showSaveDialog(mainWindow, options),
    writeFile,
  }));
  let privateEnvironment = monitorPrivateEnvironment(process.env, {
    pomegrDataRoot: desktopPaths.dataRoot,
  });
  runtimeState = "starting";
  try {
    await startShellRuntime({
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS + KILL_TIMEOUT_MS,
      startMonitor() {
        recordStage("SHELL_MONITOR_STARTING");
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
      async waitForMonitor(child) {
        const ready = await waitForMessage(child, "ready", START_TIMEOUT_MS);
        recordStage("SHELL_MONITOR_READY");
        return ready;
      },
      async startWeb(monitorReady) {
        if (startupFailed || !monitorChild.pid) throw new Error("DESKTOP_MONITOR_EXITED");
        keepOnlyRuntimeEnvironment(process.env, {
          POMEGR_MONITOR_ORIGIN: monitorReady.origin,
          POMEGR_MONITOR_TOKEN: authorizationToken,
        });
        assertNoSystemNodeInPath(process.env);
        recordStage("SHELL_WEB_IMPORTING");
        const { startWebServer } = await withDeadline(
          import("../web/server.mjs"),
          START_TIMEOUT_MS,
          "DESKTOP_WEB_IMPORT_TIMEOUT",
        );
        recordStage("SHELL_WEB_IMPORTED");
        const outDir = path.join(desktopPaths.unpackedRoot, "dist");
        recordStage("SHELL_WEB_STARTING");
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
          recordStage,
          logger: Object.freeze({ log() {} }),
        });
        recordStage("SHELL_WEB_READY");
        void webHandle.exit.then(({ code }) => {
          if (code !== "WEB_EXIT_UNEXPECTED") return;
          if (runtimeState === "starting") startupFailed = true;
          else void handleRuntimeFailure();
        });
        return webHandle;
      },
      createWindow({ web }) {
        if (startupFailed) throw new Error("DESKTOP_SERVICE_EXITED");
        const browserSession = session.fromPartition(`pomegr-${randomUUID()}`, { cache: false });
        installSessionSecurity(browserSession, {
          webOrigin: web.origin,
          authorizationToken,
        });
        const restoredWindow = clampWindowState(desktopSettings.window, screen.getAllDisplays());
        mainWindow = createSecureWindow(browserSession, restoredWindow);
        removeWindowBoundsGuard = installWindowBoundsGuard(screen, mainWindow);
        recordStage("SHELL_WINDOW_CREATED");
        if (desktopSettings.window.maximized) mainWindow.maximize();
        behaviorController = createDesktopBehaviorController({
          settings: desktopSettings,
          canPersist: settingsLoad.canPersist,
          launchAtLoginAvailable: desktopPaths.mode === "installed",
          saveSettings: (next) => queueSettingsUpdate((current) => ({ ...next, window: current.window, lanSharingAutoStart: current.lanSharingAutoStart })),
          setLoginItem: async (openAtLogin) => app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: [] }),
          hideWindow: () => mainWindow?.hide(),
          showWindow: showShellWindow,
          quitApp: () => app.quit(),
          explainClose: async () => {
            const result = await dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "Keep Pomegr available?",
              message: "Pomegr can keep observing locally after you close its window.",
              detail: "Choose Keep running to leave it in the system tray. Monitoring stays read-only, and you can quit at any time from Pomegr or the tray.",
              buttons: ["Keep running", "Quit Pomegr"],
              defaultId: 0,
              cancelId: 0,
              checkboxLabel: "Remember my choice",
              checkboxChecked: false,
              noLink: true,
            });
            return { action: result.response === 1 ? "quit" : "tray", remember: result.checkboxChecked };
          },
          updateTray: updateTrayMenu,
          broadcast: broadcastDesktopState,
          snapshotExtension: () => ({
            update: updaterController?.snapshot() || Object.freeze({ status: "disabled", version: null }),
          }),
        });
        phoneAccess = createLanSharingController({
          upstreamOrigin: web.origin,
          authorizationToken,
          autoStart: desktopSettings.lanSharingAutoStart,
          canPersist: settingsLoad.canPersist,
          saveAutoStart: (enabled) => queueSettingsUpdate((current) => ({ ...current, lanSharingAutoStart: enabled })),
          onChange: (state) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(PHONE_ACCESS_CHANNELS.changed, state);
          },
        });
        removePhoneAccessIpc = installPhoneAccessIpc({ ipcMain, isTrustedEvent: trustedDesktopEvent, controller: phoneAccess });
        startOptionalTray();
        installDesktopBehaviorIpc();
        installClaudeSignInIpc();
        removeClaudeUsageIpc = installClaudeUsageIntegrationIpc({ ipcMain, isTrustedEvent: trustedDesktopEvent, integration: claudeUsageIntegration });
        void behaviorController.initializeLogin().catch(() => {});
        removeWindowLifecycle = installDesktopWindowLifecycle(mainWindow, {
          getController: () => behaviorController,
          persistWindowState: persistCurrentWindowState,
        });
        installWebContentsSecurity(mainWindow.webContents, {
          webOrigin: web.origin,
          openExternal: (url) => shell.openExternal(url),
        });
        installRendererFailureHandler(mainWindow.webContents, {
          getRuntimeState: () => runtimeState,
          markStartupFailed: () => { startupFailed = true; },
          handleRuntimeFailure,
        });
        mainWindow.once("ready-to-show", () => {
          mainWindow?.show();
          if (focusRequested) mainWindow?.focus();
        });
        return mainWindow;
      },
      async loadWindow(window, origin) {
        recordStage("SHELL_WINDOW_LOADING");
        await window.loadURL(origin);
        recordStage("SHELL_WINDOW_READY");
      },
      stopMonitor: (child) => stopChild(child, {
        gracefulTimeoutMs: STOP_TIMEOUT_MS,
        killTimeoutMs: KILL_TIMEOUT_MS,
      }),
      stopWeb: (web) => web.close(),
    });
    if (startupFailed) throw new Error("DESKTOP_SERVICE_EXITED");
    runtimeState = "running";
    recordStage("SHELL_RUNTIME_READY");
    void phoneAccess.initialize().catch(() => {});
    startNotificationPolling();
    void startDesktopUpdates();
    if (!mainWindow.isVisible()) mainWindow.show();
  } catch {
    recordStage("SHELL_START_FAILED");
    privateEnvironment = undefined;
    await stopRuntime();
    await showStartupError();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  installDesktopAppLifecycle(app, {
    getController: () => behaviorController,
    getWindow: () => mainWindow,
    getRuntimeState: () => runtimeState,
    focusWindow: (window) => { focusRequested = true; focusShellWindow(window); },
    persistWindowState: persistCurrentWindowState,
    stopRuntime,
  });
  process.once("uncaughtException", () => { void stopRuntime().then(() => app.exit(1)); });
  process.once("unhandledRejection", () => { void stopRuntime().then(() => app.exit(1)); });
  void app.whenReady().then(startDesktop, async () => {
    await stopRuntime();
    app.exit(1);
  });
}
