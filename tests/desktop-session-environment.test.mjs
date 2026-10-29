import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { sessionEnvironmentFits } from "../desktop/runtime/environment-policy.mjs";
import { createSessionEnvironment } from "../desktop/runtime/provider-settings.mjs";
import { createSessionContinue } from "../desktop/runtime/session-continue.mjs";
import { createWindowsEnvironment, parseRegistryEnvironment, readWindowsEnvironment, refreshedEnvironment } from "../desktop/runtime/session-environment.mjs";
import { createTaskStart } from "../desktop/runtime/task-dispatch.mjs";
import { chatHarness, repositoryId as chatRepositoryId, sourceEnvironment as chatEnvironment, until } from "./helpers/agent-chat-harness.mjs";

// Synthetic values only: no test reads the real registry or starts a process.
const homeDir = "C:\\Users\\tester";
const dataRoot = "C:\\Users\\tester\\AppData\\Roaming\\Pomegr";
const repositoryId = "repo-0123456789abcdef01234567";
const root = "C:\\Work\\repo";
const exe = "C:\\Users\\tester\\.local\\bin\\claude.exe";
const token = "A".repeat(43);
const trusted = { trusted: true };
const localId = "01234567-89ab-4cde-8fab-0123456789ab";

// What the app inherited when it started: the registry's values, plus what only its launcher set.
const startup = Object.freeze({
  SystemRoot: "C:\\Windows", USERPROFILE: homeDir, Path: "C:\\Windows\\System32;C:\\Users\\tester\\bin;C:\\Launcher\\only",
  OLD_TOOL: "C:\\Old", LAUNCHER_ONLY: "kept", PORTABLE_EXECUTABLE_DIR: "C:\\Portable",
  ELECTRON_RUN_AS_NODE: "1", POMEGR_MONITOR_TOKEN: "app-private", POMEGR_TASK_TOKEN: "stale", CLAUDECODE: "1",
});
const variable = (name, value, expand = false) => ({ name, value, expand });
const startupRegistry = () => ({
  machine: [variable("Path", "%SystemRoot%\\System32", true), variable("SystemRoot", "C:\\Windows")],
  user: [variable("Path", "C:\\Users\\tester\\bin"), variable("OLD_TOOL", "C:\\Old")],
});

/** A registry the test edits after startup; each read answers a copy of what it holds then. */
function fakeRegistry() {
  const registry = { scopes: startupRegistry(), reads: 0 };
  registry.read = () => { registry.reads += 1; return structuredClone(registry.scopes); };
  registry.later = () => {
    registry.scopes.user = registry.scopes.user.filter(({ name }) => name !== "OLD_TOOL");
    registry.scopes.user.push(variable("NEW_TOOL", "%USERPROFILE%\\new", true), variable("Path", "%USERPROFILE%\\added", true));
    registry.scopes.user = registry.scopes.user.filter(({ name, value }) => name !== "Path" || value.includes("added"));
    registry.scopes.machine.push(variable("ELECTRON_RUN_AS_NODE", "1"), variable("POMEGR_TASK_TOKEN", "registry"), variable("CLAUDECODE", "1"));
  };
  return registry;
}
const sessionSource = (registry, extra = {}) => createSessionEnvironment({ environment: startup, folders: {}, homeDir, dataRoot, platform: "win32", readRegistry: registry.read, ...extra });

function assertRefreshed(env) {
  assert.equal(env.NEW_TOOL, "C:\\Users\\tester\\new");
  assert.equal(env.OLD_TOOL, undefined);
  assert.equal(env.LAUNCHER_ONLY, "kept");
  assert.equal(env.PORTABLE_EXECUTABLE_DIR, "C:\\Portable");
  assert.equal(env.Path, "C:\\Windows\\System32;C:\\Users\\tester\\added");
  for (const name of ["ELECTRON_RUN_AS_NODE", "POMEGR_MONITOR_TOKEN", "CLAUDECODE"]) assert.equal(env[name], undefined);
}

