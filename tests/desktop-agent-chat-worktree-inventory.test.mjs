// The cached facts of the task worktrees that an Aril turn reads: a read never waits, a repository with no cache starts one read in the background,
// an old cache is read again in the background, one repository at a time, and the facts of every board are read after start. Everything runs on
// fakes: no Git, no folder walk, no timer.

import assert from "node:assert/strict";
import test from "node:test";

import { createWorktreeInventory, prefetchWorktreeFacts } from "../desktop/runtime/agent-chat-worktrees.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const otherRepositoryId = "repo-fedcba9876543210fedcba98";
const repositoryRoot = "/work/repo";
const MINUTE = 60_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const fact = (taskId, extra = {}) => ({ taskId, clean: true, uniqueCommits: false, ...extra });

/** Fake worktrees: `facts` and `walks` answer the next call (a function returning a value or a promise); every call is counted. */
function fakeWorktrees({ facts = () => [fact("T-1"), fact("T-2")], walks = () => [{ taskId: "T-1", sizeMB: 4, atLeast: false }, { taskId: "T-2", sizeMB: 9.5, atLeast: true }] } = {}) {
  const calls = { inventory: [], sizes: [] };
  const listeners = new Set();
  return {
    calls, listeners,
    worktrees: {
      inventory: async (request) => { calls.inventory.push(request); return facts(calls.inventory.length); },
      sizes: async (request) => { calls.sizes.push(request); return walks(calls.sizes.length); },
      onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
  };
}

function clockAt(start = 1_000_000) {
  const clock = { time: start, now: () => clock.time };
  return clock;
}

const request = (extra = {}) => ({ repositoryRoot, repositoryId, tasks: [], columns: [], ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(check) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("The condition was not met.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Reads once to start the first read, then until the Git facts are stored. */
async function warmed(inventory, extra = {}) {
  inventory.read(request(extra));
  await until(() => inventory.read(request(extra)).rows !== null);
  return inventory.read(request(extra));
}

test("a read with no cache answers at once with nothing known, starts exactly one read, and the next read sees the rows", async () => {
  const gate = deferred();
  const fake = fakeWorktrees({ facts: () => gate.promise, walks: () => new Promise(() => {}) });
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clockAt().now });
  const cold = inventory.read(request());
  assert.deepEqual(cold, { rows: null, readAt: null }, "nothing is known, which is not the same as no worktrees");
  assert.deepEqual(inventory.read(request()), { rows: null, readAt: null });
  assert.deepEqual(fake.calls.inventory, [{ repositoryRoot, repositoryId }], "one read for two cold reads");

  gate.resolve([fact("T-1"), fact("T-2")]);
  await until(() => inventory.read(request()).rows !== null);
  const next = inventory.read(request());
  assert.deepEqual(next.rows.map(({ taskId, clean, uniqueCommits, sizeMB, atLeast }) => [taskId, clean, uniqueCommits, sizeMB, atLeast]), [["T-1", true, false, null, false], ["T-2", true, false, null, false]],
    "the Git facts, with sizes unknown while the walk still runs");
  assert.equal(next.readAt, 1_000_000);
  await until(() => fake.calls.sizes.length === 1);
  assert.equal(fake.calls.inventory.length, 1);
});

test("the sizes arrive in the background, and a cached read calls neither Git nor a walk", async () => {
  const walk = deferred();
  const fake = fakeWorktrees({ walks: () => walk.promise });
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clockAt().now });
  const first = await warmed(inventory);
  assert.deepEqual(first.rows.map(({ sizeMB }) => sizeMB), [null, null]);
  await until(() => fake.calls.sizes.length === 1);
  walk.resolve([{ taskId: "T-1", sizeMB: 4, atLeast: false }, { taskId: "T-2", sizeMB: 9.5, atLeast: true }]);
  await settle();
  const third = inventory.read(request());
  assert.deepEqual(third.rows.map(({ sizeMB, atLeast }) => [sizeMB, atLeast]), [[4, false], [9.5, true]]);
  assert.equal(third.readAt, 1_000_000, "the sizes do not change when the Git facts were read");
  assert.equal(fake.calls.inventory.length + fake.calls.sizes.length, 2, "a cached read calls neither Git nor a walk");
});

