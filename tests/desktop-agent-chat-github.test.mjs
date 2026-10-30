// The repository's GitHub settings that an Aril turn reads, kept warm in the background: a refresh comes 25 minutes after a read, a failed
// refresh keeps the last facts and backs off, a repository with no message for 2 hours is let go, one refresh runs at a time, and the
// repositories Aril was used for are read after start. Everything runs on a fake `gh`, a fake clock, and timers the test fires by hand.

import assert from "node:assert/strict";
import test from "node:test";

import { createGithubKeeper, prefetchGithubSettings } from "../desktop/runtime/agent-chat-github.mjs";
import { createRepositoryGithub } from "../desktop/runtime/repository-github.mjs";
import { agentMessage, chatHarness, repositoryId, root, seed, send, stamp, until, userMessage } from "./helpers/agent-chat-harness.mjs";

const repoA = "repo-0123456789abcdef01234567";
const repoB = "repo-fedcba987654321001234567";
const MINUTE = 60_000;
const repoJson = (over = {}) => JSON.stringify({
  squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: false,
  defaultBranchRef: { name: "main" }, ...over,
});
const FACTS = { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: false, defaultBranch: "main" };
const OFFLINE = { error: Object.assign(new Error("offline"), { code: 1 }) };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Timers the test fires by hand: `fire()` moves the clock to the earliest live timer, runs it, and lets what it started finish. */
function fakeClock(start = 1_000_000) {
  const clock = { now: start, timers: [] };
  clock.setTimer = (callback, delay) => {
    const timer = { callback, delay, dueAt: clock.now + delay, cleared: false, fired: false, unrefs: 0, unref() { this.unrefs += 1; } };
    clock.timers.push(timer);
    return timer;
  };
  clock.clearTimer = (timer) => { timer.cleared = true; };
  clock.live = () => clock.timers.filter((timer) => !timer.cleared && !timer.fired);
  clock.fire = async () => {
    const [timer] = clock.live().sort((left, right) => left.dueAt - right.dueAt);
    clock.now = Math.max(clock.now, timer.dueAt);
    timer.fired = true;
    timer.callback();
    await settle();
    return timer;
  };
  return clock;
}

/** The real reader on a fake `gh`: each `answers` entry is the next command's outcome, `{ error }`, `{ stdout }`, or one held by `gate`. */
function world({ answers = [], keeper: keeperOptions = {} } = {}) {
  const clock = fakeClock();
  const calls = [];
  const queue = [...answers];
  const github = createRepositoryGithub({
    now: () => clock.now,
    execFile: (_executable, _args, options, callback) => {
      calls.push(options.cwd);
      const answer = queue.shift() ?? {};
      void Promise.resolve(answer.gate?.promise).then(() => callback(answer.error ?? null, answer.error ? "" : answer.stdout ?? repoJson()));
    },
  });
  const keeper = createGithubKeeper({ github, now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...keeperOptions });
  return { clock, calls, github, keeper };
}

test("a message's read tracks the repository, and a refresh comes 25 minutes after the facts were read, then every 25 minutes", async () => {
  const w = world();
  assert.deepEqual(await w.keeper.read(repoA, "C:\\a"), FACTS);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [25 * MINUTE]);
  assert.equal(w.clock.live()[0].unrefs, 1, "the timer does not keep the process alive");

  await w.clock.fire();
  assert.deepEqual(w.calls, ["C:\\a", "C:\\a"], "the refresh read the repository's own folder");
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [25 * MINUTE]);
  await w.clock.fire();
  assert.equal(w.calls.length, 3);
  assert.equal(w.clock.live()[0].unrefs, 1);

  // 79 minutes after the first read, but 29 after the last refresh: the message finds the facts and starts no read.
  w.clock.now += 29 * MINUTE;
  assert.deepEqual(await w.keeper.read(repoA, "C:\\a"), FACTS);
  assert.equal(w.calls.length, 3, "a warm cache is never waited for");
});

