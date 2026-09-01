import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import {
  CLAUDE_SIGN_IN_CHANNEL,
  createClaudeSignInAction,
  installConfirmedTrustedActionIpcHandler,
  isSafeClaudeExecutable,
  resolveClaudeExecutable,
} from "../desktop/claude-auth.mjs";
import { nativeClaudeEnvironment } from "../desktop/environment-policy.mjs";

function nativeClaude(file = "C:\\Users\\Ada\\.local\\bin\\claude.exe") {
  return new Set([path.normalize(file)]);
}

function existsFrom(files) {
  return (filename) => files.has(path.normalize(filename));
}

function child() {
  const value = new EventEmitter();
  value.pid = 42;
  value.kills = 0;
  value.kill = () => { value.kills += 1; return true; };
  return value;
}

test("Claude executable discovery accepts only fixed native executables", () => {
  const installed = "C:\\Users\\Ada\\.local\\bin\\claude.exe";
  const pathClaude = "C:\\Program Files\\Claude\\claude.exe";
  const files = nativeClaude(installed);
  files.add(path.normalize(pathClaude));
  assert.equal(resolveClaudeExecutable({ USERPROFILE: "C:\\Users\\Ada", PATH: "C:\\Program Files\\Claude" }, existsFrom(files)), installed);
  assert.equal(resolveClaudeExecutable({ POMEGR_CLAUDE_EXECUTABLE: pathClaude }, existsFrom(files)), pathClaude);
  assert.equal(resolveClaudeExecutable({ POMEGR_CLAUDE_EXECUTABLE: "C:\\tools\\claude.cmd" }, existsFrom(files)), null);
  assert.equal(resolveClaudeExecutable({ PATH: ".;C:\\repo\\node_modules\\.bin;C:\\Program Files\\Claude" }, existsFrom(files)), pathClaude);
  assert.equal(isSafeClaudeExecutable("C:\\repo\\node_modules\\.bin\\claude.exe"), false);
  assert.equal(isSafeClaudeExecutable("C:\\Program Files\\Claude\\claude.cmd"), false);
  assert.equal(isSafeClaudeExecutable("C:\\Users\\O'Hare\\.local\\bin\\claude.exe"), true);
});

