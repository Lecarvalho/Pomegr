import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { environmentValue } from "./environment-policy.mjs";

export const PROVIDER_FOLDER_KEYS = Object.freeze(["claudeConfigDir", "claudeProjectsDir", "codexHome"]);
const ENVIRONMENT_KEYS = Object.freeze({ claudeConfigDir: "CLAUDE_CONFIG_DIR", claudeProjectsDir: "CLAUDE_PROJECTS_DIR", codexHome: "CODEX_HOME" });
const LABELS = Object.freeze({ claudeConfigDir: "Claude Code configuration folder", claudeProjectsDir: "Claude Code session folder", codexHome: "Codex home folder" });
export const PROVIDER_SETTINGS_CHANNELS = Object.freeze({
  get: "pomegr:provider-settings", choose: "pomegr:choose-provider-folder",
  reset: "pomegr:reset-provider-folder", discard: "pomegr:discard-provider-settings",
  save: "pomegr:save-provider-settings",
});

export function validProviderFolder(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/u.test(value) && path.isAbsolute(value);
}

export function normalizeProviderFolders(value) {
  return Object.fromEntries(PROVIDER_FOLDER_KEYS.map((key) => [key, validProviderFolder(value?.[key]) ? path.normalize(value[key]) : null]));
}

export function validPersistedProviderFolders(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && PROVIDER_FOLDER_KEYS.every((key) => value[key] === null || validProviderFolder(value[key]));
}

export function resolveProviderFolders(folders, environment, homeDir) {
  const defaults = { claudeConfigDir: path.join(homeDir, ".claude"), codexHome: path.join(homeDir, ".codex") };
  const resolved = {};
  for (const key of PROVIDER_FOLDER_KEYS) {
    const inherited = environmentValue(environment, ENVIRONMENT_KEYS[key]);
    const selected = folders[key] || inherited;
    resolved[key] = selected ? path.resolve(selected) : key === "claudeProjectsDir"
      ? path.join(resolved.claudeConfigDir, "projects") : defaults[key];
  }
  return resolved;
}

function setEnvironment(environment, key, value) {
  for (const existing of Object.keys(environment)) if (existing.toLowerCase() === key.toLowerCase()) delete environment[existing];
  if (value !== undefined) environment[key] = value;
}

// Only the native process and private monitor receive these paths. Never pass this
// object to the renderer, local web host, an HTTP handler, or a log sink.
export function providerSettingsEnvironment(environment, folders, { homeDir, dataRoot }) {
  const result = { ...environment };
  const resolved = resolveProviderFolders(normalizeProviderFolders(folders), environment, homeDir);
  for (const key of PROVIDER_FOLDER_KEYS) setEnvironment(result, ENVIRONMENT_KEYS[key], resolved[key]);
  if (folders?.claudeConfigDir || folders?.claudeProjectsDir) setEnvironment(result, "CLAUDE_SESSION_FILE", undefined);
  const identity = (directory) => process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  if (identity(resolved.claudeConfigDir) !== identity(path.join(homeDir, ".claude"))) {
    const profile = createHash("sha256").update(identity(resolved.claudeConfigDir)).digest("hex").slice(0, 32);
    for (const [variable, directory] of [["POMEGR_USAGE_SNAPSHOTS_DIR", "usage-snapshots"], ["POMEGR_COST_SNAPSHOTS_DIR", "cost-snapshots"]]) {
      if (!environmentValue(environment, variable)) setEnvironment(result, variable, path.join(dataRoot, directory, "profiles", profile));
    }
  }
  return result;
}

async function readableDirectory(directory) {
  try { return (await stat(directory)).isDirectory() && (await access(directory, constants.R_OK), true); } catch { return false; }
}

