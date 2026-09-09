"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const DESKTOP_THEME_CHANNEL = "pomegr:set-native-theme";
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;

function setNativeTheme(source) {
  if (source !== "light" && source !== "dark" && source !== "system") return Promise.resolve(false);
  return ipcRenderer.invoke(DESKTOP_THEME_CHANNEL, source);
}

window.addEventListener("DOMContentLoaded", () => {
  const source = document.documentElement.dataset.theme;
  if (source === "light" || source === "dark") void setNativeTheme(source).catch(() => {});
}, { once: true });

contextBridge.exposeInMainWorld("pomegrDesktop", Object.freeze({
  getProviderSettings() { return ipcRenderer.invoke("pomegr:provider-settings"); },
  chooseProviderFolder(key) { return ipcRenderer.invoke("pomegr:choose-provider-folder", key); },
  resetProviderFolder(key) { return ipcRenderer.invoke("pomegr:reset-provider-folder", key); },
  discardProviderSettings() { return ipcRenderer.invoke("pomegr:discard-provider-settings"); },
  saveProviderSettings() { return ipcRenderer.invoke("pomegr:save-provider-settings"); },
  getPhoneAccessState() { return ipcRenderer.invoke("pomegr:phone-access-state"); },
  setPhoneSharing(enabled, networkId) { return ipcRenderer.invoke("pomegr:set-phone-sharing", enabled, networkId); },
  setPhoneAutoStart(enabled) { return ipcRenderer.invoke("pomegr:set-phone-auto-start", enabled); },
  createPhonePairing() { return ipcRenderer.invoke("pomegr:create-phone-pairing"); },
  onPhoneAccessChanged(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("pomegr:phone-access-changed", listener);
    return () => ipcRenderer.removeListener("pomegr:phone-access-changed", listener);
  },
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
  checkForUpdates() {
    return ipcRenderer.invoke("pomegr:check-for-updates");
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
  captureRepositoryContextInventory(repositoryId, provider) {
    return ipcRenderer.invoke("pomegr:capture-repository-context-inventory", repositoryId, provider);
  },
  repositoryPluginAction(repositoryId, provider, action) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)
      || (provider !== "claude" && provider !== "codex") || (action !== "recheck" && action !== "install" && action !== "update")) return Promise.resolve("unavailable");
    return ipcRenderer.invoke("pomegr:repository-plugin-action", repositoryId, provider, action);
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
