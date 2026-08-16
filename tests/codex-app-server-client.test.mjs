import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  CODEX_APP_SERVER_UNAVAILABLE,
  createCodexAppServerRateLimitsReader,
  resolveCodexAppServerExecutable,
} from "../monitor/providers/codex-app-server-client.mjs";

function child() {
  const value = new EventEmitter();
  value.exitCode = null;
  value.signalCode = null;
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  value.stdin = new EventEmitter();
  value.stdin.writable = true;
  value.stdin.destroyed = false;
  value.stdin.writes = [];
  value.stdin.write = (data) => { value.stdin.writes.push(String(data)); return true; };
  value.stdin.end = () => { value.stdin.ended = true; };
  value.kills = [];
  value.kill = (signal = "SIGTERM") => {
    value.kills.push(signal);
    value.signalCode = signal;
    value.emit("exit", null, signal);
    return true;
  };
  return value;
}

function fakeSpawn(children, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const next = children.shift();
    assert.ok(next, "unexpected child process");
    next.start?.();
    return next;
  };
}

function versionWithOutput(output, code = 0) {
  const value = child();
  value.start = () => queueMicrotask(() => {
    value.stdout.emit("data", output);
    value.exitCode = code;
    value.emit("exit", code, null);
  });
  return value;
}

function successfulVersion() {
  return versionWithOutput("codex-cli 0.144.1\r\n");
}

test("resolves only native absolute overrides, PATH binaries, and official vendor layouts", () => {
  const executable = path.resolve("fixtures", "codex.exe");
  const fromPath = path.resolve("bin", "codex.exe");
  const nestedVendor = path.resolve("modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  const hoistedVendor = path.resolve("hoisted", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  const files = new Set([executable, fromPath, nestedVendor, hoistedVendor]);
  const fs = { statSync(candidate) {
    if (!files.has(candidate)) throw new Error("missing");
    return { isFile: () => true, mode: 0o755 };
  } };
  const common = { fs, platform: "win32", architecture: "x64", cwd: path.resolve("work") };

  assert.equal(resolveCodexAppServerExecutable({ ...common, env: { POMEGR_CODEX_EXECUTABLE: executable } }), executable);
  assert.equal(resolveCodexAppServerExecutable({ ...common, env: { POMEGR_CODEX_EXECUTABLE: "codex.cmd", Path: path.dirname(fromPath) } }), fromPath);
  assert.equal(resolveCodexAppServerExecutable({ ...common, env: {}, moduleRoots: [path.resolve("modules")] }), nestedVendor);
  assert.equal(resolveCodexAppServerExecutable({ ...common, env: {}, moduleRoots: [path.resolve("hoisted")] }), hoistedVendor);
  assert.equal(resolveCodexAppServerExecutable({ ...common, env: { POMEGR_CODEX_EXECUTABLE: "C:\\Program Files\\WindowsApps\\codex.exe" } }), null);
  assert.equal(resolveCodexAppServerExecutable({ ...common, env: { POMEGR_CODEX_EXECUTABLE: "C:\\Users\\me\\AppData\\Local\\Programs\\Codex\\Codex.exe" } }), null);
});

test("uses the documented JSONL handshake, accepts chunked CRLF output, and reaps the account-only child", async () => {
  const version = successfulVersion();
  const server = child();
  server.stdin.write = (data) => {
    server.stdin.writes.push(String(data));
    const message = JSON.parse(String(data));
    if (message.id === 1) {
      queueMicrotask(() => {
        server.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"method\":\"notice\"}\r\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r");
        server.stdout.emit("data", "\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r\n");
      });
    }
    if (message.id === 2) queueMicrotask(() => {
      server.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"id\":999,\"result\":{\"private\":true}}\n");
      server.stdout.emit("data", "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":12}}}}\n");
    });
    return true;
  };
  const calls = [];
  const reader = createCodexAppServerRateLimitsReader({
    resolveExecutable: () => "C:\\tools\\codex.exe",
    spawnFn: fakeSpawn([version, server], calls),
  });

  assert.deepEqual(await reader.readRateLimits(), { result: { rateLimits: { primary: { usedPercent: 12 } } } });
  assert.deepEqual(calls, [
    { command: "C:\\tools\\codex.exe", args: ["--version"], options: { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] } },
    { command: "C:\\tools\\codex.exe", args: ["app-server", "--stdio"], options: { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] } },
  ]);
  assert.deepEqual(server.stdin.writes.map((line) => JSON.parse(line)), [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Pomegr", version: "0.2.0" }, capabilities: {} } },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} },
  ]);
  assert.deepEqual(server.kills, ["SIGTERM"]);
  assert.equal(server.stdin.ended, true);
});