test("Claude sign-in requires confirmation, keeps credentials private, and exposes bounded outcomes", async () => {
  const executable = "C:\\Users\\Ada\\.local\\bin\\claude.exe";
  const files = nativeClaude(executable);
  let spawned = 0;
  const action = createClaudeSignInAction({
    environment: { USERPROFILE: "C:\\Users\\Ada", CLAUDE_CONFIG_DIR: "C:\\Users\\Ada\\.claude", SECRET: "must-not-pass" },
    nativeEnvironment: { USERPROFILE: "C:\\Users\\Ada", CLAUDE_CONFIG_DIR: "C:\\Users\\Ada\\.claude" },
    fileExists: existsFrom(files),
    confirm: async () => false,
    spawn: () => { spawned += 1; throw new Error("must not launch"); },
  });
  assert.equal(await action.start(), "cancelled");
  assert.equal(spawned, 0);

  let options;
  const completedChild = child();
  const completed = createClaudeSignInAction({
    environment: { USERPROFILE: "C:\\Users\\Ada" },
    nativeEnvironment: { USERPROFILE: "C:\\Users\\Ada", CLAUDE_CONFIG_DIR: "C:\\Users\\Ada\\.claude" },
    fileExists: existsFrom(files),
    confirm: async () => true,
    spawn: (command, args, value) => {
      assert.equal(command, executable);
      assert.deepEqual(args, ["auth", "login", "--claudeai"]);
      options = value;
      queueMicrotask(() => completedChild.emit("exit", 0));
      return completedChild;
    },
  });
  assert.equal(await completed.start(), "completed");
  assert.deepEqual(options, {
    env: { USERPROFILE: "C:\\Users\\Ada", CLAUDE_CONFIG_DIR: "C:\\Users\\Ada\\.claude" },
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
});

test("Claude sign-in serializes parallel calls and bounds child shutdown", async () => {
  const executable = "C:\\Users\\Ada\\.local\\bin\\claude.exe";
  const files = nativeClaude(executable);
  const running = child();
  running.kill = () => {
    running.kills += 1;
    running.emit("exit", null);
    return true;
  };
  const action = createClaudeSignInAction({
    environment: { USERPROFILE: "C:\\Users\\Ada" },
    fileExists: existsFrom(files),
    confirm: async () => true,
    timeoutMs: 5,
    shutdownTimeoutMs: 5,
    spawn: () => running,
  });
  const first = action.start();
  assert.equal(await action.start(), "busy");
  assert.equal(await first, "timed_out");
  assert.equal(running.kills, 1);
  assert.equal(running.listenerCount("exit"), 0);
  assert.equal(running.listenerCount("error"), 0);

  const unavailable = createClaudeSignInAction({ environment: {}, fileExists: () => false });
  assert.equal(await unavailable.start(), "unavailable");

  const failedChild = child();
  const failed = createClaudeSignInAction({
    environment: { USERPROFILE: "C:\\Users\\Ada" },
    fileExists: existsFrom(files),
    confirm: async () => true,
    spawn: () => {
      queueMicrotask(() => failedChild.emit("error", new Error("private native failure")));
      return failedChild;
    },
  });
  assert.equal(await failed.start(), "failed");

  const spawnThrows = createClaudeSignInAction({
    environment: { USERPROFILE: "C:\\Users\\Ada" },
    fileExists: existsFrom(files),
    confirm: async () => true,
    spawn: () => { throw new Error("private launch failure"); },
  });
  assert.equal(await spawnThrows.start(), "failed");
});

test("disposing during confirmation prevents a late native launch", async () => {
  const executable = "C:\\Users\\Ada\\.local\\bin\\claude.exe";
  const files = nativeClaude(executable);
  let approve;
  let spawned = 0;
  const action = createClaudeSignInAction({
    environment: { USERPROFILE: "C:\\Users\\Ada" },
    fileExists: existsFrom(files),
    confirm: () => new Promise((resolve) => { approve = resolve; }),
    spawn: () => { spawned += 1; return child(); },
  });
  const pending = action.start();
  await action.dispose();
  approve(true);
  assert.equal(await pending, "cancelled");
  assert.equal(spawned, 0);
  assert.equal(await action.start(), "unavailable");
});

test("trusted native IPC has a fixed no-argument Claude sign-in channel", async () => {
  const handlers = new Map();
  const ipcMain = {
    removeHandler(channel) { handlers.delete(channel); },
    handle(channel, handler) { handlers.set(channel, handler); },
  };
  let calls = 0;
  const remove = installConfirmedTrustedActionIpcHandler({
    ipcMain,
    channel: CLAUDE_SIGN_IN_CHANNEL,
    isTrustedEvent: (event) => event?.trusted === true,
    action: { async start() { calls += 1; return "completed"; } },
  });
  assert.deepEqual(await handlers.get(CLAUDE_SIGN_IN_CHANNEL)({ trusted: false }, "ignored", "payload"), { status: "unavailable" });
  assert.equal(calls, 0);
  assert.deepEqual(await handlers.get(CLAUDE_SIGN_IN_CHANNEL)({ trusted: true }, "ignored"), { status: "completed" });
  assert.equal(calls, 1);
  remove();
  assert.equal(handlers.has(CLAUDE_SIGN_IN_CHANNEL), false);
});

test("native Claude environment retains only provider configuration and profile values", () => {
  const environment = nativeClaudeEnvironment({
    USERPROFILE: "C:\\Users\\Ada",
    CLAUDE_CONFIG_DIR: "C:\\Users\\Ada\\.claude",
    APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
    CLAUDE_AUTH_TOKEN: "private",
    PATH: "C:\\runtime",
  }, {}, () => false);
  assert.equal(environment.USERPROFILE, "C:\\Users\\Ada");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "C:\\Users\\Ada\\.claude");
  assert.equal(Object.hasOwn(environment, "CLAUDE_AUTH_TOKEN"), false);
});
