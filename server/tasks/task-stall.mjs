
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { appendTaskLog } from "./task-log.mjs";
import { blockQueue, releaseQueue } from "./task-report.mjs";
import { IN_FLIGHT_STATES, isTaskSessionId, taskIdFromNumber } from "./task-record.mjs";

const WAITING_SQL = IN_FLIGHT_STATES.map((state) => `'${state}'`).join(", ");
const SWEEP_DELAY_MS = 1000;
// Longer than a provider's next reconciliation, which checks the session's process again.
export const END_CONFIRM_DELAY_MS = 20_000;
const CONFIRM_SLACK_MS = 50;

// Session IDs are `<provider>:<local id>`.
const providerOfSession = (sessionId) => {
  const separator = typeof sessionId === "string" ? sessionId.indexOf(":") : -1;
  return separator > 0 ? sessionId.slice(0, separator) : null;
};

export function sessionEnded(facts, providerId = null) {
  if (facts === null || typeof facts !== "object") return false;
  if (facts.state === "closed") return true;
  if (facts.state === "stopped") return providerId === "claude" || (providerId === "codex" && facts.writerReleased === true);
  return facts.state === "unknown" && facts.writerReleased === true;
}

// A reading that the session works again: only a state the session reaches by running a turn.
export function sessionLive(facts) {
  return facts !== null && typeof facts === "object" && (facts.state === "working" || facts.state === "needs_input");
}

// A reading that keeps a recovery waiting: a state the catalog shows only for a session that has not ended.
const OPEN_STATES = Object.freeze(["working", "needs_input", "idle", "open"]);
const sessionOpen = (facts) => facts !== null && typeof facts === "object" && OPEN_STATES.includes(facts.state);

// An ended reading is confirmed by a second one at least `delayMs` later. A reading in
// between that is not ended drops the first, so an end that a later reading reverses
// never stalls a task.
export function createEndConfirmation({ delayMs = END_CONFIRM_DELAY_MS, now = () => performance.now() } = {}) {
  const firstEnded = new Map();
  return Object.freeze({
    read(sessionId, ended) {
      if (!ended) { firstEnded.delete(sessionId); return false; }
      const since = firstEnded.get(sessionId);
      if (since === undefined) { firstEnded.set(sessionId, now()); return false; }
      if (now() - since < delayMs) return false;
      firstEnded.delete(sessionId);
      return true;
    },
    // Forgets every session the last sweep did not read: its task reported or was resolved.
    retain(sessionIds) {
      const kept = new Set(sessionIds);
      for (const sessionId of [...firstEnded.keys()]) if (!kept.has(sessionId)) firstEnded.delete(sessionId);
    },
    // Milliseconds until the earliest unconfirmed end can be confirmed, or null when none waits.
    dueIn() {
      if (firstEnded.size === 0) return null;
      return Math.max(0, Math.min(...firstEnded.values()) + delayMs - now());
    },
  });
}

// A live reading of a stalled task's session is confirmed by an open reading at least `delayMs` later. An ended,
// unknown, or missing reading in between drops the first, so one live reading never moves a stalled task back.
export function createLiveConfirmation({ delayMs = END_CONFIRM_DELAY_MS, now = () => performance.now() } = {}) {
  const firstLive = new Map();
  return Object.freeze({
    read(sessionId, facts) {
      const since = firstLive.get(sessionId);
      if (since === undefined) {
        if (sessionLive(facts)) firstLive.set(sessionId, now());
        return false;
      }
      if (!sessionOpen(facts)) { firstLive.delete(sessionId); return false; }
      if (now() - since < delayMs) return false;
      firstLive.delete(sessionId);
      return true;
    },
    retain(sessionIds) {
      const kept = new Set(sessionIds);
      for (const sessionId of [...firstLive.keys()]) if (!kept.has(sessionId)) firstLive.delete(sessionId);
    },
    dueIn() {
      if (firstLive.size === 0) return null;
      return Math.max(0, Math.min(...firstLive.values()) + delayMs - now());
    },
  });
}

const readFacts = (resolveFacts, sessionId) => {
  try { return resolveFacts(sessionId); } catch { return null; }
};

