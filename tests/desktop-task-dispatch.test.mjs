import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaskStart,
  confirmTaskStart,
  installTaskStartIpc,
  TASK_START_CHANNEL,
  TASK_START_STATUSES,
  TASK_WORKTREE_OPEN_CHANNEL,
  TASK_WORKTREE_OPEN_STATUSES,
  taskStartConfirmation,
} from "../desktop/runtime/task-dispatch.mjs";
import { userSessionEnvironment } from "../desktop/runtime/environment-policy.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const trusted = { trusted: true };
const origin = "http://127.0.0.1:4317";
const exe = "C:\\Users\\tester\\.local\\bin\\claude.exe";
const codexExe = "C:\\Users\\tester\\.local\\bin\\codex.exe";
const root = "C:\\Work\\repo";
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const token = "A".repeat(43);
// The session gets the user's environment as inherited; only this app's own runtime variables are left out.
const sessionEnvironment = { USERPROFILE: "C:\\Users\\tester", PATH: "C:\\Windows;C:\\Program Files\\nodejs", SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\tester\\AppData\\Roaming", "ProgramFiles(x86)": "C:\\Program Files (x86)", HTTPS_PROXY: "http://proxy.test:8080", NODE_EXTRA_CA_CERTS: "C:\\certs\\owner.pem", GIT_SSH_COMMAND: "ssh", ANTHROPIC_API_KEY: "synthetic-key", NODE_ENV: "development" };
const environment = { ...sessionEnvironment, ELECTRON_RUN_AS_NODE: "1", POMEGR_MONITOR_TOKEN: "app-private", POMEGR_MONITOR_ORIGIN: origin, POMEGR_SMOKE_NO_SYSTEM_NODE: "1", POMEGR_START_EXECUTABLE: "old-start", pomegr_start_args: "old-args", POMEGR_TASK_TOKEN: "stale" };

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const basePlan = () => ({ taskId: "T-3", provider: "claude", model: null, effort: null, repositoryRoot: root, prompt: "Do the thing", token });

function harness({ plan = basePlan(), answer, createImpl, confirmImpl, overrides = {} } = {}) {
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
    confirm: confirmImpl || (async (info) => { log.push("confirm"); assert.deepEqual(info, { taskId: "T-3", separateWorktree: false }); return true; }),
    fetch: async (url, options) => {
      log.push(url.split("/").pop());
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url.endsWith("start-abort")) return json({ ok: true });
      if (typeof answer === "function") return answer(url, options);
      return answer || json({ ok: true, plan });
    },
    terminal: { ensureHost: async () => {}, create: createImpl || (async ({ executable, args, cwd, env }) => { spawns.push([executable, args, { cwd, env }]); }) },
    ...overrides,
  });
  return { start, log, calls, spawns };
}

const go = (h, id = "T-3", repo = repositoryId, event = trusted) => h.start.start(event, repo, id);
const aborted = (h) => h.calls.filter((c) => c.url.endsWith("start-abort"));

test("only granted builder starts post grant authority to start-plan", async () => {
  for (const mode of ["granted", "queued", "manual", "paired"]) {
    const h = harness();
    const result = mode === "granted" ? await h.start.startGranted(repositoryId, "T-3", async () => true)
      : mode === "queued" ? await h.start.startQueued(repositoryId, "T-3")
        : mode === "paired" ? await h.start.startPaired(repositoryId, "T-3", undefined, async () => true) : await go(h);
    assert.deepEqual(result, { status: "started" });
    assert.deepEqual(h.calls[0].body, { repositoryId, payload: { id: "T-3", ...(mode === "granted" ? { grant: true } : {}) } });
  }
});

