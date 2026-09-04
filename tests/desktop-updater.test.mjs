import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_UPDATE_CHECK_INTERVAL_MS,
  boundedDesktopVersion,
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

class FakeScheduler {
  nextId = 1;
  timers = new Map();
  cleared = [];

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.cleared.push(id);
    this.timers.delete(id);
  }

  runNext() {
    const entry = this.timers.entries().next().value;
    if (!entry) return false;
    const [id, timer] = entry;
    this.timers.delete(id);
    timer.callback();
    return true;
  }
}

function harness(overrides = {}) {
  const updater = overrides.updater || new FakeUpdater();
  const calls = [];
  const scheduler = overrides.scheduler || new FakeScheduler();
  const verifyUpdateCodeSignature = overrides.verifyUpdateCodeSignature || (() => Promise.resolve(null));
  const controller = createDesktopUpdaterController({
    updater,
    currentVersion: overrides.currentVersion || "1.0.0-beta.1",
    packaged: overrides.packaged ?? true,
    mode: overrides.mode || "installed",
    updatesEnabled: overrides.updatesEnabled ?? true,
    scheduler,
    checkIntervalMs: overrides.checkIntervalMs,
    now: overrides.now || (() => Date.parse("2026-09-04T12:00:00.000Z")),
    verifyUpdateCodeSignature,
    prepareInstall() { calls.push("prepare"); },
    cancelInstall() { calls.push("cancel"); },
    onState(state) { calls.push(["state", state]); },
  });
  return { calls, controller, scheduler, updater, verifyUpdateCodeSignature };
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
  assert.equal(desktopReleaseChannel(`1.2.3-beta.${"x".repeat(65)}`), null);
  assert.equal(boundedDesktopVersion("1.2.3-beta.4"), "1.2.3-beta.4");
  assert.equal(boundedDesktopVersion("PRIVATE_PATH_MUST_NOT_LEAK"), null);
});

