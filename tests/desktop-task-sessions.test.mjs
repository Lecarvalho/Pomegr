import assert from "node:assert/strict";
import test from "node:test";

import { createTaskStart, installTaskStartIpc, TASK_SESSIONS_CHANNEL } from "../desktop/runtime/task-dispatch.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const trusted = { trusted: true };

function sessionsHarness(overrides = {}) {
  const calls = [];
  const terminal = {
    ensureHost: async () => {}, create: async () => {},
    taskSessions: async (...request) => { calls.push(["inspect", ...request]); return { live: 2, working: 1 }; },
    endDone: async (scope) => { calls.push(["endDone", scope]); return { ended: 1, working: 0 }; },
    ...overrides,
  };
  return { calls, starter: createTaskStart({ isTrustedEvent: (e) => e?.trusted === true, platform: "win32", terminal }) };
}

test("the Done action's session question is trusted-only, validated, and answers counts through fixed statuses", async () => {
  const h = sessionsHarness();
  assert.deepEqual(await h.starter.taskSessions(trusted, repositoryId, "T-3", "inspect"), { status: "ok", live: 2, working: 1 });
  // The settle names the owner, so the controller may end a working session only when the owner said so.
  assert.deepEqual(await h.starter.taskSessions(trusted, repositoryId, "T-3", "settle", false), { status: "ok", ended: 1, working: 0 });
  assert.deepEqual(await h.starter.taskSessions(trusted, repositoryId, "T-3", "settle", true), { status: "ok", ended: 1, working: 0 });
  assert.deepEqual(h.calls, [
    ["inspect", repositoryId, "T-3"],
    ["endDone", { repositoryId, taskId: "T-3", endWorking: false, owner: true }],
    ["endDone", { repositoryId, taskId: "T-3", endWorking: true, owner: true }],
  ]);
  const before = h.calls.length;
  for (const request of [
    [{ trusted: false }, repositoryId, "T-3", "inspect"], [undefined, repositoryId, "T-3", "inspect"], [trusted, "repo-x", "T-3", "inspect"], [trusted, repositoryId, "T-0", "inspect"],
    [trusted, repositoryId, "T-3", "end"], [trusted, repositoryId, "T-3", "inspect", true], [trusted, repositoryId, "T-3", "settle"], [trusted, repositoryId, "T-3", "settle", "yes"],
    [trusted, repositoryId, 3, "inspect"], [trusted, { toString: () => repositoryId }, "T-3", "inspect"],
  ]) assert.deepEqual(await h.starter.taskSessions(...request), { status: "invalid" }, JSON.stringify(request));
  assert.equal(h.calls.length, before);
});

test("the Done action's session question is unavailable without a controller that can answer, after dispose, or when it fails", async () => {
  for (const terminal of [{ ensureHost: async () => {}, create: async () => {} }, { taskSessions: async () => { throw new Error("C:\\private"); }, endDone: async () => { throw new Error("C:\\private"); } }]) {
    const starter = createTaskStart({ isTrustedEvent: () => true, platform: "win32", terminal });
    for (const request of [["inspect"], ["settle", false]]) assert.deepEqual(await starter.taskSessions({}, repositoryId, "T-3", ...request), { status: "unavailable" });
  }
  const h = sessionsHarness();
  h.starter.dispose();
  assert.deepEqual(await h.starter.taskSessions(trusted, repositoryId, "T-3", "inspect"), { status: "unavailable" });
  assert.deepEqual(h.calls, []);
});

test("the queue runner's pass names a repository and a task at most, so it can never end a working session", async () => {
  const h = sessionsHarness();
  assert.deepEqual(await h.starter.endDoneSessions({ repositoryId, taskId: "T-3", endWorking: true, owner: true }), { ended: 1, working: 0 });
  assert.deepEqual(await h.starter.endDoneSessions(), { ended: 1, working: 0 });
  assert.deepEqual(h.calls, [["endDone", { repositoryId, taskId: "T-3" }], ["endDone", { repositoryId: undefined, taskId: undefined }]]);
  const failing = sessionsHarness({ endDone: async () => { throw new Error("host"); } });
  assert.deepEqual(await failing.starter.endDoneSessions(), { ended: 0, working: 0 });
  const none = createTaskStart({ isTrustedEvent: () => true, platform: "win32", terminal: { ensureHost: async () => {}, create: async () => {} } });
  assert.deepEqual(await none.endDoneSessions(), { ended: 0, working: 0 });
  h.starter.dispose();
  assert.deepEqual(await h.starter.endDoneSessions(), { ended: 0, working: 0 });
});

test("the sessions channel is installed with the start channel, reaches the starter, and answers unavailable when it throws", async () => {
  const handlers = new Map();
  const removed = [];
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => { removed.push(channel); handlers.delete(channel); } };
  const seen = [];
  const remove = installTaskStartIpc({ ipcMain, queueRunner: false, starter: { start: async () => ({ status: "started" }), taskSessions: async (...request) => { seen.push(request); return { status: "ok", live: 0, working: 0 }; } } });
  assert.equal(TASK_SESSIONS_CHANNEL, "pomegr:task-sessions");
  assert.deepEqual(await handlers.get(TASK_SESSIONS_CHANNEL)(trusted, repositoryId, "T-3", "inspect"), { status: "ok", live: 0, working: 0 });
  assert.deepEqual(seen, [[trusted, repositoryId, "T-3", "inspect", undefined]]);
  const thrower = new Map();
  installTaskStartIpc({ ipcMain: { handle: (c, f) => thrower.set(c, f), removeHandler() {} }, queueRunner: false, starter: { taskSessions: async () => { throw new Error("secret"); } } });
  assert.deepEqual(await thrower.get(TASK_SESSIONS_CHANNEL)(trusted, repositoryId, "T-3", "inspect"), { status: "unavailable" });
  remove();
  assert.equal(handlers.has(TASK_SESSIONS_CHANNEL), false);
});

