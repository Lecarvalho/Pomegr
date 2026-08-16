import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertDirectoryHasNoPrivacySentinel,
  assertReleasePublishPrivacy,
  inspectAsarPrivacyEntry,
} from "../desktop/artifact-privacy.mjs";
import { createNeedsInputNotificationController, createSessionNotificationPoller } from "../desktop/notifications.mjs";
import { secureBrowserWindowOptions } from "../desktop/security-policy.mjs";
import { DESKTOP_BEHAVIOR_CHANNELS } from "../desktop/desktop-behavior.mjs";
import {
  installDesktopBehaviorIpcHandlers,
  installRendererFailureHandler,
  startOptionalDesktopIntegration,
} from "../desktop/native-security.mjs";
import { createDefaultProviderRegistry } from "../monitor/providers/index.mjs";
import { PROVIDER_OBSERVATION_API_KEYS } from "../monitor/providers/provider-contract.mjs";
import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import { installLocalRequestGate, startWebServer } from "../web/server.mjs";
import { PRIVATE_FIXTURE_SENTINELS } from "./helpers/provider-fixtures.mjs";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function request(port, { token = TOKEN, host = `127.0.0.1:${port}`, origin, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (token !== null) headers[DESKTOP_AUTH_HEADER] = token;
    if (origin) headers.Origin = origin;
    const pending = http.request({ host: "127.0.0.1", port, path: "/api/state", method, headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    pending.once("error", reject);
    pending.end();
  });
}

test("desktop launch authorization supports concurrent clients and revokes for the launch lifetime", async () => {
  const server = http.createServer((_request, response) => response.end("safe"));
  const port = await listen(server);
  const authorization = installLocalRequestGate(server, {
    authorizationToken: TOKEN,
    host: "127.0.0.1",
    port,
  });
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => request(port))), Array(12).fill(200));
    assert.equal(await request(port, { token: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }), 401);
    assert.equal(await request(port, { host: `localhost:${port}` }), 401);
    assert.equal(await request(port, { origin: "http://127.0.0.1:1" }), 401);
    assert.equal(await request(port, { method: "POST" }), 401);
    authorization.revoke();
    assert.equal(await request(port), 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("production web authorization is wired to launch-lifetime revocation", async () => {
  const web = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    monitorOrigin: "http://127.0.0.1:4317",
    authorizationToken: TOKEN,
    logger: Object.freeze({ log() {} }),
  });
  try {
    assert.equal((await fetch(web.origin, { headers: { [DESKTOP_AUTH_HEADER]: TOKEN } })).status, 200);
    web.revokeAuthorization();
    assert.equal((await fetch(web.origin, { headers: { [DESKTOP_AUTH_HEADER]: TOKEN } })).status, 401);
  } finally {
    await web.close();
  }
});