test("downloaded Windows installers require the exact full certificate Subject DN", async () => {
  const expected = "CN=DSNK Technologie Inc, O=DSNK Technologie Inc, C=CA";
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
  assert.equal(isFullPublisherSubject("DSNK Technologie Inc"), false);
  assert.equal(await verifier([expected], updatePath), null);
  assert.equal(await verifier(["DSNK Technologie Inc"], updatePath), "DESKTOP_UPDATE_PUBLISHER_SUBJECT_INVALID");
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

test("a matching downloaded beta remains ready until explicit installation", async () => {
  const { calls, controller, updater } = harness();
  await controller.start();
  updater.emit("update-available", { version: "1.0.0-beta.2", releaseNotes: "PROMPT_MUST_NOT_LEAK" });
  await flush();
  assert.deepEqual(updater.calls, ["check", "download"]);
  updater.emit("update-downloaded", { version: "1.0.0-beta.2", releaseNotes: "COMMAND_MUST_NOT_LEAK" });
  await flush();
  assert.deepEqual(controller.snapshot(), { status: "ready", version: "1.0.0-beta.2", lastCheckedAt: "2026-09-04T12:00:00.000Z" });
  assert.equal(calls.includes("prepare"), false);
  assert.equal(controller.install(), true);
  assert.deepEqual(calls.filter((entry) => typeof entry === "string"), ["prepare"]);
  assert.deepEqual(updater.calls.at(-1), ["install", false, true]);
  assert.equal(controller.install(), false);
  assert.equal(updater.calls.filter((entry) => Array.isArray(entry) && entry[0] === "install").length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /PROMPT_MUST_NOT_LEAK|COMMAND_MUST_NOT_LEAK/);
});

test("install is unavailable before readiness and channel isolation remains enforced", async () => {
  const wrongChannel = harness();
  await wrongChannel.controller.start();
  assert.equal(wrongChannel.controller.install(), false);
  wrongChannel.updater.emit("update-available", { version: "1.0.0" });
  wrongChannel.updater.emit("update-downloaded", { version: "1.0.0" });
  await flush();
  assert.deepEqual(wrongChannel.updater.calls, ["check"]);
  assert.equal(wrongChannel.calls.includes("prepare"), false);
  assert.equal(wrongChannel.controller.snapshot().status, "failed");

  const oversized = harness();
  await oversized.controller.start();
  oversized.updater.emit("update-available", { version: `1.0.0-beta.${"x".repeat(65)}` });
  oversized.updater.emit("update-downloaded", { version: `1.0.0-beta.${"x".repeat(65)}` });
  await flush();
  assert.deepEqual(oversized.updater.calls, ["check"]);
  assert.deepEqual(oversized.controller.snapshot(), { status: "failed", version: null, lastCheckedAt: "2026-09-04T12:00:00.000Z" });

  const failed = harness();
  await failed.controller.start();
  failed.updater.emit("error", new Error("CREDENTIAL_MUST_NOT_LEAK"));
  assert.equal(failed.controller.snapshot().status, "failed");
  assert.equal(failed.scheduler.timers.size, 1);
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
  assert.equal(thrown.controller.install(), false);
  assert.deepEqual(thrown.controller.snapshot(), { status: "ready", version: "1.0.0-beta.2", lastCheckedAt: "2026-09-04T12:00:00.000Z" });
  assert.deepEqual(thrown.calls.filter((entry) => typeof entry === "string"), ["prepare", "cancel"]);
  assert.doesNotMatch(JSON.stringify(thrown.calls), /PRIVATE_INSTALLER_PATH_MUST_NOT_LEAK/);

  const emitted = harness();
  emitted.updater.quitAndInstall = () => emitted.updater.emit("error", new Error("CERTIFICATE_MUST_NOT_LEAK"));
  await emitted.controller.start();
  emitted.updater.emit("update-downloaded", { version: "1.0.0-beta.2" });
  await flush();
  assert.equal(emitted.controller.install(), false);
  assert.deepEqual(emitted.controller.snapshot(), { status: "ready", version: "1.0.0-beta.2", lastCheckedAt: "2026-09-04T12:00:00.000Z" });
  assert.deepEqual(emitted.calls.filter((entry) => typeof entry === "string"), ["prepare", "cancel"]);
  assert.doesNotMatch(JSON.stringify(emitted.calls), /CERTIFICATE_MUST_NOT_LEAK/);
});

test("checks run at startup and every four hours without overlap", async () => {
  let resolveCheck;
  const updater = new FakeUpdater();
  updater.checkForUpdates = function checkForUpdates() {
    this.calls.push("check");
    return this.calls.length === 1 ? Promise.resolve(null) : new Promise((resolve) => { resolveCheck = resolve; });
  };
  const { controller, scheduler } = harness({ updater });
  await controller.start();
  assert.deepEqual(updater.calls, ["check"]);
  assert.equal(scheduler.timers.size, 1);
  assert.equal([...scheduler.timers.values()][0].delay, DESKTOP_UPDATE_CHECK_INTERVAL_MS);

  assert.equal(scheduler.runNext(), true);
  await flush();
  assert.deepEqual(updater.calls, ["check", "check"]);
  assert.equal(controller.snapshot().status, "checking");
  assert.equal(scheduler.timers.size, 0);
  assert.equal(await controller.start(), controller.snapshot());
  assert.deepEqual(updater.calls, ["check", "check"]);

  resolveCheck(null);
  await flush();
  assert.equal(controller.snapshot().status, "idle");
  assert.equal(scheduler.timers.size, 1);
});

test("manual checks share an in-flight availability request and retain only successful check time", async () => {
  let resolveCheck;
  const updater = new FakeUpdater();
  updater.checkForUpdates = function checkForUpdates() {
    this.calls.push("check");
    return this.calls.length === 1
      ? Promise.resolve(null)
      : new Promise((resolve) => { resolveCheck = resolve; });
  };
  const { controller } = harness({ updater, now: () => Date.parse("2026-09-04T12:34:56.000Z") });
  await controller.start();
  const firstManualCheck = controller.check();
  const secondManualCheck = controller.check();
  assert.equal(firstManualCheck, secondManualCheck);
  await flush();
  assert.deepEqual(updater.calls, ["check", "check"]);
  assert.equal(controller.snapshot().status, "checking");
  resolveCheck(null);
  await firstManualCheck;
  assert.deepEqual(controller.snapshot(), { status: "idle", version: null, lastCheckedAt: "2026-09-04T12:34:56.000Z" });

  updater.checkForUpdates = async function failedCheck() { this.calls.push("check"); throw new Error("PRIVATE_UPDATE_FAILURE"); };
  await controller.check();
  assert.deepEqual(controller.snapshot(), { status: "failed", version: null, lastCheckedAt: "2026-09-04T12:34:56.000Z" });
});

test("synchronous check failures release manual retries without acquiring before startup or when disabled", async () => {
  const preStart = harness();
  await preStart.controller.check();
  assert.deepEqual(preStart.updater.calls, []);

  const disabled = harness({ packaged: false });
  await disabled.controller.check();
  assert.deepEqual(disabled.updater.calls, []);
  assert.deepEqual(disabled.controller.snapshot(), { status: "disabled", version: null, lastCheckedAt: null });

  const updater = new FakeUpdater();
  updater.checkForUpdates = function checkForUpdates() {
    this.calls.push("check");
    if (this.calls.length === 1) throw new Error("PRIVATE_SYNCHRONOUS_FAILURE");
    return Promise.resolve(null);
  };
  const { controller } = harness({ updater });
  await controller.start();
  assert.equal(controller.snapshot().status, "failed");
  await controller.check();
  assert.deepEqual(updater.calls, ["check", "check"]);
  assert.deepEqual(controller.snapshot(), { status: "idle", version: null, lastCheckedAt: "2026-09-04T12:00:00.000Z" });
});

test("an updater error during a resolving check preserves the prior successful check timestamp", async () => {
  let now = Date.parse("2026-09-04T12:00:00.000Z");
  const updater = new FakeUpdater();
  const { controller } = harness({ updater, now: () => now });
  await controller.start();
  now = Date.parse("2026-09-04T13:00:00.000Z");
  updater.checkForUpdates = function errorThenResolve() {
    this.calls.push("check");
    this.emit("error", new Error("PRIVATE_UPDATER_EVENT"));
    return Promise.resolve(null);
  };
  await controller.check();
  assert.deepEqual(controller.snapshot(), { status: "failed", version: null, lastCheckedAt: "2026-09-04T12:00:00.000Z" });
});

test("periodic checks pause for downloads and verified updates, then stop on disposal", async () => {
  const { controller, scheduler, updater } = harness();
  await controller.start();
  assert.equal(scheduler.timers.size, 1);

  updater.emit("update-available", { version: "1.0.0-beta.2" });
  assert.equal(controller.snapshot().status, "downloading");
  assert.equal(scheduler.timers.size, 0);
  updater.emit("update-downloaded", { version: "1.0.0-beta.2" });
  assert.equal(controller.snapshot().status, "ready");
  assert.equal(scheduler.timers.size, 0);

  updater.emit("error", new Error("IGNORED_AFTER_VERIFICATION"));
  assert.equal(controller.snapshot().status, "ready");
  controller.dispose();
  assert.equal(scheduler.timers.size, 0);
  assert.equal(controller.install(), false);
});

test("disposing removes updater listeners without logging private failures", async () => {
  const { controller, updater } = harness();
  await controller.start();
  assert.equal(typeof updater.logger.error, "function");
  controller.dispose();
  assert.equal(updater.listenerCount("error"), 0);
  assert.doesNotThrow(() => updater.logger.error("SIGNED_URL_SECRET_MUST_NOT_LEAK"));
});

test("disposing before start permanently prevents updater setup", async () => {
  const { controller, scheduler, updater } = harness();
  controller.dispose();
  await controller.start();
  assert.deepEqual(updater.calls, []);
  assert.equal(updater.listenerCount("error"), 0);
  assert.equal(scheduler.timers.size, 0);
  assert.equal(controller.snapshot().status, "idle");
});
