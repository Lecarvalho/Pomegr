// What the Sessions list may know about the task a session was started for: the task ID, its
// repository, an outcome state, and the feature and step. Read from the task store when a directory
// page is served; nothing here is written to the session catalog or a checkpoint, and task text, the
// own condition, column names and reports are never selected.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { FEATURE_ID, normalizeFeatureName, taskIdFromNumber } from "./task-record.mjs";

/** The newest-linked sessions one grouped directory answer may place in features. */
export const FEATURE_LINK_MAX = 2000;

// The states a session's own state cannot show. Any other task state is served as null.
const OUTCOME_STATES = new Set(["needs_review", "stalled", "blocked", "done"]);

const REFERENCE = `SELECT t.repository_id AS repositoryId, t.number AS number, t.state AS state, t.step AS step,
  t.feature_id AS featureId, f.name AS featureName
  FROM tasks t LEFT JOIN features f ON f.id = t.feature_id WHERE t.session_id = ?`;

const safeName = (value) => (typeof value === "string" ? normalizeFeatureName(value) ?? null : null);

function reference(row) {
  const id = taskIdFromNumber(row.number);
  if (id === undefined) return null;
  const feature = row.featureId === null ? null : safeName(row.featureName);
  // A feature whose stored name does not validate is served as no feature, never as raw text.
  const attached = feature !== null && Number.isSafeInteger(row.step) && row.step >= 1;
  return {
    id,
    repositoryId: row.repositoryId,
    state: OUTCOME_STATES.has(row.state) ? row.state : null,
    featureId: attached ? row.featureId : null,
    feature: attached ? feature : null,
    step: attached ? row.step : null,
  };
}

/** The task reference of each given session that was started for a task, keyed by session ID. */
export function sessionTaskReferences({ database, sessionIds }) {
  const references = new Map();
  const statement = preparedStatement(database, REFERENCE);
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== "string" || references.has(sessionId)) continue;
    const row = statement.get(sessionId);
    const task = row ? reference(row) : null;
    if (task) references.set(sessionId, task);
  }
  return references;
}

/** One feature and the sessions started for its tasks, or null for an ID that names no feature. */
export function featureSessions({ database, featureId }) {
  if (typeof featureId !== "string" || !FEATURE_ID.test(featureId)) return null;
  const feature = preparedStatement(database, "SELECT name FROM features WHERE id = ?").get(featureId);
  const name = feature ? safeName(feature.name) : null;
  if (name === null) return null;
  const sessionIds = preparedStatement(database, "SELECT session_id AS sessionId FROM tasks WHERE feature_id = ? AND session_id IS NOT NULL")
    .all(featureId).map((row) => row.sessionId);
  return { id: featureId, name, sessionIds };
}

/** Every linked session of a feature task, newest link first and bounded: session ID to feature ID, and feature ID to name. */
export function featureSessionGroups({ database }) {
  const members = new Map();
  const labels = new Map();
  const rows = preparedStatement(database, `SELECT t.session_id AS sessionId, t.feature_id AS featureId, f.name AS featureName
    FROM tasks t JOIN features f ON f.id = t.feature_id WHERE t.session_id IS NOT NULL
    ORDER BY t.updated_at DESC, t.repository_id, t.number LIMIT ?`).all(FEATURE_LINK_MAX);
  for (const row of rows) {
    const name = safeName(row.featureName);
    if (name === null) continue;
    members.set(row.sessionId, row.featureId);
    labels.set(row.featureId, name);
  }
  return { members, labels };
}