test("the registry is laid over the startup copy: added, deleted, process-only, and PATH machine then user with expansion", () => {
  const registry = fakeRegistry();
  const before = registry.read();
  registry.later();
  const env = refreshedEnvironment(startup, before, registry.read());
  assert.equal(env.NEW_TOOL, "C:\\Users\\tester\\new");
  assert.equal(Object.hasOwn(env, "OLD_TOOL"), false);
  assert.equal(env.LAUNCHER_ONLY, "kept");
  assert.equal(env.Path, "C:\\Windows\\System32;C:\\Users\\tester\\added");
  assert.equal(Object.keys(env).filter((name) => name.toLowerCase() === "path").length, 1);
  // A plain value is never expanded; an unknown name stays as written; plain values come first within a key.
  const scopes = { machine: [variable("LATER", "%EARLY%\\x", true), variable("EARLY", "C:\\Early")], user: [variable("RAW", "%USERPROFILE%"), variable("MISSING", "%NOPE%\\y", true)] };
  const expanded = refreshedEnvironment(startup, null, scopes);
  assert.deepEqual([expanded.LATER, expanded.RAW, expanded.MISSING], ["C:\\Early\\x", "%USERPROFILE%", "%NOPE%\\y"]);
  // Without a startup reading nothing is dropped, and without a Path value the startup PATH stays.
  assert.equal(expanded.OLD_TOOL, "C:\\Old");
  assert.equal(expanded.Path, startup.Path);
});

test("a user value wins over a machine value, and a deleted variable is dropped whatever its case", () => {
  const env = refreshedEnvironment({ ...startup, old_tool: undefined }, { machine: [], user: [variable("Old_Tool", "x")] },
    { machine: [variable("SHARED", "machine")], user: [variable("shared", "user")] });
  assert.deepEqual(Object.keys(env).filter((name) => name.toLowerCase() === "shared").map((name) => env[name]), ["user"]);
  assert.equal(Object.keys(env).some((name) => name.toLowerCase() === "old_tool"), false);
});

test("the logon's own variables keep their startup values: the machine key's USERNAME=SYSTEM never reaches a session", () => {
  const env = refreshedEnvironment({ ...startup, USERNAME: "owner", USERPROFILE: "C:\Users\owner", APPDATA: "C:\Users\owner\AppData\Roaming" },
    { machine: [variable("USERNAME", "SYSTEM")], user: [variable("APPDATA", "C:\Old")] },
    { machine: [variable("USERNAME", "SYSTEM"), variable("USERPROFILE", "C:\Windows\system32\config\systemprofile")], user: [] });
  assert.equal(env.USERNAME, "owner");
  assert.equal(env.USERPROFILE, "C:\Users\owner");
  assert.equal(env.APPDATA, "C:\Users\owner\AppData\Roaming");
});

test("each start reads the registry again; provider folders still win over it", async () => {
  const registry = fakeRegistry();
  const custom = path.resolve("C:\\Claude\\custom");
  const source = sessionSource(registry, { folders: { claudeConfigDir: custom } });
  assert.equal(registry.reads, 1);
  registry.later();
  registry.scopes.user.push(variable("CLAUDE_CONFIG_DIR", "C:\\Registry\\claude"));
  const env = await source.current();
  assert.equal(registry.reads, 2);
  assert.equal(env.NEW_TOOL, "C:\\Users\\tester\\new");
  assert.equal(env.CLAUDE_CONFIG_DIR, custom);
  assert.equal(source.startup.CLAUDE_CONFIG_DIR, custom);
  await source.current();
  assert.equal(registry.reads, 3);
});

