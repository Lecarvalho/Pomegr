import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { nativeClaudeEnvironment } from "../desktop/runtime/environment-policy.mjs";
import {
  createTaskStart,
  installTaskStartIpc,
  TASK_START_CHANNEL,
  TASK_START_LAUNCH_ARGUMENTS,
  TASK_START_STATUSES,
  windowsArgument,
} from "../desktop/runtime/task-dispatch.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const exe = "C:\\Users\\tester\\.local\\bin\\claude.exe";
const root = "C:\\Work\\repo";
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const token = "A".repeat(43);
const environment = { USERPROFILE: "C:\\Users\\tester", PATH: "C:\\Windows", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\tester\\AppData\\Roaming", SECRET_KEY: "nope" };

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const basePlan = () => ({ taskId: "T-3", provider: "claude", model: null, effort: null, repositoryRoot: root, prompt: "Do the thing", token });

/** The launcher process: exits with `outcome` as its code, emits an error, or never ends ("hang"). */
function fakeChild(outcome = 0) {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  if (outcome === "error") queueMicrotask(() => child.emit("error", new Error("x")));
  else if (outcome !== "hang") queueMicrotask(() => child.emit("exit", outcome));
  return child;
}

function harness({ plan = basePlan(), answer, spawnImpl, confirmImpl, overrides = {} } = {}) {
  const log = [];
  const calls = [];
  const spawns = [];
  const start = createTaskStart({
    isTrustedEvent: (e) => e?.trusted === true,
    monitorOrigin: origin,
    authorizationToken: "secret",
    platform: "win32",
    environment,
    fileExists: (f) => f === exe || f === powershell,
    directoryExists: (d) => d === root,
    confirm: confirmImpl || (async (info) => { log.push("confirm"); assert.deepEqual(info, { taskId: "T-3" }); return true; }),
    fetch: async (url, options) => {
      log.push(url.split("/").pop());
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url.endsWith("start-abort")) return json({ ok: true });
      if (typeof answer === "function") return answer(url, options);
      return answer || json({ ok: true, plan });
    },
    spawn: spawnImpl || ((...args) => { spawns.push(args); return fakeChild(); }),
    ...overrides,
  });
  return { start, log, calls, spawns };
}

const go = (h, id = "T-3", repo = repositoryId, event = trusted) => h.start.start(event, repo, id);
const aborted = (h) => h.calls.filter((c) => c.url.endsWith("start-abort"));

test("statuses are fixed and the channel is named", () => {
  assert.equal(TASK_START_CHANNEL, "pomegr:task-start");
  assert.ok(Object.isFrozen(TASK_START_STATUSES));
  assert.equal(TASK_START_STATUSES.length, 12);
});

test("starts with no model or effort, exact args and options", async () => {
  const h = harness();
  const out = await go(h);
  assert.deepEqual(out, { status: "started" });
  assert.equal(h.spawns.length, 1);
  const [command, args, options] = h.spawns[0];
  assert.equal(command, powershell);
  assert.deepEqual(args, [...TASK_START_LAUNCH_ARGUMENTS]);
  assert.equal(options.cwd, root);
  assert.equal(options.shell, false);
  assert.equal(options.detached, undefined);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.env, {
    ...nativeClaudeEnvironment(environment),
    POMEGR_TASK_TOKEN: token,
    POMEGR_START_FILE: exe,
    POMEGR_START_ARGUMENTS: '"Do the thing"',
    POMEGR_START_DIRECTORY: root,
  });
  assert.equal(options.env.SECRET_KEY, undefined);
  const text = JSON.stringify(out);
  for (const secret of [token, root, "Do the thing"]) assert.ok(!text.includes(secret));
  assert.deepEqual(h.calls[0].body, { repositoryId, payload: { id: "T-3" } });
  assert.equal(h.calls[0].options.redirect, "error");
  assert.equal(h.calls[0].options.cache, "no-store");
});

