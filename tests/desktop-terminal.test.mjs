import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTaskStart } from "../desktop/runtime/task-dispatch.mjs";
import { createTerminalController, installTerminalIpc, terminalHostSource } from "../desktop/runtime/terminal.mjs";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";

const repositoryId = "repo-0123456789abcdef01234567";
const key = `${repositoryId}/T-3/${"a".repeat(32)}`;
const sessionId = "claude:synthetic";
const json = (value) => new Response(JSON.stringify(value));

test("dispatch creates exactly one host PTY with validated arguments and the owner's session environment", async () => {
  const plans = [];
  const calls = [];
  const controller = { ensureHost: async () => {}, create: async (plan) => { plans.push(plan); } };
  const start = createTaskStart({
    platform: "win32", monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret",
    isTrustedEvent: () => true, confirm: async () => true, terminal: controller,
    environment: { USERPROFILE: "C:\\Users\\tester", PATH: "C:\\Tools", HTTPS_PROXY: "private", NODE_OPTIONS: "private" },
    fileExists: (file) => file.endsWith("claude.exe"), directoryExists: () => true,
    fetch: async (url) => { calls.push(url); return json({ ok: true, plan: { taskId: "T-3", provider: "claude", model: null, effort: null, repositoryRoot: "C:\\Work", prompt: "a & b", token: "A".repeat(43) } }); },
  });
  assert.deepEqual(await start.start({}, repositoryId, "T-3"), { status: "started" });
  assert.equal(plans.length, 1);
  assert.match(plans[0].key, new RegExp(`^${repositoryId}/T-3/[a-f0-9]{32}$`));
  assert.deepEqual(plans[0].args, ["a & b"]);
  assert.equal(plans[0].cwd, "C:\\Work");
  assert.equal(plans[0].env.POMEGR_TASK_TOKEN, "A".repeat(43));
  assert.equal(plans[0].env.HTTPS_PROXY, "private");
  assert.equal(plans[0].env.NODE_OPTIONS, "private");
  assert.equal(calls.length, 1);
});

function fixture({ sessions = [{ key, exited: false }], clientOverrides = {}, taskSession = sessionId, sessionForProcess } = {}) {
  const calls = [];
  const client = {
    listHosts: async () => [], ensureHost: async () => {}, list: async () => sessions,
    attach: async () => ({ readOnly: false, async *[Symbol.asyncIterator]() { yield { event: "output", data: "private" }; }, return: async () => { calls.push("detach"); } }),
    input: async (...args) => { calls.push(["input", ...args]); }, resize: async (...args) => { calls.push(["resize", ...args]); }, close() {}, ...clientOverrides,
  };
  const controller = createTerminalController({ client, sessionForProcess, isTrustedEvent: (e) => e.trusted,
    monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret",
    fetch: async (_url, options) => { assert.equal(options.headers["x-pomegr-desktop-authorization"], "secret"); return json({ readiness: "ready", repositoryId, tasks: [{ id: "T-3", session: taskSession ? { id: taskSession } : null, text: "private" }] }); },
  });
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  const output = []; const frame = { send: (...args) => output.push(args) }; sender.mainFrame = frame;
  const event = { trusted: true, sender, senderFrame: frame };
  return { controller, event, calls, output, client };
}

test("restart binding uses the authenticated task board, and never returns task text or host PID", async () => {
  const f = fixture();
  const answer = await f.controller.run(f.event, "list");
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.sessions, [{ key, repositoryId, taskId: "T-3", sessionId, state: "live" }]);
  assert.equal(JSON.stringify(answer).includes("private"), false);
});

test("continue keys rebuild their direct binding after restart without a task or persisted mapping", async () => {
  const continued = "codex:01234567-89ab-4cde-8fab-0123456789ab";
  const resumeKey = `continue/codex/${continued.slice(6)}/${"c".repeat(32)}`;
  for (let restart = 0; restart < 2; restart++) {
    const f = fixture({ sessions: [{ key: resumeKey, pid: 123, exited: false }], taskSession: null });
    const rows = (await f.controller.run(f.event, "list")).sessions;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, continued);
    assert.equal(rows[0].continuedFrom, continued);
    assert.equal(rows[0].state, "live");
    assert.equal(JSON.stringify(rows).includes("pid"), false);
    assert.equal((await f.controller.run(f.event, "attach", { key: resumeKey, attachId: "resume" })).ok, true);
    f.controller.dispose();
  }
});

test("a different committed process identity replaces the claimed session and retains its origin", async () => {
  const continued = "claude:01234567-89ab-4cde-8fab-0123456789ab";
  const actual = "claude:11234567-89ab-4cde-8fab-0123456789ab";
  const resumeKey = `continue/claude/${continued.slice(7)}/${"c".repeat(32)}`;
  const f = fixture({ sessions: [{ key: resumeKey, pid: 123, exited: false }], sessionForProcess: async (pid) => { assert.equal(pid, 123); return actual; } });
  const rows = (await f.controller.run(f.event, "list")).sessions;
  assert.equal(rows[0].sessionId, actual);
  assert.equal(rows[0].continuedFrom, continued);
  f.controller.dispose();
});

