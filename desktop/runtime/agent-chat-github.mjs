// The repository's GitHub merge settings that an owner-message turn reads, kept warm in desktop main so that a turn does not wait for `gh`.
// See [Repository GitHub settings cache](../../docs/internal/architecture/agent-chat.md#repository-github-settings-cache). The reader of
// `repository-github.mjs` keeps a read for 30 minutes and does the reading; this keeper only decides when to read again, for the
// repositories Aril is in use for. It keeps no value of its own, and nothing new is read or sent: the same `gh repo view`, in the same folder.

import { lastAnswer } from "./agent-chat-thread.mjs";

// The reader keeps a read for 30 minutes; the keeper reads again 5 minutes before that ends.
const REFRESH_MS = 25 * 60_000;
// After a failed refresh the first try comes in 2 minutes and each later one waits twice as long, never longer than a refresh: a gh that is
// offline, signed out, or missing costs a few tries, not one every two minutes.
const RETRY_MS = 2 * 60_000;
// A repository with no owner message for 2 hours is let go: that is a break inside a work session, and it bounds the cost of a repository
// the owner left for the day to four refreshes. The next message after it reads once and waits for it, as it did before the keeper.
const IDLE_MS = 2 * 60 * 60_000;
// When desktop main looks for repositories Aril was used for: after the worktree prefetch (10 s) so the two do not start together, and
// again for the repositories the monitor had not located yet.
const PREFETCH_DELAYS_MS = Object.freeze([20_000, 90_000]);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;

/**
 * `read(repositoryId, root)` is the reader's own read. It also marks the repository as used now, and sets the next refresh for 25 minutes
 * after the held facts were read (so a read of a cache that is already old does not push the refresh back). `seed(repositoryId, root, usedAt)`
 * tracks a repository that was used at `usedAt` without a message in this run. Each tracked repository has one timer and at most one refresh
 * running. A refresh that fails keeps the facts the reader holds, and the next try backs off. A repository whose last use is older than
 * `idleMs` when its timer fires is dropped. A reader without `refresh` is passed through. The timers do not keep the process alive, and
 * `close()` clears them.
 */