test("a message that finds an old cache does not push the refresh back, and re-arms one timer", async () => {
  const w = world();
  await w.keeper.read(repoA, "C:\\a");
  w.clock.now += 20 * MINUTE;
  await w.keeper.read(repoA, "C:\\a");
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [5 * MINUTE], "5 minutes left of the 25, from when the facts were read");
  assert.equal(w.clock.timers.filter(({ cleared }) => cleared).length, 1, "the first timer was cleared, not left beside the second");
  await w.clock.fire();
  assert.equal(w.calls.length, 2);
  assert.equal(w.clock.now - 1_000_000, 25 * MINUTE);
});

test("a failed refresh keeps the last facts and backs off, and the next good one replaces them", async () => {
  const w = world({ answers: [{}, OFFLINE, OFFLINE, { stdout: repoJson({ autoMergeAllowed: false }) }] });
  await w.keeper.read(repoA, "C:\\a");
  await w.clock.fire();
  assert.equal(w.calls.length, 2);
  assert.equal(w.github.age(repoA), 25 * MINUTE, "the failed refresh did not clear what was held");
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [2 * MINUTE], "the first retry comes in 2 minutes");

  w.clock.now += 1 * MINUTE;
  assert.deepEqual(await w.keeper.read(repoA, "C:\\a"), FACTS, "a message in between gets the held facts at once");
  assert.equal(w.calls.length, 2, "and starts no read");
  assert.equal(w.clock.live().length, 1, "and does not move the retry");
  assert.equal(w.clock.live()[0].dueAt - w.clock.now, 1 * MINUTE, "which is still due at 27 minutes");

  await w.clock.fire();
  assert.equal(w.calls.length, 3);
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [4 * MINUTE], "the second retry waits twice as long");
  await w.clock.fire();
  assert.equal(w.calls.length, 4);
  assert.equal(w.github.age(repoA), 0);
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [25 * MINUTE]);
  assert.equal((await w.keeper.read(repoA, "C:\\a")).autoMergeAllowed, false);
  assert.equal(w.calls.length, 4);
});

test("a refresh that throws is swallowed, and the waits back off to the length of a refresh and stay there", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const clock = fakeClock();
    const github = { read: async () => FACTS, refresh: async () => { throw new Error("gh exploded"); }, age: () => null };
    const keeper = createGithubKeeper({ github, now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await keeper.read(repoA, "C:\\a");
    const delays = [clock.live()[0].delay];
    for (let round = 0; round < 5; round += 1) { await clock.fire(); delays.push(clock.live()[0].delay); }
    assert.deepEqual(delays, [2, 4, 8, 16, 25, 25].map((minutes) => minutes * MINUTE));
    await settle();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a repository with no message for 2 hours is let go: four refreshes, then nothing", async () => {
  const w = world();
  await w.keeper.read(repoA, "C:\\a");
  for (let round = 0; round < 4; round += 1) await w.clock.fire();
  assert.equal(w.calls.length, 5, "25, 50, 75, and 100 minutes");
  assert.equal(w.clock.live().length, 1);

  await w.clock.fire();
  assert.equal(w.calls.length, 5, "at 125 minutes the repository is dropped without a read");
  assert.deepEqual(w.clock.live(), []);

  // The next message reads and waits once, as before the keeper, and tracks the repository again.
  w.clock.now += 5 * MINUTE;
  await w.keeper.read(repoA, "C:\\a");
  assert.equal(w.calls.length, 6);
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [25 * MINUTE]);
});

test("a message keeps the repository in use past the 2 hours", async () => {
  const w = world();
  await w.keeper.read(repoA, "C:\\a");
  for (let round = 0; round < 4; round += 1) await w.clock.fire();
  w.clock.now += 10 * MINUTE;
  await w.keeper.read(repoA, "C:\\a");
  assert.equal(w.calls.length, 5, "the cache was 10 minutes old");
  await w.clock.fire();
  assert.equal(w.clock.now - 1_000_000, 125 * MINUTE);
  assert.equal(w.calls.length, 6, "and the refresh at 125 minutes ran, because a message came at 110");
});

