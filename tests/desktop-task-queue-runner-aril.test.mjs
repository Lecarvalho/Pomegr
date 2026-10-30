// The Aril switch and the grant runner: with Aril Off the runner starts, reviews, sends back, merges, deletes a branch, marks Done, and writes
// nothing, and it asks the switch before every one of them, not only at the start of a tick.

import assert from "node:assert/strict";
import test from "node:test";

import { createTaskQueueRunner } from "../desktop/runtime/task-queue-runner.mjs";

const origin = "http://127.0.0.1:4317";
const repoA = "repo-0123456789abcdef01234567";
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const OID = "b".repeat(40);

const STEPS = {
  start: { repositoryId: repoA, taskId: "T-1", kind: "start" },
  review: { repositoryId: repoA, taskId: "T-2", kind: "review" },
  send_back: { repositoryId: repoA, taskId: "T-3", kind: "send_back" },
  mark_done: { repositoryId: repoA, taskId: "T-4", kind: "mark_done" },
  merge: { repositoryId: repoA, taskId: "T-5", kind: "merge", pullRequest: 22, headOid: OID, mergeMethod: "squash", mergeMode: "direct" },
  delete_branch: { repositoryId: repoA, taskId: "T-6", kind: "delete_branch", pullRequest: 31, branch: "tasks/T-6" },
  write_tasks: { repositoryId: repoA, kind: "write_tasks", plans: ["docs/plan.md"] },
};
// The route each kind of step reaches first: if it is posted, the step ran.
const REACHES = { send_back: "grant-send-back", mark_done: "grant-done", merge: "grant-merge-attempt", delete_branch: "worktree-root" };

function harness({ on = true, steps = [], batches = [], start, withFollowUp = true, omitSwitch = false, hook } = {}) {
  const state = { on };
  const calls = [];
  const launches = [];
  const written = [];
  const writes = [];
  const commands = [];
  let timer = null;
  const granted = (kind) => async (repositoryId, taskId, authorized) => {
    launches.push({ kind, taskId });
    return start ? start({ kind, taskId }, authorized) : { status: await authorized() ? "started" : "cancelled" };
  };
  const runner = createTaskQueueRunner({
    starter: { startQueued: granted("queue"), startGranted: granted("start"), startGrantedReview: granted("review") },
    monitorOrigin: origin, authorizationToken: "secret",
    setTimeout: (callback) => { timer = callback; return { unref() {} }; }, clearTimeout: () => {},
    ...(omitSwitch ? {} : { arilOn: () => state.on }),
    grantWrite: async (value) => { writes.push(value); return { ok: true }; },
    ...(withFollowUp ? { grantFollowUp: async (value) => { written.push(value); return { ok: true, conversationId: "chat-0123456789ab", messageId: "m-1" }; } } : {}),
    // The merge and the branch delete only reach the repository's folder and then GitHub through `gh`.
    execFile: (_executable, args, _options, callback) => commands.push(args.join(" ")) && callback(null, args[0] === "repo" ? JSON.stringify({ nameWithOwner: "PomegrHQ/pomegr", squashMergeAllowed: true, mergeCommitAllowed: false,
      rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: false, defaultBranchRef: { name: "main" } }) : ""),
    fetch: async (url, options) => {
      const route = url.split("/").pop();
      const body = JSON.parse(options.body);
      calls.push({ route, body });
      hook?.(route, state);
      if (route === "grant-end-all") return json({ ok: true, ended: 0 });
      if (route === "grant-next") return json({ ok: true, steps });
      if (route === "grant-check") return json({ ok: true, active: true });
      if (route === "grant-merge-attempt") return json({ ok: true, pullRequest: 22 });
      if (route === "worktree-root") return json({ ok: true, root: "C:\\repo" });
      if (route === "grant-follow-ups") return json({ ok: true, batches });
      if (route === "queue-next") return json({ ok: true, starts: [{ repositoryId: repoA, taskId: "T-9" }] });
      return json({ ok: true });
    },
  });
  runner.start();
  return { state, calls, launches, written, writes, commands, tick: () => timer(), routes: () => calls.map((call) => call.route) };
}

const batch = { repositoryId: repoA, grant: 2, through: 40, followUps: true, items: [{ kind: "grant_merge", task: "T-5", provider: null }], more: 0, ended: null };

test("with Aril Off the grant runner asks for nothing, does nothing, and the owner's own queue still runs", async () => {
  const h = harness({ on: false, steps: Object.values(STEPS), batches: [batch] });
  await h.tick();
  assert.deepEqual(h.launches, [{ kind: "queue", taskId: "T-9" }], "only the queue's own start ran");
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.written, []);
  const routes = h.routes();
  for (const route of ["grant-next", "grant-send-back", "grant-done", "grant-merge-attempt", "grant-record", "grant-end", "grant-check", "grant-follow-ups", "grant-follow-up-ack"]) {
    assert.equal(routes.includes(route), false, `${route} must not be reached while Aril is Off`);
  }
  assert.ok(routes.includes("queue-next"));
});

