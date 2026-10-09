// A session that ended without a report stalls its task.
//
// The rule is decided once and persisted: when a linked task has no report and the committed facts of its
// session establish that the session ended, the task becomes Stalled and holds a running queue. Ended means
// the catalog state is Closed, or Stopped for a Claude Code session, or the state is Unknown and the primary
// agent's liveness says the Codex writer was released. A Codex session reads Stopped after a failed or
// interrupted turn while its process may still be present and able to report, so for Codex a Stopped state
// ends the session only together with a released writer. Idle, Open, Working, Needs input, a bare Unknown, and
// a session the monitor holds no facts for never stall a task. A stalled task never leaves that state by
// itself: only the user's Mark done or Requeue resolves it, and a later report from the session changes nothing.
// A linked task that never reaches an established end keeps its state and holds the queue; the user resolves it
// with the same two actions, and nothing here stops or touches a session.
//
// This module reads no route, runtime, Git, or provider data. The entry point hands it a
// `resolveFacts(sessionId)` that reads committed memory only, and a `subscribe` for committed revisions.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { blockQueue } from "./task-report.mjs";
import { isTaskSessionId, taskIdFromNumber } from "./task-record.mjs";

/** States of a linked task whose session can still report; the same set `complete` and `block` accept. */
const WAITING_STATES = Object.freeze(["not_queued", "queued", "scheduled"]);
const WAITING_SQL = WAITING_STATES.map((state) => `'${state}'`).join(", ");
/** Revisions arrive in bursts; one sweep follows the last of a burst. */
const SWEEP_DELAY_MS = 1000;

// Session IDs are `<provider>:<local id>`. The tasks layer may not import the provider contract, so the provider
// is read from the prefix; anything else is no provider.
const providerOfSession = (sessionId) => {
  const separator = typeof sessionId === "string" ? sessionId.indexOf(":") : -1;
  return separator > 0 ? sessionId.slice(0, separator) : null;
};

/**
 * True only when `facts` (`{ state, writerReleased }` from committed session facts) establish that the session
 * ended. `providerId` is the session's provider: a Codex session that reads Stopped ended only when its writer
 * was released. Anything missing, malformed, or not recognized is not an end.
 */
export function sessionEnded(facts, providerId = null) {
  if (facts === null || typeof facts !== "object") return false;
  if (facts.state === "closed") return true;
  if (facts.state === "stopped") return providerId !== "codex" || facts.writerReleased === true;
  return facts.state === "unknown" && facts.writerReleased === true;
}

/**
 * Stalls every linked task that has no report and whose session ended. Answers `{ ok: true, stalled }` with the
 * number of tasks changed. A resolver that throws, or facts that do not establish an end, leave the task as it is.
 */
export function stallEndedTasks({ database, transaction, resolveFacts, now }) {
  if (typeof resolveFacts !== "function") return { ok: true, stalled: 0 };
  const waiting = preparedStatement(database, `SELECT repository_id, number, session_id FROM tasks
    WHERE session_id IS NOT NULL AND report_at IS NULL AND state IN (${WAITING_SQL}) ORDER BY repository_id, number`).all();
  const ended = waiting.filter((row) => {
    if (!isTaskSessionId(row.session_id)) return false;
    try { return sessionEnded(resolveFacts(row.session_id), providerOfSession(row.session_id)); } catch { return false; }
  });
  if (ended.length === 0) return { ok: true, stalled: 0 };
  const stalled = transaction(() => {
    let count = 0;
    for (const row of ended) {
      // The task may have been reported, resolved, requeued, or deleted since the read above.
      const written = preparedStatement(database, `UPDATE tasks SET state = 'stalled', queue_position = NULL, updated_at = ?
        WHERE repository_id = ? AND number = ? AND session_id = ? AND report_at IS NULL AND state IN (${WAITING_SQL})`)
        .run(now(), row.repository_id, row.number, row.session_id);
      if (Number(written.changes) !== 1) continue;
      blockQueue(database, row.repository_id, taskIdFromNumber(Number(row.number)));
      count += 1;
    }
    return count;
  });
  return { ok: true, stalled };
}

/**
 * Sweeps the store after committed revisions: `subscribe(listener)` is the runtime's revision feed and returns an
 * unsubscribe; `resolveSessionFacts(sessionId)` reads committed memory. One sweep runs after start and one after
 * each burst of revisions. Returns `{ sweep(), stop() }`; nothing here throws into the caller.
 */
export function createTaskStallWatcher({ taskStore, subscribe, resolveSessionFacts, delayMs = SWEEP_DELAY_MS,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let stopped = false;
  const sweep = () => {
    if (stopped) return;
    try { taskStore?.stallEndedTasks?.(resolveSessionFacts); } catch { /* the next revision sweeps again */ }
  };
  const schedule = () => {
    if (stopped || timer !== null) return;
    timer = setTimer(() => { timer = null; sweep(); }, delayMs);
    timer?.unref?.();
  };
  let unsubscribe = null;
  try { unsubscribe = typeof subscribe === "function" ? subscribe(schedule) : null; } catch { unsubscribe = null; }
  schedule();
  return Object.freeze({
    sweep,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      try { unsubscribe?.(); } catch { /* shutdown stays bounded */ }
    },
  });
}