export function createProviderSettingsController({ folders, environment, homeDir, canPersist, chooseDirectory, confirm, persist, restart, directoryAvailable = readableDirectory, canonicalDirectory = realpath }) {
  let saved = normalizeProviderFolders(folders);
  let draft = { ...saved };
  let busy = false;
  let disposed = false;
  let restarting = false;
  const changed = () => PROVIDER_FOLDER_KEYS.some((key) => saved[key] !== draft[key]);

  async function snapshot() {
    if (disposed) return null;
    const current = { ...draft };
    const resolved = resolveProviderFolders(current, environment, homeDir);
    const entries = await Promise.all(PROVIDER_FOLDER_KEYS.map(async (key) => [key, {
      selection: current[key] ? "custom" : environmentValue(environment, ENVIRONMENT_KEYS[key]) ? "environment" : "default",
      availability: await directoryAvailable(resolved[key]) ? "available" : "unavailable",
    }]));
    return disposed ? null : { canSave: canPersist && !restarting, pendingChanges: changed(), folders: Object.fromEntries(entries) };
  }

  async function act(operation) {
    if (disposed || !canPersist) return { status: "unavailable", state: await snapshot() };
    if (busy || restarting) return { status: "busy", state: await snapshot() };
    busy = true;
    try { return { status: await operation(), state: await snapshot() }; }
    catch { return { status: "failed", state: await snapshot().catch(() => null) }; }
    finally { busy = false; }
  }

  return Object.freeze({
    snapshot,
    choose(key) {
      if (!PROVIDER_FOLDER_KEYS.includes(key)) return Promise.resolve({ status: "unavailable", state: null });
      return act(async () => {
        const selected = await chooseDirectory({ title: `Choose ${LABELS[key]}`, defaultPath: resolveProviderFolders(draft, environment, homeDir)[key], properties: ["openDirectory", "dontAddToRecent"] });
        if (disposed) return "unavailable";
        if (selected.canceled) return "cancelled";
        if (selected.filePaths?.length !== 1 || !validProviderFolder(selected.filePaths[0])) return "unavailable";
        const directory = await canonicalDirectory(selected.filePaths[0]);
        if (!validProviderFolder(directory) || !await directoryAvailable(directory)) return "unavailable";
        if (disposed) return "unavailable";
        draft = { ...draft, [key]: directory };
        return "ready";
      });
    },
    reset(key) {
      if (!PROVIDER_FOLDER_KEYS.includes(key)) return Promise.resolve({ status: "unavailable", state: null });
      return act(async () => { draft = { ...draft, [key]: null }; return "ready"; });
    },
    discard() { return act(async () => { draft = { ...saved }; return "ready"; }); },
    save() {
      return act(async () => {
        if (!changed()) return "ready";
        const next = { ...draft };
        const resolved = resolveProviderFolders(next, environment, homeDir);
        const selectedReadable = async () => (await Promise.all(PROVIDER_FOLDER_KEYS.map((key) => next[key] && next[key] !== saved[key] ? directoryAvailable(resolved[key]) : true))).every(Boolean);
        if (!await selectedReadable()) return "unavailable";
        if (await confirm({ title: "Apply provider folders?", message: "Save and restart Pomegr?", detail: PROVIDER_FOLDER_KEYS.map((key) => `${LABELS[key]}:\n${resolved[key]}`).join("\n\n") + "\n\nPomegr will observe these folders and use the selected profiles for account usage and provider setup. Running coding tools are unchanged. No provider files are moved.", buttons: ["Cancel", "Save and restart Pomegr"], defaultId: 0, cancelId: 0, noLink: true }) !== true) return "cancelled";
        if (disposed || !await selectedReadable()) return "unavailable";
        await persist(next);
        saved = next;
        if (disposed) return "unavailable";
        restarting = true;
        try { await restart(); } catch { restarting = false; return "failed"; }
        return "restarting";
      });
    },
    dispose() { disposed = true; },
  });
}

export function installProviderSettingsIpc({ ipcMain, isTrustedEvent, controller }) {
  for (const [operation, channel] of Object.entries(PROVIDER_SETTINGS_CHANNELS)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const keyed = operation === "choose" || operation === "reset";
      const invalid = !isTrustedEvent(event) || args.length !== (keyed ? 1 : 0) || (keyed && !PROVIDER_FOLDER_KEYS.includes(args[0]));
      if (invalid) return operation === "get" ? null : { status: "unavailable", state: null };
      try { return await (operation === "get" ? controller.snapshot() : controller[operation](...args)); }
      catch { return operation === "get" ? null : { status: "failed", state: null }; }
    });
  }
  return () => { for (const channel of Object.values(PROVIDER_SETTINGS_CHANNELS)) ipcMain.removeHandler(channel); };
}

// Start only Pomegr's own trusted executable after releasing its single-instance
// lock. A private child environment preserves launch overrides without restoring
// provider paths into the in-process web host's process.env.
export async function restartProviderSettingsApp({ application, stopRuntime, environment, executable, spawnProcess = spawn }) {
  await stopRuntime();
  application.releaseSingleInstanceLock();
  try {
    const child = spawnProcess(executable, application.isPackaged ? [] : [application.getAppPath()], {
      env: environment, detached: true, windowsHide: true, stdio: "ignore",
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    application.exit(0);
  } catch {
    application.requestSingleInstanceLock();
    throw new Error("DESKTOP_RESTART_FAILED");
  }
}
