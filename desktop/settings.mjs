import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DESKTOP_SETTINGS_VERSION = 4;
export const DEFAULT_DESKTOP_SETTINGS = Object.freeze({
  version: DESKTOP_SETTINGS_VERSION,
  window: Object.freeze({ width: 1280, height: 800, x: null, y: null, maximized: false }),
  launchAtLogin: false,
  closeBehavior: "ask",
  notifications: true,
  updates: true,
  lanSharingAutoStart: false,
  displayPreferences: Object.freeze({ contextHistory: true, estimatedCost: true }),
});

function boundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function isBoundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isPersistedSettings(value, version = DESKTOP_SETTINGS_VERSION) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== version) return false;
  const window = value.window;
  const displayPreferences = value.displayPreferences;
  return Boolean(window && typeof window === "object" && !Array.isArray(window)
    && isBoundedInteger(window.width, 720, 3840)
    && isBoundedInteger(window.height, 520, 2160)
    && (window.x === null || isBoundedInteger(window.x, -100_000, 100_000))
    && (window.y === null || isBoundedInteger(window.y, -100_000, 100_000))
    && typeof window.maximized === "boolean"
    && typeof value.launchAtLogin === "boolean"
    && (version === 1 || ["ask", "tray", "quit"].includes(value.closeBehavior))
    && typeof value.notifications === "boolean"
    && typeof value.updates === "boolean"
    && (version < 4 || typeof value.lanSharingAutoStart === "boolean")
    && (version < 3 || (displayPreferences && typeof displayPreferences === "object" && !Array.isArray(displayPreferences)
      && typeof displayPreferences.contextHistory === "boolean"
      && typeof displayPreferences.estimatedCost === "boolean")));
}

function loadResult(settings, status, canPersist) {
  return Object.freeze({ settings, status, canPersist });
}

export function normalizeDesktopSettings(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const window = source.window && typeof source.window === "object" && !Array.isArray(source.window)
    ? source.window
    : {};
  return {
    version: DESKTOP_SETTINGS_VERSION,
    window: {
      width: boundedInteger(window.width, 720, 3840, DEFAULT_DESKTOP_SETTINGS.window.width),
      height: boundedInteger(window.height, 520, 2160, DEFAULT_DESKTOP_SETTINGS.window.height),
      x: boundedInteger(window.x, -100_000, 100_000, null),
      y: boundedInteger(window.y, -100_000, 100_000, null),
      maximized: typeof window.maximized === "boolean" ? window.maximized : false,
    },
    launchAtLogin: typeof source.launchAtLogin === "boolean" ? source.launchAtLogin : false,
    closeBehavior: ["ask", "tray", "quit"].includes(source.closeBehavior) ? source.closeBehavior : "ask",
    notifications: typeof source.notifications === "boolean" ? source.notifications : true,
    updates: typeof source.updates === "boolean" ? source.updates : true,
    lanSharingAutoStart: typeof source.lanSharingAutoStart === "boolean" ? source.lanSharingAutoStart : false,
    displayPreferences: {
      contextHistory: typeof source.displayPreferences?.contextHistory === "boolean" ? source.displayPreferences.contextHistory : true,
      estimatedCost: typeof source.displayPreferences?.estimatedCost === "boolean" ? source.displayPreferences.estimatedCost : true,
    },
  };
}

export function settingsForWindowClose(loaded, current, bounds, maximized) {
  if (loaded?.canPersist !== true) return null;
  return normalizeDesktopSettings({
    ...current,
    window: { ...bounds, maximized: Boolean(maximized) },
  });
}

export function createDesktopSettingsStore(settingsFile, io = {}) {
  if (!path.isAbsolute(settingsFile)) throw new Error("DESKTOP_SETTINGS_PATH_INVALID");
  const operations = {
    mkdir: io.mkdir || mkdir,
    readFile: io.readFile || readFile,
    rename: io.rename || rename,
    unlink: io.unlink || unlink,
    writeFile: io.writeFile || writeFile,
  };
  let state = "unloaded";

  async function write(value) {
    const settings = normalizeDesktopSettings(value);
    await operations.mkdir(path.dirname(settingsFile), { recursive: true });
    const temporary = `${settingsFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await operations.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await operations.rename(temporary, settingsFile);
    } catch (error) {
      try { await operations.unlink(temporary); } catch { /* Best-effort temporary cleanup. */ }
      throw error;
    }
    state = "loaded";
    return settings;
  }

  return Object.freeze({
    async load() {
      try {
        const parsed = JSON.parse(await operations.readFile(settingsFile, "utf8"));
        if (Number.isInteger(parsed?.version) && parsed.version > DESKTOP_SETTINGS_VERSION) {
          state = "future-version";
          return loadResult(normalizeDesktopSettings(), state, false);
        }
        if ([1, 2, 3].includes(parsed?.version) && isPersistedSettings(parsed, parsed.version)) {
          state = "loaded";
          return loadResult(normalizeDesktopSettings({ ...parsed, lanSharingAutoStart: false }), "migrated", true);
        }
        if (!isPersistedSettings(parsed)) {
          state = "invalid";
          return loadResult(normalizeDesktopSettings(), state, false);
        }
        state = "loaded";
        return loadResult(normalizeDesktopSettings(parsed), state, true);
      } catch (error) {
        state = error?.code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid" : "unavailable";
        return loadResult(normalizeDesktopSettings(), state, state === "missing");
      }
    },
    async save(value) {
      if (!["loaded", "missing"].includes(state)) throw new Error("DESKTOP_SETTINGS_RECOVERY_REQUIRED");
      return write(value);
    },
    async recover(value) {
      if (!["invalid", "future-version"].includes(state)) throw new Error("DESKTOP_SETTINGS_RECOVERY_NOT_ALLOWED");
      await operations.mkdir(path.dirname(settingsFile), { recursive: true });
      const quarantineFile = `${settingsFile}.invalid-${Date.now()}-${randomBytes(4).toString("hex")}`;
      await operations.rename(settingsFile, quarantineFile);
      state = "missing";
      const settings = await write(value);
      return { settings, quarantineFile };
    },
  });
}
