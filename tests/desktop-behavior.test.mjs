import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  clampWindowState,
  applyDesktopNativeTheme,
  applyTrayLoginToggle,
  createSerializedSettingsWriter,
  createDesktopBehaviorController,
  createDesktopThemeHandler,
  DESKTOP_BEHAVIOR_CHANNELS,
  installDesktopAppLifecycle,
  installDesktopWindowLifecycle,
  installWindowBoundsGuard,
} from "../desktop/runtime/desktop-behavior.mjs";

test("native theme synchronization accepts only bounded values from trusted renderer events", () => {
  const nativeTheme = { themeSource: "system" };
  const trustedEvent = {};
  const handler = createDesktopThemeHandler({
    isTrustedEvent: (event) => event === trustedEvent,
    nativeTheme,
  });
  assert.equal(handler(trustedEvent, "dark"), true);
  assert.equal(nativeTheme.themeSource, "dark");
  assert.equal(handler({}, "light"), false);
  assert.equal(nativeTheme.themeSource, "dark");
  assert.equal(handler(trustedEvent, "sepia"), false);
  assert.equal(nativeTheme.themeSource, "dark");
  assert.equal(applyDesktopNativeTheme(nativeTheme, "system"), true);
  assert.equal(nativeTheme.themeSource, "system");
});

function harness(overrides = {}) {
  const calls = [];
  let persisted = {
    version: 3,
    window: { width: 1280, height: 800, x: null, y: null, maximized: false },
    launchAtLogin: false,
    closeBehavior: "ask",
    notifications: true,
    updates: true,
    displayPreferences: { estimatedCost: true },
    ...overrides.settings,
  };
  const controller = createDesktopBehaviorController({
    settings: persisted,
    canPersist: overrides.canPersist ?? true,
    launchAtLoginAvailable: overrides.launchAtLoginAvailable ?? true,
    async saveSettings(next) { calls.push(["save", next]); persisted = next; return next; },
    async setLoginItem(value) { calls.push(["login", value]); },
    hideWindow() { calls.push(["hide"]); },
    showWindow() { calls.push(["show"]); },
    quitApp() { calls.push(["quit"]); },
    async explainClose() { calls.push(["explain"]); return overrides.closeChoice || { action: "tray", remember: false }; },
    updateTray(state) { calls.push(["tray", state]); },
    broadcast(state) { calls.push(["broadcast", state]); },
    ...(overrides.snapshotExtension ? { snapshotExtension: overrides.snapshotExtension } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.schedule ? { schedule: overrides.schedule } : {}),
    ...(overrides.cancel ? { cancel: overrides.cancel } : {}),
  });
  return { calls, controller, persisted: () => persisted };
}

test("off-screen window state is clamped into a current display work area", () => {
  const displays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { workArea: { x: 1920, y: -200, width: 1280, height: 1024 } },
  ];
  assert.deepEqual(clampWindowState({ width: 1400, height: 1100, x: 9000, y: -9000, maximized: true }, displays), {
    width: 1280,
    height: 1024,
    x: 1920,
    y: -200,
    maximized: true,
  });
  assert.deepEqual(clampWindowState({ width: 800, height: 600, x: 2200, y: 0, maximized: false }, displays), {
    width: 800,
    height: 600,
    x: 2200,
    y: 0,
    maximized: false,
  });
});

test("first close explains tray behavior and can remember the bounded choice", async () => {
  const { calls, controller, persisted } = harness({ closeChoice: { action: "tray", remember: true } });
  let prevented = 0;
  assert.equal(await controller.handleWindowClose({ preventDefault() { prevented += 1; } }), "tray");
  assert.equal(prevented, 1);
  assert.equal(persisted().closeBehavior, "tray");
  assert.deepEqual(calls.filter(([name]) => ["explain", "hide"].includes(name)), [["explain"], ["hide"]]);
  calls.length = 0;
  assert.equal(await controller.handleWindowClose({ preventDefault() {} }), "tray");
  assert.deepEqual(calls.filter(([name]) => ["explain", "hide"].includes(name)), [["hide"]]);
});

