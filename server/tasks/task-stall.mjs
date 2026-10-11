
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { blockQueue } from "./task-report.mjs";
import { IN_FLIGHT_STATES, isTaskSessionId, taskIdFromNumber } from "./task-record.mjs";

const WAITING_SQL = IN_FLIGHT_STATES.map((state) => `'${state}'`).join(", ");
const SWEEP_DELAY_MS = 1000;

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

// Stalls every linked task that has no report and whose session ended.
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
