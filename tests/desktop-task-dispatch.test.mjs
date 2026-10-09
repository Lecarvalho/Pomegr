import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { nativeClaudeEnvironment, nativeCodexEnvironment } from "../desktop/runtime/environment-policy.mjs";
import {
  createTaskStart,
  installTaskStartIpc,
  TASK_START_CHANNEL,
  TASK_START_LAUNCH_ARGUMENTS,
  TASK_START_STATUSES,
  TASK_WORKTREE_OPEN_CHANNEL,
  TASK_WORKTREE_OPEN_STATUSES,
  windowsArgument,
} from "../desktop/runtime/task-dispatch.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const exe = "C:\\Users\\tester\\.local\\bin\\claude.exe";
const codexExe = "C:\\Users\\tester\\.local\\bin\\codex.exe";
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
  assert.equal(TASK_START_STATUSES.length, 14);
  assert.ok(TASK_START_STATUSES.includes("worktree_dirty"));
  assert.ok(TASK_START_STATUSES.includes("gate_held"));
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
    { provider: "gemini" }, { provider: "__proto__" }, { taskId: "T-4" }, { repositoryRoot: "relative\\dir" }, { repositoryRoot: "C:\\Work\\..\\repo" },
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
  const plan = { ...basePlan(), provider: "gemini" };
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
  assert.deepEqual(removed, [TASK_START_CHANNEL, TASK_WORKTREE_OPEN_CHANNEL]);
  assert.deepEqual(await handlers.get(TASK_START_CHANNEL)({}, repositoryId, "T-3"), { status: "cli_missing" });
  remove();
  assert.equal(handlers.has(TASK_START_CHANNEL), false);
  installTaskStartIpc({ ipcMain, starter: { start: async () => { throw new Error("boom"); } } });
  assert.deepEqual(await handlers.get(TASK_START_CHANNEL)({}, repositoryId, "T-3"), { status: "failed" });
  assert.throws(() => installTaskStartIpc({}), TypeError);
});

const codexFiles = (f) => f === codexExe || f === powershell;

test("a Codex plan starts the Codex CLI with its own environment and the task token", async () => {
  const h = harness({ plan: { ...basePlan(), provider: "codex" }, overrides: { fileExists: (f) => f === exe || codexFiles(f) } });
  assert.deepEqual(await go(h), { status: "started" });
  const [command, args, options] = h.spawns[0];
  assert.equal(command, powershell);
  assert.deepEqual(args, [...TASK_START_LAUNCH_ARGUMENTS]);
  assert.equal(options.shell, false);
  assert.deepEqual(options.env, {
    ...nativeCodexEnvironment(environment),
    POMEGR_TASK_TOKEN: token,
    POMEGR_START_FILE: codexExe,
    POMEGR_START_ARGUMENTS: '"Do the thing"',
    POMEGR_START_DIRECTORY: root,
  });
  assert.equal(options.env.SECRET_KEY, undefined);
});

test("Codex model and effort flags are passed only when set, xhigh by name", async () => {
  const start = (plan) => harness({ plan: { ...basePlan(), provider: "codex", ...plan }, overrides: { fileExists: codexFiles } });
  let h = start({ model: "gpt-6-sol", effort: "xhigh" });
  assert.deepEqual(await go(h), { status: "started" });
  assert.equal(h.spawns[0][2].env.POMEGR_START_ARGUMENTS, '--model gpt-6-sol -c model_reasoning_effort=xhigh "Do the thing"');
  h = start({ effort: "low" });
  assert.deepEqual(await go(h), { status: "started" });
  assert.equal(h.spawns[0][2].env.POMEGR_START_ARGUMENTS, '-c model_reasoning_effort=low "Do the thing"');
  h = start({ model: "gpt-6-sol" });
  assert.deepEqual(await go(h), { status: "started" });
  assert.equal(h.spawns[0][2].env.POMEGR_START_ARGUMENTS, '--model gpt-6-sol "Do the thing"');
});

test("a plan whose provider CLI is missing aborts the dispatch and answers cli_missing", async () => {
  for (const [provider, fileExists] of [["codex", (f) => f === exe || f === powershell], ["claude", codexFiles]]) {
    const h = harness({ plan: { ...basePlan(), provider }, overrides: { fileExists } });
    assert.deepEqual(await go(h), { status: "cli_missing" }, provider);
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(aborted(h)[0].body, { repositoryId, payload: { id: "T-3", token } });
  }
});

test("with no provider CLI installed nothing is confirmed or planned", async () => {
  const h = harness({ overrides: { fileExists: (f) => f === powershell } });
  assert.deepEqual(await go(h), { status: "cli_missing" });
  assert.deepEqual(h.log, []);
});