test("explicit quit, remembered close-to-quit, and second instance are deterministic", async () => {
  const remembered = harness({ closeChoice: { action: "quit", remember: true } });
  assert.equal(await remembered.controller.handleWindowClose({ preventDefault() {} }), "quit");
  assert.equal(remembered.persisted().closeBehavior, "quit");
  assert.equal(remembered.calls.filter(([name]) => name === "quit").length, 1);
  remembered.controller.quit();
  assert.equal(remembered.calls.filter(([name]) => name === "quit").length, 1, "quit is idempotent");

  const second = harness();
  second.controller.secondInstance();
  assert.deepEqual(second.calls, [["show"]]);
});

test("pause changes only bounded UI state and login startup is opt-in and reversible", async () => {
  const { calls, controller } = harness();
  assert.deepEqual(controller.setPaused(true), {
    paused: true,
    launchAtLogin: false,
    launchAtLoginAvailable: true,
    closeBehavior: "ask",
    notifications: true,
    notificationCategories: { attention: true, provider_news: false, model_news: false },
    notificationQuietUntil: null,
    displayPreferences: { estimatedCost: true },
    homeUpdate: { seenId: null, dismissedId: null },
  });
  assert.equal(calls.some(([name]) => /monitor|provider|session|command/i.test(name)), false);
  await controller.initializeLogin();
  await controller.setLaunchAtLogin(true);
  await controller.setLaunchAtLogin(false);
  assert.deepEqual(calls.filter(([name]) => name === "login").map(([, value]) => value), [false, true, false]);
});

test("unavailable or unsafe settings cannot enable login or persist behavior", async () => {
  const { calls, controller } = harness({ canPersist: false, launchAtLoginAvailable: false });
  await controller.initializeLogin();
  await controller.setLaunchAtLogin(true);
  await controller.setCloseBehavior("tray");
  assert.equal(calls.some(([name]) => name === "login" || name === "save"), false);
  assert.equal(controller.snapshot().launchAtLogin, false);
  assert.equal(controller.snapshot().closeBehavior, "ask");
});

test("login registration rolls back when persistence fails and close still honors a one-time choice", async () => {
  const calls = [];
  const settings = {
    version: 2,
    window: { width: 1280, height: 800, x: null, y: null, maximized: false },
    launchAtLogin: false,
    closeBehavior: "ask",
    notifications: true,
    updates: true,
  };
  const controller = createDesktopBehaviorController({
    settings,
    canPersist: true,
    async saveSettings() { throw new Error("SETTINGS_WRITE_FAILED"); },
    async setLoginItem(value) { calls.push(["login", value]); },
    hideWindow() { calls.push(["hide"]); },
    showWindow() {},
    quitApp() {},
    async explainClose() { return { action: "tray", remember: true }; },
  });
  await assert.rejects(controller.setLaunchAtLogin(true), /SETTINGS_WRITE_FAILED/);
  assert.deepEqual(calls, [["login", true], ["login", false]]);
  assert.equal(await controller.handleWindowClose({ preventDefault() {} }), "tray");
  assert.deepEqual(calls.at(-1), ["hide"]);
});

