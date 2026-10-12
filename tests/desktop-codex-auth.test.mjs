import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import {
  CODEX_SIGN_IN_CHANNEL,
  createCodexSignInAction,
} from "../desktop/runtime/codex-auth.mjs";
import { confirmProviderSignIn, installConfirmedTrustedActionIpcHandler } from "../desktop/runtime/claude-auth.mjs";

const executable = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
const env = {
  USERPROFILE: "C:\\Users\\Ada",
  APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
  CODEX_HOME: "C:\\Users\\Ada\\.codex",
  HOME: "C:\\Users\\Ada",
  PATH: "C:\\Program Files\\Codex",
  PRIVATE_TOKEN: "must-not-pass",
};
const fileExists = (filename) => path.normalize(filename) === path.normalize(executable);

function child() {
  const value = new EventEmitter();
  value.kills = 0;
  value.kill = () => { value.kills += 1; return true; };
  return value;
}

test("Codex sign-in requires confirmation and launches fixed login with an allowlisted environment", async () => {
  let spawned = 0;
  const cancelled = createCodexSignInAction({
    environment: env,
    fileExists,
    confirm: async () => false,
    spawn: () => { spawned += 1; throw new Error("must not launch"); },
  });
  assert.equal(await cancelled.start(), "cancelled");
  assert.equal(spawned, 0);

  const running = child();
  let launch;
  const action = createCodexSignInAction({
    environment: env,
    fileExists,
    confirm: async () => true,
    spawn: (command, args, options) => {
      launch = { command, args, options };
      queueMicrotask(() => running.emit("exit", 0));
      return running;
    },
  });
  assert.equal(await action.start(), "completed");
  assert.equal(launch.command, executable);
  assert.deepEqual(launch.args, ["login"]);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.stdio, "ignore");
  assert.deepEqual(launch.options.env, {
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "production",
    PATH: env.PATH,
    POMEGR_SMOKE_NO_SYSTEM_NODE: "1",
    USERPROFILE: env.USERPROFILE,
    APPDATA: env.APPDATA,
    CODEX_HOME: env.CODEX_HOME,
    HOME: env.HOME,
  });
  assert.equal(Object.hasOwn(launch.options.env, "PRIVATE_TOKEN"), false);
});

test("Codex sign-in bounds missing executable and synchronous or asynchronous launch failures", async () => {
  const missing = createCodexSignInAction({ environment: env, fileExists: () => false });
  assert.equal(await missing.start(), "unavailable");

  const syncFailure = createCodexSignInAction({
    environment: env, fileExists, confirm: async () => true,
    spawn: () => { throw new Error("PRIVATE_SYNC_LAUNCH_ERROR"); },
  });
  assert.equal(await syncFailure.start(), "failed");

  const failedChild = child();
  const asyncFailure = createCodexSignInAction({
    environment: env, fileExists, confirm: async () => true,
    spawn: () => {
      queueMicrotask(() => failedChild.emit("error", new Error("PRIVATE_ASYNC_LAUNCH_ERROR")));
      return failedChild;
    },
  });
  assert.equal(await asyncFailure.start(), "failed");
  assert.equal(failedChild.listenerCount("exit"), 0);
  assert.equal(failedChild.listenerCount("error"), 0);
});

test("Codex sign-in rejects parallel work, times out, and disposes its child", async () => {
  const running = child();
  const timeout = createCodexSignInAction({
    environment: env, fileExists, confirm: async () => true,
    timeoutMs: 5, shutdownTimeoutMs: 5,
    spawn: () => running,
  });
  const first = timeout.start();
  assert.equal(await timeout.start(), "busy");
  assert.equal(await first, "timed_out");
  assert.equal(running.kills, 1);
  assert.equal(running.listenerCount("exit"), 0);
  assert.equal(running.listenerCount("error"), 0);

  const disposedChild = child();
  const disposing = createCodexSignInAction({
    environment: env, fileExists, confirm: async () => true,
    shutdownTimeoutMs: 5,
    spawn: () => disposedChild,
  });
  const pending = disposing.start();
  await new Promise((resolve) => setImmediate(resolve));
  await disposing.dispose();
  assert.equal(await pending, "timed_out");
  assert.equal(disposedChild.kills, 1);
  assert.equal(await disposing.start(), "unavailable");
});

test("Codex native IPC is one trusted no-argument channel with bounded statuses", async () => {
  const handlers = new Map();
  const ipcMain = {
    removeHandler(channel) { handlers.delete(channel); },
    handle(channel, handler) { handlers.set(channel, handler); },
  };
  let calls = 0;
  const remove = installConfirmedTrustedActionIpcHandler({
    ipcMain,
    channel: CODEX_SIGN_IN_CHANNEL,
    isTrustedEvent: (event) => event?.trusted === true,
    action: { async start() { calls += 1; return "completed"; } },
  });
  assert.deepEqual(await handlers.get(CODEX_SIGN_IN_CHANNEL)({ trusted: false }, "untrusted", { private: true }), { status: "unavailable" });
  assert.equal(calls, 0);
  assert.deepEqual(await handlers.get(CODEX_SIGN_IN_CHANNEL)({ trusted: true }, "ignored", "arguments"), { status: "completed" });
  assert.equal(calls, 1);
  remove();
  assert.equal(handlers.has(CODEX_SIGN_IN_CHANNEL), false);
});

test("Codex native confirmation defaults to cancel and rechecks desktop lifetime", async () => {
  let running = true;
  let calls = 0;
  const window = { isDestroyed: () => false };
  const dialog = { async showMessageBox(owner, options) {
    calls += 1;
    assert.equal(owner, window);
    assert.equal(options.title, "Sign in to Codex");
    assert.equal(options.defaultId, 1);
    assert.equal(options.cancelId, 1);
    assert.deepEqual(options.buttons, ["Open sign-in", "Cancel"]);
    return { response: 0 };
  } };
  assert.equal(await confirmProviderSignIn(dialog, window, () => running, "Codex"), true);
  assert.equal(await confirmProviderSignIn(dialog, null, () => running, "Codex"), false);
  running = false;
  assert.equal(await confirmProviderSignIn(dialog, window, () => running, "Codex"), false);
  assert.equal(calls, 1);
  running = true;
  dialog.showMessageBox = async () => { running = false; return { response: 0 }; };
  assert.equal(await confirmProviderSignIn(dialog, window, () => running, "Codex"), false);
});