const queued = (h, id = "T-3", repo = repositoryId) => h.start.startQueued(repo, id);

test("a queued start asks no confirmation and needs no renderer event", async () => {
  const h = harness({ confirmImpl: async () => { h.log.push("confirm"); return false; } });
  assert.deepEqual(await queued(h), { status: "started" });
  assert.deepEqual(h.log, ["start-plan"]);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0][2].env.POMEGR_TASK_TOKEN, token);
  assert.deepEqual(h.calls[0].body, { repositoryId, payload: { id: "T-3" } });
  assert.equal(h.calls[0].options.redirect, "error");
  const text = JSON.stringify(await queued(h));
  for (const secret of [token, root, "Do the thing"]) assert.ok(!text.includes(secret));
});

test("a queued start keeps every refusal of a manual start", async () => {
  let h = harness();
  for (const [repo, id] of [["repo-bad", "T-3"], [repositoryId, "T-0"], [repositoryId, "x"], [repositoryId, 3], [3, "T-3"]]) {
    assert.deepEqual(await queued(h, id, repo), { status: "invalid" });
  }
  assert.deepEqual(h.log, []);

  h = harness({ overrides: { platform: "linux" } });
  assert.deepEqual(await queued(h), { status: "unsupported_platform" });
  h = harness({ overrides: { fileExists: () => false } });
  assert.deepEqual(await queued(h), { status: "cli_missing" });
  h = harness({ overrides: { fileExists: (f) => f === exe } });
  assert.deepEqual(await queued(h), { status: "unavailable" });
  h = harness({ overrides: { authorizationToken: "" } });
  assert.deepEqual(await queued(h), { status: "unavailable" });
  for (const error of ["not_startable", "plugin_missing", "not_found", "unsupported_provider"]) {
    h = harness({ answer: json({ ok: false, error }) });
    assert.deepEqual(await queued(h), { status: error });
    assert.equal(h.spawns.length, 0);
  }
  h = harness({ plan: { ...basePlan(), provider: "codex" }, overrides: { fileExists: (f) => f === exe || f === powershell } });
  assert.deepEqual(await queued(h), { status: "cli_missing" });
  assert.deepEqual(aborted(h)[0].body, { repositoryId, payload: { id: "T-3", token } });
});

test("a queued start aborts on a malformed plan or a failed launch", async () => {
  let h = harness({ plan: { ...basePlan(), repositoryRoot: "relative\dir" } });
  assert.deepEqual(await queued(h), { status: "failed" });
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(aborted(h)[0].body, { repositoryId, payload: { id: "T-3", token } });
  for (const spawnImpl of [() => { throw new Error("EPERM"); }, () => fakeChild(1), () => fakeChild("error")]) {
    h = harness({ spawnImpl });
    assert.deepEqual(await queued(h), { status: "failed" });
    assert.deepEqual(aborted(h).map((c) => c.body), [{ repositoryId, payload: { id: "T-3", token } }]);
  }
});

test("a manual and a queued start share one slot and answer busy to each other", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let h = harness({ confirmImpl: async () => { await gate; return true; } });
  const manual = go(h);
  assert.deepEqual(await queued(h), { status: "busy" });
  assert.deepEqual(await go(h, "T-3", repositoryId, {}), { status: "invalid" });
  release();
  assert.deepEqual(await manual, { status: "started" });
  assert.deepEqual(await queued(h), { status: "started" });

  let releasePlan;
  const planGate = new Promise((resolve) => { releasePlan = resolve; });
  h = harness({ answer: async () => { await planGate; return json({ ok: true, plan: basePlan() }); } });
  const first = queued(h);
  assert.deepEqual(await go(h), { status: "busy" });
  assert.deepEqual(await queued(h), { status: "busy" });
  releasePlan();
  assert.deepEqual(await first, { status: "started" });
  assert.deepEqual(await go(h), { status: "started" });
});

test("a disposed starter refuses a queued start", async () => {
  const h = harness();
  h.start.dispose();
  assert.deepEqual(await queued(h), { status: "unavailable" });
  assert.deepEqual(h.calls, []);
});

test("the installer starts the queue runner and disposes it with the handler", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  const order = [];
  const starter = { start: async () => ({ status: "started" }), dispose: () => order.push("starter.dispose") };
  const queueRunner = { start: () => order.push("runner.start"), dispose: () => order.push("runner.dispose") };
  const remove = installTaskStartIpc({ ipcMain, starter, queueRunner });
  assert.deepEqual(order, ["runner.start"]);
  remove();
  assert.deepEqual(order, ["runner.start", "runner.dispose", "starter.dispose"]);

  order.length = 0;
  installTaskStartIpc({ ipcMain, starter, queueRunner: false })();
  assert.deepEqual(order, ["starter.dispose"]);
});