test("model and effort flags precede the single prompt argument", async () => {
  const h = harness({ plan: { ...basePlan(), model: "claude-opus-4-1[1m]", effort: "xhigh" } });
  assert.deepEqual(await go(h), { status: "started" });
  assert.equal(h.spawns[0][2].env.POMEGR_START_ARGUMENTS, '--model claude-opus-4-1[1m] --effort xhigh "Do the thing"');
});

test("the launch command is fixed and carries no task content", async () => {
  const prompt = "a \" & | ; $( ) \nline two `x` %PATH%";
  const h = harness({ plan: { ...basePlan(), prompt, model: "sonnet" } });
  assert.deepEqual(await go(h), { status: "started" });
  const [, args, options] = h.spawns[0];
  assert.deepEqual(args, [...TASK_START_LAUNCH_ARGUMENTS]);
  assert.ok(!args.join(" ").includes("line two"));
  assert.ok(!args.join(" ").includes(root));
  assert.equal(options.env.POMEGR_START_ARGUMENTS, `--model sonnet ${windowsArgument(prompt)}`);
});

/** The Windows C runtime rule for a command-line tail, as the started executable applies it. */
function parseWindowsArguments(line) {
  const out = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === " " || line[index] === "\t") index += 1;
    if (index >= line.length) break;
    let current = "";
    let quoted = false;
    for (; index < line.length; index += 1) {
      const character = line[index];
      if (character === "\\") {
        let slashes = 0;
        while (line[index] === "\\") { slashes += 1; index += 1; }
        if (line[index] === "\"") {
          current += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) current += "\""; else quoted = !quoted;
        } else { current += "\\".repeat(slashes); index -= 1; }
      } else if (character === "\"") quoted = !quoted;
      else if (!quoted && (character === " " || character === "\t")) break;
      else current += character;
    }
    out.push(current);
  }
  return out;
}

test("quoted arguments survive the Windows command-line rules unchanged", () => {
  const samples = [
    "plain", "", "two words", "a \"quoted\" word", "ends with a backslash\\", "path\\with\\slashes", "slashes before a quote \\\\\" end",
    "a & b | c ; $(x) %PATH% ^ `n 'q' -- --model evil", "tab\there", "line one\nline two\r\nline three", "trailing quote\"", "\\\\",
  ];
  for (const sample of samples) assert.deepEqual(parseWindowsArguments(windowsArgument(sample)), [sample]);
  assert.deepEqual(parseWindowsArguments(samples.map(windowsArgument).join(" ")), samples);
});

