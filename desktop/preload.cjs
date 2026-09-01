"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const DESKTOP_THEME_CHANNEL = "pomegr:set-native-theme";

function setNativeTheme(source) {
  if (source !== "light" && source !== "dark" && source !== "system") return Promise.resolve(false);
  return ipcRenderer.invoke(DESKTOP_THEME_CHANNEL, source);
}

window.addEventListener("DOMContentLoaded", () => {
  const source = document.documentElement.dataset.theme;
  if (source === "light" || source === "dark") void setNativeTheme(source).catch(() => {});
}, { once: true });

contextBridge.exposeInMainWorld("pomegrDesktop", Object.freeze({
  saveReport(payload) {
    return ipcRenderer.invoke("pomegr:save-report", payload);
  },
  getDesktopState() {
    return ipcRenderer.invoke("pomegr:desktop-state");
  },
  setPaused(value) {
    return ipcRenderer.invoke("pomegr:set-paused", value);
  },
  setLaunchAtLogin(value) {
    return ipcRenderer.invoke("pomegr:set-launch-at-login", value);
  },
  setCloseBehavior(value) {
    return ipcRenderer.invoke("pomegr:set-close-behavior", value);
  },
  setNotifications(value) {
    return ipcRenderer.invoke("pomegr:set-notifications", value);
  },
  setNotificationQuiet(value) {
    return ipcRenderer.invoke("pomegr:set-notification-quiet", value);
  },
  setDisplayPreference(key, visible) {
    return ipcRenderer.invoke("pomegr:set-display-preference", key, visible);
  },
  installUpdate() {
    return ipcRenderer.invoke("pomegr:install-update");
  },
  startClaudeSignIn() {
    return ipcRenderer.invoke("pomegr:start-claude-sign-in");
  },
  getClaudeUsageIntegration() {
    return ipcRenderer.invoke("pomegr:claude-usage-integration");
  },
  enableClaudeUsageIntegration() {
    return ipcRenderer.invoke("pomegr:enable-claude-usage-integration");
  },
  setNativeTheme,
  quit() {
    return ipcRenderer.invoke("pomegr:quit");
  },
  onDesktopStateChanged(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("pomegr:desktop-state-changed", listener);
    return () => ipcRenderer.removeListener("pomegr:desktop-state-changed", listener);
  },
}));
