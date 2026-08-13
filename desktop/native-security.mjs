export function startOptionalDesktopIntegration({ start, cleanup }) {
  try {
    start();
    return true;
  } catch {
    try { cleanup?.(); } catch { /* Optional native integration cleanup is best-effort. */ }
    return false;
  }
}

export async function boundedDesktopMutation(getController, operation) {
  try { return await operation(getController()); } catch {
    try { return getController()?.snapshot() || null; } catch { return null; }
  }
}

export function installRendererFailureHandler(webContents, options) {
  const failed = () => {
    if (options.getRuntimeState() === "starting") options.markStartupFailed();
    else void Promise.resolve(options.handleRuntimeFailure()).catch(() => {});
  };
  webContents.once("render-process-gone", failed);
  return () => webContents.removeListener("render-process-gone", failed);
}

export function installDesktopBehaviorIpcHandlers(options) {
  const { ipcMain, channels, isTrustedEvent, getController } = options;
  const handled = [
    channels.getState,
    channels.setPaused,
    channels.setLaunchAtLogin,
    channels.setCloseBehavior,
    channels.setNotifications,
    channels.setNotificationQuiet,
    channels.installUpdate,
    channels.setTheme,
    channels.quit,
  ];
  for (const channel of handled) ipcMain.removeHandler(channel);
  const trusted = (event) => isTrustedEvent(event) ? getController() : null;
  ipcMain.handle(channels.getState, (event) => trusted(event)?.snapshot() || null);
  ipcMain.handle(channels.setPaused, (event, value) => trusted(event)
    ? boundedDesktopMutation(getController, (controller) => controller.setPaused(value)) : null);
  ipcMain.handle(channels.setLaunchAtLogin, (event, value) => trusted(event)
    ? boundedDesktopMutation(getController, (controller) => controller.setLaunchAtLogin(value)) : null);
  ipcMain.handle(channels.setCloseBehavior, (event, value) => trusted(event)
    ? boundedDesktopMutation(getController, (controller) => controller.setCloseBehavior(value)) : null);
  ipcMain.handle(channels.setNotifications, (event, value) => trusted(event)
    ? boundedDesktopMutation(getController, (controller) => controller.setNotifications(value)) : null);
  ipcMain.handle(channels.setNotificationQuiet, (event, value) => trusted(event)
    ? boundedDesktopMutation(getController, (controller) => controller.setNotificationQuiet(value)) : null);
  ipcMain.handle(channels.installUpdate, async (event) => {
    if (!trusted(event)) return null;
    try { await options.getUpdater?.()?.install(); } catch { /* The bounded snapshot reports the recoverable state. */ }
    return getController()?.snapshot() || null;
  });
  ipcMain.handle(channels.setTheme, options.themeHandler);
  ipcMain.handle(channels.quit, (event) => {
    const controller = trusted(event);
    if (!controller) return false;
    try { controller.quit(); return true; } catch { return false; }
  });
  return Object.freeze([...handled]);
}
