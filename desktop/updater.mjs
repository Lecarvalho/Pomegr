import { execFile as defaultExecFile } from "node:child_process";
import path from "node:path";

import { minimalRuntimeEnvironment } from "./environment-policy.mjs";

const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z]+)(?:\.[0-9A-Za-z-]+)*)?$/;
const FULL_PUBLISHER_SUBJECT = /^CN=.+,\s*[A-Z][A-Z0-9.]*=.+$/i;
const SIGNATURE_TIMEOUT_MS = 20_000;

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
      "$signature = Get-AuthenticodeSignature -LiteralPath $env:THREADLIGHT_UPDATE_VERIFY_PATH",
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
      env: minimalRuntimeEnvironment(sourceEnvironment, { THREADLIGHT_UPDATE_VERIFY_PATH: updatePath }),
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
  const match = String(version || "").match(SAFE_VERSION);
  if (!match) return null;
  return match[1] === undefined ? "stable" : match[1] === "beta" ? "beta" : null;
}

export function isUpdateVersionAllowed(currentVersion, candidateVersion) {
  const currentChannel = desktopReleaseChannel(currentVersion);
  return currentChannel !== null && desktopReleaseChannel(candidateVersion) === currentChannel;
}

function boundedUpdateState(status, version = null) {
  return Object.freeze({
    status: DESKTOP_UPDATE_STATES.includes(status) ? status : "failed",
    version: SAFE_VERSION.test(String(version || "")) ? String(version) : null,
  });
}

export function createDesktopUpdaterController(options) {
  const updater = options.updater;
  const enabled = options.packaged === true
    && options.mode === "installed"
    && options.updatesEnabled === true
    && desktopReleaseChannel(options.currentVersion) !== null;
  let state = boundedUpdateState(enabled ? "idle" : "disabled");
  let started = false;
  let disposed = false;
  let installing = false;
  const listeners = [];
  const setState = (status, version = null) => {
    state = boundedUpdateState(status, version);
    options.onState?.(state);
    return state;
  };
  const listen = (event, handler) => {
    updater.on(event, handler);
    listeners.push([event, handler]);
  };
  const recoverInstall = () => {
    if (!installing) return;
    installing = false;
    options.cancelInstall?.();
    if (!disposed) setState("failed");
  };

  async function download(info) {
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

  async function offerInstall(info) {
    if (installing || !isUpdateVersionAllowed(options.currentVersion, info?.version)) {
      if (!installing) setState("failed");
      return;
    }
    setState("ready", info.version);
    let confirmed = false;
    try { confirmed = await options.confirmInstall(info.version); } catch { /* A failed prompt leaves the current app running. */ }
    if (!confirmed || disposed) return;
    installing = true;
    setState("installing", info.version);
    try {
      options.prepareInstall?.();
      updater.quitAndInstall(false, true);
    } catch {
      recoverInstall();
    }
  }

  return Object.freeze({
    snapshot: () => state,
    async start() {
      if (started || !enabled) return state;
      started = true;
      updater.logger = Object.freeze({ debug() {}, error() {}, info() {}, warn() {} });
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowDowngrade = false;
      updater.allowPrerelease = desktopReleaseChannel(options.currentVersion) === "beta";
      if (options.verifyUpdateCodeSignature) updater.verifyUpdateCodeSignature = options.verifyUpdateCodeSignature;
      listen("update-available", (info) => { void download(info); });
      listen("update-downloaded", (info) => { void offerInstall(info); });
      listen("update-not-available", () => { if (!installing) setState("idle"); });
      listen("error", () => { if (installing) recoverInstall(); else setState("failed"); });
      setState("checking");
      try {
        await updater.checkForUpdates();
      } catch {
        if (!disposed) setState("failed");
      }
      return state;
    },
    dispose() {
      disposed = true;
      for (const [event, handler] of listeners) updater.removeListener(event, handler);
      listeners.length = 0;
    },
  });
}
