import { execFile as defaultExecFile } from "node:child_process";
import path from "node:path";

import { minimalRuntimeEnvironment } from "./environment-policy.mjs";

const MAX_SAFE_VERSION_LENGTH = 64;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z]+)(?:\.[0-9A-Za-z-]+)*)?$/;
const FULL_PUBLISHER_SUBJECT = /^CN=.+,\s*[A-Z][A-Z0-9.]*=.+$/i;
const SIGNATURE_TIMEOUT_MS = 20_000;
export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

function sameWindowsPath(left, right) {
  return path.resolve(String(left || "")).toUpperCase() === path.resolve(String(right || "")).toUpperCase();
}

export function isFullPublisherSubject(value) {
  return FULL_PUBLISHER_SUBJECT.test(String(value || ""));
}

export function createWindowsUpdateSignatureVerifier(options = {}) {
  const execFile = options.execFile || defaultExecFile;
  const sourceEnvironment = options.environment || process.env;
  return (publisherNames, updatePath) => new Promise((resolve) => {
    const expectedSubject = Array.isArray(publisherNames) && publisherNames.length === 1
      ? publisherNames[0]
      : null;
    if (!isFullPublisherSubject(expectedSubject) || typeof updatePath !== "string" || !path.isAbsolute(updatePath)) {
      resolve("DESKTOP_UPDATE_PUBLISHER_SUBJECT_INVALID");
      return;
    }
    const script = [
      "$signature = Get-AuthenticodeSignature -LiteralPath $env:POMEGR_UPDATE_VERIFY_PATH",
      "[PSCustomObject]@{ Status = [string]$signature.Status; Path = $signature.Path; Subject = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress",
    ].join("; ");
    execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat", "None",
      "-Command", script,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: SIGNATURE_TIMEOUT_MS,
      env: minimalRuntimeEnvironment(sourceEnvironment, { POMEGR_UPDATE_VERIFY_PATH: updatePath }),
    }, (error, stdout, stderr) => {
      if (error || stderr) {
        resolve("DESKTOP_UPDATE_SIGNATURE_CHECK_FAILED");
        return;
      }
      try {
        const result = JSON.parse(stdout);
        const subjectMatches = String(result?.Subject || "").toUpperCase() === expectedSubject.toUpperCase();
        if (result?.Status === "Valid" && sameWindowsPath(result?.Path, updatePath) && subjectMatches) resolve(null);
        else resolve("DESKTOP_UPDATE_SIGNATURE_INVALID");
      } catch {
        resolve("DESKTOP_UPDATE_SIGNATURE_CHECK_FAILED");
      }
    });
  });
}

export const DESKTOP_UPDATE_STATES = Object.freeze([
  "disabled",
  "idle",
  "checking",
  "downloading",
  "ready",
  "installing",
  "failed",
]);

export function desktopReleaseChannel(version) {
  const normalizedVersion = String(version || "");
  if (normalizedVersion.length > MAX_SAFE_VERSION_LENGTH) return null;
  const match = normalizedVersion.match(SAFE_VERSION);
  if (!match) return null;
  return match[1] === undefined ? "stable" : match[1] === "beta" ? "beta" : null;
}

export function isUpdateVersionAllowed(currentVersion, candidateVersion) {
  const currentChannel = desktopReleaseChannel(currentVersion);
  return currentChannel !== null && desktopReleaseChannel(candidateVersion) === currentChannel;
}

function boundedUpdateState(status, version = null) {
  const normalizedVersion = String(version || "");
  return Object.freeze({
    status: DESKTOP_UPDATE_STATES.includes(status) ? status : "failed",
    version: normalizedVersion.length <= MAX_SAFE_VERSION_LENGTH && SAFE_VERSION.test(normalizedVersion)
      ? normalizedVersion
      : null,
  });
}

