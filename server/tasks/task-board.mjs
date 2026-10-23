// The board's session projection.

import { readChecks } from "./task-checks.mjs";
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

function observedEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z][a-z0-9-]{0,15}$/.test(effort) && effort !== "unspecified" && effort !== "unknown" ? effort : null;
}

function checksOf(task, resolveCheckFacts) {
  if (typeof resolveCheckFacts !== "function" || task.report || !IN_FLIGHT_STATES.includes(task.state)) return null;
  const checks = task.completeWhen?.checks;
  if (!Array.isArray(checks) || checks.length === 0) return null;
  try {
    const facts = resolveCheckFacts(task.session.id);
    return facts !== null && typeof facts === "object" ? readChecks(checks, facts) : null;
  } catch { return null; }
}

function sessionOf(id, resolveFacts, reading = {}) {
  let facts = null;
  try { facts = typeof resolveFacts === "function" ? resolveFacts(id) : null; } catch { facts = null; }
  if (facts === null || typeof facts !== "object") return { id, title: null, state: "unknown", observedModel: null, observedEffort: null, ...reading };
  return {
    id,
    title: sessionTitle(facts.title),
    state: TASK_SESSION_STATES.includes(facts.state) ? facts.state : "unknown",
    observedModel: observedModel(facts.observedModel),
    observedEffort: observedEffort(facts.observedEffort),
    ...reading,
  };
}

function filled(task, resolveFacts, resolveCheckFacts) {
  if (!task?.session && !Array.isArray(task?.assigned)) return task;
  const next = { ...task };
  if (task.session) {
    const checks = checksOf(task, resolveCheckFacts);
    next.session = sessionOf(task.session.id, resolveFacts, checks ? { checks } : {});
  }
  // An assigned session borrows the same facts and carries no reading of the conditions.
  if (Array.isArray(task.assigned)) next.assigned = task.assigned.map((session) => sessionOf(session.id, resolveFacts));
  return next;
}

// Returns the board with `session` filled for every task that has a linked session, and `assigned` for every assigned one.
export function fillTaskSessions(board, resolveFacts, resolveCheckFacts = null) {
  if (board === null || typeof board !== "object" || !Array.isArray(board.tasks)) return board;
  return { ...board, tasks: board.tasks.map((task) => filled(task, resolveFacts, resolveCheckFacts)) };
}
