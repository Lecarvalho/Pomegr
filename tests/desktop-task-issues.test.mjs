import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createTaskIssues,
  installTaskIssuesIpc,
  TASK_ISSUES_CHANNEL,
  TASK_ISSUES_LAUNCH_ARGUMENTS,
  TASK_ISSUES_OPERATIONS,
} from "../desktop/runtime/task-issues.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const digest = "a".repeat(64);
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const invalid = { ok: false, error: "invalid" };
const unavailable = { ok: false, error: "unavailable" };

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function harness(answer, overrides = {}) {
  const calls = [];
  const issues = createTaskIssues({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: origin,
    authorizationToken: "secret",
    fetch: async (url, options) => { calls.push({ url, options }); return typeof answer === "function" ? answer(url, options) : answer; },
    ...overrides,
  });
  return { issues, calls };
}

function signInHarness(overrides = {}) {
  const spawns = [];
  const confirms = [];
  const existing = new Set(["C:\\Tools\\gh.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
  const issues = createTaskIssues({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: origin,
    authorizationToken: "secret",
    platform: "win32",
    environment: { PATH: "C:\\Tools;relative", SystemRoot: "C:\\Windows", POMEGR_TASK_TOKEN: "x" },
    fileExists: (file) => existing.has(file),
    confirm: async () => { confirms.push(1); return true; },
    spawn: (...args) => {
      spawns.push(args);
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 0));
      return child;
    },
    ...overrides,
  });
  return { issues, spawns, confirms };
}

test("channel and operation list are fixed; unknown operations are refused", async () => {
  assert.equal(TASK_ISSUES_CHANNEL, "pomegr:task-issues");
  assert.deepEqual([...TASK_ISSUES_OPERATIONS], ["status", "list", "promote", "create", "sign_in"]);
  const { issues, calls } = harness(() => json({ ok: true }));
  for (const operation of ["../list", "STATUS", "", undefined, 3, "github-status"]) {
    assert.deepEqual(await issues.run(trusted, repositoryId, operation, {}), invalid);
  }
  assert.equal(calls.length, 0);
});

test("every input is validated before any request", async () => {
  const { issues, calls } = harness(() => json({ ok: true }));
  const good = { number: 5, digest };
  for (const id of ["C:\\x", "repo-0123", "repo-0123456789ABCDEF01234567", "repo-0123456789abcdef012345678", undefined, 7]) {
    for (const operation of TASK_ISSUES_OPERATIONS) {
      assert.deepEqual(await issues.run(trusted, id, operation, operation === "promote" ? good : operation === "create" ? { taskId: "T-1" } : {}), invalid);
    }
  }
  for (const operation of ["status", "list", "create", "sign_in"]) {
    assert.deepEqual(await issues.run(trusted, repositoryId, operation, { extra: 1 }), invalid);
  }
  const bad = [
    {}, { number: 5 }, { digest }, { ...good, extra: 1 },
    { number: 0, digest }, { number: 1_000_000_000, digest }, { number: 1.5, digest }, { number: "5", digest }, { number: -1, digest },
    { number: 5, digest: "A".repeat(64) }, { number: 5, digest: "a".repeat(63) }, { number: 5, digest: `${"a".repeat(64)}\n` }, { number: 5, digest: 5 },
    { number: 5, digest, big: "x".repeat(20_000) },
  ];
  for (const payload of bad) assert.deepEqual(await issues.run(trusted, repositoryId, "promote", payload), invalid);
  for (const payload of [undefined, null, "x", 5, [], ["a"], new Map(), new (class P {})(), () => {}]) {
    for (const operation of TASK_ISSUES_OPERATIONS) assert.deepEqual(await issues.run(trusted, repositoryId, operation, payload), invalid);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await issues.run(trusted, repositoryId, "promote", { number: 999_999_999, digest }), { ok: true });
  assert.deepEqual(await issues.run(trusted, repositoryId, "promote", { number: 1, digest }), { ok: true });
});

