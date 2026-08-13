export const DESKTOP_BEHAVIOR_CHANNELS = Object.freeze({
  getState: "pomegr:desktop-state",
  setPaused: "pomegr:set-paused",
  setLaunchAtLogin: "pomegr:set-launch-at-login",
  setCloseBehavior: "pomegr:set-close-behavior",
  setNotifications: "pomegr:set-notifications",
  setNotificationQuiet: "pomegr:set-notification-quiet",
  quit: "pomegr:quit",
  setTheme: "pomegr:set-native-theme",
  stateChanged: "pomegr:desktop-state-changed",
});

export const CLOSE_BEHAVIORS = Object.freeze(["ask", "tray", "quit"]);
export const DESKTOP_THEME_SOURCES = Object.freeze(["light", "dark", "system"]);

export function applyDesktopNativeTheme(nativeTheme, source) {
  if (!nativeTheme || !DESKTOP_THEME_SOURCES.includes(source)) return false;
  nativeTheme.themeSource = source;
  return true;
}

export function createDesktopThemeHandler({ isTrustedEvent, nativeTheme }) {
  return (event, source) => isTrustedEvent(event) && applyDesktopNativeTheme(nativeTheme, source);
}

export function isCloseBehavior(value) {
  return CLOSE_BEHAVIORS.includes(value);
}

function intersectionArea(first, second) {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  return width * height;
}

function centerDistanceSquared(first, second) {
  const dx = (first.x + first.width / 2) - (second.x + second.width / 2);
  const dy = (first.y + first.height / 2) - (second.y + second.height / 2);
  return dx * dx + dy * dy;
}

export function clampWindowState(windowState, displays) {
  const source = windowState && typeof windowState === "object" ? windowState : {};
  const areas = (Array.isArray(displays) ? displays : [])
    .map((display) => display?.workArea)
    .filter((area) => area && ["x", "y", "width", "height"].every((key) => Number.isInteger(area[key])) && area.width > 0 && area.height > 0);
  if (!areas.length) return { ...source };
  const candidate = {
    x: Number.isInteger(source.x) ? source.x : areas[0].x,
    y: Number.isInteger(source.y) ? source.y : areas[0].y,
    width: Number.isInteger(source.width) ? source.width : 1280,
    height: Number.isInteger(source.height) ? source.height : 800,
  };
  const area = areas.reduce((best, current) => {
    const currentIntersection = intersectionArea(candidate, current);
    const bestIntersection = intersectionArea(candidate, best);
    if (currentIntersection !== bestIntersection) return currentIntersection > bestIntersection ? current : best;
    return centerDistanceSquared(candidate, current) < centerDistanceSquared(candidate, best) ? current : best;
  }, areas[0]);
  const width = Math.max(720, Math.min(candidate.width, area.width));
  const height = Math.max(520, Math.min(candidate.height, area.height));
  return {
    ...source,
    width,
    height,
    x: Math.min(Math.max(candidate.x, area.x), area.x + Math.max(0, area.width - width)),
    y: Math.min(Math.max(candidate.y, area.y), area.y + Math.max(0, area.height - height)),
    maximized: Boolean(source.maximized),
  };
}