test("the default runner is wired to the starter and does no network before its first interval", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  const requests = [];
  const remove = installTaskStartIpc({
    ipcMain, isTrustedEvent: () => true, monitorOrigin: origin, authorizationToken: "s", platform: "win32", environment,
    fileExists: () => false,
    fetch: async (url) => { requests.push(url); return json({ ok: false }); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, []);
  remove();
  assert.equal(handlers.has(TASK_START_CHANNEL), false);
  assert.deepEqual(requests, []);
});

const worktreeDirectory = "C:\\Data\\task-worktrees\\repo-0123456789abcdef01234567\\T-3";

/** Fake worktrees: `ensure` answers `made`, every call is recorded. */
function fakeWorktrees(made = { ok: true, directory: worktreeDirectory, created: true, branchCreated: true }) {
  const calls = [];
  return {
    calls,
    ensure: async (request) => { calls.push(["ensure", request]); if (made instanceof Error) throw made; return made; },
    remove: async (request) => { calls.push(["remove", request]); return "removed"; },
  };
}

test("a plan that asks for a worktree starts the session in the task's worktree", async () => {
  const worktrees = fakeWorktrees();
  const h = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees } });
  assert.deepEqual(await go(h), { status: "started" });
  assert.deepEqual(worktrees.calls, [["ensure", { repositoryRoot: root, repositoryId, taskId: "T-3" }]]);
  const [, , options] = h.spawns[0];
  assert.equal(options.cwd, worktreeDirectory);
  assert.equal(options.env.POMEGR_START_DIRECTORY, worktreeDirectory);
  assert.equal(options.shell, false);
  assert.equal(aborted(h).length, 0);
});

test("a plan without a worktree keeps the repository root and makes none", async () => {
  for (const plan of [basePlan(), { ...basePlan(), worktree: false }]) {
    const worktrees = fakeWorktrees();
    const h = harness({ plan, overrides: { worktrees } });
    assert.deepEqual(await go(h), { status: "started" });
    assert.equal(h.spawns[0][2].cwd, root);
    assert.deepEqual(worktrees.calls, []);
  }
});

test("a worktree that cannot be made fails the start, aborts the dispatch and spawns nothing", async () => {
  const outcomes = [
    { ok: false }, null, new Error("git"), { ok: true, directory: "relative" }, { ok: true, directory: `${worktreeDirectory}"` }, { ok: true },
  ];
  for (const made of outcomes) {
    const worktrees = fakeWorktrees(made);
    const h = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees } });
    assert.deepEqual(await go(h), { status: "failed" });
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(aborted(h).map((c) => c.body), [{ repositoryId, payload: { id: "T-3", token } }]);
    assert.equal(worktrees.calls.some(([name]) => name === "remove"), false);
  }
  // No worktree root configured: a worktree plan cannot start, and never falls back to the repository root.
  const h = harness({ plan: { ...basePlan(), worktree: true } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.equal(h.spawns.length, 0);
});

test("a worktree made for a start that fails is removed again; a reused one is left alone", async () => {
  let worktrees = fakeWorktrees();
  let h = harness({ plan: { ...basePlan(), worktree: true }, spawnImpl: () => fakeChild(1), overrides: { worktrees } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.deepEqual(worktrees.calls[1], ["remove", { repositoryRoot: root, repositoryId, taskId: "T-3", deleteBranch: true }]);
  worktrees = fakeWorktrees({ ok: true, directory: worktreeDirectory, created: true, branchCreated: false });
  h = harness({ plan: { ...basePlan(), worktree: true }, spawnImpl: () => fakeChild(1), overrides: { worktrees } });
  await go(h);
  assert.equal(worktrees.calls[1][1].deleteBranch, false);
  worktrees = fakeWorktrees({ ok: true, directory: worktreeDirectory, created: false, branchCreated: false });
  h = harness({ plan: { ...basePlan(), worktree: true }, spawnImpl: () => fakeChild(1), overrides: { worktrees } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.deepEqual(worktrees.calls.map(([name]) => name), ["ensure"]);
});

test("a plan whose worktree field is not a boolean is malformed", async () => {
  const worktrees = fakeWorktrees();
  const h = harness({ plan: { ...basePlan(), worktree: "yes" }, overrides: { worktrees } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(worktrees.calls, []);
});

test("a dirty reused worktree answers worktree_dirty, aborts the dispatch and spawns nothing; other failures stay failed", async () => {
  const worktrees = fakeWorktrees({ ok: false, reason: "dirty" });
  const h = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees } });
  assert.deepEqual(await go(h), { status: "worktree_dirty" });
  assert.equal(h.spawns.length, 0);
  assert.equal(aborted(h).length, 1);
  for (const made of [{ ok: false }, { ok: false, reason: "other" }]) {
    const other = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees: fakeWorktrees(made) } });
    assert.deepEqual(await go(other), { status: "failed" });
  }
});