test("a cached read answers at once and calls nothing, whatever the board says", async () => {
  const fake = fakeWorktrees();
  const clock = clockAt();
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clock.now });
  await warmed(inventory);
  await settle();
  const before = [fake.calls.inventory.length, fake.calls.sizes.length];
  // A hanging Git or walk could not delay a read now: these fakes would never answer.
  fake.worktrees.inventory = () => new Promise(() => {});
  fake.worktrees.sizes = () => new Promise(() => {});
  clock.time += MINUTE;
  const read = inventory.read(request({
    tasks: [{ id: "T-1", state: "done", columnId: "col-done" }, { id: "T-9", state: "queued", columnId: "col-x" }],
    columns: [{ id: "col-done", name: "Done" }],
  }));
  assert.deepEqual(read.rows.map(({ taskId, state, column, sizeMB }) => [taskId, state, column, sizeMB]), [["T-1", "done", "Done", 4], ["T-2", "not on board", "not on board", 9.5]],
    "the state and the column come from the board of this turn, not from the cache");
  assert.deepEqual([before[0], before[1]], [1, 1]);
  assert.equal(Object.keys(read.rows[0]).sort().join(), "atLeast,clean,column,sizeMB,state,taskId,uniqueCommits");
});

test("a cache older than a few minutes starts exactly one background refresh, and concurrent reads start no second", async () => {
  const gate = deferred();
  let round = 0;
  const fake = fakeWorktrees({ facts: () => { round += 1; return round === 1 ? [fact("T-1"), fact("T-2")] : gate.promise; } });
  const clock = clockAt();
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clock.now });
  await warmed(inventory);
  await settle();
  assert.equal(fake.calls.inventory.length, 1);

  clock.time += 2 * MINUTE;
  inventory.read(request());
  assert.equal(fake.calls.inventory.length, 1, "two minutes old is still fresh");

  clock.time += 2 * MINUTE;
  const reads = [inventory.read(request()), inventory.read(request()), inventory.read(request())];
  assert.equal(fake.calls.inventory.length, 2, "four minutes old: one refresh, held by the gate");
  for (const read of reads) assert.deepEqual(read.rows.map(({ taskId, sizeMB }) => [taskId, sizeMB]), [["T-1", 4], ["T-2", 9.5]], "the old rows, sizes kept, answered at once");
  inventory.read(request());
  assert.equal(fake.calls.inventory.length, 2, "a turn while it runs starts no other");

  gate.resolve([fact("T-2", { clean: false })]);
  await until(() => fake.calls.sizes.length === 2);
  await settle();
  const fresh = inventory.read(request());
  assert.deepEqual(fresh.rows.map(({ taskId, clean }) => [taskId, clean]), [["T-2", false]]);
  assert.equal(fresh.readAt, clock.time);
  assert.equal(fake.calls.inventory.length, 2);
  assert.equal(fake.calls.sizes.length, 2);
});

test("a refresh keeps the last known size of a row until its own walk ends, and two walks never run together", async () => {
  const walk = deferred();
  let round = 0;
  const fake = fakeWorktrees({ walks: () => { round += 1; return round === 1 ? [{ taskId: "T-1", sizeMB: 4, atLeast: false }] : walk.promise; } });
  const clock = clockAt();
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clock.now });
  await warmed(inventory);
  await until(() => fake.calls.sizes.length === 1);
  await settle();
  clock.time += 4 * MINUTE;
  inventory.read(request());
  await until(() => fake.calls.sizes.length === 2);
  // The second walk is running, and a change makes the cache out of date at once: the row shows the size of the first walk, and a read
  // starts nothing until the walk ends.
  clock.time += 30_000;
  inventory.changed(repositoryId);
  const during = inventory.read(request());
  assert.deepEqual(during.rows.map(({ taskId, sizeMB }) => [taskId, sizeMB]), [["T-1", 4], ["T-2", null]]);
  assert.equal(fake.calls.inventory.length, 2);
  assert.equal(fake.calls.sizes.length, 2);
  walk.resolve([{ taskId: "T-1", sizeMB: 5, atLeast: false }]);
  await settle();
  assert.deepEqual(inventory.read(request()).rows.map(({ sizeMB }) => sizeMB), [5, null]);
  assert.equal(fake.calls.inventory.length, 3, "after the walk the old cache is read again");
});