test("an untrusted frame is refused for every operation without a request or launch", async () => {
  const { issues, calls } = harness(() => json({ ok: true }));
  const sign = signInHarness();
  for (const event of [{}, undefined, null, { trusted: false }]) {
    for (const operation of TASK_ISSUES_OPERATIONS) {
      const payload = operation === "promote" ? { number: 1, digest } : operation === "create" ? { taskId: "T-1" } : {};
      assert.deepEqual(await issues.run(event, repositoryId, operation, payload), invalid);
      assert.deepEqual(await sign.issues.run(event, repositoryId, operation, payload), invalid);
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(sign.spawns.length, 0);
  assert.equal(sign.confirms.length, 0);
});

test("each monitor operation posts the exact route, token, and body", async () => {
  const { issues, calls } = harness(() => json({ ok: true, taskId: "T-1" }));
  await issues.run(trusted, repositoryId, "status", {});
  await issues.run(trusted, repositoryId, "list", {});
  await issues.run(trusted, repositoryId, "promote", { number: 12, digest });
  assert.deepEqual(calls.map((call) => call.url), [
    `${origin}/internal/tasks/github-status`, `${origin}/internal/tasks/issues-list`, `${origin}/internal/tasks/issue-promote`,
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.cache, "no-store");
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(Object.values(call.options.headers).includes("secret"), true);
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), { repositoryId, payload: {} });
  assert.deepEqual(JSON.parse(calls[2].options.body), { repositoryId, payload: { number: 12, digest } });
});

test("success passes through unchanged and refusals collapse to the bounded error", async () => {
  const answer = { ok: true, connection: "connected", repository: { visibility: "private", capabilities: ["read_issues"] } };
  const pass = harness(() => json(answer));
  assert.deepEqual(await pass.issues.run(trusted, repositoryId, "status", {}), answer);
  for (const error of ["invalid", "not_found", "conflict", "limit", "unavailable"]) {
    const { issues } = harness(() => json({ ok: false, error, detail: "C:\\secret", issues: [{ body: "x" }] }, 409));
    assert.deepEqual(await issues.run(trusted, repositoryId, "list", {}), { ok: false, error });
  }
  for (const body of [{ ok: false, error: "teapot" }, { ok: false, error: 3 }, { ok: false }, {}, [], null, "ok", { ok: "true" }]) {
    const { issues } = harness(() => json(body));
    assert.deepEqual(await issues.run(trusted, repositoryId, "list", {}), unavailable);
  }
  assert.deepEqual(await harness(() => json({ ok: true }, 500)).issues.run(trusted, repositoryId, "list", {}), unavailable);
  assert.deepEqual(await harness(() => new Response("<html>", { status: 200 })).issues.run(trusted, repositoryId, "list", {}), unavailable);
  assert.deepEqual(await harness(() => { throw new TypeError("unexpected redirect C:\\secret"); }).issues.run(trusted, repositoryId, "list", {}), unavailable);
  assert.deepEqual(await harness(() => Promise.reject(new Error("down"))).issues.run(trusted, repositoryId, "list", {}), unavailable);
});

test("a missing token, non-loopback origin, or disposal never posts", async () => {
  for (const options of [{ authorizationToken: undefined }, { monitorOrigin: "https://example.test" }, { monitorOrigin: undefined }]) {
    const { issues, calls } = harness(() => json({ ok: true }), options);
    assert.deepEqual(await issues.run(trusted, repositoryId, "status", {}), unavailable);
    assert.equal(calls.length, 0);
  }
  const { issues, calls } = harness(() => json({ ok: true }));
  issues.dispose();
  assert.deepEqual(await issues.run(trusted, repositoryId, "status", {}), unavailable);
  assert.equal(calls.length, 0);
});

test("sign-in: unsupported platform launches and asks nothing", async () => {
  const { issues, spawns, confirms } = signInHarness({ platform: "linux" });
  assert.deepEqual(await issues.run(trusted, repositoryId, "sign_in", {}), { ok: true, status: "unsupported_platform" });
  assert.equal(spawns.length + confirms.length, 0);
});

test("sign-in: a declined confirmation launches nothing", async () => {
  const { issues, spawns } = signInHarness({ confirm: async () => false });
  assert.deepEqual(await issues.run(trusted, repositoryId, "sign_in", {}), { ok: true, status: "cancelled" });
  assert.equal(spawns.length, 0);
});

test("sign-in: a missing CLI answers cli_missing before asking", async () => {
  const { issues, spawns, confirms } = signInHarness({ fileExists: () => false });
  assert.deepEqual(await issues.run(trusted, repositoryId, "sign_in", {}), { ok: true, status: "cli_missing" });
  assert.equal(spawns.length + confirms.length, 0);
});

test("sign-in opens the GitHub CLI's own sign-in with fixed arguments and no shell", async () => {
  const { issues, spawns, confirms } = signInHarness();
  assert.deepEqual(await issues.run(trusted, repositoryId, "sign_in", {}), { ok: true, status: "opened" });
  assert.equal(confirms.length, 1);
  assert.equal(spawns.length, 1);
  const [file, args, options] = spawns[0];
  assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(args, [...TASK_ISSUES_LAUNCH_ARGUMENTS]);
  assert.equal(options.shell, false);
  assert.equal(options.cwd, undefined);
  assert.equal(options.env.POMEGR_START_FILE, "C:\\Tools\\gh.exe");
  assert.equal(options.env.POMEGR_START_ARGUMENTS, "auth login --hostname github.com --web");
  assert.equal(options.env.POMEGR_TASK_TOKEN, undefined);
  assert.match(args.at(-1), /Start-Process -FilePath \$f -ArgumentList \$a$/u);
});

test("sign-in: spawn failure, launcher failure, and a thrown confirmation are unavailable", async () => {
  const status = { ok: true, status: "unavailable" };
  const thrown = signInHarness({ spawn: () => { throw new Error("EPERM C:\\secret"); } });
  assert.deepEqual(await thrown.issues.run(trusted, repositoryId, "sign_in", {}), status);
  const failed = signInHarness({ spawn: () => { const child = new EventEmitter(); setImmediate(() => child.emit("error", new Error("x"))); return child; } });
  assert.deepEqual(await failed.issues.run(trusted, repositoryId, "sign_in", {}), status);
  const exit = signInHarness({ spawn: () => { const child = new EventEmitter(); setImmediate(() => child.emit("exit", 1)); return child; } });
  assert.deepEqual(await exit.issues.run(trusted, repositoryId, "sign_in", {}), status);
  const confirm = signInHarness({ confirm: async () => { throw new Error("x"); } });
  assert.deepEqual(await confirm.issues.run(trusted, repositoryId, "sign_in", {}), status);
});

test("the default confirmation shows the native dialog on the main window", async () => {
  const shown = [];
  const window = { isDestroyed: () => false };
  const make = (response, getWindow = () => window) => signInHarness({
    confirm: undefined,
    getWindow,
    dialog: { showMessageBox: async (...args) => { shown.push(args); return { response }; } },
  });
  const accepted = make(0);
  assert.deepEqual(await accepted.issues.run(trusted, repositoryId, "sign_in", {}), { ok: true, status: "opened" });
  assert.equal(shown[0][0], window);
  assert.match(shown[0][1].detail, /never reads or stores your GitHub credentials/u);
  assert.deepEqual(await make(1).issues.run(trusted, repositoryId, "sign_in", {}), { ok: true, status: "cancelled" });
  const noWindow = make(0, () => null);
  assert.deepEqual(await noWindow.issues.run(trusted, repositoryId, "sign_in", {}), { ok: true, status: "cancelled" });
  assert.equal(noWindow.spawns.length, 0);
});

test("disposal stops sign-in", async () => {
  const { issues, spawns } = signInHarness();
  issues.dispose();
  assert.deepEqual(await issues.run(trusted, repositoryId, "sign_in", {}), { ok: true, status: "unavailable" });
  assert.equal(spawns.length, 0);
});

test("IPC registers the fixed channel, passes arguments, normalizes throws, and removes the handler", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  let disposed = 0;
  const calls = [];
  const remove = installTaskIssuesIpc({
    ipcMain,
    action: { run: async (...args) => { calls.push(args); return { ok: true }; }, dispose() { disposed += 1; } },
  });
  assert.deepEqual([...handlers.keys()], [TASK_ISSUES_CHANNEL]);
  assert.deepEqual(await handlers.get(TASK_ISSUES_CHANNEL)(trusted, repositoryId, "list", {}), { ok: true });
  assert.deepEqual(calls, [[trusted, repositoryId, "list", {}]]);
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, 1);
  assert.throws(() => installTaskIssuesIpc({}), TypeError);
  installTaskIssuesIpc({ ipcMain, action: { run: async () => { throw new Error("C:\\secret"); } } });
  assert.deepEqual(await handlers.get(TASK_ISSUES_CHANNEL)(trusted, repositoryId, "list", {}), unavailable);
});

