import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { createMonitorRequestHandler } from "../monitor/server.mjs";
import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import {
  DESKTOP_CSP,
  installSessionSecurity,
  installWebContentsSecurity,
  isAllowedExternalUrl,
  secureBrowserWindowOptions,
} from "../desktop/security-policy.mjs";
import { installLocalRequestGate, installStaticAssetFallback } from "../web/server.mjs";
import { focusShellWindow, startShellRuntime } from "../desktop/shell-orchestrator.mjs";
import { DESKTOP_STARTUP_ERROR_CODE, startupErrorDocument } from "../desktop/startup-error.mjs";
import {
  SHELL_LIFECYCLE_STAGES,
  SHELL_STARTUP_STAGES,
  isAllowedShellStage,
  recordShellStage,
} from "../desktop/shell-stage.mjs";
import { installQuietConsole } from "../desktop/quiet-console.mjs";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, { method = "GET", host = `127.0.0.1:${port}`, origin, path: requestPath = "/", token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (origin) headers.Origin = origin;
    if (token) headers[DESKTOP_AUTH_HEADER] = token;
    const outgoing = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ body, headers: response.headers, status: response.statusCode }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("secure BrowserWindow preferences deny renderer privileges", () => {
  const browserSession = {};
  const options = secureBrowserWindowOptions({
    preloadPath: path.resolve("desktop/preload.cjs"),
    browserSession,
  });
  assert.deepEqual(options.webPreferences, {
    preload: path.resolve("desktop/preload.cjs"),
    session: browserSession,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,
  });
  assert.match(DESKTOP_CSP, /default-src 'self'/);
  assert.match(DESKTOP_CSP, /object-src 'none'/);
  assert.match(DESKTOP_CSP, /frame-ancestors 'none'/);
});

test("quiet desktop console permits runtime warning filters without restoring output", () => {
  const leaked = [];
  const target = {
    debug: (...values) => leaked.push(values),
    error: (...values) => leaked.push(values),
    info: (...values) => leaked.push(values),
    log: (...values) => leaked.push(values),
    warn: (...values) => leaked.push(values),
  };
  installQuietConsole(target);
  const originalSink = target.error;
  target.error = (...values) => leaked.push(values);
  target.error("PRIVATE_PATH_MUST_NOT_LEAK");
  assert.equal(target.error, originalSink);
  assert.deepEqual(leaked, []);
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, "error"), {
    configurable: false,
    enumerable: true,
    get: Object.getOwnPropertyDescriptor(target, "error").get,
    set: Object.getOwnPropertyDescriptor(target, "error").set,
  });
});

test("desktop session injects local authorization and denies permissions and downloads", () => {
  const browserSession = new EventEmitter();
  const hooks = {};
  browserSession.webRequest = {
    onBeforeSendHeaders(callback) { hooks.before = callback; },
    onHeadersReceived(callback) { hooks.headers = callback; },
  };
  browserSession.setPermissionCheckHandler = (callback) => { hooks.permissionCheck = callback; };
  browserSession.setPermissionRequestHandler = (callback) => { hooks.permissionRequest = callback; };
  browserSession.setDevicePermissionHandler = (callback) => { hooks.devicePermission = callback; };
  installSessionSecurity(browserSession, {
    webOrigin: "http://127.0.0.1:4444",
    authorizationToken: TOKEN,
  });

  assert.equal(hooks.permissionCheck(), false);
  let permissionResult;
  hooks.permissionRequest(null, "camera", (allowed) => { permissionResult = allowed; });
  assert.equal(permissionResult, false);
  assert.equal(hooks.devicePermission(), false);
  const downloadEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  browserSession.emit("will-download", downloadEvent);
  assert.equal(downloadEvent.prevented, true);

  let localHeaders;
  hooks.before({ url: "http://127.0.0.1:4444/api/state", requestHeaders: { Accept: "*/*" } }, (result) => { localHeaders = result.requestHeaders; });
  assert.equal(localHeaders[DESKTOP_AUTH_HEADER], TOKEN);
  let remoteHeaders;
  hooks.before({ url: "https://example.invalid/", requestHeaders: { [DESKTOP_AUTH_HEADER]: "leak" } }, (result) => { remoteHeaders = result.requestHeaders; });
  assert.equal(remoteHeaders[DESKTOP_AUTH_HEADER], undefined);
});

