import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalController } from "../desktop/runtime/terminal.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const otherRepositoryId = "repo-abcdef012345678901234567";
const keyOf = (task, nonce = "a", prefix = "", repository = repositoryId) => `${repository}/${task}/${prefix}${nonce.repeat(32)}`;
const json = (value) => new Response(JSON.stringify(value));

// A task board as the monitor serves it: only the facts the desktop reads. `session.state` is the observed state.
const task = (id, state, fields = {}) => ({ id, state, session: { id: `claude:${id}`, state: "idle" }, review: null, text: "private task text", ...fields });

function fixture({ rows, boards, ended = () => true, order = [] }) {
  const listed = rows.map((row) => ({ exited: false, ...row }));
  const calls = { end: [], detach: [] };
  const client = {
    listHosts: async () => [], ensureHost: async () => {}, list: async () => listed, close() {},
    // Like the host: an ended terminal is listed as exited until the acknowledgement removes it.
    end: async (key) => {
      calls.end.push(key); order.push(`end ${key}`);
      const done = ended(key);
      if (done) listed.find((row) => row.key === key).exited = true;
      return done;
    },
    detach: async (key, acknowledge) => { calls.detach.push([key, acknowledge]); if (acknowledge) listed.splice(listed.findIndex((row) => row.key === key), 1); },
  };
  const controller = createTerminalController({
    client, isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret",
    fetch: async (url, options) => {
      assert.equal(options.headers["x-pomegr-desktop-authorization"], "secret");
      if (url.endsWith("/internal/tasks/review-session")) return json({ ok: true, sessionId: "codex:reviewer", sessionIds: ["codex:reviewer"] });
      const id = new URL(url).searchParams.get("repositoryId");
      return json({ readiness: "ready", repositoryId: id, tasks: boards[id] ?? [] });
    },
  });
  return { controller, calls, listed };
}

test("a Done task's idle builder ends at once, whichever idle state the monitor observes", async (t) => {
  for (const state of ["idle", "open", "stopped", "closed"]) {
    const f = fixture({ rows: [{ key: keyOf("T-3") }], boards: { [repositoryId]: [task("T-3", "done", { session: { id: "claude:T-3", state } })] } });
    t.after(() => f.controller.dispose());
    assert.deepEqual(await f.controller.endDone({}), { ended: 1, working: 0 }, state);
    assert.deepEqual(f.calls.end, [keyOf("T-3")]);
    // The host record goes with it, so the ended key does not hold one of the host's sixteen places.
    assert.deepEqual(f.calls.detach, [[keyOf("T-3"), true]]);
  }
});

test("a session that works, needs input, is unknown, or is not linked yet is never ended by a pass", async (t) => {
  for (const session of [{ id: "claude:T-3", state: "working" }, { id: "claude:T-3", state: "needs_input" }, { id: "claude:T-3", state: "unknown" }, { id: "claude:T-3", state: undefined }, null]) {
    const f = fixture({ rows: [{ key: keyOf("T-3") }], boards: { [repositoryId]: [task("T-3", "done", { session })] } });
    t.after(() => f.controller.dispose());
    assert.deepEqual(await f.controller.endDone({}), { ended: 0, working: 1 }, JSON.stringify(session));
    assert.deepEqual(f.calls.end, []);
  }
});

test("only the owner's settle may end a working session, and its keep answer holds for later passes", async (t) => {
  const working = [task("T-3", "done", { session: { id: "claude:T-3", state: "working" } })];
  const boards = { [repositoryId]: working };
  const f = fixture({ rows: [{ key: keyOf("T-3") }], boards });
  t.after(() => f.controller.dispose());
  // Keep it running: nothing ends, and the session is remembered as kept.
  assert.deepEqual(await f.controller.endDone({ repositoryId, taskId: "T-3", endWorking: false, owner: true }), { ended: 0, working: 1 });
  // It turns idle: a later pass leaves a kept session alone.
  working[0].session.state = "idle";
  assert.deepEqual(await f.controller.endDone({}), { ended: 0, working: 0 });
  assert.deepEqual(f.calls.end, []);
  // The owner's End session ends it, kept or not.
  assert.deepEqual(await f.controller.endDone({ repositoryId, taskId: "T-3", endWorking: true, owner: true }), { ended: 1, working: 0 });
  assert.deepEqual(f.calls.end, [keyOf("T-3")]);
  // Without the owner flag, a pass cannot end a working session whatever it passes.
  const g = fixture({ rows: [{ key: keyOf("T-3") }], boards: { [repositoryId]: [task("T-3", "done", { session: { id: "claude:T-3", state: "working" } })] } });
  t.after(() => g.controller.dispose());
  assert.deepEqual(await g.controller.endDone({ endWorking: false }), { ended: 0, working: 1 });
});

test("a task that is not Done keeps its sessions, and a pass never touches another task, a continue key, or a key of no task", async (t) => {
  const continued = "continue/claude/0a1b2c3d-0000-4000-8000-000000000001/" + "c".repeat(32);
  const rows = [{ key: keyOf("T-3") }, { key: keyOf("T-4") }, { key: keyOf("T-5", "d") }, { key: keyOf("T-6", "e", "", otherRepositoryId) }, { key: continued }, { key: "owner-terminal" }];
  const boards = {
    [repositoryId]: [task("T-3", "needs_review"), task("T-4", "done"), task("T-5", "queued")],
    [otherRepositoryId]: [task("T-6", "not_queued")],
  };
  const f = fixture({ rows, boards });
  t.after(() => f.controller.dispose());
  assert.deepEqual(await f.controller.endDone({}), { ended: 1, working: 0 });
  assert.deepEqual(f.calls.end, [keyOf("T-4")]);
  // A settle for one task names that task only, and a task the monitor does not list as Done ends nothing.
  assert.deepEqual(await f.controller.endDone({ repositoryId, taskId: "T-3", endWorking: true, owner: true }), { ended: 0, working: 0 });
  assert.deepEqual(await f.controller.endDone({ repositoryId: otherRepositoryId, taskId: "T-6", endWorking: true, owner: true }), { ended: 0, working: 0 });
  assert.deepEqual(f.calls.end, [keyOf("T-4")]);
});

