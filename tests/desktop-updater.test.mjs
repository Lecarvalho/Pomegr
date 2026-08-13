import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import {
  createDesktopUpdaterController,
  createWindowsUpdateSignatureVerifier,
  desktopReleaseChannel,
  isFullPublisherSubject,
  isUpdateVersionAllowed,
} from "../desktop/updater.mjs";

class FakeUpdater extends EventEmitter {
  async checkForUpdates() { this.calls.push("check"); return null; }
  async downloadUpdate() { this.calls.push("download"); return []; }
  quitAndInstall(silent, runAfter) { this.calls.push(["install", silent, runAfter]); }
  calls = [];
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(overrides = {}) {
  const updater = overrides.updater || new FakeUpdater();
  const calls = [];
  const verifyUpdateCodeSignature = overrides.verifyUpdateCodeSignature || (() => Promise.resolve(null));
  const controller = createDesktopUpdaterController({
    updater,
    currentVersion: overrides.currentVersion || "1.0.0-beta.1",
    packaged: overrides.packaged ?? true,
    mode: overrides.mode || "installed",
    updatesEnabled: overrides.updatesEnabled ?? true,
    verifyUpdateCodeSignature,
    async confirmInstall(version) { calls.push(["confirm", version]); return overrides.confirmed ?? true; },
    prepareInstall() { calls.push("prepare"); },
    cancelInstall() { calls.push("cancel"); },
    onState(state) { calls.push(["state", state]); },
  });
  return { calls, controller, updater, verifyUpdateCodeSignature };
}

test("release channels accept stable or beta only and never cross streams", () => {
  assert.equal(desktopReleaseChannel("1.2.3"), "stable");
  assert.equal(desktopReleaseChannel("1.2.3-beta.4"), "beta");
  assert.equal(desktopReleaseChannel("1.2.3-alpha.1"), null);
  assert.equal(desktopReleaseChannel("PRIVATE_PATH_MUST_NOT_LEAK"), null);
  assert.equal(isUpdateVersionAllowed("1.2.3", "1.2.4"), true);
  assert.equal(isUpdateVersionAllowed("1.2.3", "1.2.4-beta.1"), false);
  assert.equal(isUpdateVersionAllowed("1.2.3-beta.1", "1.2.3-beta.2"), true);
  assert.equal(isUpdateVersionAllowed("1.2.3-beta.1", "1.2.3"), false);
});

test("downloaded Windows installers require the exact full certificate Subject DN", async () => {
  const expected = "CN=Leandro Carvalho, O=Pomegr, C=CA";
  const updatePath = path.resolve("Pomegr-Setup.exe");
  const calls = [];
  const verifier = createWindowsUpdateSignatureVerifier({
    environment: { SystemRoot: "C:\\Windows", PRIVATE_TOKEN: "MUST_NOT_LEAK" },
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null, JSON.stringify({ Status: "Valid", Path: updatePath, Subject: expected }), "");
    },
  });
  assert.equal(isFullPublisherSubject(expected), true);
  assert.equal(isFullPublisherSubject("Leandro Carvalho"), false);
  assert.equal(await verifier([expected], updatePath), null);
  assert.equal(await verifier(["Leandro Carvalho"], updatePath), "DESKTOP_UPDATE_PUBLISHER_SUBJECT_INVALID");
  assert.equal(await verifier([expected, "CN=Other, O=Other"], updatePath), "DESKTOP_UPDATE_PUBLISHER_SUBJECT_INVALID");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "None"]);
  assert.equal(calls[0].options.env.POMEGR_UPDATE_VERIFY_PATH, updatePath);
  assert.equal(calls[0].options.env.PRIVATE_TOKEN, undefined);

  const wrongSubject = createWindowsUpdateSignatureVerifier({
    execFile(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ Status: "Valid", Path: updatePath, Subject: "CN=Other, O=Pomegr, C=CA" }), "");
    },
  });
  assert.equal(await wrongSubject([expected], updatePath), "DESKTOP_UPDATE_SIGNATURE_INVALID");
});

