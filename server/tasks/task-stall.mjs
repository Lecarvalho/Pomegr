
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { blockQueue } from "./task-report.mjs";
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

// Stalls every linked task that has no report and whose session ended. With a
// `confirmation`, an end counts only when its second reading confirms it.
export function stallEndedTasks({ database, transaction, resolveFacts, confirmation = null, now }) {
  if (typeof resolveFacts !== "function") return { ok: true, stalled: 0 };
  const waiting = preparedStatement(database, `SELECT repository_id, number, session_id FROM tasks
    WHERE session_id IS NOT NULL AND report_at IS NULL AND state IN (${WAITING_SQL}) ORDER BY repository_id, number`).all();
  const read = [];
  const ended = waiting.filter((row) => {
    if (!isTaskSessionId(row.session_id)) return false;
    let over = false;
    try { over = sessionEnded(resolveFacts(row.session_id), providerOfSession(row.session_id)); } catch { over = false; }
    if (!confirmation) return over;
    read.push(row.session_id);
    return confirmation.read(row.session_id, over);
  });
  confirmation?.retain(read);
  if (ended.length === 0) return { ok: true, stalled: 0 };
  const stalled = transaction(() => {
    let count = 0;
    for (const row of ended) {
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

export function createTaskStallWatcher({ taskStore, subscribe, resolveSessionFacts, delayMs = SWEEP_DELAY_MS,
  confirmDelayMs = END_CONFIRM_DELAY_MS, now = undefined, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const confirmation = createEndConfirmation({ delayMs: confirmDelayMs, now });
  let timer = null;
  let confirmTimer = null;
  let stopped = false;
  const sweep = () => {
    if (stopped) return;
    try { taskStore?.stallEndedTasks?.(resolveSessionFacts, confirmation); } catch { /* the next revision sweeps again */ }
    // A quiet catalog commits no revision, so the second reading has its own timer.
    const due = confirmation.dueIn();
    if (due === null || confirmTimer !== null) return;
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