test("a refresh that hangs is given up on after a minute, and what it answers later is dropped", async () => {
  const hung = deferred();
  let round = 0;
  const fake = fakeWorktrees({ facts: () => { round += 1; return round === 2 ? hung.promise : round === 1 ? [fact("T-1")] : [fact("T-1"), fact("T-3")]; }, walks: () => new Promise(() => {}) });
  const clock = clockAt();
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clock.now });
  await warmed(inventory);
  await until(() => fake.calls.sizes.length === 1);
  // The walk never ends. A change makes the cache out of date at once, but a walk of ten seconds is not yet given up on.
  clock.time += 10_000;
  inventory.changed(repositoryId);
  inventory.read(request());
  assert.equal(fake.calls.inventory.length, 1);
  // At a minute it is, and the new refresh hangs too.
  clock.time += MINUTE;
  inventory.read(request());
  assert.equal(fake.calls.inventory.length, 2);
  clock.time += MINUTE;
  inventory.read(request());
  assert.equal(fake.calls.inventory.length, 3, "the hung refresh is given up on in its turn");
  await settle();
  assert.deepEqual(inventory.read(request()).rows.map(({ taskId }) => taskId), ["T-1", "T-3"]);
  hung.resolve([fact("T-77")]);
  await settle();
  assert.deepEqual(inventory.read(request()).rows.map(({ taskId }) => taskId), ["T-1", "T-3"], "the answer of a refresh given up on is dropped");
});

test("repositories do not share a cache, and a repository with no worktrees is known, not pending", async () => {
  const fake = fakeWorktrees({ facts: () => [] });
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clockAt().now });
  assert.deepEqual((await warmed(inventory)).rows, [], "an empty list is an answer");
  assert.deepEqual(inventory.read(request({ repositoryId: otherRepositoryId })), { rows: null, readAt: null });
  assert.deepEqual(fake.calls.inventory.map((call) => call.repositoryId), [repositoryId, otherRepositoryId]);
});

test("Git facts that cannot be read keep nothing, raise nothing, and the next read tries again", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    let round = 0;
    const fake = fakeWorktrees({ facts: () => { round += 1; if (round === 1) throw new Error("git failed: C:\\private"); return [fact("T-1")]; } });
    const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clockAt().now });
    assert.deepEqual(inventory.read(request()), { rows: null, readAt: null });
    await until(() => fake.calls.inventory.length === 1);
    await settle();
    assert.equal(fake.calls.sizes.length, 0, "no walk without facts");
    assert.deepEqual(inventory.read(request()), { rows: null, readAt: null }, "nothing was kept, and this read starts the next try");
    await until(() => inventory.read(request()).rows !== null);
    assert.deepEqual(inventory.read(request()).rows.map(({ taskId }) => taskId), ["T-1"]);
    assert.equal(fake.calls.inventory.length, 2);
    await settle();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a refresh that fails leaves the last facts, raises nothing, and the next read tries again", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    let round = 0;
    const fake = fakeWorktrees({ facts: () => { round += 1; if (round === 2) throw new Error("git failed"); return [fact("T-1")]; }, walks: () => { throw new Error("walk failed"); } });
    const clock = clockAt();
    const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clock.now });
    await warmed(inventory);
    await settle();
    clock.time += 5 * MINUTE;
    assert.deepEqual(inventory.read(request()).rows.map(({ taskId, sizeMB }) => [taskId, sizeMB]), [["T-1", null]]);
    await settle();
    assert.deepEqual(inventory.read(request()).rows.map(({ taskId }) => taskId), ["T-1"], "still the last facts");
    assert.equal(fake.calls.inventory.length, 3, "the failed refresh was tried again on the next read");
    await settle();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a worktree without a size walk leaves every size unknown", async () => {
  const inventory = createWorktreeInventory({ worktrees: { inventory: async () => [fact("T-1")] }, now: clockAt().now });
  assert.deepEqual((await warmed(inventory)).rows.map(({ sizeMB, atLeast }) => [sizeMB, atLeast]), [[null, false]]);
});

test("a change removes the row of a removed worktree at once and sends the next read to a new refresh, even one that began earlier", async () => {
  const gate = deferred();
  let round = 0;
  const fake = fakeWorktrees({ facts: () => { round += 1; return round === 2 ? gate.promise : [fact("T-1"), fact("T-2"), fact("T-3")]; } });
  const clock = clockAt();
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clock.now });
  await warmed(inventory);
  await settle();
  inventory.changed(repositoryId, "T-2");
  assert.deepEqual(inventory.read(request()).rows.map(({ taskId }) => taskId), ["T-1", "T-3"], "the removed row is gone before any new read");
  assert.equal(fake.calls.inventory.length, 2);

  // The change came while that refresh was running; its answer still lists T-2, so it cannot satisfy the next read.
  inventory.changed(repositoryId, "T-3");
  gate.resolve([fact("T-1"), fact("T-2"), fact("T-3")]);
  await settle();
  assert.equal(fake.calls.inventory.length, 2);
  inventory.read(request());
  assert.equal(fake.calls.inventory.length, 3, "the refresh that began before the change is out of date at once");
  await settle();
  assert.equal(inventory.read(request()).rows.length, 3);
  assert.equal(fake.calls.inventory.length, 3, "and the newest answer is not");

  // Nothing changes for a repository nobody read, and a change without a task only asks for a new read.
  inventory.changed(otherRepositoryId, "T-1");
  inventory.changed(repositoryId);
  assert.equal(inventory.read(request()).rows.length, 3);
  assert.equal(fake.calls.inventory.length, 4);
});