test("update checks are nonblocking at the shell boundary and installed builds only", async () => {
  for (const input of [
    { packaged: false, mode: "installed", updatesEnabled: true },
    { packaged: true, mode: "portable", updatesEnabled: true },
    { packaged: true, mode: "installed", updatesEnabled: false },
  ]) {
    const { controller, updater } = harness(input);
    await controller.start();
    assert.deepEqual(updater.calls, []);
    assert.equal(controller.snapshot().status, "disabled");
  }
  const { controller, updater, verifyUpdateCodeSignature } = harness();
  await controller.start();
  assert.deepEqual(updater.calls, ["check"]);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.verifyUpdateCodeSignature, verifyUpdateCodeSignature);
});

test("a matching downloaded beta launches only after explicit confirmation", async () => {
  const { calls, controller, updater } = harness();
  await controller.start();
  updater.emit("update-available", { version: "1.0.0-beta.2", releaseNotes: "PROMPT_MUST_NOT_LEAK" });
  await flush();
  assert.deepEqual(updater.calls, ["check", "download"]);
  updater.emit("update-downloaded", { version: "1.0.0-beta.2", releaseNotes: "COMMAND_MUST_NOT_LEAK" });
  await flush();
  assert.deepEqual(calls.filter((entry) => typeof entry === "string" || entry[0] === "confirm"), [
    ["confirm", "1.0.0-beta.2"],
    "prepare",
  ]);
  assert.deepEqual(updater.calls.at(-1), ["install", false, true]);
  assert.doesNotMatch(JSON.stringify(calls), /PROMPT_MUST_NOT_LEAK|COMMAND_MUST_NOT_LEAK/);
});

test("declining, mismatched channels, and updater errors leave the current runtime usable", async () => {
  const declined = harness({ confirmed: false });
  await declined.controller.start();
  declined.updater.emit("update-downloaded", { version: "1.0.0-beta.2" });
  await flush();
  assert.equal(declined.calls.includes("prepare"), false);
  assert.equal(declined.updater.calls.some((entry) => Array.isArray(entry) && entry[0] === "install"), false);

  const wrongChannel = harness();
  await wrongChannel.controller.start();
  wrongChannel.updater.emit("update-available", { version: "1.0.0" });
  wrongChannel.updater.emit("update-downloaded", { version: "1.0.0" });
  await flush();
  assert.deepEqual(wrongChannel.updater.calls, ["check"]);
  assert.equal(wrongChannel.calls.includes("prepare"), false);

  const failed = harness();
  await failed.controller.start();
  failed.updater.emit("error", new Error("CREDENTIAL_MUST_NOT_LEAK"));
  assert.equal(failed.controller.snapshot().status, "failed");
  assert.equal(failed.calls.includes("stop"), false);
  assert.doesNotMatch(JSON.stringify(failed.calls), /CREDENTIAL_MUST_NOT_LEAK/);
});

test("installer launch failure restores normal runtime behavior deterministically", async () => {
  const thrownUpdater = new FakeUpdater();
  thrownUpdater.quitAndInstall = () => { throw new Error("PRIVATE_INSTALLER_PATH_MUST_NOT_LEAK"); };
  const thrown = harness({ updater: thrownUpdater });
  await thrown.controller.start();
  thrownUpdater.emit("update-downloaded", { version: "1.0.0-beta.2" });
  await flush();
  assert.equal(thrown.controller.snapshot().status, "failed");
  assert.deepEqual(thrown.calls.filter((entry) => typeof entry === "string"), ["prepare", "cancel"]);
  assert.doesNotMatch(JSON.stringify(thrown.calls), /PRIVATE_INSTALLER_PATH_MUST_NOT_LEAK/);

  const emitted = harness();
  emitted.updater.quitAndInstall = () => emitted.updater.emit("error", new Error("CERTIFICATE_MUST_NOT_LEAK"));
  await emitted.controller.start();
  emitted.updater.emit("update-downloaded", { version: "1.0.0-beta.2" });
  await flush();
  assert.equal(emitted.controller.snapshot().status, "failed");
  assert.deepEqual(emitted.calls.filter((entry) => typeof entry === "string"), ["prepare", "cancel"]);
  assert.doesNotMatch(JSON.stringify(emitted.calls), /CERTIFICATE_MUST_NOT_LEAK/);
});

test("disposing removes updater listeners without logging private failures", async () => {
  const { controller, updater } = harness();
  await controller.start();
  assert.equal(typeof updater.logger.error, "function");
  controller.dispose();
  assert.equal(updater.listenerCount("error"), 0);
  assert.doesNotThrow(() => updater.logger.error("SIGNED_URL_SECRET_MUST_NOT_LEAK"));
});