test("one refresh runs for a repository at a time, and a message during it neither waits nor starts a second timer", async () => {
  const gate = deferred();
  const w = world({ answers: [{}, { gate }] });
  await w.keeper.read(repoA, "C:\\a");
  await w.clock.fire();
  assert.equal(w.calls.length, 2);
  assert.deepEqual(w.clock.live(), [], "no timer waits while the refresh runs");

  const reading = w.keeper.read(repoA, "C:\\a");
  assert.deepEqual(await reading, FACTS, "the message still gets the held facts at once");
  assert.equal(w.calls.length, 2);
  assert.deepEqual(w.clock.live(), []);

  gate.resolve();
  await settle();
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [25 * MINUTE], "one timer, set when the refresh ended");
});

test("two repositories have their own timers, folders, and idle clocks", async () => {
  const w = world();
  await w.keeper.read(repoA, "C:\\a");
  w.clock.now += 10 * MINUTE;
  await w.keeper.read(repoB, "C:\\b");
  assert.deepEqual(w.clock.live().map(({ dueAt }) => dueAt - w.clock.now), [15 * MINUTE, 25 * MINUTE], "each is 25 minutes after its own repository's read");
  await w.clock.fire();
  assert.deepEqual(w.calls.slice(2), ["C:\\a"], "the earlier one first");
  await w.clock.fire();
  assert.deepEqual(w.calls.slice(2), ["C:\\a", "C:\\b"]);
});

test("a reader without a refresh is passed through, with no timer", async () => {
  const clock = fakeClock();
  const keeper = createGithubKeeper({ github: { read: async (id, folder) => ({ id, folder }) }, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.deepEqual(await keeper.read(repoA, "C:\\a"), { id: repoA, folder: "C:\\a" });
  keeper.seed(repoA, "C:\\a", Date.now());
  assert.deepEqual(clock.timers, []);
  await assert.rejects(createGithubKeeper({ github: { read: async () => { throw new Error("offline"); } } }).read(repoA, "C:\\a"), /offline/u, "a failed read reaches the preparation, which leaves the section unknown");
});

test("closing clears every timer, and nothing is armed afterwards, not even by a refresh that was running", async () => {
  const gate = deferred();
  const w = world({ answers: [{}, {}, { gate }] });
  await w.keeper.read(repoA, "C:\\a");
  await w.keeper.read(repoB, "C:\\b");
  await w.clock.fire();
  assert.equal(w.clock.live().length, 1);
  w.keeper.close();
  assert.deepEqual(w.clock.live(), []);
  gate.resolve();
  await settle();
  assert.deepEqual(w.clock.live(), [], "the refresh that was running armed nothing");
  const calls = w.calls.length;
  assert.deepEqual(await w.keeper.read(repoA, "C:\\a"), FACTS, "a read after closing is the reader's own");
  w.keeper.seed(repoB, "C:\\b", w.clock.now);
  assert.deepEqual(w.clock.live(), []);
  assert.equal(w.calls.length, calls);
});

test("a seeded repository is read at once, once, and is let go when its last use is too old", async () => {
  const w = world();
  w.keeper.seed(repoA, "C:\\a", w.clock.now - 10 * MINUTE);
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [0]);
  w.keeper.seed(repoA, "C:\\other", w.clock.now);
  assert.equal(w.clock.live().length, 1, "a repository that is tracked is not seeded again");
  await w.clock.fire();
  assert.deepEqual(w.calls, ["C:\\a"]);
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [25 * MINUTE]);

  w.keeper.seed(repoB, "C:\\b", w.clock.now - 3 * 60 * MINUTE);
  await w.clock.fire();
  assert.deepEqual(w.calls, ["C:\\a"], "an old use reads nothing");
  assert.equal(w.clock.live().length, 1, "and arms nothing");
});

