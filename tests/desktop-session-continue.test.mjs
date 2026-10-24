import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createSessionContinue, confirmSessionContinue, installSessionContinueIpc } from "../desktop/runtime/session-continue.mjs";
import { requestTerminalSession } from "../desktop/runtime/monitor-worker.mjs";

const localId = "01234567-89ab-4cde-8fab-0123456789ab";
const sessionId = `claude:${localId}`;
const cwd = path.resolve("outputs/synthetic-continue");
const plan = (provider = "claude") => ({ provider, sessionId: `${provider}:${localId}`, localId, cwd, title: "Synthetic session" });
function fixture(overrides = {}) {
  const creates = [], calls = [], confirmations = [];
  const sender = { isDestroyed: () => false, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  const options = {
    isTrustedEvent: (candidate) => candidate === event, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "private-token",
    environment: { PATH: "C:\\Tools", USERPROFILE: "C:\\Users\\tester", POMEGR_TASK_TOKEN: "old", POMEGR_MONITOR_TOKEN: "private", ELECTRON_RUN_AS_NODE: "1", OWNER_SETTING: "keep" },
    directoryExists: () => true, fileExists: (file) => file.endsWith("claude.exe") || file.endsWith("codex.exe"),
    confirm: async (value) => { confirmations.push(value); return true; },
    fetch: async (url, request) => { calls.push({ url, request }); return Response.json({ ok: true, plan: plan() }); },
    terminal: { ensureHost: async () => {}, run: async () => ({ ok: true, sessions: [], hosts: [] }), create: async (value) => { creates.push(value); } },
    ...overrides,
  };
  return { action: createSessionContinue(options), event, creates, calls, confirmations, options };
}

test("cancelled confirmation launches nothing; confirmed resume has only provider resume arguments and owner environment", async () => {
  const cancelled = fixture({ confirm: async () => false });
  assert.deepEqual(await cancelled.action.run(cancelled.event, sessionId), { status: "cancelled" });
  assert.equal(cancelled.creates.length, 0);
  for (const provider of ["claude", "codex"]) {
    const f = fixture({ fetch: async () => Response.json({ ok: true, plan: plan(provider) }) });
    assert.deepEqual(await f.action.run(f.event, `${provider}:${localId}`), { status: "started" });
    assert.equal(f.creates.length, 1);
    assert.match(f.creates[0].executable, new RegExp(`${provider}\\.exe$`));
    assert.deepEqual(f.creates[0].args, [provider === "claude" ? "--resume" : "resume", localId]);
    assert.equal(f.creates[0].cwd, cwd);
    assert.match(f.creates[0].key, new RegExp(`^continue/${provider}/${localId}/[a-f0-9]{32}$`));
    assert.equal(f.creates[0].env.OWNER_SETTING, "keep");
    for (const key of ["POMEGR_TASK_TOKEN", "POMEGR_MONITOR_TOKEN", "ELECTRON_RUN_AS_NODE"]) assert.equal(f.creates[0].env[key], undefined);
  }
});

test("native confirmation contains title, provider and folder with Cancel default", async () => {
  let shown;
  const answer = await confirmSessionContinue({ showMessageBox: async (_window, value) => { shown = value; return { response: 1 }; } }, () => ({ isDestroyed: () => false }), plan());
  assert.equal(answer, false);
  assert.equal(shown.message, "Continue this session in Pomegr?");
  assert.equal(shown.buttons[shown.defaultId], "Cancel");
  for (const text of [cwd, "Claude Code", "Synthetic session"]) assert.ok(shown.detail.includes(text));
});

test("fixed monitor refusals and errors never expose plan data through IPC", async () => {
  for (const reason of ["live", "unknown", "folder_missing", "history_missing"]) {
    const f = fixture({ fetch: async () => Response.json({ ok: false, reason, cwd, title: "private" }) });
    const handlers = new Map();
    const remove = installSessionContinueIpc({ ipcMain: { removeHandler: (key) => handlers.delete(key), handle: (key, fn) => handlers.set(key, fn) }, action: f.action });
    assert.deepEqual(await handlers.get("pomegr:session-continue")(f.event, sessionId), { status: reason });
    assert.equal(f.creates.length, 0); remove();
  }
  for (const error of ["invalid", "not_found", "unavailable"]) {
    const f = fixture({ fetch: async () => Response.json({ error }, { status: error === "invalid" ? 400 : error === "not_found" ? 404 : 503 }) });
    assert.deepEqual(await f.action.run(f.event, sessionId), { status: error });
  }
});

test("invalid identities and plans never reach host arguments", async () => {
  const f = fixture();
  for (const id of ["claude:--resume", "codex:../bad", "claude:synthetic", "other:" + localId]) {
    assert.deepEqual(await f.action.run(f.event, id), { status: "invalid" });
  }
  assert.equal(f.calls.length, 0);
  for (const change of [{ localId: "--danger" }, { sessionId: `codex:${localId}` }, { provider: "codex" }, { cwd: "relative" }, { cwd: path.join(cwd, "sub") + path.sep + ".." }, { title: "x".repeat(241) }]) {
    const bad = fixture({ fetch: async () => Response.json({ ok: true, plan: { ...plan(), ...change } }) });
    assert.deepEqual(await bad.action.run(bad.event, sessionId), { status: "unavailable" });
    assert.equal(bad.creates.length, 0);
  }
});

test("folder disappearance, missing executable and running host session refuse", async () => {
  for (const [status, overrides] of [
    ["folder_missing", { directoryExists: () => false }],
    ["cli_missing", { fileExists: () => false }],
    ["busy", { terminal: { run: async () => ({ ok: true, sessions: [{ sessionId, state: "live" }] }) } }],
  ]) {
    const f = fixture(overrides);
    assert.deepEqual(await f.action.run(f.event, sessionId), { status });
    assert.equal(f.creates.length, 0);
  }
});

test("serializes clicks while starting, rechecks after confirmation and refuses changed evidence", async () => {
  let release;
  const f = fixture({ confirm: () => new Promise((resolve) => { release = resolve; }) });
  const first = f.action.run(f.event, sessionId);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await f.action.run(f.event, sessionId), { status: "busy" });
  release(true);
  assert.deepEqual(await first, { status: "started" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].request.method, "POST");
  assert.equal(f.calls[0].request.headers["x-pomegr-desktop-authorization"], "private-token");
  let reads = 0;
  const changed = fixture({ fetch: async () => Response.json(++reads === 1 ? { ok: true, plan: plan() } : { ok: false, reason: "live" }) });
  assert.deepEqual(await changed.action.run(changed.event, sessionId), { status: "live" });
  assert.equal(changed.creates.length, 0);
});