test("the worktrees' own changes reach the cache until it is closed", async () => {
  const fake = fakeWorktrees();
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clockAt().now });
  await warmed(inventory);
  await settle();
  assert.equal(fake.listeners.size, 1);
  for (const listener of fake.listeners) listener(repositoryId, "T-1");
  assert.deepEqual(inventory.read(request()).rows.map(({ taskId }) => taskId), ["T-2"]);
  inventory.close();
  assert.equal(fake.listeners.size, 0);
});

/** Timers the test fires by hand: `fire(delay)` runs the callbacks set for that delay. */
function fakeTimers() {
  const waiting = [];
  return {
    waiting,
    setTimer: (callback, delay) => { const timer = { callback, delay, cleared: false, unref() {} }; waiting.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    fire: (delay) => { for (const timer of waiting.filter((entry) => entry.delay === delay && !entry.cleared)) { timer.cleared = true; timer.callback(); } },
  };
}

test("the prefetch reads the facts of every board after its delay, one repository at a time, and retries a repository whose root is not known yet", async () => {
  const timers = fakeTimers();
  const gate = deferred();
  const order = [];
  const fake = fakeWorktrees({ facts: (round) => { order.push(`inventory ${round}`); return round === 1 ? gate.promise : [fact("T-1")]; } });
  const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clockAt().now });
  let knownRoot = { [repositoryId]: repositoryRoot };
  const prefetch = prefetchWorktreeFacts({
    inventory, delaysMs: [100, 1_000], setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    readHome: async () => ({ boards: [{ repositoryId }, { repositoryId: otherRepositoryId }, { repositoryId: "repo-short" }, null] }),
    rootOf: async (id) => knownRoot[id] ?? null,
  });
  assert.deepEqual(timers.waiting.map(({ delay }) => delay), [100, 1_000]);
  await settle();
  assert.deepEqual(fake.calls.inventory, [], "nothing is read before the delay: desktop main starts first");

  timers.fire(100);
  await until(() => fake.calls.inventory.length === 1);
  await settle();
  assert.deepEqual(fake.calls.inventory, [{ repositoryRoot, repositoryId }], "the first repository is being read, and the second waits for it");
  gate.resolve([fact("T-1")]);
  await until(() => inventory.read(request()).rows !== null);
  assert.deepEqual(inventory.read(request()).rows.map(({ taskId }) => taskId), ["T-1"], "a first turn finds the rows");
  await settle();
  assert.deepEqual(fake.calls.inventory.map((call) => call.repositoryId), [repositoryId], "the other repository has no known root yet");

  knownRoot = { ...knownRoot, [otherRepositoryId]: "/work/other" };
  timers.fire(1_000);
  await until(() => fake.calls.inventory.length === 2);
  assert.deepEqual(fake.calls.inventory.map((call) => call.repositoryId), [repositoryId, otherRepositoryId], "tried again at the next delay, and the first one is not read twice");
  prefetch.cancel();
});

test("a prefetch that is cancelled, or whose home cannot be read, reads nothing and raises nothing", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const timers = fakeTimers();
    const fake = fakeWorktrees();
    const inventory = createWorktreeInventory({ worktrees: fake.worktrees, now: clockAt().now });
    const cancelled = prefetchWorktreeFacts({ inventory, delaysMs: [10], setTimer: timers.setTimer, clearTimer: timers.clearTimer, readHome: async () => ({ boards: [{ repositoryId }] }), rootOf: async () => repositoryRoot });
    cancelled.cancel();
    timers.fire(10);
    prefetchWorktreeFacts({ inventory, delaysMs: [20], setTimer: timers.setTimer, clearTimer: timers.clearTimer, readHome: async () => { throw new Error("monitor down"); }, rootOf: async () => repositoryRoot });
    timers.fire(20);
    prefetchWorktreeFacts({ inventory, delaysMs: [30], setTimer: timers.setTimer, clearTimer: timers.clearTimer, readHome: async () => ({ boards: [{ repositoryId }] }), rootOf: async () => { throw new Error("root failed"); } });
    timers.fire(30);
    await settle();
    assert.deepEqual(fake.calls.inventory, []);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});