// Moves back every stalled task with no report whose own session works again: the end Pomegr confirmed was wrong.
// The task is linked and in flight once more, so the stall rule watches it again, and the queue it held is released.
// With a `confirmation`, a live reading counts only when a later open reading confirms it.
function recoverLiveTasks({ database, resolveFacts, confirmation, now }) {
  const stalled = preparedStatement(database, `SELECT repository_id, number, session_id FROM tasks
    WHERE session_id IS NOT NULL AND report_at IS NULL AND state = 'stalled' ORDER BY repository_id, number`).all();
  const read = [];
  const live = stalled.filter((row) => {
    if (!isTaskSessionId(row.session_id)) return false;
    const facts = readFacts(resolveFacts, row.session_id);
    if (!confirmation) return sessionLive(facts);
    read.push(row.session_id);
    return confirmation.read(row.session_id, facts);
  });
  confirmation?.retain(read);
  let count = 0;
  for (const row of live) {
    const at = now();
    const written = preparedStatement(database, `UPDATE tasks SET state = 'not_queued', queue_position = NULL, updated_at = ?
      WHERE repository_id = ? AND number = ? AND session_id = ? AND report_at IS NULL AND state = 'stalled'`)
      .run(at, row.repository_id, row.number, row.session_id);
    if (Number(written.changes) !== 1) continue;
    appendTaskLog(database, row.repository_id, row.number, "recovered", at);
    releaseQueue(database, row.repository_id);
    count += 1;
  }
  return count;
}

// Stalls every linked task that has no report and whose session ended. With a
// `confirmation`, an end counts only when its second reading confirms it.
// With a `recovery`, a stalled task whose session works again moves back (see `recoverLiveTasks`).
export function stallEndedTasks({ database, transaction, resolveFacts, confirmation = null, recovery = null, now }) {
  if (typeof resolveFacts !== "function") return { ok: true, stalled: 0, recovered: 0 };
  // Recovery reads first, so a task this sweep stalls is not read as stalled in the same sweep.
  const recovered = transaction(() => recoverLiveTasks({ database, resolveFacts, confirmation: recovery, now }));
  const waiting = preparedStatement(database, `SELECT repository_id, number, session_id FROM tasks
    WHERE session_id IS NOT NULL AND report_at IS NULL AND state IN (${WAITING_SQL}) ORDER BY repository_id, number`).all();
  const read = [];
  const ended = waiting.filter((row) => {
    if (!isTaskSessionId(row.session_id)) return false;
    const over = sessionEnded(readFacts(resolveFacts, row.session_id), providerOfSession(row.session_id));
    if (!confirmation) return over;
    read.push(row.session_id);
    return confirmation.read(row.session_id, over);
  });
  confirmation?.retain(read);
  if (ended.length === 0) return { ok: true, stalled: 0, recovered };
  const stalled = transaction(() => {
    let count = 0;
    for (const row of ended) {
      const at = now();
      const written = preparedStatement(database, `UPDATE tasks SET state = 'stalled', queue_position = NULL, updated_at = ?
        WHERE repository_id = ? AND number = ? AND session_id = ? AND report_at IS NULL AND state IN (${WAITING_SQL})`)
        .run(at, row.repository_id, row.number, row.session_id);
      if (Number(written.changes) !== 1) continue;
      appendTaskLog(database, row.repository_id, row.number, "stalled", at);
      blockQueue(database, row.repository_id, taskIdFromNumber(Number(row.number)));
      count += 1;
    }
    return count;
  });
  return { ok: true, stalled, recovered };
}

export function createTaskStallWatcher({ taskStore, subscribe, resolveSessionFacts, delayMs = SWEEP_DELAY_MS,
  confirmDelayMs = END_CONFIRM_DELAY_MS, now = undefined, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const confirmation = createEndConfirmation({ delayMs: confirmDelayMs, now });
  const recovery = createLiveConfirmation({ delayMs: confirmDelayMs, now });
  let timer = null;
  let confirmTimer = null;
  let stopped = false;
  const sweep = () => {
    if (stopped) return;
    try { taskStore?.stallEndedTasks?.(resolveSessionFacts, confirmation, recovery); } catch { /* the next revision sweeps again */ }
    // A quiet catalog commits no revision, so the second reading has its own timer.
    const waits = [confirmation.dueIn(), recovery.dueIn()].filter((due) => due !== null);
    if (waits.length === 0 || confirmTimer !== null) return;
    const due = Math.min(...waits);
    confirmTimer = setTimer(() => { confirmTimer = null; sweep(); }, due + CONFIRM_SLACK_MS);
    confirmTimer?.unref?.();
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
      if (confirmTimer !== null) clearTimer(confirmTimer);
      timer = null;
      confirmTimer = null;
      try { unsubscribe?.(); } catch { /* shutdown stays bounded */ }
    },
  });
}