/** The open channel: a fake worktrees with `locate`, an injected `openPath` and the same trust check as the start. */
function openHarness({ located = worktreeDirectory, openPath, platform = "win32", withWorktrees = true } = {}) {
  const opened = [];
  const locates = [];
  const worktrees = withWorktrees ? { locate: async (request) => { locates.push(request); if (located instanceof Error) throw located; return located; } } : null;
  const starter = createTaskStart({
    isTrustedEvent: (e) => e?.trusted === true,
    platform,
    worktrees,
    openPath: openPath || (async (directory) => { opened.push(directory); return ""; }),
  });
  return { starter, opened, locates };
}
const open = (h, repo = repositoryId, id = "T-3", event = trusted) => h.starter.openWorktree(event, repo, id);

test("the open channel is fixed and answers one of four statuses", async () => {
  assert.equal(TASK_WORKTREE_OPEN_CHANNEL, "pomegr:task-worktree-open");
  assert.deepEqual([...TASK_WORKTREE_OPEN_STATUSES], ["opened", "not_found", "invalid", "unavailable"]);
  assert.ok(Object.isFrozen(TASK_WORKTREE_OPEN_STATUSES));
  const h = openHarness();
  assert.deepEqual(await open(h), { status: "opened" });
  assert.deepEqual(h.opened, [worktreeDirectory]);
  assert.deepEqual(h.locates, [{ repositoryId, taskId: "T-3" }]);
});

test("the open channel refuses an untrusted frame and bad IDs without locating anything", async () => {
  const h = openHarness();
  assert.deepEqual(await open(h, repositoryId, "T-3", { trusted: false }), { status: "invalid" });
  assert.deepEqual(await open(h, repositoryId, "T-3", null), { status: "invalid" });
  for (const [repo, id] of [["repo-x", "T-3"], [7, "T-3"], [repositoryId, "T-0"], [repositoryId, "../T-3"], [repositoryId, 3], [null, null]]) {
    assert.deepEqual(await open(h, repo, id), { status: "invalid" });
  }
  assert.deepEqual(h.locates, []);
  assert.deepEqual(h.opened, []);
});

test("an unlisted or missing worktree is not_found and opens nothing", async () => {
  for (const located of [null, "relative\\dir", new Error("git")]) {
    const h = openHarness({ located });
    assert.deepEqual(await open(h), { status: "not_found" });
    assert.deepEqual(h.opened, []);
  }
});

test("no worktree root, a non-Windows platform, or an openPath failure is unavailable, with no path in any answer", async () => {
  const cases = [
    openHarness({ withWorktrees: false }),
    openHarness({ platform: "linux" }),
    openHarness({ openPath: async () => `${worktreeDirectory}: access denied` }),
    openHarness({ openPath: async () => { throw new Error(worktreeDirectory); } }),
  ];
  for (const h of cases) {
    const answer = await open(h);
    assert.deepEqual(answer, { status: "unavailable" });
    assert.equal(JSON.stringify(answer).includes("Data"), false);
  }
  const noOpener = createTaskStart({ isTrustedEvent: () => true, platform: "win32", worktrees: { locate: async () => worktreeDirectory } });
  assert.deepEqual(await noOpener.openWorktree({}, repositoryId, "T-3"), { status: "unavailable" });
});

test("the open channel is installed and removed with the start channel", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  const h = openHarness();
  const remove = installTaskStartIpc({ ipcMain, starter: { start: async () => ({ status: "started" }), openWorktree: h.starter.openWorktree }, queueRunner: false });
  assert.ok(handlers.has(TASK_WORKTREE_OPEN_CHANNEL));
  assert.deepEqual(await handlers.get(TASK_WORKTREE_OPEN_CHANNEL)(trusted, repositoryId, "T-3"), { status: "opened" });
  assert.deepEqual(await handlers.get(TASK_WORKTREE_OPEN_CHANNEL)({ trusted: false }, repositoryId, "T-3"), { status: "invalid" });
  const thrower = new Map();
  installTaskStartIpc({ ipcMain: { handle: (c, f) => thrower.set(c, f), removeHandler() {} }, starter: { openWorktree: async () => { throw new Error("secret"); } }, queueRunner: false });
  assert.deepEqual(await thrower.get(TASK_WORKTREE_OPEN_CHANNEL)(trusted, repositoryId, "T-3"), { status: "unavailable" });
  remove();
  assert.equal(handlers.has(TASK_WORKTREE_OPEN_CHANNEL), false);
  assert.equal(handlers.has(TASK_START_CHANNEL), false);
});