test("desktop renderer contract is fixed, bounded, and contains no provider metadata", () => {
  assert.deepEqual(Object.keys(DESKTOP_BEHAVIOR_CHANNELS).sort(), ["checkForUpdates", "getState", "installUpdate", "quit", "setCloseBehavior", "setDisplayPreference", "setHomeUpdate", "setLaunchAtLogin", "setNotificationCategory", "setNotificationQuiet", "setNotifications", "setPaused", "setTheme", "stateChanged"].sort());
  const update = Object.freeze({ status: "ready", version: "1.2.3", lastCheckedAt: "2026-09-04T12:00:00.000Z" });
  const state = harness({ snapshotExtension: () => ({ update }) }).controller.snapshot();
  assert.deepEqual(Object.keys(state).sort(), ["closeBehavior", "displayPreferences", "homeUpdate", "launchAtLogin", "launchAtLoginAvailable", "notificationCategories", "notificationQuietUntil", "notifications", "paused", "update"].sort());
  assert.deepEqual(state.displayPreferences, { estimatedCost: true });
  assert.deepEqual(state.homeUpdate, { seenId: null, dismissedId: null });
  assert.deepEqual(state.notificationCategories, { attention: true, provider_news: false, model_news: false });
  assert.deepEqual(state.update, update);
  const { notificationCategories, ...remainingState } = state;
  assert.deepEqual(notificationCategories, { attention: true, provider_news: false, model_news: false });
  assert.doesNotMatch(JSON.stringify(remainingState), /prompt|response|command|stdout|stderr|credential|oauth|provider|session|path/i);
});

test("update installation bypasses close prompts without invoking an early app quit", async () => {
  const { calls, controller } = harness();
  controller.prepareForUpdateInstall();
  assert.equal(await controller.handleWindowClose({ preventDefault() { calls.push(["prevent"]); } }), "quit");
  assert.equal(calls.some(([name]) => name === "quit" || name === "explain" || name === "prevent"), false);
});

test("failed update launch restores ordinary close behavior", async () => {
  const { calls, controller } = harness({ closeChoice: { action: "tray", remember: false } });
  controller.prepareForUpdateInstall();
  controller.cancelUpdateInstall();
  assert.equal(await controller.handleWindowClose({ preventDefault() { calls.push(["prevent"]); } }), "tray");
  assert.equal(calls.some(([name]) => name === "prevent"), true);
  assert.equal(calls.some(([name]) => name === "explain"), true);
});

test("notification preference persists while one-hour quiet mode is temporary and expires", async () => {
  let nowMs = Date.parse("2026-08-12T12:00:00.000Z");
  let expiry;
  const { calls, controller, persisted } = harness({
    now: () => nowMs,
    schedule(callback) { expiry = callback; return 1; },
    cancel() { expiry = undefined; },
  });
  await controller.setNotifications(false);
  assert.equal(persisted().notifications, false);
  assert.equal(controller.setNotificationQuiet(true).notificationQuietUntil, null);
  await controller.setNotifications(true);
  const quiet = controller.setNotificationQuiet(true);
  assert.equal(quiet.notificationQuietUntil, "2026-08-12T13:00:00.000Z");
  assert.equal(persisted().notificationQuietUntil, undefined);
  nowMs += 60 * 60_000;
  expiry();
  assert.equal(controller.snapshot().notificationQuietUntil, null);
  assert.ok(calls.some(([name]) => name === "broadcast"));
});

test("fixed notification categories persist independently of enablement and reject unknown values", async () => {
  const { calls, controller, persisted } = harness({ settings: { notifications: false } });
  await Promise.all([
    controller.setNotificationCategory("provider_news", true),
    controller.setNotificationCategory("model_news", true),
  ]);
  assert.deepEqual(persisted().notificationCategories, { attention: true, provider_news: true, model_news: true });
  assert.equal(persisted().notifications, false);
  const saves = calls.filter(([name]) => name === "save").length;
  for (const [key, value] of [["provider_service", true], ["open_url", true], ["attention", "true"], [["attention"], true], ["model_news", 1]]) {
    assert.deepEqual(await controller.setNotificationCategory(key, value), controller.snapshot());
  }
  assert.equal(calls.filter(([name]) => name === "save").length, saves);
  await controller.setNotifications(true);
  assert.equal(controller.snapshot().notificationCategories.model_news, true);
});

