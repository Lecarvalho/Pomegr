// Warm runs: a Claude Code process that Pomegr starts before the owner sends, so the message does not wait for the process to boot and
// connect its MCP server. A warm run is the same read-only run as any turn, started with every argument fixed and then left waiting on
// stdin with no prompt. It is declared to the monitor while it waits, so it never shows as a session. It holds no prompt, no board
// fact, and no conversation text until the owner sends: the message's prompt is built as always and written to it then. It is never a
// model call. Only Claude Code has one: Codex reads its prompt until the end of stdin and does nothing before it, so it starts fresh.

import { failedChatRun } from "./agent-chat-runner.mjs";

// A warm run closes after five minutes without a send. The monitor keeps a declaration for eleven, so a run that waits and is then
// used (a turn may take ten minutes) is declared again when it is taken.
export const WARM_IDLE_MS = 5 * 60_000;
// At most one warm run for a repository's thread, and this many in total: a new one makes the oldest close.
export const WARM_LIMIT = 2;
// The providers that can be warm. Codex waits for the end of its stdin before it connects anything (a probe on 2026-10-29: its MCP
// server connected about 1.9 seconds after the prompt arrived), so a warm Codex run would gain nothing.
export const WARM_PROVIDERS = Object.freeze(["claude"]);
// The steps of a turn's preparation that the warm run did when it started. A turn it answers records them as 0.
export const WARM_PREPARE = Object.freeze({ environment: 0, declare: 0, server: 0 });

const same = (left, right) => Object.keys(left).every((name) => left[name] === right[name]);

/**
 * The warm runs of the repositories' threads. `startProcess` starts the provider process (`startChatProcess`), `spawn` and `clock` are
 * its, and `executable(provider)`, `repositoryRoot(repositoryId)`, `instructions()`, `imageFolder(repositoryId)`, and `environment()`
 * answer the arguments a turn of that thread would start with. `declare(provider)` makes and declares the run's session ID,
 * `redeclare(sessionId)` declares it again, and `withdraw(sessionId)` takes it back. `openBridge(stand)` opens the task-read bridge for
 * the run: it must answer nothing until `stand.bound` is the turn that took the run. `busy(repositoryId)` says whether a turn or a
 * compaction of that thread runs or waits. `setTimer` and `clearTimer` are the idle clock.
 */
