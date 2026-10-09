// The board's session projection. A task linked to a session carries `{ id, title, state, observedModel }`,
// borrowed from facts the monitor already committed. This module is pure: the entry point hands it a
// `resolveFacts(sessionId)` that reads memory only, and it validates every field it is handed, so the
// projection never trusts its caller. It reads no store, route, runtime, Git, or provider data.

import { normalizeModelIdentifier } from "./task-record.mjs";

/** The session catalog's state values; the Sessions list State column renders exactly these. */
export const TASK_SESSION_STATES = Object.freeze(["working", "needs_input", "idle", "open", "stopped", "closed", "unknown"]);
/** The session catalog bounds its title to this many characters. */
export const TASK_SESSION_TITLE_LENGTH = 160;

const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

// A one-line title within the catalog's bound; anything else is no title.
function sessionTitle(value) {
  if (typeof value !== "string" || !value.isWellFormed()) return null;
  const title = value.trim();
  return title.length > 0 && title.length <= TASK_SESSION_TITLE_LENGTH && !LINE_CONTROL.test(title) ? title : null;
}

// Validated like the request model identifier. The provider's "unknown" placeholder is no model.
function observedModel(value) {
  const model = normalizeModelIdentifier(value) ?? null;
  return model !== null && model.toLowerCase() === "unknown" ? null : model;
}

function sessionOf(id, resolveFacts) {
  let facts = null;
  try { facts = typeof resolveFacts === "function" ? resolveFacts(id) : null; } catch { facts = null; }
  if (facts === null || typeof facts !== "object") return { id, title: null, state: "unknown", observedModel: null };
  return {
    id,
    title: sessionTitle(facts.title),
    state: TASK_SESSION_STATES.includes(facts.state) ? facts.state : "unknown",
    observedModel: observedModel(facts.observedModel),
  };
}

/**
 * Returns the board with `session` filled for every task that has a linked session. `resolveFacts(sessionId)`
 * returns `{ title, state, observedModel }` or null. No facts, a throwing resolver, or an absent resolver gives
 * `{ id, title: null, state: "unknown", observedModel: null }`: unknown, never guessed. A task without a
 * linked session stays null. The input board is not changed.
 */
export function fillTaskSessions(board, resolveFacts) {
  if (board === null || typeof board !== "object" || !Array.isArray(board.tasks)) return board;
  return {
    ...board,
    tasks: board.tasks.map((task) => (task?.session ? { ...task, session: sessionOf(task.session.id, resolveFacts) } : task)),
  };
}
