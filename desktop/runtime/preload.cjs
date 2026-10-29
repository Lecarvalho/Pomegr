"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const DESKTOP_THEME_CHANNEL = "pomegr:set-native-theme";
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const TASK_ACTIONS = new Set([
  "create", "update", "delete", "move",
  "feature_create", "feature_update", "feature_delete",
  "queue_add", "queue_remove", "queue_group", "queue_ungroup", "queue_settings",
  "resolve_done", "resolve_requeue", "session_assign", "session_unassign", "after_set", "rework_declare", "rework_remove",
  "aril_settings_set", "aril_memory_add", "aril_memory_update", "aril_memory_remove", "grant_start", "grant_stop",
]);
const TASK_ISSUE_OPERATIONS = new Set(["status", "list", "promote", "create", "sign_in"]);
const AGENT_CHAT_OPERATIONS = new Set(["list", "read", "thread", "search", "send", "stop", "apply", "dismiss", "delete", "warm"]);
const TASK_IMAGE_OPERATIONS = new Set(["add", "remove", "read"]);
const TASK_FEATURE_ID = /^feat-[0-9a-f]{12}$/u;
const SESSION_ID = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TERMINAL_KEY = /^(?:repo-[a-f0-9]{24}\/T-[1-9][0-9]{0,8}\/(?:review-)?|continue\/(?:claude|codex)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/)[a-f0-9]{32}$/iu;
const TERMINAL_ATTACH_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const TASK_IMAGE_ID = /^img-[0-9a-f]{12}$/u;
const TASK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const AGENT_CHAT_CONVERSATION_ID = /^chat-[0-9a-f]{12}$/u;
const ISSUE_DIGEST = /^[a-f0-9]{64}$/u;
const ISSUE_TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const HOME_UPDATE_ID =/^[a-z0-9][a-z0-9-]{0,63}$/u;
const STORAGE_SETTING_ENUMS = {
  retentionDays: new Set([30, 90, 180, 365, 0]),
  storeMaxMb: new Set([250, 500, 1024, 2048]),
};

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
  getStorageSettings() { return ipcRenderer.invoke("pomegr:storage-settings"); },
  setStorageSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(STORAGE_SETTING_ENUMS, key) || !STORAGE_SETTING_ENUMS[key].has(value)) {
      return Promise.resolve({ status: "unavailable", state: null });
    }
    return ipcRenderer.invoke("pomegr:set-storage-setting", key, value);
  },
  discardStorageSettings() { return ipcRenderer.invoke("pomegr:discard-storage-settings"); },
  saveStorageSettings() { return ipcRenderer.invoke("pomegr:save-storage-settings"); },
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
  setNotificationCategory(key, enabled) {
    if (!["attention", "provider_news", "model_news"].includes(key) || typeof enabled !== "boolean") return Promise.resolve(null);
    return ipcRenderer.invoke("pomegr:set-notification-category", key, enabled);
  },
  setDisplayPreference(key, visible) {
    return ipcRenderer.invoke("pomegr:set-display-preference", key, visible);
  },
  setHomeUpdate(key, id) {
    if ((key !== "seenId" && key !== "dismissedId") || typeof id !== "string" || !HOME_UPDATE_ID.test(id)) return Promise.resolve(null);
    return ipcRenderer.invoke("pomegr:set-home-update", key, id);
  },
  checkForUpdates() {
    return ipcRenderer.invoke("pomegr:check-for-updates");
  },
  installUpdate() {
    return ipcRenderer.invoke("pomegr:install-update");
  },
  startCodexSignIn() {
    return ipcRenderer.invoke("pomegr:start-codex-sign-in");
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
  taskAction(repositoryId, action, payload) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || !TASK_ACTIONS.has(action)
      || !payload || typeof payload !== "object" || Array.isArray(payload)) return Promise.resolve({ ok: false, error: "invalid" });
    return ipcRenderer.invoke("pomegr:task-action", repositoryId, action, payload);
  },
  taskLog(repositoryId) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return Promise.resolve({ ok: false, error: "invalid" });
    return ipcRenderer.invoke("pomegr:task-log", repositoryId);
  },
  taskScorecard(repositoryId) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) return Promise.resolve({ ok: false, error: "invalid" });
    return ipcRenderer.invoke("pomegr:task-scorecard", repositoryId);
  },
  taskFeature(repositoryId, featureId) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || typeof featureId !== "string" || !TASK_FEATURE_ID.test(featureId)) return Promise.resolve({ ok: false, error: "invalid" });
    return ipcRenderer.invoke("pomegr:task-feature", repositoryId, featureId);
  },
  sessionContinue(sessionId) {
    if (typeof sessionId !== "string" || !/^(?:claude|codex):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(sessionId)) return Promise.resolve({ status: "invalid" });
    return ipcRenderer.invoke("pomegr:session-continue", sessionId);
  },
  sessionHistory(sessionId, request) {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return Promise.resolve({ ok: false, error: "invalid" });
    return ipcRenderer.invoke("pomegr:session-history", sessionId, request);
  },
  openSessionLink(url) { return ipcRenderer.invoke("pomegr:open-session-link", url); },
  terminal(operation, payload) {
    const plain = payload && typeof payload === "object" && !Array.isArray(payload)
      && (Object.getPrototypeOf(payload) === Object.prototype || Object.getPrototypeOf(payload) === null);
    let valid = operation === "list" && (payload === undefined || (plain && Object.keys(payload).length === 0));
    if (["attach", "input", "resize", "detach"].includes(operation) && plain
      && typeof payload.attachId === "string" && TERMINAL_ATTACH_ID.test(payload.attachId)) {
      const fields = operation === "attach" ? ["key", "attachId"] : operation === "input" ? ["attachId", "data"] : operation === "resize" ? ["attachId", "cols", "rows"] : ["attachId"];
      valid = Object.keys(payload).length === fields.length && fields.every((key) => Object.hasOwn(payload, key));
      if (operation === "attach") valid = valid && typeof payload.key === "string" && TERMINAL_KEY.test(payload.key);
      if (operation === "input") valid = valid && typeof payload.data === "string" && new TextEncoder().encode(payload.data).byteLength <= 16 * 1024;
      if (operation === "resize") valid = valid && Number.isInteger(payload.cols) && payload.cols >= 1 && payload.cols <= 1000
        && Number.isInteger(payload.rows) && payload.rows >= 1 && payload.rows <= 1000;
    }
    if (!valid) return Promise.resolve({ ok: false, status: "invalid" });
    return ipcRenderer.invoke("pomegr:terminal", operation, payload);
  },
  onTerminalOutput(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => {
      if (value && typeof value.attachId === "string" && TERMINAL_ATTACH_ID.test(value.attachId)
        && ["output", "exit", "detached"].includes(value.event)) callback(value);
    };
    ipcRenderer.on("pomegr:terminal-output", listener);
    return () => ipcRenderer.removeListener("pomegr:terminal-output", listener);
  },
  taskIssues(repositoryId, operation, payload) {
    const plain = payload && typeof payload === "object" && !Array.isArray(payload)
      && (Object.getPrototypeOf(payload) === Object.prototype || Object.getPrototypeOf(payload) === null);
    let valid = typeof repositoryId === "string" && REPOSITORY_ID.test(repositoryId) && TASK_ISSUE_OPERATIONS.has(operation) && plain;
    if (valid) {
      const keys = Object.keys(payload);
      valid = operation === "promote"
        ? keys.length === 2 && Number.isInteger(payload.number) && payload.number >= 1 && payload.number <= 999999999
          && typeof payload.digest === "string" && ISSUE_DIGEST.test(payload.digest)
        : operation === "create"
          ? keys.length === 1 && typeof payload.taskId === "string" && ISSUE_TASK_ID.test(payload.taskId)
          : keys.length === 0;
    }
    if (valid) {
      try { valid = JSON.stringify(payload).length <= 16 * 1024; } catch { valid = false; }
    }
    if (!valid) return Promise.resolve({ ok: false, error: "invalid" });
    return ipcRenderer.invoke("pomegr:task-issues", repositoryId, operation, payload);
  },
  taskImage(repositoryId, operation, payload) {
    const plain = payload && typeof payload === "object" && !Array.isArray(payload)
      && (Object.getPrototypeOf(payload) === Object.prototype || Object.getPrototypeOf(payload) === null);
    let valid = typeof repositoryId === "string" && REPOSITORY_ID.test(repositoryId) && TASK_IMAGE_OPERATIONS.has(operation) && plain
      && Object.keys(payload).length === (operation === "add" ? 3 : 2) && typeof payload.taskId === "string" && TASK_ID.test(payload.taskId)
      && typeof payload.imageId === "string" && TASK_IMAGE_ID.test(payload.imageId);
    if (valid && operation === "add") {
      valid = payload.bytes instanceof Uint8Array && payload.bytes.byteLength > 0 && payload.bytes.byteLength <= TASK_IMAGE_MAX_BYTES;
    }
    if (!valid) return Promise.resolve({ ok: false, error: "invalid" });
    return ipcRenderer.invoke("pomegr:task-image", repositoryId, operation, payload);
  },
  agentChat(operation, payload) {
    const plain = payload && typeof payload === "object" && !Array.isArray(payload)
      && (Object.getPrototypeOf(payload) === Object.prototype || Object.getPrototypeOf(payload) === null);
    if (!AGENT_CHAT_OPERATIONS.has(operation) || !plain || typeof payload.repositoryId !== "string" || !REPOSITORY_ID.test(payload.repositoryId)) {
      return Promise.resolve({ ok: false, error: "invalid" });
    }
    return ipcRenderer.invoke("pomegr:agent-chat", operation, payload);
  },
  agentChatImage(operation, payload) {
    const plain = payload && typeof payload === "object" && !Array.isArray(payload)
      && (Object.getPrototypeOf(payload) === Object.prototype || Object.getPrototypeOf(payload) === null);
    let valid = plain && typeof payload.repositoryId === "string" && REPOSITORY_ID.test(payload.repositoryId);
    if (valid && operation === "add") {
      valid = Object.keys(payload).length === 2 && payload.bytes instanceof Uint8Array && payload.bytes.byteLength > 0 && payload.bytes.byteLength <= TASK_IMAGE_MAX_BYTES;
    } else if (valid && operation === "read") {
      valid = Object.keys(payload).length === 3 && typeof payload.conversationId === "string" && AGENT_CHAT_CONVERSATION_ID.test(payload.conversationId)
        && typeof payload.imageId === "string" && TASK_IMAGE_ID.test(payload.imageId);
    } else valid = false;
    if (!valid) return Promise.resolve({ ok: false, error: "invalid" });
    return ipcRenderer.invoke("pomegr:agent-chat-image", operation, payload);
  },
  taskStart(repositoryId, taskId, separateWorktree) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)
      || typeof taskId !== "string" || !TASK_ID.test(taskId)
      || (separateWorktree !== undefined && separateWorktree !== true)) return Promise.resolve({ status: "invalid" });
    return separateWorktree === true
      ? ipcRenderer.invoke("pomegr:task-start", repositoryId, taskId, true)
      : ipcRenderer.invoke("pomegr:task-start", repositoryId, taskId);
  },
  taskReviewStart(repositoryId, taskId) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)
      || typeof taskId !== "string" || !TASK_ID.test(taskId)) return Promise.resolve({ status: "invalid" });
    return ipcRenderer.invoke("pomegr:task-review-start", repositoryId, taskId);
  },
  taskWorktreeOpen(repositoryId, taskId) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)
      || typeof taskId !== "string" || !TASK_ID.test(taskId)) return Promise.resolve({ status: "invalid" });
    return ipcRenderer.invoke("pomegr:task-worktree-open", repositoryId, taskId);
  },
  // The Done action's two questions about a task's running sessions: `inspect` counts them, `settle` ends them once the task is Done.
  taskSessions(repositoryId, taskId, operation, endWorking) {
    if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)
      || typeof taskId !== "string" || !TASK_ID.test(taskId)
      || (operation === "inspect" ? endWorking !== undefined : operation !== "settle" || typeof endWorking !== "boolean")) return Promise.resolve({ status: "invalid" });
    return operation === "inspect"
      ? ipcRenderer.invoke("pomegr:task-sessions", repositoryId, taskId, "inspect")
      : ipcRenderer.invoke("pomegr:task-sessions", repositoryId, taskId, "settle", endWorking);
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