test("an ended key is not ended again, and a stop the host cannot confirm or complete is asked again by the next pass", async (t) => {
  const boards = { [repositoryId]: [task("T-3", "done")] };
  let answer = false;
  const f = fixture({ rows: [{ key: keyOf("T-3") }, { key: keyOf("T-3", "b"), exited: true, exitCode: 0 }], boards, ended: () => answer });
  t.after(() => f.controller.dispose());
  assert.deepEqual(await f.controller.endDone({}), { ended: 0, working: 0 });
  assert.deepEqual(f.calls.detach, []);
  answer = true;
  assert.deepEqual(await f.controller.endDone({}), { ended: 1, working: 0 });
  // The exited key is never sent an end.
  assert.deepEqual(f.calls.end, [keyOf("T-3"), keyOf("T-3")]);
  const failing = fixture({ rows: [{ key: keyOf("T-3") }], boards, ended: () => { throw new Error("TERMINAL_UNAVAILABLE"); } });
  t.after(() => failing.controller.dispose());
  assert.deepEqual(await failing.controller.endDone({}), { ended: 0, working: 0 });
});

test("a reviewer works until its verdict; a missing verdict counts as working", async (t) => {
  const review = keyOf("T-3", "b", "review-");
  for (const [state, expected] of [["running", { ended: 0, working: 1 }], [undefined, { ended: 0, working: 1 }], ["passed", { ended: 1, working: 0 }], ["failed", { ended: 1, working: 0 }]]) {
    const f = fixture({ rows: [{ key: review }], boards: { [repositoryId]: [task("T-3", "done", { review: state ? { state } : null })] } });
    t.after(() => f.controller.dispose());
    assert.deepEqual(await f.controller.endDone({}), expected, String(state));
    assert.deepEqual(f.calls.end, expected.ended ? [review] : []);
  }
});

test("taskSessions counts the running sessions of one task, with how many work, before the task is Done", async (t) => {
  const rows = [{ key: keyOf("T-3") }, { key: keyOf("T-3", "b", "review-") }, { key: keyOf("T-3", "c"), exited: true, exitCode: 0 }, { key: keyOf("T-4") }];
  const boards = { [repositoryId]: [task("T-3", "needs_review", { session: { id: "claude:T-3", state: "idle" }, review: { state: "running" } }), task("T-4", "stalled")] };
  const f = fixture({ rows, boards });
  t.after(() => f.controller.dispose());
  assert.deepEqual(await f.controller.taskSessions(repositoryId, "T-3"), { live: 2, working: 1 });
  assert.deepEqual(await f.controller.taskSessions(repositoryId, "T-9"), { live: 0, working: 0 });
  assert.deepEqual(f.calls.end, []);
});

test("passes run one after another, so a session is ended once", async (t) => {
  const order = [];
  const f = fixture({ rows: [{ key: keyOf("T-3") }], boards: { [repositoryId]: [task("T-3", "done")] }, order });
  t.after(() => f.controller.dispose());
  assert.deepEqual(await Promise.all([f.controller.endDone({}), f.controller.endDone({})]), [{ ended: 1, working: 0 }, { ended: 0, working: 0 }]);
  assert.deepEqual(f.calls.end, [keyOf("T-3")]);
});

test("hosts of older builds are reached through the host list; one with nothing left running is let go so it exits by itself", async (t) => {
  const older = "1".repeat(64);
  const busyHost = "2".repeat(64);
  const oldKey = keyOf("T-3");
  const busyKey = keyOf("T-4", "b");
  const fakeHost = (rows) => {
    const host = { closed: 0, ended: [], connectHost: async () => {}, close() { host.closed += 1; }, list: async () => rows.map((row) => ({ exited: false, ...row })),
      end: async (key) => { host.ended.push(key); return true; }, detach: async () => {} };
    return host;
  };
  const hosts = { [older]: fakeHost([{ key: oldKey }]), [busyHost]: fakeHost([{ key: busyKey }]) };
  let created = 0;
  const controller = createTerminalController({
    client: { listHosts: async () => [{ buildId: older, protocol: 1 }, { buildId: busyHost, protocol: 1 }], list: async () => [], close() {}, ensureHost: async () => {} },
    createClient: () => hosts[[older, busyHost][created++]],
    userData: "C:\\profile", isTrustedEvent: () => true, monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret",
    fetch: async (url) => json({ readiness: "ready", repositoryId: new URL(url).searchParams.get("repositoryId"), tasks: [task("T-3", "done"), task("T-4", "needs_review")] }),
  });
  t.after(() => controller.dispose());
  assert.deepEqual(await controller.endDone({}), { ended: 1, working: 0 });
  assert.deepEqual(hosts[older].ended, [oldKey]);
  assert.deepEqual(hosts[busyHost].ended, []);
  // The older host has no running session left, so no connection holds it; the other still runs a task's session.
  assert.equal(hosts[older].closed, 1);
  assert.equal(hosts[busyHost].closed, 0);
});

test("a disposed controller or one without a client ends nothing", async () => {
  const none = createTerminalController({});
  assert.deepEqual(await none.endDone({}), { ended: 0, working: 0 });
  assert.deepEqual(await none.taskSessions(repositoryId, "T-3"), { live: 0, working: 0 });
});