test("a launcher that never ends is stopped and the start fails", async () => {
  let child;
  const h = harness({ spawnImpl: () => (child = fakeChild("hang")), overrides: { launchTimeoutMs: 5 } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.equal(child.killed, true);
  assert.equal(aborted(h).length, 1);
});

test("a missing PowerShell answers unavailable before the confirmation", async () => {
  const h = harness({ overrides: { fileExists: (f) => f === exe } });
  assert.deepEqual(await go(h), { status: "unavailable" });
  assert.deepEqual(h.log, []);
});

test("confirmation precedes the plan request", async () => {
  const h = harness();
  await go(h);
  assert.deepEqual(h.log, ["confirm", "start-plan"]);
});

test("refusals before any work", async () => {
  let h = harness();
  assert.deepEqual(await go(h, "T-3", repositoryId, {}), { status: "invalid" });
  assert.deepEqual(await go(h, "T-3", "repo-bad"), { status: "invalid" });
  for (const id of ["T-0", "T-03", "t-1", "T-1234567890", "x", 3]) assert.deepEqual(await go(h, id), { status: "invalid" });
  assert.deepEqual(h.log, []);

  h = harness({ overrides: { platform: "linux" } });
  assert.deepEqual(await go(h), { status: "unsupported_platform" });
  assert.deepEqual(h.log, []);
  assert.equal(h.spawns.length, 0);

  h = harness({ overrides: { fileExists: () => false } });
  assert.deepEqual(await go(h), { status: "cli_missing" });
  assert.deepEqual(h.log, []);

  h = harness({ overrides: { authorizationToken: "" } });
  assert.deepEqual(await go(h), { status: "unavailable" });

  h = harness({ confirmImpl: async () => false });
  assert.deepEqual(await go(h), { status: "cancelled" });
  assert.deepEqual(h.log, []);
  h = harness({ confirmImpl: async () => "yes" });
  assert.deepEqual(await go(h), { status: "cancelled" });
});

test("monitor errors map to same-named statuses", async () => {
  for (const error of ["invalid", "not_found", "not_startable", "unsupported_provider", "plugin_missing", "unavailable"]) {
    const h = harness({ answer: json({ ok: false, error }) });
    assert.deepEqual(await go(h), { status: error });
    assert.equal(h.spawns.length, 0);
  }
  for (const answer of [json({ ok: false, error: "weird" }), json({ nope: 1 }), new Response("not json")]) {
    assert.deepEqual(await go(harness({ answer })), { status: "unavailable" });
  }
  const down = harness({ answer: () => { throw new Error("down"); } });
  assert.deepEqual(await go(down), { status: "unavailable" });
});

test("malformed plans fail, spawn nothing and abort with the token", async () => {
  const bad = [
    { provider: "codex" }, { taskId: "T-4" }, { repositoryRoot: "relative\\dir" }, { repositoryRoot: "C:\\Work\\..\\repo" },
    { repositoryRoot: "C:\\Work\\missing" }, { repositoryRoot: "C:\\Work\\\"x" },
    { model: "bad model" }, { model: "a/b" }, { effort: "max" }, { prompt: "-rf" }, { prompt: "" }, { prompt: "a\u0000b" },
    { prompt: "x".repeat(8001) },
  ];
  for (const change of bad) {
    const h = harness({ plan: { ...basePlan(), ...change } });
    assert.deepEqual(await go(h), { status: "failed" }, JSON.stringify(change));
    assert.equal(h.spawns.length, 0);
    const [abort] = aborted(h);
    assert.ok(abort, JSON.stringify(change));
    assert.deepEqual(abort.body, { repositoryId, payload: { id: "T-3", token } });
  }
});

test("spawn failures abort and report failed", async () => {
  let h = harness({ spawnImpl: () => { throw new Error("EPERM"); } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.equal(aborted(h).length, 1);
  h = harness({ spawnImpl: () => fakeChild(1) });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.equal(aborted(h).length, 1);
  h = harness({ spawnImpl: () => fakeChild("error") });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.deepEqual(aborted(h)[0].body.payload, { id: "T-3", token });
});

test("a failing abort never changes the status", async () => {
  const plan = { ...basePlan(), provider: "codex" };
  const h = harness({ plan, answer: (url) => {
    if (url.endsWith("start-abort")) throw new Error("down");
    return json({ ok: true, plan });
  } });
  assert.deepEqual(await go(h), { status: "failed" });
});

test("a concurrent second start answers busy", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ confirmImpl: async () => { await gate; return true; } });
  const first = go(h);
  assert.deepEqual(await go(h), { status: "busy" });
  release();
  assert.deepEqual(await first, { status: "started" });
  assert.deepEqual(await go(h), { status: "started" });
});

test("the installer replaces the handler, removes it and never throws", async () => {
  const handlers = new Map();
  const removed = [];
  const ipcMain = {
    handle: (c, f) => handlers.set(c, f),
    removeHandler: (c) => { removed.push(c); handlers.delete(c); },
  };
  const remove = installTaskStartIpc({ ipcMain, isTrustedEvent: () => true, monitorOrigin: origin, authorizationToken: "s", platform: "win32", fileExists: () => false, environment });
  assert.deepEqual(removed, [TASK_START_CHANNEL]);
  assert.deepEqual(await handlers.get(TASK_START_CHANNEL)({}, repositoryId, "T-3"), { status: "cli_missing" });
  remove();
  assert.equal(handlers.has(TASK_START_CHANNEL), false);
  installTaskStartIpc({ ipcMain, starter: { start: async () => { throw new Error("boom"); } } });
  assert.deepEqual(await handlers.get(TASK_START_CHANNEL)({}, repositoryId, "T-3"), { status: "failed" });
  assert.throws(() => installTaskStartIpc({}), TypeError);
});