test("renderer, preload, IPC, native UI, diagnostics, update, and packaged API surfaces stay bounded", async () => {
  const preloadPath = new URL("../desktop/preload.cjs", import.meta.url);
  const options = secureBrowserWindowOptions({ preloadPath: preloadPath.pathname.slice(1).replaceAll("/", "\\") });
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.nodeIntegrationInWorker, false);
  assert.equal(options.webPreferences.nodeIntegrationInSubFrames, false);
  assert.equal(options.webPreferences.webviewTag, false);

  const files = [
    "../desktop/preload.cjs",
    "../desktop/shell-main.mjs",
    "../desktop/notifications.mjs",
    "../desktop/quiet-console.mjs",
    "../desktop/shell-stage.mjs",
    "../desktop/startup-error.mjs",
    "../desktop/updater.mjs",
    "../desktop/smoke-main.mjs",
    "../desktop/inspect-artifacts.mjs",
    "../desktop/artifact-privacy.mjs",
  ];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), "utf8")))).join("\n");
  for (const sentinel of PRIVATE_FIXTURE_SENTINELS) assert.equal(source.includes(`\"${sentinel}\"`), false);
  assert.match(source, /contextBridge\.exposeInMainWorld\("pomegrDesktop", Object\.freeze\(/);
  assert.doesNotMatch(await readFile(preloadPath, "utf8"), /node:(?:fs|child_process)|process\.|ipcRenderer\.(?:send|sendSync)|shell|webFrame/);
  assert.match(source, /body: NEEDS_INPUT_NOTIFICATION_COPY/);
  assert.match(source, /setToolTip\("Pomegr .* local read-only observer"\)/);
  assert.match(source, /installQuietConsole\(\)/);
  assert.match(source, /DESKTOP_START_FAILED/);
  assert.match(source, /updater\.logger = Object\.freeze/);
  assert.match(await readFile(preloadPath, "utf8"), /installUpdate\(\)\s*\{\s*return ipcRenderer\.invoke\("pomegr:install-update"\);/);
  assert.match(source, /privacySafe:/);
  assert.match(source, /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
});

test("artifact privacy scans extracted payloads and the exact final publish allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-artifact-security-"));
  const extracted = path.join(root, "extracted");
  const publish = path.join(root, "publish");
  await mkdir(extracted);
  await mkdir(publish);
  await writeFile(path.join(extracted, "safe.json"), JSON.stringify({ status: "ready" }), "utf8");
  await writeFile(path.join(extracted, ".env"), "SAFE_TEST_VALUE=1", "utf8");
  await writeFile(path.join(extracted, "extensionless"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(extracted, "certificate.pfx"), Buffer.from("safe synthetic bytes"));
  await assertDirectoryHasNoPrivacySentinel(extracted);
  await writeFile(path.join(extracted, "certificate.pfx"), Buffer.from("\u0000PROMPT_MUST_NOT_LEAK\u0000"));
  await assert.rejects(assertDirectoryHasNoPrivacySentinel(extracted), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);
  await writeFile(path.join(extracted, "certificate.pfx"), Buffer.alloc(32));
  await assert.rejects(assertDirectoryHasNoPrivacySentinel(extracted, { maximumFileBytes: 16 }), /DESKTOP_ARTIFACT_PRIVACY_BOUND_EXCEEDED/);

  const source = path.join(root, "source");
  await mkdir(path.join(source, "pomegr-1.0.0", "tests"), { recursive: true });
  await mkdir(path.join(source, "pomegr-1.0.0", "desktop"), { recursive: true });
  await writeFile(path.join(source, "pomegr-1.0.0", "tests", "fixture.txt"), "PROMPT_MUST_NOT_LEAK", "utf8");
  await assertDirectoryHasNoPrivacySentinel(source, {
    allowedSentinelPath: (relativePath) => /^[^/]+\/tests\//.test(relativePath),
  });
  await writeFile(path.join(source, "pomegr-1.0.0", "desktop", "runtime.txt"), "COMMAND_MUST_NOT_LEAK", "utf8");
  await assert.rejects(assertDirectoryHasNoPrivacySentinel(source, {
    allowedSentinelPath: (relativePath) => /^[^/]+\/tests\//.test(relativePath),
  }), /DESKTOP_ARTIFACT_PRIVACY_SENTINEL/);

  await writeFile(path.join(publish, "NOTICE"), "safe notice", "utf8");
  assert.deepEqual(await assertReleasePublishPrivacy(publish, ["NOTICE"]), undefined);
  await writeFile(path.join(publish, "extra.txt"), "safe", "utf8");
  await assert.rejects(assertReleasePublishPrivacy(publish, ["NOTICE"]), /DESKTOP_RELEASE_ARTIFACT_SET_INVALID/);
});

test("ASAR privacy inspection never follows link metadata", () => {
  const calls = [];
  assert.throws(() => inspectAsarPrivacyEntry("fixture.asar", "linked-file", (...args) => {
    calls.push(args);
    return { link: "private-target" };
  }), /DESKTOP_ARTIFACT_PRIVACY_LINK_FORBIDDEN/);
  assert.deepEqual(calls, [["fixture.asar", "linked-file", false]]);
});

test("desktop monitor provider surface is observation-only", () => {
  const registry = createDefaultProviderRegistry();
  for (const provider of registry.providers) {
    assert.equal(Object.isFrozen(provider), true);
    for (const key of Object.keys(provider)) assert.ok(PROVIDER_OBSERVATION_API_KEYS.includes(key), `${provider.id}.${key} is not an observation API`);
    if (provider.resolveCapabilities) {
      assert.equal(provider.resolveCapabilities.length, 0);
    }
    assert.equal(Object.keys(provider).some((key) => /(?:write|send|control|approve|reject|execute|command|kill|interrupt|resume|delete|update)/i.test(key)), false);
  }
});

test("notification failures and session-catalog failures remain isolated and bounded", async () => {
  const controller = createNeedsInputNotificationController({
    notify() { throw new Error("PROMPT_MUST_NOT_LEAK"); },
    openSession() { throw new Error("COMMAND_MUST_NOT_LEAK"); },
  });
  assert.equal(controller.observe([{ id: "codex:safe", isLive: true, needsInput: true, title: "PRIVATE_PATH_MUST_NOT_LEAK" }], { enabled: true }), 0);

  let scheduled = 0;
  const poller = createSessionNotificationPoller({
    controller,
    async loadSessions() { throw new Error("OAUTH_TOKEN_MUST_NOT_LEAK"); },
    getMode: () => ({ enabled: true }),
    schedule() { scheduled += 1; return 1; },
    cancel() {},
  });
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled, 1);
  poller.stop();
});