test("a failed, malformed, or timed-out read uses the startup copy", async () => {
  for (const readRegistry of [() => { throw new Error("denied"); }, async () => { throw new Error("denied"); }, async () => ({ machine: "x" }), () => new Promise(() => {})]) {
    const current = createWindowsEnvironment({ environment: startup, platform: "win32", readRegistry, timeoutMs: 20 });
    assert.deepEqual(await current(), { ...startup });
  }
  // A failed startup reading only means a deleted variable cannot be told from a launcher one: both stay.
  let reads = 0;
  const registry = fakeRegistry();
  registry.later();
  const current = createWindowsEnvironment({ environment: startup, platform: "win32", readRegistry: () => (reads++ === 0 ? Promise.reject(new Error("x")) : registry.read()) });
  const env = await current();
  assert.equal(env.NEW_TOOL, "C:\\Users\\tester\\new");
  assert.equal(env.OLD_TOOL, "C:\\Old");
});

test("other platforms keep the startup copy and never read a registry", async () => {
  const current = createWindowsEnvironment({ environment: startup, platform: "linux", readRegistry: () => assert.fail("no registry") });
  assert.deepEqual(await current(), { ...startup });
});

test("the reader runs Windows PowerShell with a fixed argument array and a timeout, and decodes each value", async () => {
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
  let call;
  const scopes = await readWindowsEnvironment({ environment: { SystemRoot: "C:\\Windows" }, timeoutMs: 1234, execFile: (file, args, options, done) => {
    call = { file, args, options };
    done(null, `machine x ${b64("Path")} ${b64("%SystemRoot%\\System32")}\r\nuser s ${b64("JOÃO_HOME")} ${b64("C:\\Users\\João")}\r\nuser s ${b64("EMPTY")} \r\nnoise\r\n`);
  } });
  assert.equal(call.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(call.args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
  assert.equal(call.args.length, 7);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 1234);
  assert.deepEqual(scopes, { machine: [variable("Path", "%SystemRoot%\\System32", true)], user: [variable("JOÃO_HOME", "C:\\Users\\João"), variable("EMPTY", "")] });
  await assert.rejects(readWindowsEnvironment({ environment: { SystemRoot: "C:\\Windows" }, execFile: (_f, _a, _o, done) => done(new Error("timeout")) }), /SESSION_ENVIRONMENT_UNAVAILABLE/u);
  await assert.rejects(readWindowsEnvironment({ environment: {} }), /SESSION_ENVIRONMENT_UNAVAILABLE/u);
  assert.deepEqual(parseRegistryEnvironment("garbage"), { machine: [], user: [] });
});

test("the host's limits are checked in main and never cut an environment to fit", () => {
  assert.equal(sessionEnvironmentFits({ PATH: "C:\\x", "ProgramFiles(x86)": "C:\\y" }), true);
  assert.equal(sessionEnvironmentFits({ "MY-VAR": "x" }), false);
  assert.equal(sessionEnvironmentFits({ BIG: "x".repeat(32768) }), false);
  assert.equal(sessionEnvironmentFits(Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`V${index}`, "x"]))), false);
  assert.equal(sessionEnvironmentFits(Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`V${index}`, "x".repeat(13_000)]))), false);
});

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const startPlan = () => ({ taskId: "T-3", provider: "claude", model: null, effort: null, repositoryRoot: root, prompt: "Do the thing", token });

function starter(source) {
  const creates = [], routes = [];
  const start = createTaskStart({
    isTrustedEvent: (event) => event === trusted, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret", platform: "win32",
    environment: source.startup, sessionEnvironment: source.current,
    fileExists: (file) => file === exe, directoryExists: (directory) => directory === root,
    confirm: async () => true, confirmReview: async () => true, worktrees: { locate: async () => null },
    fetch: async (url) => { const route = url.split("/").pop(); routes.push(route); return json(route.endsWith("abort") ? { ok: true } : { ok: true, plan: startPlan() }); },
    terminal: { ensureHost: async () => {}, create: async (plan) => { creates.push(plan); } },
  });
  return { start, creates, routes };
}
const withClaude = (source) => ({ startup: { ...source.startup, POMEGR_CLAUDE_EXECUTABLE: exe }, current: async () => ({ ...await source.current(), POMEGR_CLAUDE_EXECUTABLE: exe }) });