test("a runner given no switch treats Aril as Off", async () => {
  const h = harness({ omitSwitch: true, steps: Object.values(STEPS), batches: [batch] });
  await h.tick();
  assert.equal(h.routes().includes("grant-next"), false);
  assert.deepEqual(h.launches, [{ kind: "queue", taskId: "T-9" }]);
});

test("with Aril On every kind of step runs, so the Off tests below stop something real", async () => {
  const h = harness({ steps: Object.values(STEPS), batches: [batch] });
  await h.tick();
  assert.deepEqual(h.launches.map(({ kind, taskId }) => `${kind}:${taskId}`).sort(), ["queue:T-9", "review:T-2", "start:T-1"]);
  assert.deepEqual(h.writes, [{ repositoryId: repoA, plans: ["docs/plan.md"] }]);
  for (const route of Object.values(REACHES)) assert.ok(h.routes().includes(route), route);
  assert.ok(h.routes().includes("grant-record"));
  assert.equal(h.written.length, 1, "the follow-up line is written");
});

for (const kind of Object.keys(STEPS)) {
  test(`${kind}: Aril turned Off while the step is offered stops it before it runs`, async () => {
    const h = harness({ steps: [STEPS[kind]], hook: (route, state) => { if (route === "grant-next") state.on = false; } });
    await h.tick();
    assert.deepEqual(h.launches, [{ kind: "queue", taskId: "T-9" }], "no grant start or review");
    assert.deepEqual(h.writes, []);
    const routes = h.routes();
    for (const route of Object.values(REACHES)) assert.equal(routes.includes(route), false, route);
    assert.equal(routes.includes("grant-record"), false);
  });
}

test("Aril turned Off after a first step stops the second step", async () => {
  const h = harness({ steps: [{ ...STEPS.start }, { ...STEPS.start, taskId: "T-7" }, STEPS.mark_done], start: async ({ kind }) => { if (kind === "start") h.state.on = false; return { status: "started" }; } });
  await h.tick();
  assert.deepEqual(h.launches.filter(({ kind }) => kind === "start"), [{ kind: "start", taskId: "T-1" }]);
  assert.equal(h.routes().includes("grant-done"), false);
  // The session that did start is recorded: Off ends no session and hides none.
  assert.deepEqual(h.calls.filter((call) => call.route === "grant-record").map((call) => call.body), [{ repositoryId: repoA, taskId: "T-1", kind: "start" }]);
});

test("the authorization a step asks before it launches refuses at once when Aril is Off, and asks the monitor nothing", async () => {
  let authorized;
  const h = harness({ steps: [STEPS.start], start: async (_step, check) => { authorized = check; return { status: "started" }; } });
  await h.tick();
  const checksBefore = h.routes().filter((route) => route === "grant-check").length;
  assert.equal(await authorized(), true, "On: the monitor says the grant is active");
  h.state.on = false;
  assert.equal(await authorized(), false, "Off: refused");
  assert.equal(h.routes().filter((route) => route === "grant-check").length, checksBefore + 1, "Off asked the monitor nothing");
});

test("a merge asks the switch at every command: Off between the attempt and the command merges nothing", async () => {
  // The attempt is recorded, then the repository's folder is read; Aril goes Off there, before `gh pr merge`.
  const h = harness({ steps: [STEPS.merge], hook: (route, state) => { if (route === "worktree-root") state.on = false; } });
  await h.tick();
  assert.ok(h.routes().includes("grant-merge-attempt"));
  assert.deepEqual(h.commands, [], "no gh command ran");
});

test("a branch delete asks the switch before it reads GitHub and before the delete", async () => {
  const h = harness({ steps: [STEPS.delete_branch], hook: (route, state) => { if (route === "worktree-root") state.on = false; } });
  await h.tick();
  assert.deepEqual(h.commands, []);
  assert.equal(h.routes().includes("grant-branch-result"), false, "a stopped delete records nothing");
});

test("the grant's chat lines wait while Aril is Off and are written when it is On again", async () => {
  const h = harness({ on: false, batches: [batch] });
  await h.tick();
  assert.deepEqual(h.written, []);
  assert.equal(h.routes().includes("grant-follow-up-ack"), false, "nothing is acknowledged, so nothing is lost");
  h.state.on = true;
  await h.tick();
  assert.equal(h.written.length, 1);
  assert.ok(h.routes().includes("grant-follow-up-ack"));
});

test("a restart reads the switch again: the runner of a new run starts with whatever the switch holds", async () => {
  const off = harness({ on: false, steps: [STEPS.start] });
  await off.tick();
  assert.equal(off.routes().includes("grant-next"), false);
  const on = harness({ on: true, steps: [STEPS.start] });
  await on.tick();
  assert.ok(on.routes().includes("grant-next"));
});
