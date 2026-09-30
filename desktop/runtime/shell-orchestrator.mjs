import { withDeadline } from "./bounded-lifecycle.mjs";

async function boundedStop(value, stop, timeoutMs, errorCode) {
  if (!value) return;
  try {
    await withDeadline(stop(value), timeoutMs, errorCode);
  } catch { /* Every remaining owned service still gets a stop attempt. */ }
}

export async function startShellRuntime(options) {
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  let monitor;
  let web;
  let window;
  try {
    monitor = await withDeadline(
      Promise.resolve().then(options.startMonitor),
      startTimeoutMs,
      "DESKTOP_MONITOR_START_TIMEOUT",
      (lateMonitor) => { void options.stopMonitor(lateMonitor); },
    );
    const monitorReady = await withDeadline(
      options.waitForMonitor(monitor),
      startTimeoutMs,
      "DESKTOP_MONITOR_READY_TIMEOUT",
    );
    web = await withDeadline(
      Promise.resolve().then(() => options.startWeb(monitorReady)),
      startTimeoutMs,
      "DESKTOP_WEB_START_TIMEOUT",
      (lateWeb) => { void options.stopWeb(lateWeb); },
    );
    window = await withDeadline(
      Promise.resolve().then(() => options.createWindow({ monitorReady, web })),
      startTimeoutMs,
      "DESKTOP_WINDOW_CREATE_TIMEOUT",
    );
    await withDeadline(
      options.loadWindow(window, web.origin),
      startTimeoutMs,
      "DESKTOP_WINDOW_LOAD_TIMEOUT",
    );
    return Object.freeze({ monitor, web, window });
  } catch {
    await boundedStop(web, options.stopWeb, stopTimeoutMs, "DESKTOP_WEB_STOP_TIMEOUT");
    await boundedStop(monitor, options.stopMonitor, stopTimeoutMs, "DESKTOP_MONITOR_STOP_TIMEOUT");
    throw new Error("DESKTOP_START_FAILED");
  }
}

export function focusShellWindow(window) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}