export function createGithubKeeper({ github, now = Date.now, refreshMs = REFRESH_MS, retryMs = RETRY_MS, idleMs = IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tracked = new Map();
  const keeps = typeof github?.refresh === "function";
  let closed = false;

  // A repository's entry: its folder and last use stay in desktop main's memory, and `failures` counts the tries in a row that stored nothing.
  function track(repositoryId, root, usedAt) {
    let entry = tracked.get(repositoryId);
    if (!entry) { entry = { root, usedAt, timer: null, running: false, failures: 0 }; tracked.set(repositoryId, entry); }
    entry.root = root;
    entry.usedAt = Math.max(entry.usedAt, usedAt);
    return entry;
  }

  const backoff = (entry) => Math.min(refreshMs, retryMs * 2 ** Math.min(entry.failures++, 20));

  // The wait until the next refresh, or null to leave the timer that waits. Facts younger than a refresh are due when they reach that age.
  // Older facts, or none, are due now (`whenNone` for none), unless a timer waits already: a retry that backs off is not pushed forward or
  // back by a message, which is also why a failing gh costs one try for each wait and not one for each message.
  function waitFor(repositoryId, entry, whenNone = null) {
    const age = github.age?.(repositoryId) ?? null;
    if (age !== null && age < refreshMs) { entry.failures = 0; return refreshMs - age; }
    if (entry.timer) return null;
    return age !== null ? 0 : whenNone ?? backoff(entry);
  }

  function arm(repositoryId, entry, delayMs) {
    if (delayMs === null || closed || entry.running || tracked.get(repositoryId) !== entry) return;
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = setTimer(() => { entry.timer = null; void tick(repositoryId, entry); }, Math.max(0, delayMs));
    entry.timer?.unref?.();
  }

  // The timer fired: reads again, unless the repository has been idle for too long.
  async function tick(repositoryId, entry) {
    if (closed || tracked.get(repositoryId) !== entry || entry.running) return;
    if (now() - entry.usedAt > idleMs) { tracked.delete(repositoryId); return; }
    entry.running = true;
    let stored = false;
    try { stored = await github.refresh(repositoryId, entry.root) === true; } catch { /* The facts the reader holds stay. */ }
    entry.running = false;
    if (stored) entry.failures = 0;
    arm(repositoryId, entry, stored ? refreshMs : backoff(entry));
  }

  return Object.freeze({
    async read(repositoryId, root) {
      if (!keeps || closed) return github.read(repositoryId, root);
      const entry = track(repositoryId, root, now());
      try { return await github.read(repositoryId, root); } finally { if (!entry.running) arm(repositoryId, entry, waitFor(repositoryId, entry)); }
    },
    seed(repositoryId, root, usedAt) {
      if (!keeps || closed || tracked.has(repositoryId)) return;
      const entry = track(repositoryId, root, usedAt);
      arm(repositoryId, entry, waitFor(repositoryId, entry, 0));
    },
    /**
     * The owner opened the chat of the repository (the `warm` request). Never awaited by a turn, and it never rejects. Facts younger than a
     * refresh need no read; a refresh that runs, or a retry that waits after a failure, is left alone. Otherwise it reads now (a read already
     * running is joined by the reader) and tracks the repository, whose folder `rootOf()` answers when the keeper does not hold it. An
     * open starts the idle clock for a repository that is not tracked, or whose 2 hours have passed; it never extends a clock that runs,
     * because a focused message field asks again and again and only a message is a use.
     */
    async open(repositoryId, rootOf) {
      if (!keeps || closed) return;
      const ageOf = () => github.age?.(repositoryId) ?? null;
      const settled = (entry) => entry && (entry.running || entry.failures > 0 || (ageOf() !== null && ageOf() < refreshMs));
      try {
        if (settled(tracked.get(repositoryId))) return;
        const root = tracked.get(repositoryId)?.root ?? await rootOf();
        if (typeof root !== "string" || root === "" || closed || settled(tracked.get(repositoryId))) return;
        const known = tracked.get(repositoryId);
        const entry = track(repositoryId, root, known && now() - known.usedAt <= idleMs ? known.usedAt : now());
        if (ageOf() !== null && ageOf() < refreshMs) {
          arm(repositoryId, entry, refreshMs - ageOf());
        } else {
          if (entry.timer) { clearTimer(entry.timer); entry.timer = null; }
          void tick(repositoryId, entry);
        }
      } catch { /* The next message reads, as before. */ }
    },
    close() {
      closed = true;
      for (const entry of tracked.values()) if (entry.timer) clearTimer(entry.timer);
      tracked.clear();
    },
  });
}

/**
 * Tracks the repositories Aril was used for before this run, a little after desktop main starts, so that the first message finds their
 * settings read. A repository counts when its newest complete answer is not older than `idleMs`. `readHome()` answers the Tasks home of
 * the monitor (`{ boards: [{ repositoryId }] }`), `rootOf(repositoryId)` the repository root or null, and `store.index(repositoryId)` the
 * conversations of the repository. A repository whose root is not known yet is tried again at the next delay; a repository with no
 * recent answer is tracked by its first message. Timers do not keep the process alive. `cancel()` stops the ones still waiting.
 */
export function prefetchGithubSettings({ keeper, readHome, rootOf, store, now = Date.now, idleMs = IDLE_MS, delaysMs = PREFETCH_DELAYS_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const decided = new Set();
  const timers = new Set();
  let closed = false;
  async function pass() {
    let boards = [];
    try { const home = await readHome(); boards = Array.isArray(home?.boards) ? home.boards : []; } catch { return; }
    for (const board of boards) {
      const repositoryId = board?.repositoryId;
      if (closed) return;
      if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId) || decided.has(repositoryId)) continue;
      try {
        const usedAt = lastAnswer(await store.index(repositoryId));
        if (usedAt === null || now() - usedAt > idleMs) { decided.add(repositoryId); continue; }
        const root = await rootOf(repositoryId);
        if (!root || closed) continue;
        decided.add(repositoryId);
        keeper.seed(repositoryId, root, usedAt);
      } catch { /* Tried again at the next delay. */ }
    }
  }
  for (const delay of delaysMs) {
    const timer = setTimer(() => { timers.delete(timer); void pass(); }, delay);
    timer?.unref?.();
    timers.add(timer);
  }
  return Object.freeze({ cancel() { closed = true; for (const timer of timers) clearTimer(timer); timers.clear(); } });
}