export function createWarmRuns({ startProcess, spawn, clock, executable, repositoryRoot, instructions, imageFolder, environment, declare, redeclare, withdraw, openBridge, busy,
  idleMs = WARM_IDLE_MS, limit = WARM_LIMIT, setTimer = setTimeout, clearTimer = clearTimeout }) {
  // repositoryId to entry. An entry is starting until `ready`, then waits for a send, and leaves the map when it is taken or closed.
  const entries = new Map();
  let disposed = false;
  let order = 0;

  // Closes an entry in any state: its idle clock, its bridge, its process, and its declaration. An entry that is still starting finishes
  // its step and closes again, so a process or a declaration that arrives late is closed too. Each is closed once.
  function close(entry) {
    if (entries.get(entry.repositoryId) === entry) entries.delete(entry.repositoryId);
    entry.cancelled = true;
    clearTimer(entry.timer);
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.stand?.closeTaskRead?.();
    entry.handle?.close();
    entry.handle = null;
    if (entry.sessionId) withdraw(entry.sessionId);
    entry.sessionId = null;
  }

  function arm(entry) {
    clearTimer(entry.timer);
    entry.timer = setTimer(() => close(entry), idleMs);
    entry.timer?.unref?.();
  }

  async function build(entry) {
    const { repositoryId, run } = entry;
    const command = executable(run.provider);
    const [root, instructionsFile, folder, env] = await Promise.all([repositoryRoot(repositoryId), instructions(), imageFolder(repositoryId), environment()]);
    if (!command || !root || entry.cancelled || disposed) return close(entry);
    // The bridge opens now and is bound to the turn that takes the run: until then it refuses every read.
    const stand = { repositoryId, bound: null, get stopped() { return this.bound?.stopped === true; } };
    entry.stand = stand;
    const [sessionId, server] = await Promise.all([declare(run.provider), openBridge(stand)]);
    entry.sessionId = sessionId;
    if (entry.cancelled || disposed) return close(entry);
    const handle = startProcess({ spawn, executable: command, provider: run.provider, model: run.model, effort: run.effort, mcpServer: server,
      images: folder ? { folder, files: [] } : null, sessionId, instructionsFile, cwd: root, env, clock });
    if (!handle) return close(entry);
    entry.handle = handle;
    // Everything a turn must match to use the run: the arguments that were fixed at the start.
    entry.key = { repositoryId, provider: run.provider, model: run.model, effort: run.effort, command, root, instructions: instructionsFile?.file ?? null, imageFolder: folder };
    // A run that exits or fails before it is used is discarded without a word; the next send starts fresh.
    entry.unsubscribe = handle.onExit(() => close(entry));
    if (!handle.alive()) return close(entry);
    entry.ready = true;
    arm(entry);
  }

  function oldest() {
    return [...entries.values()].reduce((first, entry) => (entry.touched < first.touched ? entry : first));
  }

  return Object.freeze({
    /**
     * Keeps a warm run ready for the thread with this run (`{ provider, model, effort }`). The same run already held is kept and its idle
     * clock starts again; another run closes the held one first. Starts nothing for a provider with no warm run, while a turn or a
     * compaction of the thread runs, or after `dispose`. Answers when the run is ready or has been given up, and never rejects.
     */
    async request(repositoryId, run) {
      try {
        if (disposed || !startProcess || !WARM_PROVIDERS.includes(run.provider) || busy(repositoryId)) return;
        const held = entries.get(repositoryId);
        if (held && same(held.run, run)) {
          held.touched = (order += 1);
          if (held.ready) { arm(held); redeclare(held.sessionId); }
          await held.started;
          return;
        }
        if (held) close(held);
        while (entries.size >= limit) close(oldest());
        const entry = { repositoryId, run: { ...run }, touched: (order += 1), cancelled: false, ready: false, key: null, sessionId: null, stand: null, handle: null, timer: null, unsubscribe: null, started: null };
        entries.set(repositoryId, entry);
        entry.started = build(entry).catch(() => close(entry));
        await entry.started;
      } catch { /* A warm run is only a head start; the next send starts fresh. */ }
    },

    /** Whether a ready warm run of this provider waits for the thread, so a turn can leave out what the run already did. */
    holds(repositoryId, provider) {
      const entry = entries.get(repositoryId);
      return Boolean(entry?.ready && entry.run.provider === provider);
    },

    /**
     * The warm run for a turn that would start with exactly `key` (`{ repositoryId, provider, model, effort, command, root, instructions,
     * imageFolder }`), bound to `turn`: its bridge answers from now on, for that turn, and `turn.closeTaskRead` closes it. A held run
     * that does not match, is still starting, or has exited is closed, and the turn starts fresh. Answers null then, else
     * `{ sessionId, setEffort(level), begin(options), discard() }`: `setEffort` lowers the effort the run holds and answers whether the
     * run acknowledged it, `begin` writes the prompt (see `startChatProcess`), and `discard` closes the run. The key's effort is the one
     * the run was started with, the owner's; a turn that lowers it does so after taking the run.
     */
    take(key, turn) {
      const entry = entries.get(key.repositoryId);
      if (!entry) return null;
      if (!entry.ready || !entry.handle.alive() || !same(entry.key, key)) { close(entry); return null; }
      entries.delete(key.repositoryId);
      clearTimer(entry.timer);
      entry.unsubscribe();
      const { handle, stand, sessionId } = entry;
      stand.bound = turn;
      turn.closeTaskRead = stand.closeTaskRead;
      redeclare(sessionId);
      return {
        sessionId,
        // Changes the effort the waiting run holds (see `startChatProcess`). A turn calls it only to lower the effort it was started with.
        setEffort: (level) => handle.setEffort(level),
        begin: (options) => handle.begin({ ...options, warm: true }) ?? failedChatRun(),
        discard() { stand.closeTaskRead?.(); handle.close(); withdraw(sessionId); },
      };
    },

    /** Closes every warm run, as the app quits. */
    dispose() {
      disposed = true;
      for (const entry of [...entries.values()]) close(entry);
    },
  });
}