test("only the attaching trusted main frame can write and receives replay carrying its attach ID", async () => {
  let finish;
  const tail = new Promise((resolve) => { finish = resolve; });
  const f = fixture({ clientOverrides: { attach: async () => ({ readOnly: false, async *[Symbol.asyncIterator]() { yield { event: "output", data: "private" }; await tail; }, return: async () => { finish(); } }) } });
  assert.equal((await f.controller.run({ ...f.event, senderFrame: {} }, "list")).status, "invalid");
  assert.equal((await f.controller.run(f.event, "attach", { key, attachId: "owner" })).status, "attached");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.output, [["pomegr:terminal-output", { attachId: "owner", event: "output", data: "private" }]]);
  assert.equal((await f.controller.run(f.event, "input", { attachId: "owner", data: "x".repeat(16385) })).status, "invalid");
  assert.equal((await f.controller.run({ ...f.event, senderFrame: {} }, "input", { attachId: "owner", data: "x" })).status, "invalid");
  assert.equal((await f.controller.run(f.event, "input", { attachId: "owner", data: "ok" })).ok, true);
  f.event.sender.emit("did-start-navigation", {}, "http://other.test", false, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.controller.run(f.event, "input", { attachId: "owner", data: "x" })).status, "not_found");
  finish();
});

test("renderer output carries only the fixed true replay marker", async () => {
  const markers = [true, false, "true", 1, { private: "value" }, undefined];
  const f = fixture({ clientOverrides: { attach: async () => ({ readOnly: false,
    async *[Symbol.asyncIterator]() {
      for (const replay of markers) yield { event: "output", data: "synthetic", replay };
    }, return: async () => {},
  }) } });
  assert.equal((await f.controller.run(f.event, "attach", { key, attachId: "replay" })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.output.map(([, value]) => value), markers.map((replay) => ({
    attachId: "replay", event: "output", data: "synthetic", ...(replay === true ? { replay: true } : {}),
  })));
  f.controller.dispose();
});

test("IPC installer has exactly the five fixed operations and cleanup only detaches", async () => {
  const handlers = new Map(); const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  const f = fixture(); const remove = installTerminalIpc({ ipcMain, controller: f.controller });
  assert.equal(handlers.size, 1);
  assert.equal((await handlers.get("pomegr:terminal")(f.event, "kill", { key })).status, "invalid");
  remove(); assert.equal(handlers.size, 0);
});

test("before a confirmed task report a PTY stays starting, and ambiguous keys never guess a session", async () => {
  const unbound = fixture({ taskSession: null });
  assert.equal((await unbound.controller.run(unbound.event, "list")).sessions[0].state, "starting");
  const second = `${repositoryId}/T-3/${"b".repeat(32)}`;
  const ambiguous = fixture({ sessions: [{ key, exited: false }, { key: second, exited: false }] });
  assert.ok((await ambiguous.controller.run(ambiguous.event, "list")).sessions.every((row) => row.sessionId === null));
  const relaunched = fixture({ sessions: [{ key, exited: true, exitCode: 3 }, { key: second, exited: false }] });
  const rows = (await relaunched.controller.run(relaunched.event, "list")).sessions;
  assert.equal(rows.find((row) => row.key === second).sessionId, sessionId);
  assert.equal(rows.find((row) => row.key === key).sessionId, null);
  assert.equal(rows.find((row) => row.key === key).exitCode, 3);
});

test("lost hosts retain known metadata; incompatible host discovery never invents a session key", async () => {
  const f = fixture();
  await f.controller.run(f.event, "list");
  f.client.list = async () => { throw new Error("private transport detail"); };
  const lost = await f.controller.run(f.event, "list");
  assert.equal(lost.sessions[0].state, "host_unavailable");
  assert.equal(lost.sessions[0].sessionId, sessionId);
  const mismatch = fixture({ sessions: [], clientOverrides: { listHosts: async () => [{ buildId: "a".repeat(64), protocol: 999, pid: 123, token: "private" }] } });
  const result = await mismatch.controller.run(mismatch.event, "list");
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.hosts, [{ buildId: "a".repeat(64), protocol: 999, state: "incompatible_host" }]);
});

test("invalid terminal payloads, foreign frames, and unowned attachments never reach a host", async () => {
  const f = fixture();
  for (const [operation, payload] of [
    ["create", {}], ["list", { path: "private" }], ["attach", { key: "bad", attachId: "x" }],
    ["attach", { key, attachId: "x", executable: "private" }], ["detach", { attachId: "x", acknowledge: true }],
    ["input", { attachId: "x", data: "x".repeat(16385) }], ["input", { attachId: "x", data: "😀".repeat(4097) }],
    ["resize", { attachId: "x", cols: 1001, rows: 1 }], ["resize", { attachId: "x", cols: 1, rows: 1.5 }],
  ]) assert.equal((await f.controller.run(f.event, operation, payload)).status, "invalid");
  assert.equal((await f.controller.run(f.event, "input", { attachId: "unowned", data: "x" })).status, "not_found");
  assert.deepEqual(f.calls, []);
});