test("tray and renderer failures are isolated while IPC rejections are normalized", async () => {
  let cleaned = 0;
  assert.equal(startOptionalDesktopIntegration({
    start() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    cleanup() { cleaned += 1; },
  }), false);
  assert.equal(cleaned, 1);
  const contents = new EventEmitter();
  let runtimeState = "starting";
  let startupFailures = 0;
  let runtimeFailures = 0;
  installRendererFailureHandler(contents, {
    getRuntimeState: () => runtimeState,
    markStartupFailed: () => { startupFailures += 1; },
    handleRuntimeFailure: () => { runtimeFailures += 1; },
  });
  contents.emit("render-process-gone", {}, { reason: "PRIVATE_PATH_MUST_NOT_LEAK" });
  assert.equal(startupFailures, 1);
  assert.equal(runtimeFailures, 0);
  runtimeState = "running";
  installRendererFailureHandler(contents, {
    getRuntimeState: () => runtimeState,
    markStartupFailed: () => { startupFailures += 1; },
    handleRuntimeFailure: () => { runtimeFailures += 1; },
  });
  contents.emit("render-process-gone", {}, { reason: "COMMAND_MUST_NOT_LEAK" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeFailures, 1);

  const handlers = new Map();
  const ipcMain = {
    removeHandler(channel) { handlers.delete(channel); },
    handle(channel, handler) { handlers.set(channel, handler); },
  };
  const safeState = Object.freeze({ paused: false, update: Object.freeze({ status: "ready", version: "1.2.3" }) });
  let updateInstalls = 0;
  const updater = { async install() { updateInstalls += 1; } };
  const controller = {
    snapshot: () => safeState,
    setPaused() { throw new Error("PROMPT_MUST_NOT_LEAK"); },
    setLaunchAtLogin() { throw new Error("PRIVATE_PATH_MUST_NOT_LEAK"); },
    setCloseBehavior() { throw new Error("ARBITRARY_EXCEPTION_MUST_NOT_LEAK"); },
    setNotifications() { throw new Error("CREDENTIAL_MUST_NOT_LEAK"); },
    setNotificationQuiet() { throw new Error("ENV_SECRET_MUST_NOT_LEAK"); },
    quit() { throw new Error("COMMAND_MUST_NOT_LEAK"); },
  };
  const trustedEvent = {};
  const registered = installDesktopBehaviorIpcHandlers({
    ipcMain,
    channels: DESKTOP_BEHAVIOR_CHANNELS,
    isTrustedEvent: (event) => event === trustedEvent,
    getController: () => controller,
    getUpdater: () => updater,
    themeHandler: () => false,
  });
  assert.equal(registered.length, 9);
  for (const channel of [
    DESKTOP_BEHAVIOR_CHANNELS.setPaused,
    DESKTOP_BEHAVIOR_CHANNELS.setLaunchAtLogin,
    DESKTOP_BEHAVIOR_CHANNELS.setCloseBehavior,
    DESKTOP_BEHAVIOR_CHANNELS.setNotifications,
    DESKTOP_BEHAVIOR_CHANNELS.setNotificationQuiet,
  ]) {
    assert.deepEqual(await handlers.get(channel)(trustedEvent, true), safeState);
    assert.equal(await handlers.get(channel)({}, true), null);
  }
  assert.deepEqual(await handlers.get(DESKTOP_BEHAVIOR_CHANNELS.installUpdate)(trustedEvent), safeState);
  assert.equal(updateInstalls, 1);
  assert.equal(await handlers.get(DESKTOP_BEHAVIOR_CHANNELS.installUpdate)({}), null);
  assert.equal(updateInstalls, 1);
  assert.equal(handlers.get(DESKTOP_BEHAVIOR_CHANNELS.quit)(trustedEvent), false);
});

test("desktop bridge and runtime reject the removed legacy namespace", async () => {
  const legacy = ["thread", "light"].join("");
  const [preload, behavior, environment, shell] = await Promise.all([
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/desktop-behavior.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/environment-policy.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/shell-main.mjs", import.meta.url), "utf8"),
  ]);
  const sources = `${preload}\n${behavior}\n${environment}\n${shell}`.toLowerCase();
  assert.equal(sources.includes(legacy), false);
  assert.match(preload, /exposeInMainWorld\("pomegrDesktop"/);
  assert.match(behavior, /pomegr:desktop-state/);
  assert.match(environment, /POMEGR_DATA_DIR/);
});