test("granted builder starts never confirm and recheck authority at all four boundaries", async () => {
  for (let revokedAt = 1; revokedAt <= 5; revokedAt++) {
    const order = [];
    const h = harness({ confirmImpl: () => assert.fail("a grant already confirms"), overrides: {
      confirmReview: () => assert.fail("no review confirmation"),
      fetch: async (url) => { order.push(url.split("/").pop()); return json({ ok: true, plan: basePlan() }); },
      terminal: { ensureHost: async () => order.push("host"), create: async () => order.push("create") },
    } });
    let checks = 0;
    const answer = await h.start.startGranted(repositoryId, "T-3", async () => { order.push("check"); return ++checks !== revokedAt; });
    assert.deepEqual(answer, { status: revokedAt === 5 ? "started" : "cancelled" });
    const success = ["check", "start-plan", "check", "check", "host", "check", "create"];
    const index = success.map((value, i) => value === "check" ? i : -1).filter((i) => i >= 0)[revokedAt - 1];
    assert.deepEqual(order, revokedAt === 5 ? success : [...success.slice(0, index + 1), ...(revokedAt > 1 ? ["start-abort"] : [])]);
  }
});

test("granted starts require an authorization callback and fail closed if it throws", async () => {
  const h = harness();
  assert.deepEqual(await h.start.startGranted(repositoryId, "T-3"), { status: "invalid" });
  assert.deepEqual(await h.start.startGranted(repositoryId, "T-3", async () => { throw Error("offline"); }), { status: "cancelled" });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.spawns, []);
});

test("queued and granted starts for a sent-back task reuse its existing worktree", async () => {
  for (const mode of ["queued", "granted"]) {
    const worktrees = fakeWorktrees();
    worktrees.locate = async (request) => { worktrees.calls.push(["locate", request]); return "C:\\Data\\legacy-task-worktree"; };
    const h = harness({ plan: { ...basePlan(), sendBack: true }, overrides: { worktrees } });
    const result = mode === "queued"
      ? await h.start.startQueued(repositoryId, "T-3")
      : await h.start.startGranted(repositoryId, "T-3", async () => true);
    assert.deepEqual(result, { status: "started" });
    assert.deepEqual(worktrees.calls, [["locate", { repositoryRoot: root, repositoryId, taskId: "T-3" }]]);
    assert.equal(h.spawns[0][2].cwd, "C:\\Data\\legacy-task-worktree");
  }
});

test("ordinary queued and granted plans do not look up or change their worktree", async () => {
  for (const mode of ["queued", "granted"]) for (const plan of [basePlan(), { ...basePlan(), sendBack: false }]) {
    const worktrees = fakeWorktrees();
    const h = harness({ plan, overrides: { worktrees } });
    const result = mode === "queued"
      ? await h.start.startQueued(repositoryId, "T-3")
      : await h.start.startGranted(repositoryId, "T-3", async () => true);
    assert.deepEqual(result, { status: "started" });
    assert.equal(h.spawns[0][2].cwd, root);
    assert.deepEqual(worktrees.calls, []);
  }
});

test("a broken or malformed sent-back worktree lookup refuses without creating a worktree", async () => {
  for (const located of [new Error("lookup failed"), "relative-path"]) {
    const worktrees = fakeWorktrees();
    worktrees.locate = async (request) => { worktrees.calls.push(["locate", request]); if (located instanceof Error) throw located; return located; };
    const h = harness({ plan: { ...basePlan(), sendBack: true }, overrides: { worktrees } });
    assert.deepEqual(await h.start.startQueued(repositoryId, "T-3"), { status: "failed" });
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(worktrees.calls.map(([name]) => name), ["locate"]);
  }
});

test("statuses are fixed and the channel is named", () => {
  assert.equal(TASK_START_CHANNEL, "pomegr:task-start");
  assert.ok(Object.isFrozen(TASK_START_STATUSES));
  assert.equal(TASK_START_STATUSES.length, 15);
  assert.ok(TASK_START_STATUSES.includes("tree_dirty"));
  assert.ok(TASK_START_STATUSES.includes("worktree_dirty"));
  assert.ok(TASK_START_STATUSES.includes("gate_held"));
});