test("foreign frame and disposed operation cannot launch, and ambiguous create cannot retry", async () => {
  const f = fixture();
  assert.deepEqual(await f.action.run({}, sessionId), { status: "invalid" });
  f.action.dispose();
  assert.deepEqual(await f.action.run(f.event, sessionId), { status: "unavailable" });
  const uncertain = fixture({ terminal: { run: async () => ({ ok: true, sessions: [] }), ensureHost: async () => {}, create: async () => { throw new Error("TERMINAL_UNAVAILABLE"); } } });
  assert.deepEqual(await uncertain.action.run(uncertain.event, sessionId), { status: "failed" });
  assert.deepEqual(await uncertain.action.run(uncertain.event, sessionId), { status: "busy" });
});

test("terminal identity observation stays on private worker IPC and validates responses", async () => {
  const child = new EventEmitter();
  let sent;
  child.postMessage = (message) => { sent = message; };
  const pending = requestTerminalSession(child, 123);
  assert.equal(sent.type, "terminal-session"); assert.equal(sent.pid, 123);
  child.emit("message", { type: "terminal-session-result", requestId: sent.requestId, sessionId });
  assert.equal(await pending, sessionId);
  const invalid = requestTerminalSession(child, 123);
  child.emit("message", { type: "terminal-session-result", requestId: sent.requestId, sessionId: cwd });
  assert.equal(await invalid, null);
  assert.equal(await requestTerminalSession(child, 0), null);
  assert.equal(child.listenerCount("message"), 0);
});