export function createDesktopUpdaterController(options) {
  const updater = options.updater;
  const scheduler = options.scheduler || globalThis;
  const checkIntervalMs = Number.isFinite(options.checkIntervalMs) && options.checkIntervalMs > 0
    ? options.checkIntervalMs
    : DESKTOP_UPDATE_CHECK_INTERVAL_MS;
  const enabled = options.packaged === true
    && options.mode === "installed"
    && options.updatesEnabled === true
    && desktopReleaseChannel(options.currentVersion) !== null;
  let state = boundedUpdateState(enabled ? "idle" : "disabled");
  let started = false;
  let disposed = false;
  let installing = false;
  let readyVersion = null;
  let checkPromise = null;
  let checkTimer = null;
  const listeners = [];
  const clearScheduledCheck = () => {
    if (checkTimer === null) return;
    scheduler.clearTimeout(checkTimer);
    checkTimer = null;
  };
  const scheduleCheck = () => {
    clearScheduledCheck();
    if (!started || disposed || (state.status !== "idle" && state.status !== "failed")) return;
    checkTimer = scheduler.setTimeout(() => {
      checkTimer = null;
      void check();
    }, checkIntervalMs);
    checkTimer?.unref?.();
  };
  const setState = (status, version = null) => {
    state = boundedUpdateState(status, version);
    options.onState?.(state);
    scheduleCheck();
    return state;
  };
  const listen = (event, handler) => {
    updater.on(event, handler);
    listeners.push([event, handler]);
  };
  const recoverInstall = () => {
    if (!installing) return;
    installing = false;
    try { options.cancelInstall?.(); } catch { /* Recovery must still restore the verified update offer. */ }
    if (!disposed && readyVersion) setState("ready", readyVersion);
  };

  async function check() {
    if (checkPromise || disposed || (state.status !== "idle" && state.status !== "failed")) return checkPromise;
    clearScheduledCheck();
    setState("checking");
    checkPromise = (async () => {
      try {
        await updater.checkForUpdates();
        if (!disposed && state.status === "checking") setState("idle");
      } catch {
        if (!disposed && state.status === "checking") setState("failed");
      } finally {
        checkPromise = null;
        scheduleCheck();
      }
      return state;
    })();
    return checkPromise;
  }

  async function download(info) {
    if (disposed || state.status === "ready" || state.status === "installing") return;
    if (!isUpdateVersionAllowed(options.currentVersion, info?.version)) {
      setState("idle");
      return;
    }
    setState("downloading", info.version);
    try {
      await updater.downloadUpdate();
    } catch {
      if (!disposed) setState("failed");
    }
  }

  function markReady(info) {
    if (disposed || installing || state.status === "ready") return;
    if (!isUpdateVersionAllowed(options.currentVersion, info?.version)) {
      setState("failed");
      return;
    }
    readyVersion = info.version;
    setState("ready", readyVersion);
  }

  function install() {
    if (disposed || installing || state.status !== "ready" || !readyVersion) return false;
    installing = true;
    setState("installing", readyVersion);
    try {
      options.prepareInstall?.();
      updater.quitAndInstall(false, true);
    } catch {
      recoverInstall();
    }
    return installing;
  }

  return Object.freeze({
    snapshot: () => state,
    async start() {
      if (started || disposed || !enabled) return state;
      started = true;
      updater.logger = Object.freeze({ debug() {}, error() {}, info() {}, warn() {} });
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowDowngrade = false;
      updater.allowPrerelease = desktopReleaseChannel(options.currentVersion) === "beta";
      if (options.verifyUpdateCodeSignature) updater.verifyUpdateCodeSignature = options.verifyUpdateCodeSignature;
      listen("update-available", (info) => { void download(info); });
      listen("update-downloaded", markReady);
      listen("update-not-available", () => { if (state.status === "checking") setState("idle"); });
      listen("error", () => {
        if (installing) recoverInstall();
        else if (state.status !== "ready") setState("failed");
      });
      await check();
      return state;
    },
    install,
    dispose() {
      disposed = true;
      clearScheduledCheck();
      for (const [event, handler] of listeners) updater.removeListener(event, handler);
      listeners.length = 0;
    },
  });
}