test("a seeded repository whose reader already holds good facts waits for their age", async () => {
  const w = world();
  await w.github.read(repoA, "C:\\a");
  w.clock.now += 10 * MINUTE;
  w.keeper.seed(repoA, "C:\\a", w.clock.now);
  assert.deepEqual(w.clock.live().map(({ delay }) => delay), [15 * MINUTE]);
  assert.equal(w.calls.length, 1);
});

/** The prefetch on a fake store and fake timers: it tracks the repositories whose newest complete answer is recent. */
function prefetchWorld({ metas = {}, roots = {}, home = async () => ({ boards: Object.keys(metas).map((id) => ({ repositoryId: id })) }), nowAt = 10_000_000 } = {}) {
  const clock = fakeClock();
  const seeds = [];
  const looked = [];
  const prefetch = prefetchGithubSettings({
    keeper: { seed: (...args) => seeds.push(args) }, readHome: home, store: { index: async (id) => metas[id] ?? [] },
    rootOf: async (id) => { looked.push(id); return roots[id] ?? null; },
    now: () => nowAt, delaysMs: [20_000, 90_000], setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  return { clock, seeds, looked, prefetch };
}

test("after its delay the prefetch tracks a repository with a recent answer, with its folder and the time of that answer", async () => {
  const recent = { answeredAt: 10_000_000 - 30 * MINUTE };
  const w = prefetchWorld({
    metas: { [repoA]: [{ answeredAt: null }, recent, { answeredAt: 10_000_000 - 50 * MINUTE }], [repoB]: [{ answeredAt: 10_000_000 - 3 * 60 * MINUTE }], "repo-0000000000000000000000ee": [] },
    roots: { [repoA]: "C:\\a", [repoB]: "C:\\b" },
    home: async () => ({ boards: [{ repositoryId: repoA }, { repositoryId: repoB }, { repositoryId: "repo-0000000000000000000000ee" }, { repositoryId: "repo-short" }, null] }),
  });
  assert.deepEqual(w.clock.timers.map(({ delay, unrefs }) => [delay, unrefs]), [[20_000, 1], [90_000, 1]]);
  await settle();
  assert.deepEqual([w.seeds, w.looked], [[], []], "nothing is asked before the delay");

  await w.clock.fire();
  assert.deepEqual(w.seeds, [[repoA, "C:\\a", recent.answeredAt]]);
  assert.deepEqual(w.looked, [repoA], "a repository with no recent answer, and an invalid ID, never ask for a folder");

  await w.clock.fire();
  assert.equal(w.seeds.length, 1, "a repository decided once is not asked again");
});

test("a repository whose folder is not known yet is tried again at the second delay", async () => {
  const roots = {};
  const w = prefetchWorld({ metas: { [repoA]: [{ answeredAt: 10_000_000 - MINUTE }] }, roots });
  await w.clock.fire();
  assert.deepEqual(w.seeds, []);
  roots[repoA] = "C:\\a";
  await w.clock.fire();
  assert.deepEqual(w.seeds.map(([id, folder]) => [id, folder]), [[repoA, "C:\\a"]]);
});

test("a prefetch whose Tasks home or store fails goes on, and cancelling stops the timers that still wait", async () => {
  const failing = prefetchWorld({ home: async () => { throw new Error("monitor down"); } });
  await failing.clock.fire();
  assert.deepEqual(failing.seeds, []);

  const broken = prefetchGithubSettings({
    keeper: { seed() { throw new Error("no"); } }, readHome: async () => ({ boards: [{ repositoryId: repoA }, { repositoryId: repoB }] }),
    store: { index: async (id) => { if (id === repoA) throw new Error("no store"); return [{ answeredAt: 1 }]; } }, rootOf: async () => "C:\\x", now: () => 2,
    delaysMs: [1], setTimer: (callback) => { queueMicrotask(callback); return { unref() {} }; }, clearTimer() {},
  });
  await settle();
  broken.cancel();

  const w = prefetchWorld({ metas: { [repoA]: [{ answeredAt: 10_000_000 }] }, roots: { [repoA]: "C:\\a" } });
  w.prefetch.cancel();
  assert.deepEqual(w.clock.timers.map(({ cleared }) => cleared), [true, true]);
});

// The wiring in the chat controller.
const github = (calls) => {
  let held = false;
  return {
    read: async (id, folder) => { calls.push(["read", id, folder]); held = true; return FACTS; },
    refresh: async (id, folder) => { calls.push(["refresh", id, folder]); held = true; return true; },
    age: () => (held ? 0 : null),
  };
};

test("an Aril message reads through the keeper, which then refreshes ahead of the expiry, until the app closes", async (context) => {
  const clock = fakeClock();
  const calls = [];
  const h = await chatHarness(context, { repositoryGithub: github(calls), githubKeeper: { setTimer: clock.setTimer, clearTimer: clock.clearTimer } });
  assert.deepEqual(clock.timers, [], "nothing is tracked before a message");
  const sent = await send(h);
  assert.equal(sent.ok, true);
  assert.deepEqual(calls, [["read", repositoryId, root]]);
  assert.deepEqual(clock.live().map(({ delay }) => delay), [25 * MINUTE]);

  await clock.fire();
  assert.deepEqual(calls, [["read", repositoryId, root], ["refresh", repositoryId, root]]);
  assert.equal(clock.live().length, 1);
  h.chat.dispose();
  assert.deepEqual(clock.live(), [], "closing the app clears the timer");
});

test("desktop main tracks the repositories Aril was used for a little after it starts, and not the others", async (context) => {
  const prefetchClock = fakeClock();
  const keeperClock = fakeClock();
  const calls = [];
  const h = await chatHarness(context, {
    repositoryGithub: github(calls), githubKeeper: { now: () => Date.parse(stamp) + 60 * MINUTE, setTimer: keeperClock.setTimer, clearTimer: keeperClock.clearTimer },
    prefetchGithub: { delaysMs: [20_000], setTimer: prefetchClock.setTimer, clearTimer: prefetchClock.clearTimer, now: () => Date.parse(stamp) + 60 * MINUTE },
  });
  await seed(h, { messages: [userMessage(1), agentMessage(2)] });
  assert.deepEqual([calls, h.calls], [[], []], "nothing is asked of the monitor or of gh before the delay");

  await prefetchClock.fire();
  await until(() => keeperClock.live().length === 1);
  assert.deepEqual(keeperClock.live().map(({ delay }) => delay), [0]);
  assert.deepEqual(h.calls.map((call) => `${call.pathname}${call.search}`), ["/api/tasks?view=home", "/internal/tasks/worktree-root"]);
  await keeperClock.fire();
  assert.deepEqual(calls, [["refresh", repositoryId, root]]);

  // The first message finds the settings held and reads through the reader as before.
  assert.equal((await send(h)).ok, true);
  assert.deepEqual(calls.at(-1), ["read", repositoryId, root]);
  h.chat.dispose();
  assert.deepEqual([prefetchClock.live(), keeperClock.live()], [[], []]);
});

test("a repository whose last answer is older than 2 hours is left to its first message", async (context) => {
  const prefetchClock = fakeClock();
  const keeperClock = fakeClock();
  const h = await chatHarness(context, {
    repositoryGithub: github([]), githubKeeper: { setTimer: keeperClock.setTimer, clearTimer: keeperClock.clearTimer },
    prefetchGithub: { delaysMs: [20_000], setTimer: prefetchClock.setTimer, clearTimer: prefetchClock.clearTimer, now: () => Date.parse(stamp) + 3 * 60 * MINUTE },
  });
  await seed(h, { messages: [userMessage(1), agentMessage(2)] });
  await prefetchClock.fire();
  await until(() => h.calls.length >= 1);
  await settle();
  assert.deepEqual(h.calls.map((call) => call.pathname), ["/api/tasks"], "only the home was read: no folder was asked for");
  assert.deepEqual(keeperClock.timers, []);
});
