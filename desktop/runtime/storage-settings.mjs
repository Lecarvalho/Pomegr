import { environmentValue } from "./environment-policy.mjs";

export const STORAGE_SETTING_KEYS = Object.freeze(["retentionDays", "storeMaxMb"]);
// Desktop encoding: `0` means keep all (the monitor environment contract uses `"all"`).
const STORAGE_SETTING_CHOICES = Object.freeze({
  retentionDays: Object.freeze([30, 90, 180, 365, 0]),
  storeMaxMb: Object.freeze([250, 500, 1024, 2048]),
});
const ENVIRONMENT_KEYS = Object.freeze({ retentionDays: "POMEGR_RETENTION_DAYS", storeMaxMb: "POMEGR_STORE_MAX_MB" });
const DEFAULTS = Object.freeze({ retentionDays: 90, storeMaxMb: 500 });
const LABELS = Object.freeze({ retentionDays: "Retention age", storeMaxMb: "Resource history cleanup threshold" });
export const STORAGE_SETTINGS_CHANNELS = Object.freeze({
  get: "pomegr:storage-settings", set: "pomegr:set-storage-setting",
  discard: "pomegr:discard-storage-settings", save: "pomegr:save-storage-settings",
});

export function validStorageSetting(key, value) {
  return STORAGE_SETTING_KEYS.includes(key) && typeof value === "number" && STORAGE_SETTING_CHOICES[key].includes(value);
}

export function normalizeStorageSettings(value) {
  return Object.fromEntries(STORAGE_SETTING_KEYS.map((key) => [key, validStorageSetting(key, value?.[key]) ? value[key] : null]));
}

export function validPersistedStorageSettings(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && STORAGE_SETTING_KEYS.every((key) => value[key] === null || validStorageSetting(key, value[key]));
}

function parseEnvironmentRetentionDays(raw) {
  if (raw === "all") return 0;
  if (typeof raw !== "string" || !/^\d+$/u.test(raw)) return undefined;
  const parsed = Number(raw);
  return validStorageSetting("retentionDays", parsed) ? parsed : undefined;
}

function parseEnvironmentStoreMaxMb(raw) {
  if (typeof raw !== "string" || !/^\d+$/u.test(raw)) return undefined;
  const parsed = Number(raw);
  return validStorageSetting("storeMaxMb", parsed) ? parsed : undefined;
}

const ENVIRONMENT_PARSERS = Object.freeze({ retentionDays: parseEnvironmentRetentionDays, storeMaxMb: parseEnvironmentStoreMaxMb });

export function effectiveStorageSettings(saved, environment) {
  const result = {};
  for (const key of STORAGE_SETTING_KEYS) {
    const savedValue = saved?.[key];
    if (validStorageSetting(key, savedValue)) { result[key] = savedValue; continue; }
    const inherited = ENVIRONMENT_PARSERS[key](environmentValue(environment, ENVIRONMENT_KEYS[key]));
    result[key] = inherited !== undefined ? inherited : DEFAULTS[key];
  }
  return result;
}

function setEnvironment(environment, key, value) {
  for (const existing of Object.keys(environment)) if (existing.toLowerCase() === key.toLowerCase()) delete environment[existing];
  if (value !== undefined) environment[key] = value;
}

// Only the private monitor worker receives these variables. Null fields leave any
// inherited launch-environment value in place so an unsaved field keeps working.
export function storageSettingsEnvironment(environment, saved) {
  const result = { ...environment };
  for (const key of STORAGE_SETTING_KEYS) {
    const value = saved?.[key];
    if (!validStorageSetting(key, value)) continue;
    setEnvironment(result, ENVIRONMENT_KEYS[key], key === "retentionDays" && value === 0 ? "all" : String(value));
  }
  return result;
}

function describeStorageValue(key, value) {
  if (key === "retentionDays") return value === 0 ? "Keep all" : `${value} days`;
  if (value === 1024) return "1 GB";
  if (value === 2048) return "2 GB";
  return `${value} MB`;
}

export function createStorageSettingsController({ storage, environment, canPersist, confirm, persist, restart }) {
  let saved = normalizeStorageSettings(storage);
  let draft = { ...saved };
  let busy = false;
  let disposed = false;
  let restarting = false;
  const changed = () => STORAGE_SETTING_KEYS.some((key) => saved[key] !== draft[key]);

  function snapshot() {
    if (disposed) return null;
    return { canSave: canPersist && !restarting, pendingChanges: changed(), values: effectiveStorageSettings(draft, environment) };
  }

  async function act(operation) {
    if (disposed || !canPersist) return { status: "unavailable", state: snapshot() };
    if (busy || restarting) return { status: "busy", state: snapshot() };
    busy = true;
    try { return { status: await operation(), state: snapshot() }; }
    catch { return { status: "failed", state: disposed ? null : snapshot() }; }
    finally { busy = false; }
  }

  return Object.freeze({
    snapshot: async () => snapshot(),
    set(key, value) {
      if (!validStorageSetting(key, value)) return Promise.resolve({ status: "unavailable", state: null });
      return act(async () => { draft = { ...draft, [key]: value }; return "ready"; });
    },
    discard() { return act(async () => { draft = { ...saved }; return "ready"; }); },
    save() {
      return act(async () => {
        if (!changed()) return "ready";
        const next = { ...draft };
        const effective = effectiveStorageSettings(next, environment);
        const detail = STORAGE_SETTING_KEYS.map((key) => `${LABELS[key]}: ${describeStorageValue(key, effective[key])}`).join("\n")
          + "\n\nThe monitor applies these on its next prune cycle. Pruning never removes sessions, transcripts, checkpoints, file history, or recorded peaks.";
        if (await confirm({ title: "Apply storage settings?", message: "Save and restart Pomegr?", detail, buttons: ["Cancel", "Save and restart Pomegr"], defaultId: 0, cancelId: 0, noLink: true }) !== true) return "cancelled";
        if (disposed) return "unavailable";
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

export function installStorageSettingsIpc({ ipcMain, isTrustedEvent, controller }) {
  for (const [operation, channel] of Object.entries(STORAGE_SETTINGS_CHANNELS)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const keyed = operation === "set";
      const invalid = !isTrustedEvent(event) || args.length !== (keyed ? 2 : 0) || (keyed && !validStorageSetting(args[0], args[1]));
      if (invalid) return operation === "get" ? null : { status: "unavailable", state: null };
      try { return await (operation === "get" ? controller.snapshot() : controller[operation](...args)); }
      catch { return operation === "get" ? null : { status: "failed", state: null }; }
    });
  }
  return () => { for (const channel of Object.values(STORAGE_SETTINGS_CHANNELS)) ipcMain.removeHandler(channel); };
}