export function createDesktopBehaviorController(options) {
  let settings = options.settings;
  let paused = false;
  let quitting = false;
  let closeDecisionPending = false;
  let mutationQueue = Promise.resolve();
  let notificationQuietUntil = 0;
  let notificationQuietTimer = null;
  const now = options.now || Date.now;
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel || ((handle) => clearTimeout(handle));

  const clearNotificationQuiet = () => {
    if (notificationQuietTimer !== null) cancel(notificationQuietTimer);
    notificationQuietTimer = null;
    notificationQuietUntil = 0;
  };

  const snapshot = () => Object.freeze({
    paused,
    launchAtLogin: Boolean(settings.launchAtLogin),
    launchAtLoginAvailable: options.launchAtLoginAvailable !== false,
    closeBehavior: isCloseBehavior(settings.closeBehavior) ? settings.closeBehavior : "ask",
    notifications: Boolean(settings.notifications),
    notificationQuietUntil: notificationQuietUntil > now() ? new Date(notificationQuietUntil).toISOString() : null,
  });
  const broadcast = () => options.broadcast?.(snapshot());
  const persist = async (patch) => {
    if (options.canPersist !== true) return false;
    const next = { ...settings, ...patch };
    const saved = await options.saveSettings(next);
    settings = saved || next;
    broadcast();
    return true;
  };
  const enqueueMutation = (operation) => {
    const result = mutationQueue.catch(() => {}).then(operation);
    mutationQueue = result;
    return result;
  };
  const hideToTray = () => {
    options.hideWindow();
    options.updateTray?.(snapshot());
  };
  const requestQuit = () => {
    if (quitting) return;
    quitting = true;
    options.quitApp();
  };

  return Object.freeze({
    snapshot,
    isQuitting: () => quitting,
    async initializeLogin() {
      if (options.canPersist === true && options.launchAtLoginAvailable !== false) {
        await options.setLoginItem(Boolean(settings.launchAtLogin));
      }
      return snapshot();
    },
    showWindow() { options.showWindow(); },
    secondInstance() { options.showWindow(); },
    async handleWindowClose(event) {
      if (quitting) return "quit";
      event?.preventDefault?.();
      const behavior = isCloseBehavior(settings.closeBehavior) ? settings.closeBehavior : "ask";
      if (behavior === "quit") {
        requestQuit();
        return "quit";
      }
      if (behavior === "tray") {
        hideToTray();
        return "tray";
      }
      if (closeDecisionPending) return "pending";
      closeDecisionPending = true;
      try {
        const choice = await options.explainClose();
        if (choice?.remember === true) {
          try {
            await enqueueMutation(() => persist({ closeBehavior: choice.action === "quit" ? "quit" : "tray" }));
          } catch { /* The close choice still applies once. */ }
        }
        if (choice?.action === "quit") requestQuit();
        else hideToTray();
        return choice?.action === "quit" ? "quit" : "tray";
      } finally {
        closeDecisionPending = false;
      }
    },
    setPaused(value) {
      if (typeof value !== "boolean") return snapshot();
      paused = value;
      options.updateTray?.(snapshot());
      broadcast();
      return snapshot();
    },
    togglePaused() {
      paused = !paused;
      options.updateTray?.(snapshot());
      broadcast();
      return snapshot();
    },
    async setLaunchAtLogin(value) {
      if (typeof value !== "boolean" || options.launchAtLoginAvailable === false || options.canPersist !== true) return snapshot();
      return enqueueMutation(async () => {
        const previous = Boolean(settings.launchAtLogin);
        await options.setLoginItem(value);
        try {
          await persist({ launchAtLogin: value });
        } catch (error) {
          try { await options.setLoginItem(previous); } catch { /* Keep the original bounded failure. */ }
          throw error;
        }
        options.updateTray?.(snapshot());
        return snapshot();
      });
    },
    async setCloseBehavior(value) {
      if (!isCloseBehavior(value)) return snapshot();
      return enqueueMutation(async () => {
        await persist({ closeBehavior: value });
        options.updateTray?.(snapshot());
        return snapshot();
      });
    },
    async setNotifications(value) {
      if (typeof value !== "boolean") return snapshot();
      return enqueueMutation(async () => {
        await persist({ notifications: value });
        if (!value) clearNotificationQuiet();
        options.updateTray?.(snapshot());
        broadcast();
        return snapshot();
      });
    },
    setNotificationQuiet(value) {
      if (typeof value !== "boolean" || !settings.notifications) return snapshot();
      clearNotificationQuiet();
      if (value) {
        notificationQuietUntil = now() + 60 * 60_000;
        notificationQuietTimer = schedule(() => {
          notificationQuietTimer = null;
          notificationQuietUntil = 0;
          options.updateTray?.(snapshot());
          broadcast();
        }, 60 * 60_000);
      }
      options.updateTray?.(snapshot());
      broadcast();
      return snapshot();
    },
    prepareForUpdateInstall() { quitting = true; },
    cancelUpdateInstall() { quitting = false; },
    dispose() { clearNotificationQuiet(); },
    quit: requestQuit,
  });
}

export function installWindowBoundsGuard(browserScreen, browserWindow) {
  const refresh = () => {
    if (!browserWindow || browserWindow.isDestroyed()) return false;
    const current = browserWindow.getNormalBounds();
    const next = clampWindowState(current, browserScreen.getAllDisplays());
    if (["x", "y", "width", "height"].every((key) => current[key] === next[key])) return false;
    browserWindow.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height });
    return true;
  };
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) browserScreen.on(event, refresh);
  return () => {
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) browserScreen.removeListener(event, refresh);
  };
}

export function createSerializedSettingsWriter(initialSettings, saveSettings) {
  let committed = initialSettings;
  let queue = Promise.resolve();
  return Object.freeze({
    snapshot: () => committed,
    update(transform) {
      const operation = queue.catch(() => {}).then(async () => {
        const next = transform(committed);
        const saved = await saveSettings(next);
        committed = saved || next;
        return committed;
      });
      queue = operation;
      return operation;
    },
    settled: () => queue,
  });
}

export async function applyTrayLoginToggle(controller, value, updateTray) {
  try {
    const state = await controller.setLaunchAtLogin(value);
    updateTray(state);
    return true;
  } catch {
    updateTray(controller.snapshot());
    return false;
  }
}

export function installDesktopWindowLifecycle(browserWindow, options) {
  const close = (event) => {
    options.persistWindowState();
    void options.getController()?.handleWindowClose(event).catch(() => {});
  };
  const sessionEnd = () => { options.getController()?.quit(); };
  browserWindow.on("close", close);
  browserWindow.on("session-end", sessionEnd);
  return () => {
    browserWindow.removeListener("close", close);
    browserWindow.removeListener("session-end", sessionEnd);
  };
}

export function installDesktopAppLifecycle(application, options) {
  const secondInstance = () => {
    const controller = options.getController();
    if (controller) controller.secondInstance();
    else options.focusWindow(options.getWindow());
  };
  const activate = () => { options.getController()?.showWindow(); };
  const allClosed = () => { if (!options.getController()) application.quit(); };
  const beforeQuit = (event) => {
    if (["stopped", "idle"].includes(options.getRuntimeState())) return;
    event.preventDefault();
    options.persistWindowState();
    void options.stopRuntime().then(() => application.exit(0));
  };
  application.on("second-instance", secondInstance);
  application.on("activate", activate);
  application.on("window-all-closed", allClosed);
  application.on("before-quit", beforeQuit);
  return () => {
    application.removeListener("second-instance", secondInstance);
    application.removeListener("activate", activate);
    application.removeListener("window-all-closed", allClosed);
    application.removeListener("before-quit", beforeQuit);
  };
}
