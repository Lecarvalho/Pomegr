import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import test from "node:test";

import { createRepositoryPluginAction, installRepositoryPluginActionIpc, REPOSITORY_PLUGIN_ACTION_CHANNEL } from "../desktop/repository-plugin-action.mjs";
import { createRepositoryPluginCli, pluginCommands, resolveCodexExecutable } from "../desktop/plugin-cli.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const plan = Object.freeze({ root: "C:\\private\\Pomegr", repositoryName: "Pomegr", provider: "codex", scope: "user", currentVersion: "0.5.0", targetVersion: "0.6.0", marketplaceRegistered: true, ref: "main", operation: "update" });
const ready = (version = "0.6.0") => ({ status: "completed", setup: { readiness: "ready", installation: "installed", version } });

function response(value, status = 200) { return new Response(JSON.stringify(value), { status }); }

test("repository plugin IPC accepts only trusted opaque ids and bounded actions", async () => {
  let calls = 0;
  const handler = createRepositoryPluginAction({
    isTrustedEvent: (event) => event?.trusted === true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret",
    fetch: async (url, options) => { calls += 1; assert.match(url, /repository-plugin\/recheck\?repositoryId=repo-0123456789abcdef01234567&provider=codex/u); assert.equal(options.headers["x-pomegr-desktop-authorization"], "secret"); assert.equal(options.redirect, "error"); return response({ status: "completed" }); },
  });
  assert.equal(await handler.start({}, repositoryId, "codex", "recheck"), "unavailable");
  assert.equal(await handler.start({ trusted: true }, "C:\\private", "codex", "recheck"), "unavailable");
  assert.equal(await handler.start({ trusted: true }, repositoryId, "codex", "erase"), "unavailable");
  assert.equal(await handler.start({ trusted: true }, repositoryId, "codex", "recheck"), "completed");
  assert.equal(calls, 1);
});

test("private plugin requests reject non-loopback origins and malformed private plans", async () => {
  let calls = 0;
  const remote = createRepositoryPluginAction({ isTrustedEvent: () => true, monitorOrigin: "https://example.test", authorizationToken: "secret", fetch: async () => { calls += 1; return response({}); } });
  assert.equal(await remote.start({}, repositoryId, "codex", "recheck"), "unavailable");
  const malformed = createRepositoryPluginAction({
    isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret", confirm: async () => true,
    fetch: async () => response({ plan: { ...plan, root: "..\\private", repositoryName: "Pomegr\nprivate" } }), runPlan: async () => { calls += 1; return "completed"; },
  });
  assert.equal(await malformed.start({}, repositoryId, "codex", "update"), "unavailable");
  assert.equal(calls, 0);
});

test("cancelled confirmation never launches a provider child", async () => {
  let ran = 0;
  const action = createRepositoryPluginAction({
    isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "token", confirm: async () => false,
    fetch: async () => response({ plan }), runPlan: async () => { ran += 1; return "completed"; },
  });
  assert.equal(await action.start({}, repositoryId, "codex", "update"), "cancelled");
  assert.equal(ran, 0);
});

test("a changed plan after confirmation is rejected before the native command runs", async () => {
  let prepares = 0;
  let ran = 0;
  const action = createRepositoryPluginAction({
    isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "token", confirm: async () => true,
    fetch: async () => response({ plan: prepares++ === 0 ? plan : { ...plan, targetVersion: "0.7.0" } }),
    runPlan: async () => { ran += 1; return "completed"; },
  });
  assert.equal(await action.start({}, repositoryId, "codex", "update"), "changed");
  assert.equal(ran, 0);
});

test("only one repository mutation can proceed at a time", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const action = createRepositoryPluginAction({
    isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "token", confirm: async () => waiting,
    fetch: async () => response({ plan }), runPlan: async () => "completed",
  });
  const first = action.start({}, repositoryId, "codex", "update");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await action.start({}, repositoryId, "claude", "install"), "busy");
  release(false);
  assert.equal(await first, "cancelled");
});

test("a mutation returns completed only after the bounded recheck proves the target version", async () => {
  const urls = [];
  const action = createRepositoryPluginAction({
    isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "token", confirm: async () => true,
    fetch: async (url) => { urls.push(url); return url.includes("prepare") ? response({ plan }) : response(ready()); },
    runPlan: async (value) => { assert.deepEqual(value, plan); return "completed"; },
  });
  assert.equal(await action.start({}, repositoryId, "codex", "update"), "completed");
  assert.equal(urls.filter((url) => url.includes("prepare")).length, 2);
  assert.equal(urls.filter((url) => url.includes("recheck")).length, 1);
  const notVerified = createRepositoryPluginAction({
    isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "token", confirm: async () => true,
    fetch: async (url) => url.includes("prepare") ? response({ plan }) : response(ready("0.5.0")), runPlan: async () => "completed",
  });
  assert.equal(await notVerified.start({}, repositoryId, "codex", "update"), "changed");
});

test("failed or timed-out native work still rechecks, and disposal after reprepare prevents a launch", async () => {
  for (const expected of ["failed", "timed_out"]) {
    const urls = [];
    const action = createRepositoryPluginAction({
      isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "token", confirm: async () => true,
      fetch: async (url) => { urls.push(url); return url.includes("prepare") ? response({ plan }) : response(ready()); }, runPlan: async () => expected,
    });
    assert.equal(await action.start({}, repositoryId, "codex", "update"), expected);
    assert.equal(urls.filter((url) => url.includes("recheck")).length, 1);
  }
  let prepares = 0; let ran = 0;
  const disposed = createRepositoryPluginAction({
    isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "token", confirm: async () => true,
    fetch: async () => { prepares += 1; if (prepares === 2) disposed.dispose(); return response({ plan }); }, runPlan: async () => { ran += 1; return "completed"; },
  });
  assert.equal(await disposed.start({}, repositoryId, "codex", "update"), "cancelled");
  assert.equal(ran, 0);
});