test("starts with no model or effort, exact args and options", async () => {
  const h = harness();
  const out = await go(h);
  assert.deepEqual(out, { status: "started" });
  assert.equal(h.spawns.length, 1);
  const [command, args, options] = h.spawns[0];
  assert.equal(command, exe);
  assert.deepEqual(args, ["Do the thing"]);
  assert.equal(options.cwd, root);
  assert.deepEqual(options.env, { ...sessionEnvironment, POMEGR_TASK_TOKEN: token });
  for (const name of ["ELECTRON_RUN_AS_NODE", "POMEGR_MONITOR_TOKEN", "POMEGR_MONITOR_ORIGIN", "POMEGR_SMOKE_NO_SYSTEM_NODE", "POMEGR_START_EXECUTABLE", "pomegr_start_args"]) assert.equal(options.env[name], undefined, name);
  assert.equal(options.env.PATH.includes("nodejs"), true, "the user's Node stays on the session's PATH");
  const text = JSON.stringify(out);
  for (const secret of [token, root, "Do the thing"]) assert.ok(!text.includes(secret));
  assert.deepEqual(h.calls[0].body, { repositoryId, payload: { id: "T-3" } });
  assert.equal(h.calls[0].options.redirect, "error");
  assert.equal(h.calls[0].options.cache, "no-store");
});

