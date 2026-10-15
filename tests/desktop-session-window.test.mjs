import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { requestSessionWindowOwner } from "../desktop/runtime/monitor-worker.mjs";
import { focusSessionWindow, sessionWindowFocusRequest, sessionWindowTitle, sessionWindowTitles } from "../desktop/runtime/session-window.mjs";

const OWNER = Object.freeze({ pid: 50068, processStartIdentity: "134365685309874121" });

// A fake helper process: records how it was started and what it read, then answers once.
function fakeSpawn({ output = "focused", code = 0, hang = false } = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null)); };
    const call = { command, args, options, input: null, child };
    child.stdin = {
      once() {},
      end(value) {
        call.input = JSON.parse(value);
        if (hang) return;
        queueMicrotask(() => { if (output) child.stdout.emit("data", Buffer.from(output)); child.emit("close", code); });
      },
    };
    calls.push(call);
    return child;
  };
  return { spawnFn, calls };
}

test("the helper request carries only a validated pid, process start, Pomegr's own pid, and safe titles", () => {
  assert.deepEqual(sessionWindowFocusRequest(OWNER, 1234, ["  Fix  the\nbuild ", "Build fix routing", "Fix the build"]),
    { pid: 50068, start: "134365685309874121", self: 1234, titles: ["Fix the build", "Build fix routing"] });
  assert.deepEqual(sessionWindowFocusRequest(OWNER, 1234).titles, []);
  assert.deepEqual(sessionWindowTitles(["One title", "Two title", "Three title", "Four title"]), ["One title", "Two title", "Three title"]);
  assert.deepEqual(sessionWindowTitles("One title"), []);
  assert.equal(sessionWindowTitle("abc"), "", "too short to tell windows apart");
  assert.equal(sessionWindowTitle("x".repeat(513)), "");
  assert.equal(sessionWindowTitle("Fix ‮build"), "");
  assert.equal(sessionWindowTitle(["Fix the build"]), "");
  for (const owner of [null, { ...OWNER, pid: 0 }, { ...OWNER, pid: 1.5 }, { ...OWNER, pid: 2 ** 31 },
    { ...OWNER, processStartIdentity: "unix-ms:1" }, { ...OWNER, processStartIdentity: "1; Stop-Process" },
    { ...OWNER, processStartIdentity: 134365685309874121 }]) {
    assert.equal(sessionWindowFocusRequest(owner, 1234), null, JSON.stringify(owner));
  }
  assert.equal(sessionWindowFocusRequest(OWNER, 0), null);
});

test("focus runs one fixed hidden helper and passes the identity only on stdin", async () => {
  const helper = fakeSpawn();
  const outcome = await focusSessionWindow(OWNER, { platform: "win32", selfPid: 77, titles: ["Fix the build"], spawnFn: helper.spawnFn, env: { SystemRoot: "C:\\Windows" } });
  assert.equal(outcome, "focused");
  assert.equal(helper.calls.length, 1);
  const [call] = helper.calls;
  assert.match(call.command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.doesNotMatch(call.args.join(" "), /50068|134365685309874121|Fix the build/);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.input, { pid: 50068, start: "134365685309874121", self: 77, titles: ["Fix the build"] });
  // The helper reads windows and handles and focuses one window; it never sends input or attaches.
  assert.doesNotMatch(call.args[3], /SendInput|keybd_event|PostMessage|SendMessage|AttachConsole|AttachThreadInput|WriteConsoleInput/);
});

test("ambiguous, missing, and unknown helper answers never claim focus", async () => {
  for (const [output, code, expected] of [["ambiguous", 0, "ambiguous"], ["missing", 0, "missing"], ["refused", 0, "refused"],
    ["focused-ish", 0, "unavailable"], ["focused", 1, "unavailable"], ["", 0, "unavailable"], ["x".repeat(65), 0, "unavailable"]]) {
    const helper = fakeSpawn({ output, code });
    assert.equal(await focusSessionWindow(OWNER, { platform: "win32", spawnFn: helper.spawnFn }), expected, `${output}/${code}`);
  }
});

test("no helper starts off Windows or for an owner that fails validation, and a stuck helper is stopped", async () => {
  const helper = fakeSpawn();
  assert.equal(await focusSessionWindow(OWNER, { platform: "linux", spawnFn: helper.spawnFn }), "unavailable");
  assert.equal(await focusSessionWindow({ pid: 1, processStartIdentity: "bad" }, { platform: "win32", spawnFn: helper.spawnFn }), "missing");
  assert.equal(helper.calls.length, 0);
  const stuck = fakeSpawn({ hang: true });
  assert.equal(await focusSessionWindow(OWNER, { platform: "win32", spawnFn: stuck.spawnFn, timeoutMs: 5 }), "unavailable");
  assert.equal(stuck.calls[0].child.killed, true);
});

test("the owner request answers only its own reply and releases every listener", async () => {
  const child = new EventEmitter();
  const sent = [];
  child.postMessage = (message) => sent.push(message);
  const pending = requestSessionWindowOwner(child, "claude:session-a");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "session-window-owner");
  assert.equal(sent[0].sessionId, "claude:session-a");
  child.emit("message", { type: "session-window-owner-result", requestId: sent[0].requestId + 1, owner: { pid: 9, processStartIdentity: "1" } });
  child.emit("message", { type: "session-window-owner-result", requestId: sent[0].requestId, owner: { ...OWNER, extra: "PRIVATE", windowTitles: 7 } });
  assert.deepEqual(await pending, { pid: 50068, processStartIdentity: "134365685309874121", windowTitles: [] });
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);

  const invalid = requestSessionWindowOwner(child, "claude:session-b");
  child.emit("message", { type: "session-window-owner-result", requestId: sent[1].requestId, owner: { pid: -1, processStartIdentity: "1" } });
  assert.equal(await invalid, null);
  const titled = requestSessionWindowOwner(child, "claude:session-t");
  child.emit("message", { type: "session-window-owner-result", requestId: sent[2].requestId,
    owner: { ...OWNER, windowTitles: ["Custom title", 9, "AI title", "Third title"] } });
  assert.deepEqual((await titled).windowTitles, ["Custom title", "AI title"]);
  const exited = requestSessionWindowOwner(child, "claude:session-c");
  child.emit("exit", 1);
  assert.equal(await exited, null);
  assert.equal(await requestSessionWindowOwner(child, "claude:session-d", 1), null);
  assert.equal(await requestSessionWindowOwner(null, "claude:session-e"), null);
  assert.equal(child.listenerCount("message"), 0);
});
