// The board's session projection.

import { verifyChecks } from "./task-checks.mjs";
import { IN_FLIGHT_STATES, normalizeModelIdentifier } from "./task-record.mjs";

export const TASK_SESSION_STATES = Object.freeze(["working", "needs_input", "idle", "open", "stopped", "closed", "unknown"]);
export const TASK_SESSION_TITLE_LENGTH = 160;

const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function sessionTitle(value) {
  if (typeof value !== "string" || !value.isWellFormed()) return null;
  const title = value.trim();
  return title.length > 0 && title.length <= TASK_SESSION_TITLE_LENGTH && !LINE_CONTROL.test(title) ? title : null;
}

function observedModel(value) {
  const model = normalizeModelIdentifier(value) ?? null;
  return model !== null && model.toLowerCase() === "unknown" ? null : model;
}

function checksOf(task, resolveCheckFacts) {
  if (typeof resolveCheckFacts !== "function" || task.report || !IN_FLIGHT_STATES.includes(task.state)) return null;
  const checks = task.completeWhen?.checks;
  if (!Array.isArray(checks) || checks.length === 0) return null;
  try {
    const facts = resolveCheckFacts(task.session.id);
    return facts !== null && typeof facts === "object" ? verifyChecks(checks, facts) : null;
  } catch { return null; }
}

function sessionOf(task, resolveFacts, resolveCheckFacts) {
  const { id } = task.session;
  const checks = checksOf(task, resolveCheckFacts);
  const reading = checks ? { checks } : {};
  let facts = null;
  try { facts = typeof resolveFacts === "function" ? resolveFacts(id) : null; } catch { facts = null; }
  if (facts === null || typeof facts !== "object") return { id, title: null, state: "unknown", observedModel: null, ...reading };
  return {
    id,
    title: sessionTitle(facts.title),
    state: TASK_SESSION_STATES.includes(facts.state) ? facts.state : "unknown",
    observedModel: observedModel(facts.observedModel),
    ...reading,
  };
}

// Returns the board with `session` filled for every task that has a linked session.
export function fillTaskSessions(board, resolveFacts, resolveCheckFacts = null) {
  if (board === null || typeof board !== "object" || !Array.isArray(board.tasks)) return board;
  return {
    ...board,
    tasks: board.tasks.map((task) => (task?.session ? { ...task, session: sessionOf(task, resolveFacts, resolveCheckFacts) } : task)),
  };
}