test("preload exposes taskIssues on the fixed channel and refuses bad calls locally", async () => {
  const preload = await readFile(new URL("../desktop/runtime/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /taskIssues\(repositoryId, operation, payload\)/u);
  assert.match(preload, /ipcRenderer\.invoke\("pomegr:task-issues", repositoryId, operation, payload\)/u);
  const invokes = [];
  let exposed;
  const Module = (await import("node:module")).default;
  const require = Module.createRequire(import.meta.url);
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
        ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true }); } },
      };
    }
    return original.call(this, request, ...rest);
  };
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try { require("../desktop/runtime/preload.cjs"); } finally { Module._load = original; globalThis.window = previousWindow; }
  const good = { number: 3, digest };
  for (const call of [
    ["nope", "status", {}], [repositoryId, "erase", {}], [repositoryId, "status", null], [repositoryId, "status", []],
    [repositoryId, "status", { a: 1 }], [repositoryId, "sign_in", "x"], [repositoryId, "promote", {}],
    [repositoryId, "promote", { ...good, number: 0 }], [repositoryId, "promote", { ...good, number: 1.5 }],
    [repositoryId, "promote", { ...good, number: 1_000_000_000 }], [repositoryId, "promote", { ...good, digest: "z" }],
    [repositoryId, "promote", { ...good, extra: 1 }], [repositoryId, "status", new Map()],
    [repositoryId, "create", {}], [repositoryId, "create", good], [repositoryId, "create", { taskId: "t-1" }], [repositoryId, "create", { taskId: "T-0" }],
    [repositoryId, "create", { taskId: "T-1234567890" }], [repositoryId, "create", { taskId: 1 }], [repositoryId, "create", { taskId: "T-1", text: "x" }],
    [repositoryId, "create", { taskId: "T-1\n" }], [repositoryId, "create", null], [repositoryId, "list", { taskId: "T-1" }],
  ]) assert.deepEqual(await exposed.taskIssues(...call), invalid, JSON.stringify(call));
  assert.equal(invokes.length, 0);
  for (const operation of ["status", "list", "sign_in"]) assert.deepEqual(await exposed.taskIssues(repositoryId, operation, {}), { ok: true });
  assert.deepEqual(await exposed.taskIssues(repositoryId, "promote", good), { ok: true });
  assert.deepEqual(await exposed.taskIssues(repositoryId, "create", { taskId: "T-12" }), { ok: true });
  assert.equal(invokes.length, 5);
  assert.deepEqual(invokes[3], ["pomegr:task-issues", repositoryId, "promote", good]);
  assert.deepEqual(invokes[4], ["pomegr:task-issues", repositoryId, "create", { taskId: "T-12" }]);
});