test("IPC returns only action status and cleans up its owned action", async () => {
  const handlers = new Map(); let disposed = 0;
  const remove = installRepositoryPluginActionIpc({
    ipcMain: { removeHandler: (channel) => handlers.delete(channel), handle: (channel, fn) => handlers.set(channel, fn) },
    action: { async start() { return "private result"; }, dispose() { disposed += 1; } },
  });
  assert.equal(await handlers.get(REPOSITORY_PLUGIN_ACTION_CHANNEL)({}, repositoryId, "codex", "update"), "failed");
  remove();
  assert.equal(disposed, 1);
  assert.equal(handlers.has(REPOSITORY_PLUGIN_ACTION_CHANNEL), false);
});

test("native provider commands are fixed, scoped, and discard provider output", async () => {
  assert.deepEqual(pluginCommands({ ...plan, provider: "claude", scope: "project", marketplaceRegistered: false, operation: "update" }), [
    ["plugin", "marketplace", "add", "Lecarvalho/pomegr"], ["plugin", "update", "pomegr@pomegr", "--scope", "project"],
  ]);
  assert.deepEqual(pluginCommands({ ...plan, provider: "claude", scope: "project", marketplaceRegistered: true, operation: "install" }), [
    ["plugin", "marketplace", "update", "pomegr"], ["plugin", "install", "pomegr@pomegr", "--scope", "project"],
  ]);
  assert.deepEqual(pluginCommands({ ...plan, operation: "update" }), [
    ["plugin", "marketplace", "upgrade", "pomegr"], ["plugin", "add", "pomegr@pomegr"],
  ]);
  assert.deepEqual(pluginCommands({ ...plan, operation: "install", marketplaceRegistered: true }), [
    ["plugin", "marketplace", "upgrade", "pomegr"], ["plugin", "add", "pomegr@pomegr"],
  ]);
  const calls = [];
  const cli = createRepositoryPluginCli({
    environment: { USERPROFILE: "C:\\Users\\agent", APPDATA: "C:\\Users\\agent\\AppData\\Roaming" }, fileExists: () => true,
    spawn: (file, args, options) => { calls.push({ file, args, options }); const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child; },
  });
  assert.equal(await cli.run(plan), "completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].args, ["plugin", "marketplace", "upgrade", "pomegr"]);
});

test("Codex executable resolution accepts only configured, local, and official user npm vendor binaries", () => {
  const environment = { USERPROFILE: "C:\\Users\\agent", APPDATA: "C:\\Users\\agent\\AppData\\Roaming", POMEGR_CODEX_EXECUTABLE: "C:\\repo\\codex.cmd" };
  assert.equal(resolveCodexExecutable(environment, () => true), null);
  const trusted = { ...environment, POMEGR_CODEX_EXECUTABLE: "C:\\Users\\agent\\.local\\bin\\codex.exe" };
  assert.equal(resolveCodexExecutable(trusted, () => true), "C:\\Users\\agent\\.local\\bin\\codex.exe");
  const noOverride = { USERPROFILE: "C:\\Users\\agent", APPDATA: "C:\\Users\\agent\\AppData\\Roaming" };
  const nested = "C:\\Users\\agent\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  const sibling = "C:\\Users\\agent\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  assert.equal(resolveCodexExecutable(noOverride, (candidate) => candidate === nested, { platform: "win32", architecture: "x64" }), nested);
  assert.equal(resolveCodexExecutable(noOverride, (candidate) => candidate === sibling, { platform: "win32", architecture: "x64" }), sibling);
  const actual = resolveCodexExecutable(process.env);
  assert.ok(actual === null || (typeof actual === "string" && existsSync(actual)), "native resolver performs only a local file-existence check");
});

test("CLI snapshots the caller environment before later desktop lifecycle trimming", async () => {
  const environment = { USERPROFILE: "C:\\Users\\agent", APPDATA: "C:\\Users\\agent\\AppData\\Roaming", POMEGR_CODEX_EXECUTABLE: "C:\\Tools\\codex.exe" };
  const calls = [];
  const cli = createRepositoryPluginCli({ environment, fileExists: (candidate) => candidate === "C:\\Tools\\codex.exe", spawn: (file, args, options) => { calls.push({ file, args, options }); const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child; } });
  delete environment.POMEGR_CODEX_EXECUTABLE;
  assert.equal(await cli.run(plan), "completed");
  assert.equal(calls[0].file, "C:\\Tools\\codex.exe");
});

test("native failures, timeouts, and disposal leave no active CLI child", async () => {
  const environment = { USERPROFILE: "C:\\Users\\agent", APPDATA: "C:\\Users\\agent\\AppData\\Roaming" };
  const failed = createRepositoryPluginCli({ environment, fileExists: () => true, spawn: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 1)); return child; } });
  assert.equal(await failed.run(plan), "failed");
  let killed = 0;
  const slow = createRepositoryPluginCli({ environment, fileExists: () => true, timeoutMs: 1, spawn: () => { const child = new EventEmitter(); child.kill = () => { killed += 1; queueMicrotask(() => child.emit("exit", null)); }; return child; } });
  assert.equal(await slow.run(plan), "timed_out");
  assert.equal(killed, 1);
  let disposeKilled = 0;
  const held = createRepositoryPluginCli({ environment, fileExists: () => true, timeoutMs: 5_000, spawn: () => { const child = new EventEmitter(); child.kill = () => { disposeKilled += 1; child.emit("exit", null); }; return child; } });
  const pending = held.run(plan);
  held.dispose();
  assert.equal(await pending, "failed");
  assert.equal(disposeKilled, 1);
});