test("Home update markers persist only fixed keys with a bounded identifier", async () => {
  const { calls, controller, persisted } = harness();
  await Promise.all([
    controller.setHomeUpdate("seenId", "release-notes-v1"),
    controller.setHomeUpdate("dismissedId", "release-notes-v1"),
  ]);
  assert.deepEqual(persisted().homeUpdate, { seenId: "release-notes-v1", dismissedId: "release-notes-v1" });
  assert.deepEqual(controller.snapshot().homeUpdate, { seenId: "release-notes-v1", dismissedId: "release-notes-v1" });
  const saves = calls.filter(([name]) => name === "save").length;
  for (const [key, id] of [["openedId", "release-notes-v1"], ["seenId", "C:\\Users\\private"], ["seenId", "Has Spaces"], ["seenId", "x".repeat(65)], ["seenId", 7], ["seenId", ""]]) {
    assert.deepEqual(await controller.setHomeUpdate(key, id), controller.snapshot());
  }
  assert.equal(calls.filter(([name]) => name === "save").length, saves);
  assert.deepEqual(persisted().homeUpdate, { seenId: "release-notes-v1", dismissedId: "release-notes-v1" });
});

test("display preferences persist only recognized booleans and serialize concurrent changes", async () => {
  const { calls, controller, persisted } = harness();
  await Promise.all([
    controller.setDisplayPreference("contextHistory", false),
    controller.setDisplayPreference("estimatedCost", false),
  ]);
  assert.deepEqual(persisted().displayPreferences, { estimatedCost: false });
  const saves = calls.filter(([name]) => name === "save").length;
  assert.deepEqual(await controller.setDisplayPreference("unknown", false), controller.snapshot());
  assert.deepEqual(await controller.setDisplayPreference("contextHistory", "false"), controller.snapshot());
  assert.equal(calls.filter(([name]) => name === "save").length, saves);
});

test("concurrent preference writes serialize without dropping either setting", async () => {
  const settings = {
    version: 2,
    window: { width: 1280, height: 800, x: null, y: null, maximized: false },
    launchAtLogin: false,
    closeBehavior: "ask",
    notifications: true,
    updates: true,
  };
  let firstSaveStarted;
  let releaseFirstSave;
  const started = new Promise((resolve) => { firstSaveStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseFirstSave = resolve; });
  const writes = [];
  const controller = createDesktopBehaviorController({
    settings,
    canPersist: true,
    launchAtLoginAvailable: true,
    async saveSettings(next) {
      writes.push(next);
      if (writes.length === 1) { firstSaveStarted(); await blocked; }
      return next;
    },
    async setLoginItem() {},
    hideWindow() {},
    showWindow() {},
    quitApp() {},
    async explainClose() { return { action: "tray", remember: false }; },
  });
  const closeWrite = controller.setCloseBehavior("tray");
  await started;
  const loginWrite = controller.setLaunchAtLogin(true);
  await Promise.resolve();
  assert.equal(writes.length, 1, "second mutation waits for the deferred first save");
  releaseFirstSave();
  await Promise.all([closeWrite, loginWrite]);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].closeBehavior, "tray");
  assert.equal(writes[1].launchAtLogin, true);
});

test("a remembered first-close choice cannot overwrite a concurrent login mutation", async () => {
  const settings = {
    version: 2,
    window: { width: 1280, height: 800, x: null, y: null, maximized: false },
    launchAtLogin: false,
    closeBehavior: "ask",
    notifications: true,
    updates: true,
  };
  let answerClose;
  const closeAnswer = new Promise((resolve) => { answerClose = resolve; });
  const writes = [];
  const controller = createDesktopBehaviorController({
    settings,
    canPersist: true,
    launchAtLoginAvailable: true,
    async saveSettings(next) { writes.push(next); return next; },
    async setLoginItem() {},
    hideWindow() {},
    showWindow() {},
    quitApp() {},
    explainClose: () => closeAnswer,
  });
  const closing = controller.handleWindowClose({ preventDefault() {} });
  const login = controller.setLaunchAtLogin(true);
  await login;
  answerClose({ action: "tray", remember: true });
  await closing;
  assert.equal(writes.length, 2);
  assert.equal(writes[1].launchAtLogin, true);
  assert.equal(writes[1].closeBehavior, "tray");
});