test("create posts the issue-create route with exactly a task ID and answers only the number", async () => {
  const { issues, calls } = harness(() => json({ ok: true, number: 41, title: "SECRET TITLE", path: "C:\secret" }));
  assert.deepEqual(await issues.run(trusted, repositoryId, "create", { taskId: "T-12" }), { ok: true, number: 41 });
  assert.equal(calls[0].url, `${origin}/internal/tasks/issue-create`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { repositoryId, payload: { taskId: "T-12" } });
  for (const payload of [{}, { taskId: "t-12" }, { taskId: "T-0" }, { taskId: "T-1234567890" }, { taskId: 12 }, { taskId: "T-1", extra: 1 }, { taskId: "T-1\n" }]) {
    assert.deepEqual(await issues.run(trusted, repositoryId, "create", payload), invalid);
  }
  assert.equal(calls.length, 1);
  for (const body of [{ ok: true }, { ok: true, number: 0 }, { ok: true, number: 1_000_000_000 }, { ok: true, number: "4" }, { ok: true, number: 1.5 }]) {
    assert.deepEqual(await harness(() => json(body)).issues.run(trusted, repositoryId, "create", { taskId: "T-1" }), unavailable);
  }
});

test("create passes only the fixed GitHub failures through, and only for create", async () => {
  for (const error of ["invalid", "not_found", "conflict", "unavailable", "cli_missing", "not_signed_in", "no_access", "issues_disabled", "failed"]) {
    const { issues } = harness(() => json({ ok: false, error, detail: "C:\secret", message: "gh said" }, 502));
    assert.deepEqual(await issues.run(trusted, repositoryId, "create", { taskId: "T-1" }), { ok: false, error });
  }
  for (const error of ["cli_missing", "not_signed_in", "no_access", "issues_disabled", "failed"]) {
    const { issues } = harness(() => json({ ok: false, error }, 502));
    assert.deepEqual(await issues.run(trusted, repositoryId, "list", {}), unavailable);
  }
  const { issues } = harness(() => json({ ok: false, error: "teapot" }));
  assert.deepEqual(await issues.run(trusted, repositoryId, "create", { taskId: "T-1" }), unavailable);
});

test("create waits up to its own 30 second deadline, other operations keep theirs", async () => {
  const { issues, calls } = harness(() => json({ ok: true, number: 1, connection: "connected", repository: null }));
  await issues.run(trusted, repositoryId, "create", { taskId: "T-1" });
  await issues.run(trusted, repositoryId, "status", {});
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.ok(calls[1].options.signal instanceof AbortSignal);
  const source = await readFile(new URL("../desktop/runtime/task-issues.mjs", import.meta.url), "utf8");
  assert.match(source, /const CREATE_TIMEOUT_MS = 30_000;/u);
  assert.match(source, /const timeoutMs = options\.timeoutMs \?\? 20_000;/u);
});