test("fails closed on app-server errors, asynchronous EPIPE, malformed initialization, oversized protocol output, and deadlines", async () => {
  for (const scenario of ["error", "epipe", "malformed-initialize", "oversized", "timeout"]) {
    const version = successfulVersion();
    const server = child();
    server.stdin.write = (data) => {
      server.stdin.writes.push(String(data));
      const message = JSON.parse(String(data));
      if (scenario === "epipe" && message.method === "initialized") {
        queueMicrotask(() => server.stdin.emit("error", new Error("EPIPE PRIVATE_DETAILS_MUST_NOT_LEAK")));
      }
      if (message.id !== 1) return true;
      queueMicrotask(() => {
        if (scenario === "error") server.stdout.emit("data", "{\"id\":1,\"error\":{\"message\":\"credential leak\"}}\n");
        if (scenario === "epipe") server.stdout.emit("data", "{\"id\":1,\"result\":{}}\n");
        if (scenario === "malformed-initialize") server.stdout.emit("data", "{\"id\":1}\n");
        if (scenario === "oversized") server.stdout.emit("data", `${"x".repeat(80)}\n`);
      });
      return true;
    };
    const reader = createCodexAppServerRateLimitsReader({
      resolveExecutable: () => "C:\\tools\\codex.exe",
      spawnFn: fakeSpawn([version, server], []),
      timeoutMs: 15,
      maximumLineBytes: 32,
    });
    await assert.rejects(reader.readRateLimits(), new RegExp(CODEX_APP_SERVER_UNAVAILABLE));
    assert.equal(server.stdin.ended, true, scenario);
    assert.deepEqual(server.kills, ["SIGTERM"], scenario);
  }
});

test("isAvailable caches absent, invalid, oversized, and valid executable checks as booleans", async () => {
  let absentResolutions = 0;
  const absentCalls = [];
  const absent = createCodexAppServerRateLimitsReader({
    resolveExecutable: () => { absentResolutions += 1; return null; },
    spawnFn: fakeSpawn([], absentCalls),
  });
  assert.equal(await absent.isAvailable(), false);
  assert.equal(await absent.isAvailable(), false);
  assert.equal(absentResolutions, 1);
  assert.deepEqual(absentCalls, []);

  for (const output of ["codex 0.144.1\n", "codex-cli 0.144\n", "PRIVATE_ERROR_MUST_NOT_LEAK\n"]) {
    const calls = [];
    const invalid = createCodexAppServerRateLimitsReader({
      resolveExecutable: () => "C:\\tools\\codex.exe",
      spawnFn: fakeSpawn([versionWithOutput(output)], calls),
    });
    assert.equal(await invalid.isAvailable(), false);
    assert.equal(await invalid.isAvailable(), false);
    assert.equal(calls.length, 1);
  }

  const oversizedVersion = child();
  oversizedVersion.start = () => queueMicrotask(() => oversizedVersion.stdout.emit("data", "x".repeat(8 * 1024 + 1)));
  const oversized = createCodexAppServerRateLimitsReader({
    resolveExecutable: () => "C:\\tools\\codex.exe",
    spawnFn: fakeSpawn([oversizedVersion], []),
    versionTimeoutMs: 2_000,
  });
  assert.equal(await oversized.isAvailable(), false);
  assert.deepEqual(oversizedVersion.kills, ["SIGTERM"]);

  const validCalls = [];
  const valid = createCodexAppServerRateLimitsReader({
    resolveExecutable: () => "C:\\tools\\codex.exe",
    spawnFn: fakeSpawn([successfulVersion()], validCalls),
  });
  assert.equal(await valid.isAvailable(), true);
  assert.equal(await valid.isAvailable(), true);
  assert.equal(validCalls.length, 1);
});

test("caches a successful executable validation but never leaks validation errors", async () => {
  const version = successfulVersion();
  const first = child();
  const second = child();
  for (const server of [first, second]) {
    server.stdin.write = (data) => {
      server.stdin.writes.push(String(data));
      const message = JSON.parse(String(data));
      if (message.id === 1) queueMicrotask(() => server.stdout.emit("data", "{\"id\":1,\"result\":{}}\n"));
      if (message.id === 2) queueMicrotask(() => server.stdout.emit("data", "{\"id\":2,\"result\":{\"rateLimits\":{}}}\n"));
      return true;
    };
  }
  const calls = [];
  const reader = createCodexAppServerRateLimitsReader({ resolveExecutable: () => "C:\\tools\\codex.exe", spawnFn: fakeSpawn([version, first, second], calls) });
  await reader.readRateLimits();
  await reader.readRateLimits();
  assert.equal(calls.filter(({ args }) => args[0] === "--version").length, 1);
});