test("serialized settings writer never resurrects a rejected preference during a later window save", async () => {
  const initial = { launchAtLogin: false, closeBehavior: "ask", window: { width: 1280, height: 800 } };
  const writes = [];
  let failFirst = true;
  const writer = createSerializedSettingsWriter(initial, async (next) => {
    writes.push(next);
    if (failFirst) { failFirst = false; throw new Error("SETTINGS_WRITE_FAILED"); }
    return next;
  });
  await assert.rejects(writer.update((current) => ({ ...current, closeBehavior: "tray" })), /SETTINGS_WRITE_FAILED/);
  const saved = await writer.update((current) => ({ ...current, window: { width: 1000, height: 700 } }));
  assert.equal(saved.closeBehavior, "ask");
  assert.deepEqual(saved.window, { width: 1000, height: 700 });
  assert.equal(writes[1].closeBehavior, "ask");
});

test("display topology changes re-clamp a live window and listeners are removable", () => {
  const browserScreen = new EventEmitter();
  browserScreen.getAllDisplays = () => [{ workArea: { x: 0, y: 0, width: 1024, height: 768 } }];
  const changes = [];
  const browserWindow = {
    isDestroyed: () => false,
    getNormalBounds: () => ({ x: 5000, y: 5000, width: 1280, height: 800 }),
    setBounds: (bounds) => changes.push(bounds),
  };
  const remove = installWindowBoundsGuard(browserScreen, browserWindow);
  browserScreen.emit("display-removed");
  assert.deepEqual(changes, [{ x: 0, y: 0, width: 1024, height: 768 }]);
  remove();
  browserScreen.emit("display-metrics-changed");
  assert.equal(changes.length, 1);
});

test("a rejected tray login toggle restores the bounded menu state without rejecting", async () => {
  const states = [];
  const controller = {
    async setLaunchAtLogin() { throw new Error("SETTINGS_WRITE_FAILED"); },
    snapshot: () => ({ paused: false, launchAtLogin: false, launchAtLoginAvailable: true, closeBehavior: "ask" }),
  };
  assert.equal(await applyTrayLoginToggle(controller, true, (state) => states.push(state)), false);
  assert.deepEqual(states, [controller.snapshot()]);
});

test("production lifecycle wiring closes to tray, reopens, focuses second launch, and stops before explicit or OS quit", async () => {
  const application = new EventEmitter();
  const browserWindow = new EventEmitter();
  const calls = [];
  let runtimeState = "running";
  application.quit = () => { calls.push("app-quit"); application.emit("before-quit", { preventDefault: () => calls.push("prevent-quit") }); };
  application.exit = (code) => { calls.push(`exit-${code}`); runtimeState = "stopped"; };
  const controller = {
    async handleWindowClose(event) { event.preventDefault(); calls.push("hide"); },
    quit() { calls.push("controller-quit"); application.quit(); },
    showWindow() { calls.push("show"); },
    secondInstance() { calls.push("second-instance-focus"); },
  };
  installDesktopWindowLifecycle(browserWindow, {
    getController: () => controller,
    persistWindowState: () => calls.push("persist-window"),
  });
  installDesktopAppLifecycle(application, {
    getController: () => controller,
    getWindow: () => browserWindow,
    getRuntimeState: () => runtimeState,
    focusWindow: () => calls.push("fallback-focus"),
    persistWindowState: () => calls.push("persist-window"),
    async stopRuntime() { calls.push("stop-services"); runtimeState = "stopped"; },
  });

  browserWindow.emit("close", { preventDefault: () => calls.push("prevent-close") });
  await Promise.resolve();
  application.emit("activate");
  application.emit("second-instance");
  browserWindow.emit("session-end");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, [
    "persist-window", "prevent-close", "hide", "show", "second-instance-focus",
    "controller-quit", "app-quit", "prevent-quit", "persist-window", "stop-services", "exit-0",
  ]);
});