test("a variable added after startup reaches a task start and a review start; excluded variables never pass", async () => {
  const registry = fakeRegistry();
  const h = starter(withClaude(sessionSource(registry)));
  registry.later();
  assert.deepEqual(await h.start.start(trusted, repositoryId, "T-3"), { status: "started" });
  assert.deepEqual(await h.start.startReview(trusted, repositoryId, "T-3"), { status: "started" });
  assert.equal(h.creates.length, 2);
  for (const { env } of h.creates) {
    assertRefreshed(env);
    assert.equal(env.POMEGR_TASK_TOKEN, token);
  }
});

test("a refreshed environment over the host's limits fails the start with its own reason and launches nothing", async () => {
  const registry = fakeRegistry();
  const h = starter(withClaude(sessionSource(registry)));
  registry.scopes.user.push(variable("MY-TOOL", "x"));
  assert.deepEqual(await h.start.start(trusted, repositoryId, "T-3"), { status: "environment_invalid" });
  assert.ok(h.routes.includes("start-abort"));
  assert.deepEqual(await h.start.startReview(trusted, repositoryId, "T-3"), { status: "environment_invalid" });
  assert.ok(h.routes.includes("review-abort"));
  assert.equal(h.creates.length, 0);
});

function continuer(source) {
  const creates = [];
  const sender = { isDestroyed: () => false, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  const cwd = path.resolve("outputs/synthetic-continue");
  const action = createSessionContinue({
    isTrustedEvent: (candidate) => candidate === event, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "private-token",
    environment: source.startup, sessionEnvironment: source.current, directoryExists: () => true, fileExists: (file) => file === exe,
    confirm: async () => true,
    fetch: async () => Response.json({ ok: true, plan: { provider: "claude", sessionId: `claude:${localId}`, localId, cwd, title: "Synthetic session" } }),
    terminal: { ensureHost: async () => {}, run: async () => ({ ok: true, sessions: [], hosts: [] }), create: async (plan) => { creates.push(plan); } },
  });
  return { run: () => action.run(event, `claude:${localId}`), creates };
}

test("a variable added after startup reaches a session continue, and an oversized one fails it", async () => {
  const registry = fakeRegistry();
  const h = continuer(withClaude(sessionSource(registry)));
  registry.later();
  assert.deepEqual(await h.run(), { status: "started" });
  assertRefreshed(h.creates[0].env);
  assert.equal(h.creates[0].env.POMEGR_TASK_TOKEN, undefined);
  registry.scopes.user.push(variable("HUGE", "x".repeat(32768)));
  assert.deepEqual(await h.run(), { status: "environment_invalid" });
  assert.equal(h.creates.length, 1);
});

test("a variable added after startup reaches an Aril run", async (context) => {
  const registry = { scopes: { machine: [], user: [variable("OLD_TOOL", "C:\\Old")] }, reads: 0 };
  registry.read = () => { registry.reads += 1; return structuredClone(registry.scopes); };
  const source = createSessionEnvironment({ environment: { ...chatEnvironment, OLD_TOOL: "C:\\Old" }, folders: {}, homeDir, dataRoot, platform: "win32", readRegistry: registry.read });
  const h = await chatHarness(context, { environment: source.startup, sessionEnvironment: source.current });
  registry.scopes.user = [variable("NEW_TOOL", "%USERPROFILE%\\new", true), variable("ELECTRON_RUN_AS_NODE", "1")];
  assert.equal((await h.handle("send", { repositoryId: chatRepositoryId, conversationId: null, text: "Hello", provider: "claude", model: null })).ok, true);
  const run = await until(() => h.runs[0] ?? null);
  assert.equal(run.options.env.NEW_TOOL, "C:\\Users\\tester\\new");
  assert.equal(run.options.env.OLD_TOOL, undefined);
  assert.equal(run.options.env.HTTPS_PROXY, "http://proxy.test:8080");
  for (const name of ["ELECTRON_RUN_AS_NODE", "POMEGR_MONITOR_TOKEN", "POMEGR_TASK_TOKEN"]) assert.equal(run.options.env[name], undefined);
});