test("a session never inherits the marks of a provider session the app was launched from", () => {
  const nested = { CLAUDECODE: "1", CLAUDE_PID: "1", CLAUDE_EFFORT: "high", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_EXECPATH: "x", CLAUDE_CODE_MESSAGING_SOCKET: "pipe", claude_code_messaging_token: "secret", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_SSE_PORT: "1", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: "1", CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1", CODEX_THREAD_ID: "t" };
  const owner = { CLAUDE_CONFIG_DIR: "C:\claude", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000", CODEX_HOME: "C:\codex" };
  assert.deepEqual(userSessionEnvironment({ ...sessionEnvironment, ...nested, ...owner }), { ...sessionEnvironment, ...owner });
});

test("model and effort flags precede the single prompt argument", async () => {
  const h = harness({ plan: { ...basePlan(), model: "claude-opus-4-1[1m]", effort: "xhigh" } });
  assert.deepEqual(await go(h), { status: "started" });
  assert.deepEqual(h.spawns[0][1], ["--model", "claude-opus-4-1[1m]", "--effort", "xhigh", "Do the thing"]);
});

test("the validated prompt is one argument and never interpreted by a shell", async () => {
  const prompt = "a & b | c ; $( ) \nline two";
  const h = harness({ plan: { ...basePlan(), prompt, model: "sonnet" } });
  assert.deepEqual(await go(h), { status: "started" });
  assert.equal(h.spawns[0][0], exe);
  assert.deepEqual(h.spawns[0][1], ["--model", "sonnet", prompt]);
});

test("an ambiguous create failure aborts once and never retries", async () => {
  let attempts = 0;
  const h = harness({ createImpl: async () => { attempts++; throw new Error("TERMINAL_UNAVAILABLE"); } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.equal(attempts, 1);
  assert.equal(aborted(h).length, 1);
});

test("the embedded start needs no PowerShell executable", async () => {
  const h = harness({ overrides: { fileExists: (f) => f === exe } });
  assert.deepEqual(await go(h), { status: "started" });
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
    { sendBack: "yes" }, { sendBack: 1 },
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
  let h = harness({ createImpl: () => { throw new Error("EPERM"); } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.equal(aborted(h).length, 1);
  h = harness({ createImpl: async () => { throw new Error("TERMINAL_SPAWN_FAILED"); } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.equal(aborted(h).length, 1);
  h = harness({ createImpl: async () => { throw new Error("TERMINAL_UNAVAILABLE"); } });
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
  assert.deepEqual(removed, [TASK_START_CHANNEL, "pomegr:task-review-start", TASK_WORKTREE_OPEN_CHANNEL, "pomegr:terminal"]);
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
  assert.equal(command, codexExe);
  // Inline mode keeps Codex's transcript in the terminal panel's scrollback.
  assert.deepEqual(args, ["--no-alt-screen", "Do the thing"]);
  assert.deepEqual(options.env, { ...sessionEnvironment, POMEGR_TASK_TOKEN: token });
  for (const name of ["ELECTRON_RUN_AS_NODE", "POMEGR_MONITOR_TOKEN", "POMEGR_MONITOR_ORIGIN", "POMEGR_SMOKE_NO_SYSTEM_NODE", "POMEGR_START_EXECUTABLE", "pomegr_start_args"]) assert.equal(options.env[name], undefined, name);
  assert.equal(options.env.PATH.includes("nodejs"), true, "the user's Node stays on the session's PATH");
});

test("Codex model and effort flags are passed only when set, xhigh by name", async () => {
  const start = (plan) => harness({ plan: { ...basePlan(), provider: "codex", ...plan }, overrides: { fileExists: codexFiles } });
  let h = start({ model: "gpt-6-sol", effort: "xhigh" });
  assert.deepEqual(await go(h), { status: "started" });
  assert.deepEqual(h.spawns[0][1], ["--no-alt-screen", "--model", "gpt-6-sol", "-c", "model_reasoning_effort=xhigh", "Do the thing"]);
  h = start({ effort: "low" });
  assert.deepEqual(await go(h), { status: "started" });
  assert.deepEqual(h.spawns[0][1], ["--no-alt-screen", "-c", "model_reasoning_effort=low", "Do the thing"]);
  h = start({ model: "gpt-6-sol" });
  assert.deepEqual(await go(h), { status: "started" });
  assert.deepEqual(h.spawns[0][1], ["--no-alt-screen", "--model", "gpt-6-sol", "Do the thing"]);
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
  h = harness({ overrides: { terminal: { ensureHost: async () => { throw new Error("TERMINAL_UNAVAILABLE"); } } } });
  assert.deepEqual(await queued(h), { status: "failed" });
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
  for (const createImpl of [() => { throw new Error("EPERM"); }, async () => { throw new Error("TERMINAL_SPAWN_FAILED"); }, async () => { throw new Error("TERMINAL_UNAVAILABLE"); }]) {
    h = harness({ createImpl });
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
    locate: async (request) => { calls.push(["locate", request]); return null; },
  };
}

test("a plan that asks for a worktree starts the session in the task's worktree", async () => {
  const worktrees = fakeWorktrees();
  const h = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees } });
  assert.deepEqual(await go(h), { status: "started" });
  assert.deepEqual(worktrees.calls, [["ensure", { repositoryRoot: root, repositoryId, taskId: "T-3" }]]);
  const [, , options] = h.spawns[0];
  assert.equal(options.cwd, worktreeDirectory);
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
  let h = harness({ plan: { ...basePlan(), worktree: true }, createImpl: async () => { throw new Error("TERMINAL_SPAWN_FAILED"); }, overrides: { worktrees } });
  assert.deepEqual(await go(h), { status: "failed" });
  assert.deepEqual(worktrees.calls[1], ["remove", { repositoryRoot: root, repositoryId, taskId: "T-3", deleteBranch: true }]);
  worktrees = fakeWorktrees({ ok: true, directory: worktreeDirectory, created: true, branchCreated: false });
  h = harness({ plan: { ...basePlan(), worktree: true }, createImpl: async () => { throw new Error("TERMINAL_SPAWN_FAILED"); }, overrides: { worktrees } });
  await go(h);
  assert.equal(worktrees.calls[1][1].deleteBranch, false);
  worktrees = fakeWorktrees({ ok: true, directory: worktreeDirectory, created: false, branchCreated: false });
  h = harness({ plan: { ...basePlan(), worktree: true }, createImpl: async () => { throw new Error("TERMINAL_SPAWN_FAILED"); }, overrides: { worktrees } });
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

test("a start held by the repository's uncommitted changes answers tree_dirty and spawns nothing", async () => {
  const h = harness({ answer: json({ ok: false, error: "tree_dirty" }) });
  assert.deepEqual(await go(h), { status: "tree_dirty" });
  assert.equal(h.spawns.length, 0);
  assert.equal(aborted(h).length, 0);
});

test("a start asked for a separate worktree says so in the confirmation and the plan request, and runs in the worktree", async () => {
  const worktrees = fakeWorktrees();
  const confirmed = [];
  const h = harness({
    plan: { ...basePlan(), worktree: true },
    confirmImpl: async (info) => { confirmed.push(info); return true; },
    overrides: { worktrees },
  });
  assert.deepEqual(await h.start.start(trusted, repositoryId, "T-3", true), { status: "started" });
  assert.deepEqual(confirmed, [{ taskId: "T-3", separateWorktree: true }]);
  assert.deepEqual(h.calls[0].body, { repositoryId, payload: { id: "T-3", worktree: true } });
  assert.equal(h.spawns[0][2].cwd, worktreeDirectory);
  assert.deepEqual(worktrees.calls[0], ["ensure", { repositoryRoot: root, repositoryId, taskId: "T-3" }]);
});

test("the confirmation of a separate-worktree start says the uncommitted changes are left out", () => {
  assert.equal(taskStartConfirmation({ taskId: "T-3", separateWorktree: false }).message, "Start task T-3?");
  const separate = taskStartConfirmation({ taskId: "T-3", separateWorktree: true });
  assert.equal(separate.message, "Start task T-3 in a separate worktree?");
  assert.match(separate.detail, /uncommitted changes in this repository are not part of it and are left untouched/u);
});

test("native task confirmation uses the current window and defaults to Cancel", async () => {
  const window = { isDestroyed: () => false };
  const shown = [];
  const dialog = { showMessageBox: async (...args) => { shown.push(args); return { response: 0 }; } };
  assert.equal(await confirmTaskStart(dialog, () => window, { taskId: "T-3", separateWorktree: true }), true);
  assert.equal(shown[0][0], window);
  assert.equal(shown[0][1].message, "Start task T-3 in a separate worktree?");
  assert.deepEqual(shown[0][1].buttons, ["Start session", "Cancel"]);
  assert.equal(shown[0][1].defaultId, 1);
  assert.equal(shown[0][1].cancelId, 1);
  assert.equal(await confirmTaskStart(dialog, () => ({ isDestroyed: () => true }), { taskId: "T-3" }), false);
  assert.equal(shown.length, 1);
});

test("a separate-worktree start never runs in the repository root, and takes only the fixed mark", async () => {
  // A plan that does not ask for the worktree the owner confirmed is malformed: the dispatch is aborted.
  for (const plan of [basePlan(), { ...basePlan(), worktree: false }]) {
    const h = harness({ plan, confirmImpl: async () => true, overrides: { worktrees: fakeWorktrees() } });
    assert.deepEqual(await h.start.start(trusted, repositoryId, "T-3", true), { status: "failed" });
    assert.equal(h.spawns.length, 0);
    assert.equal(aborted(h).length, 1);
  }
  for (const mark of [false, "true", 1, null, {}, "C:\\Work\\elsewhere"]) {
    const h = harness({ confirmImpl: async () => true });
    assert.deepEqual(await h.start.start(trusted, repositoryId, "T-3", mark), { status: "invalid" });
    assert.deepEqual(h.calls, []);
  }
  // The queue never asks for one.
  const queued = harness();
  assert.deepEqual(await queued.start.startQueued(repositoryId, "T-3"), { status: "started" });
  assert.deepEqual(queued.calls[0].body, { repositoryId, payload: { id: "T-3" } });
});

/** The open channel: a fake worktrees with `locate`, an injected `openPath` and the same trust check as the start. */
function openHarness({ located = worktreeDirectory, openPath, platform = "win32", withWorktrees = true, rootAnswer = null } = {}) {
  const opened = [];
  const locates = [];
  const posts = [];
  const worktrees = withWorktrees ? { locate: async (request) => { locates.push(request); if (located instanceof Error) throw located; return located; } } : null;
  const starter = createTaskStart({
    isTrustedEvent: (e) => e?.trusted === true,
    platform,
    worktrees,
    openPath: openPath || (async (directory) => { opened.push(directory); return ""; }),
    // The monitor is asked for the repository root only when the harness gives it an answer.
    ...(rootAnswer === null ? {} : {
      monitorOrigin: origin, authorizationToken: "secret",
      fetch: async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return rootAnswer(); },
    }),
  });
  return { starter, opened, locates, posts };
}
const open = (h, repo = repositoryId, id = "T-3", event = trusted) => h.starter.openWorktree(event, repo, id);

test("the open channel is fixed and answers one of four statuses", async () => {
  assert.equal(TASK_WORKTREE_OPEN_CHANNEL, "pomegr:task-worktree-open");
  assert.deepEqual([...TASK_WORKTREE_OPEN_STATUSES], ["opened", "not_found", "invalid", "unavailable"]);
  assert.ok(Object.isFrozen(TASK_WORKTREE_OPEN_STATUSES));
  const h = openHarness();
  assert.deepEqual(await open(h), { status: "opened" });
  assert.deepEqual(h.opened, [worktreeDirectory]);
  assert.deepEqual(h.locates, [{ repositoryRoot: null, repositoryId, taskId: "T-3" }]);
});

test("the open channel asks the monitor for the repository root, and a root it cannot get leaves only the older folder", async () => {
  const h = openHarness({ rootAnswer: () => json({ ok: true, root }) });
  assert.deepEqual(await open(h), { status: "opened" });
  assert.deepEqual(h.posts, [{ url: `${origin}/internal/tasks/worktree-root`, body: { repositoryId, payload: {} } }]);
  assert.deepEqual(h.locates, [{ repositoryRoot: root, repositoryId, taskId: "T-3" }]);
  for (const rootAnswer of [() => json({ ok: false, error: "not_found" }), () => json({ ok: true, root: 7 }), () => json(null), () => { throw new Error("offline"); }]) {
    const missing = openHarness({ rootAnswer });
    assert.deepEqual(await open(missing), { status: "opened" });
    assert.deepEqual(missing.locates, [{ repositoryRoot: null, repositoryId, taskId: "T-3" }]);
  }
});

test("a done task's worktree is removed with its branch, and only the fixed outcome is answered", async () => {
  const removes = [];
  const starter = (outcome) => createTaskStart({ worktrees: { remove: async (request) => { removes.push(request); if (outcome instanceof Error) throw outcome; return outcome; } } });
  for (const outcome of ["removed", "absent", "kept", "failed"]) {
    assert.equal(await starter(outcome).cleanWorktree(repositoryId, "T-3", root), outcome);
    assert.deepEqual(removes.pop(), { repositoryRoot: root, repositoryId, taskId: "T-3", deleteBranch: true });
  }
  assert.equal(await starter(new Error("git")).cleanWorktree(repositoryId, "T-3", root), "failed");
  removes.length = 0;
  for (const [repo, id] of [["repo-x", "T-3"], [repositoryId, "T-0"], [repositoryId, "../T-3"], [null, null]]) {
    assert.equal(await starter("removed").cleanWorktree(repo, id, root), "failed");
  }
  assert.equal(await createTaskStart({}).cleanWorktree(repositoryId, "T-3", root), "failed", "no worktrees, nothing to remove");
  const disposed = starter("removed");
  disposed.dispose();
  assert.equal(await disposed.cleanWorktree(repositoryId, "T-3", root), "failed");
  assert.deepEqual(removes, []);
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

const imageFolder = "C:\\Users\\tester\\AppData\\Roaming\\pomegr\\tasks-v1\\images\\repo-0123456789abcdef01234567\\T-3";
const imageFiles = [`${imageFolder}\\img-0123456789ab.png`, `${imageFolder}\\img-ba9876543210.jpg`];
const imagePlan = (change = {}) => ({ ...basePlan(), prompt: `Do the thing\n- ${imageFiles[0]}\n- ${imageFiles[1]}`, images: imageFiles, ...change });
const withImageFiles = (extra = () => false) => ({ fileExists: (f) => f === exe || f === powershell || imageFiles.includes(f) || extra(f) });

test("Claude Code is given the image folder as a readable directory, after the prompt", async () => {
  const h = harness({ plan: imagePlan({ model: "claude-opus-4-1" }), overrides: withImageFiles() });
  assert.deepEqual(await go(h), { status: "started" });
  const argumentsLine = h.spawns[0][1];
  assert.deepEqual(argumentsLine, ["--model", "claude-opus-4-1", imagePlan().prompt, "--add-dir", imageFolder]);
  assert.equal(h.spawns[0][2].cwd, root);
});

test("Codex gets the images attached, after the prompt", async () => {
  const h = harness({ plan: imagePlan({ provider: "codex" }), overrides: withImageFiles(codexFiles) });
  assert.deepEqual(await go(h), { status: "started" });
  assert.deepEqual(h.spawns[0][1], ["--no-alt-screen", imagePlan().prompt, "--image", ...imageFiles]);
});

test("a plan with no images, or from an older monitor, adds no image flag", async () => {
  for (const plan of [{ ...basePlan(), images: [] }, basePlan()]) {
    const h = harness({ plan });
    assert.deepEqual(await go(h), { status: "started" });
    assert.deepEqual(h.spawns[0][1], ["Do the thing"]);
  }
});

test("image files that are not the store's own fail the start and abort", async () => {
  const other = "C:\\Users\\tester\\Pictures\\img-0123456789ab.png";
  const bad = [
    { images: "x" }, { images: [imageFiles[0], imageFiles[0]] }, { images: [...imageFiles, ...imageFiles, imageFiles[0]] },
    { images: ["img-0123456789ab.png"] }, { images: [`${imageFolder}\\..\\T-4\\img-0123456789ab.png`] }, { images: [`${imageFolder}\\notes.txt`] },
    { images: [`${imageFolder}\\img-0123456789ab.svg`] }, { images: [imageFiles[0], other] }, { images: [`${imageFolder}\\img-ffffffffffff.png`] },
    // A file the prompt does not name was not put there by the monitor's own plan.
    { prompt: "Do the thing" },
  ];
  for (const change of bad) {
    const h = harness({ plan: imagePlan(change), overrides: withImageFiles((f) => f === other) });
    assert.deepEqual(await go(h), { status: "failed" }, JSON.stringify(change));
    assert.equal(h.spawns.length, 0);
    assert.ok(aborted(h)[0], JSON.stringify(change));
  }
});

test("a Claude Code plan that asks for Remote Control adds the fixed flag after the prompt, before the image folder", async () => {
  const plain = harness({ plan: { ...basePlan(), model: "claude-opus-4-1", remoteControl: true } });
  assert.deepEqual(await go(plain), { status: "started" });
  assert.deepEqual(plain.spawns[0][1], ["--model", "claude-opus-4-1", "Do the thing", "--remote-control"]);
  const images = harness({ plan: imagePlan({ remoteControl: true }), overrides: withImageFiles() });
  assert.deepEqual(await go(images), { status: "started" });
  assert.deepEqual(images.spawns[0][1], [imagePlan().prompt, "--remote-control", "--add-dir", imageFolder]);
});

test("a plan without Remote Control, or from an older monitor, adds no Remote Control flag", async () => {
  for (const plan of [{ ...basePlan(), remoteControl: false }, basePlan()]) {
    const h = harness({ plan });
    assert.deepEqual(await go(h), { status: "started" });
    assert.deepEqual(h.spawns[0][1], ["Do the thing"]);
  }
});

test("a Remote Control field that is not a boolean, or is set on a Codex plan, is malformed", async () => {
  for (const plan of [{ ...basePlan(), remoteControl: "yes" }, { ...basePlan(), remoteControl: "--remote-control" }, { ...basePlan(), provider: "codex", remoteControl: true }]) {
    const h = harness({ plan, overrides: { fileExists: (f) => f === exe || f === powershell || codexFiles(f) } });
    assert.deepEqual(await go(h), { status: "failed" });
    assert.equal(h.spawns.length, 0);
    assert.equal(aborted(h).length, 1);
  }
});