test("navigation during attach discards replay and detaches the eventual stream", async () => {
  let ready;
  let release;
  let detached = 0;
  const waiting = new Promise((resolve) => { ready = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ clientOverrides: { attach: async () => { ready(); await gate; return { return: async () => { detached++; }, async *[Symbol.asyncIterator]() { yield { event: "output", data: "private" }; } }; } } });
  const attaching = f.controller.run(f.event, "attach", { key, attachId: "race" });
  await waiting;
  f.event.sender.emit("did-start-navigation", {}, "http://other.test", false, true);
  release();
  assert.equal((await attaching).ok, false);
  assert.equal(detached, 1);
  assert.deepEqual(f.output, []);
});

test("development Electron resourcesPath still uses the staged development runtime", () => {
  assert.equal(terminalHostSource("C:\\Electron\\resources"), path.resolve("outputs/terminal-runtime"));
});

test("preload exposes only validated operations and removes its private output listener", async () => {
  const require = createRequire(import.meta.url);
  const invokes = [];
  const listeners = new Map();
  let bridge;
  const original = Module._load;
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  Module._load = function (name, ...args) {
    if (name === "electron") return {
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (...args) => { invokes.push(args); return { ok: true }; },
        on: (name, callback) => listeners.set(name, callback), removeListener: (name, callback) => { assert.equal(listeners.get(name), callback); listeners.delete(name); } },
    };
    return original.call(this, name, ...args);
  };
  try { require("../desktop/runtime/preload.cjs"); }
  finally { Module._load = original; globalThis.window = previousWindow; }
  for (const [operation, payload] of [["kill", {}], ["input", { attachId: "x", data: "😀".repeat(4097) }],
    ["attach", { attachId: "x", key, path: "private" }], ["resize", { attachId: "x", cols: 0, rows: 24 }]]) {
    assert.equal((await bridge.terminal(operation, payload)).status, "invalid");
  }
  assert.deepEqual(invokes, []);
  await bridge.terminal("list");
  await bridge.terminal("attach", { key, attachId: "owner" });
  await bridge.terminal("input", { attachId: "owner", data: "x".repeat(16384) });
  assert.equal(invokes.length, 3);
  const frames = [];
  const remove = bridge.onTerminalOutput((frame) => frames.push(frame));
  listeners.get("pomegr:terminal-output")({ secret: true }, { attachId: "owner", event: "output", data: "private" });
  assert.deepEqual(frames, [{ attachId: "owner", event: "output", data: "private" }]);
  remove(); assert.equal(listeners.size, 0);
});

test("a viewed exit acknowledges only that exited host record and retains read-only metadata", async () => {
  const acknowledgments = [];
  let sessions = [{ key, exited: false }];
  const f = fixture({ clientOverrides: {
    list: async () => sessions,
    attach: async () => ({ readOnly: false, async *[Symbol.asyncIterator]() { yield { event: "exit", exitCode: 7 }; }, return: async () => {} }),
    detach: async (...args) => { acknowledgments.push(args); sessions = []; },
  } });
  assert.equal((await f.controller.run(f.event, "attach", { key, attachId: "ending" })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.output, [["pomegr:terminal-output", { attachId: "ending", event: "exit", exitCode: 7 }]]);
  assert.deepEqual(acknowledgments, [[key, true]]);
  const after = await f.controller.run(f.event, "list");
  assert.equal(after.sessions[0].state, "exited");
  assert.equal(after.sessions[0].exitCode, 7);
});

test("queued terminals that were never viewed release exited capacity before subsequent starts", async () => {
  const rows = new Map();
  const acknowledgments = [];
  let starts = 0;
  const f = fixture({ clientOverrides: {
    list: async () => [...rows.values()],
    create: async (plan) => {
      if (rows.size >= 2) throw new Error("TERMINAL_CAPACITY");
      starts++; rows.set(plan.key, { key: plan.key, exited: true, exitCode: 0 });
    },
    detach: async (key, acknowledge) => { assert.equal(acknowledge, true); acknowledgments.push(key); rows.delete(key); },
  } });
  for (let i = 0; i < 4; i++) {
    await f.controller.ensureHost();
    await f.controller.create({ key: `${repositoryId}/T-${i + 1}/${"a".repeat(32)}` });
  }
  assert.equal(starts, 4);
  assert.equal(acknowledgments.length, 3);
  assert.equal(rows.size, 1);
  const result = await f.controller.run(f.event, "list");
  assert.equal(result.sessions.length, 4);
  assert.ok(result.sessions.every((row) => row.state === "exited" && row.exitCode === 0));
  assert.equal(result.sessions.find((row) => row.taskId === "T-3").sessionId, sessionId);
});
