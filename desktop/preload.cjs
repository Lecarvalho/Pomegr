"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const DESKTOP_THEME_CHANNEL = "threadlight:set-native-theme";

function setNativeTheme(source) {
  if (source !== "light" && source !== "dark" && source !== "system") return Promise.resolve(false);
  return ipcRenderer.invoke(DESKTOP_THEME_CHANNEL, source);
}

window.addEventListener("DOMContentLoaded", () => {
  const source = document.documentElement.dataset.theme;
  if (source === "light" || source === "dark") void setNativeTheme(source).catch(() => {});
}, { once: true });

contextBridge.exposeInMainWorld("threadlightDesktop", Object.freeze({
  saveReport(payload) {
    return ipcRenderer.invoke("threadlight:save-report", payload);
  },
  getDesktopState() {
    return ipcRenderer.invoke("threadlight:desktop-state");
  },
  setPaused(value) {
    return ipcRenderer.invoke("threadlight:set-paused", value);
  },
  setLaunchAtLogin(value) {
    return ipcRenderer.invoke("threadlight:set-launch-at-login", value);
  },
  setCloseBehavior(value) {
    return ipcRenderer.invoke("threadlight:set-close-behavior", value);
  },
  setNotifications(value) {
    return ipcRenderer.invoke("threadlight:set-notifications", value);
  },
  setNotificationQuiet(value) {
    return ipcRenderer.invoke("threadlight:set-notification-quiet", value);
  },
  setNativeTheme,
  quit() {
    return ipcRenderer.invoke("threadlight:quit");
  },
  onDesktopStateChanged(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("threadlight:desktop-state-changed", listener);
    return () => ipcRenderer.removeListener("threadlight:desktop-state-changed", listener);
  },
}));