test("desktop navigation denies webviews, unexpected origins, and non-allowlisted external URLs", async () => {
  const contents = new EventEmitter();
  let openHandler;
  contents.setWindowOpenHandler = (handler) => { openHandler = handler; };
  const opened = [];
  installWebContentsSecurity(contents, {
    webOrigin: "http://127.0.0.1:4444",
    openExternal: async (url) => { opened.push(url); },
  });
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const internal = event();
  contents.emit("will-navigate", internal, "http://127.0.0.1:4444/about");
  assert.equal(internal.prevented, false);
  const unexpected = event();
  contents.emit("will-navigate", unexpected, "http://127.0.0.1:5555/");
  assert.equal(unexpected.prevented, true);
  const webview = event();
  contents.emit("will-attach-webview", webview);
  assert.equal(webview.prevented, true);
  assert.deepEqual(openHandler({ url: "https://example.com/private" }), { action: "deny" });
  assert.deepEqual(openHandler({ url: "https://github.com/Lecarvalho/pomegr/blob/main/LICENSE" }), { action: "deny" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["https://github.com/Lecarvalho/pomegr/blob/main/LICENSE"]);
  assert.equal(isAllowedExternalUrl("https://github.com/Lecarvalho/pomegr.evil.invalid/"), false);
  assert.equal(isAllowedExternalUrl("http://github.com/Lecarvalho/pomegr"), false);
});

test("desktop web gate requires the dynamic host, same origin, read-only method, and launch token", async () => {
  const server = http.createServer((_request, response) => response.end("dashboard"));
  const port = await listen(server);
  installLocalRequestGate(server, {
    authorizationToken: TOKEN,
    host: "127.0.0.1",
    port,
    responseHeaders: { "Content-Security-Policy": DESKTOP_CSP },
  });
  try {
    const accepted = await request(port, { token: TOKEN, origin: `http://127.0.0.1:${port}` });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body, "dashboard");
    assert.equal(accepted.headers["content-security-policy"], DESKTOP_CSP);
    assert.equal((await request(port)).status, 401);
    assert.equal((await request(port, { token: TOKEN, host: "localhost" })).status, 401);
    assert.equal((await request(port, { token: TOKEN, origin: "http://127.0.0.1:9999" })).status, 401);
    assert.equal((await request(port, { token: TOKEN, method: "POST" })).status, 401);
  } finally {
    await close(server);
  }
});

test("desktop web gate serves authorized generated assets before the Windows Vinext cache miss", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end("vinext cache miss");
  });
  const port = await listen(server);
  let fallbackCalls = 0;
  installStaticAssetFallback(server, async (_request, response, pathname) => {
    fallbackCalls += 1;
    assert.equal(pathname, "/assets/app-fixed.css");
    response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    response.end(".appFrame { display: grid; }");
    return true;
  });
  installLocalRequestGate(server, {
    authorizationToken: TOKEN,
    host: "127.0.0.1",
    port,
  });
  try {
    const accepted = await request(port, { token: TOKEN, origin: `http://127.0.0.1:${port}`, path: "/assets/app-fixed.css" });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers["content-type"], "text/css; charset=utf-8");
    assert.match(accepted.body, /display: grid/);
    assert.equal(fallbackCalls, 1);
    assert.equal((await request(port, { path: "/assets/app-fixed.css" })).status, 401);
    assert.equal(fallbackCalls, 1);
    assert.equal((await request(port, { token: TOKEN, path: "/assets/%2e%2e/private.css" })).status, 404);
    assert.equal((await request(port, { token: TOKEN, path: "/.vite/private.css" })).status, 404);
    assert.equal(fallbackCalls, 1);
  } finally {
    await close(server);
  }
});

test("authorized monitor mode removes wildcard CORS and rejects untrusted local clients", async () => {
  const runtime = {
    async sessionCatalog() { return []; },
    analyzeEmpty() { return {}; },
  };
  const server = http.createServer(createMonitorRequestHandler({ runtime, authorizationToken: TOKEN }));
  const port = await listen(server);
  try {
    assert.equal((await request(port)).status, 401);
    const accepted = await request(port, { token: TOKEN });
    assert.equal(accepted.status, 404);
    assert.equal(accepted.headers["access-control-allow-origin"], undefined);
    assert.equal((await request(port, { token: TOKEN, host: "localhost" })).status, 401);
    assert.equal((await request(port, { token: TOKEN, origin: `http://127.0.0.1:${port}` })).status, 401);
    assert.equal((await request(port, { token: TOKEN, method: "POST" })).status, 401);
  } finally {
    await close(server);
  }
});

test("production shell orchestration starts in readiness order", async () => {
  const order = [];
  const monitor = { id: "monitor" };
  const web = { origin: "http://127.0.0.1:4444" };
  const window = {};
  const result = await startShellRuntime({
    startTimeoutMs: 50,
    stopTimeoutMs: 50,
    startMonitor() { order.push("monitor-start"); return monitor; },
    async waitForMonitor(value) { assert.equal(value, monitor); order.push("monitor-ready"); return { origin: "http://127.0.0.1:3333" }; },
    async startWeb(ready) { assert.equal(ready.origin, "http://127.0.0.1:3333"); order.push("web-start"); return web; },
    createWindow({ web: readyWeb }) { assert.equal(readyWeb, web); order.push("window-create"); return window; },
    async loadWindow(value, origin) { assert.equal(value, window); assert.equal(origin, web.origin); order.push("window-load"); },
    async stopMonitor() { assert.fail("successful startup must not stop monitor"); },
    async stopWeb() { assert.fail("successful startup must not stop web"); },
  });
  assert.deepEqual(order, ["monitor-start", "monitor-ready", "web-start", "window-create", "window-load"]);
  assert.deepEqual(result, { monitor, web, window });
});

test("durable shell diagnostics use only fixed ordered stages and retain the worker handoff", () => {
  assert.deepEqual(SHELL_STARTUP_STAGES, [
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
  assert.deepEqual(SHELL_LIFECYCLE_STAGES, [
    "SHELL_START_FAILED",
    "SHELL_CLEANUP_STARTED",
    "SHELL_CLEANUP_COMPLETE",
    "SHELL_ERROR_LOADING",
    "SHELL_ERROR_READY",
  ]);
  let content = "MONITOR_READY\nPRIVATE_PATH_MUST_NOT_SURVIVE";
  const io = {
    readFileSync: () => content,
    writeFileSync: (_path, value) => { content = value; },
  };
  const environment = { POMEGR_SMOKE_MAIN_STAGE_PATH: "fixed-diagnostic-path" };
  for (const stage of SHELL_STARTUP_STAGES) assert.equal(recordShellStage(environment, stage, io), true);
  assert.equal(recordShellStage(environment, "SHELL_PRIVATE_PATH", io), false);
  assert.equal(isAllowedShellStage("SHELL_WEB_READY"), true);
  assert.equal(isAllowedShellStage("SHELL_PRIVATE_PATH"), false);
  assert.deepEqual(content.split("\n"), ["MONITOR_READY", ...SHELL_STARTUP_STAGES]);
  assert.doesNotMatch(content, /PRIVATE_PATH/);
});

test("production shell orchestration bounds a late web start and cleans every owned service", async () => {
  let resolveWeb;
  let monitorStopped = false;
  let webStopped = false;
  const webStart = new Promise((resolve) => { resolveWeb = resolve; });
  const web = { origin: "http://127.0.0.1:4444" };
  await assert.rejects(startShellRuntime({
    startTimeoutMs: 5,
    stopTimeoutMs: 20,
    startMonitor: () => ({}),
    waitForMonitor: async () => ({ origin: "http://127.0.0.1:3333" }),
    startWeb: () => webStart,
    createWindow: () => assert.fail("window must not be created"),
    loadWindow: () => assert.fail("window must not load"),
    async stopMonitor() { monitorStopped = true; },
    async stopWeb() { webStopped = true; },
  }), /DESKTOP_START_FAILED/);
  assert.equal(monitorStopped, true);
  resolveWeb(web);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(webStopped, true);
});

test("production shell failure cleanup cannot hang on web close", async () => {
  let monitorStopped = false;
  const startedAt = Date.now();
  await assert.rejects(startShellRuntime({
    startTimeoutMs: 20,
    stopTimeoutMs: 5,
    startMonitor: () => ({}),
    waitForMonitor: async () => ({ origin: "http://127.0.0.1:3333" }),
    startWeb: async () => ({ origin: "http://127.0.0.1:4444" }),
    createWindow: () => ({}),
    loadWindow: async () => { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    async stopMonitor() { monitorStopped = true; },
    stopWeb: () => new Promise(() => {}),
  }), (error) => error.message === "DESKTOP_START_FAILED" && !error.stack.includes("PRIVATE_PATH"));
  assert.equal(monitorStopped, true);
  assert.ok(Date.now() - startedAt < 100);
});

test("second-instance focus restores only a live production window", () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  assert.equal(focusShellWindow(window), true);
  assert.deepEqual(calls, ["restore", "show", "focus"]);
  assert.equal(focusShellWindow({ isDestroyed: () => true }), false);
});

test("production startup error document contains only fixed bounded diagnostics", () => {
  const document = startupErrorDocument();
  assert.equal(DESKTOP_STARTUP_ERROR_CODE, "DESKTOP_START_FAILED");
  assert.match(document, /Pomegr could not start/);
  assert.match(document, /default-src 'none'/);
  assert.match(document, /DESKTOP_START_FAILED/);
  assert.doesNotMatch(document, /PRIVATE_PATH|stack|exception|stdout|stderr|credential/i);
  assert.ok(document.length < 1_500);
});

test("desktop shell startup ordering and failure UI remain bounded", async () => {
  const [main, preload, runtimeProof, serverBundle, webServer] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../desktop/shell-main.mjs", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../desktop/runtime-proof.mjs", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../dist/server/index.js", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../web/server.mjs", import.meta.url), "utf8")),
  ]);
  assert.ok(main.indexOf('waitForMessage(monitorChild, "ready"') < main.indexOf("startWebServer({"));
  assert.ok(main.indexOf("startWebServer({") < main.indexOf('recordStage("SHELL_WINDOW_LOADING")'));
  assert.match(main, /startShellRuntime\(\{/);
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /installDesktopAppLifecycle\(app/);
  assert.match(main, /stopChild\(monitorChild/);
  assert.match(main, /POMEGR_RESOURCE_ROOT:\s*desktopPaths\.applicationRoot/);
  assert.match(main, /resourcesPath:\s*process\.resourcesPath/);
  assert.match(main, /userDataPath:\s*app\.getPath\("userData"\)/);
  assert.ok(main.indexOf('app.setPath("userData", userDataOverride)') < main.indexOf("app.requestSingleInstanceLock()"));
  assert.match(main, /settingsForWindowClose\(\s*settingsLoad,\s*current,/);
  assert.match(main, /WEB_EXIT_UNEXPECTED/);
  assert.match(main, /startupErrorDocument\(\)/);
  for (const stage of SHELL_STARTUP_STAGES) assert.match(`${main}\n${webServer}`, new RegExp(stage));
  for (const stage of SHELL_LIFECYCLE_STAGES) assert.match(main, new RegExp(stage));
  assert.match(runtimeProof, /containsShellStageTrace\(readFileSync/);
  assert.match(main, /installQuietConsole\(\)/);
  assert.doesNotMatch(main, /writable:\s*false/);
  assert.match(serverBundle, /console\.error\s*=/);
  assert.doesNotMatch(main, /error\.message|error\.stack|console\.(?:error|log)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("pomegrDesktop"/);
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:save-report", payload\)/);
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:set-notifications", value\)/);
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:set-notification-quiet", value\)/);
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:set-display-preference", key, visible\)/);
  assert.match(preload, /ipcRenderer\.on\("pomegr:desktop-state-changed", listener\)/);
  assert.match(preload, /ipcRenderer\.removeListener\("pomegr:desktop-state-changed", listener\)/);
  assert.match(preload, /ipcRenderer\.invoke\(DESKTOP_THEME_CHANNEL, source\)/);
  assert.match(preload, /source !== "light" && source !== "dark" && source !== "system"/);
  assert.doesNotMatch(preload, /node:(?:fs|child_process)|process\.|ipcRenderer\.(?:send|sendSync|once)|shell|webFrame/);
  assert.match(main, /new Tray\(icon\)/);
  assert.match(main, /new Notification\(\{ \.\.\.payload, icon: shellIconPath\(\) \}\)/);
  assert.match(main, /createNeedsInputNotificationController\(\{/);
  assert.match(main, /createDesktopUpdaterController\(\{/);
  assert.match(main, /void startDesktopUpdates\(\)/);
  assert.match(main, /const electronUpdater = await import\("electron-updater"\);\s*if \(runtimeState !== "running"\) return;\s*const updater =/);
  assert.match(main, /prepareInstall:\s*\(\) => behaviorController\?\.prepareForUpdateInstall\(\)/);
  assert.match(main, /cancelInstall:\s*\(\) => behaviorController\?\.cancelUpdateInstall\(\)/);
  assert.doesNotMatch(main, /releaseNotes|signedUrl|certificate|update[^\n]*console\./i);
  assert.match(main, /fetch\(`\$\{webHandle\.origin\}\/api\/sessions`/);
  assert.match(main, /openNotificationSession/);
  assert.match(main, /import \{ encodeSessionRoute \} from "\.\.\/shared\/session-route\.mjs"/);
  assert.match(main, /\/sessions\/\$\{encodeSessionRoute\(sessionId\)\}/);
  assert.doesNotMatch(main, /notification[^\n]*(?:answer|approve|command|prompt)/i);
  assert.match(main, /label: "Quit Pomegr"/);
  assert.match(main, /installDesktopWindowLifecycle\(mainWindow/);
  assert.match(main, /installDesktopAppLifecycle\(app/);
  assert.match(main, /createDesktopThemeHandler\(\{/);
  assert.match(main, /applyDesktopNativeTheme\(nativeTheme, "dark"\)/);
  assert.match(main, /clampWindowState\(desktopSettings\.window, screen\.getAllDisplays\(\)\)/);
});
