
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { FEATURE_ID, normalizeFeatureName, taskIdFromNumber } from "./task-record.mjs";
import { readTaskSource } from "./task-source.mjs";
import { sessionAssignedTasks } from "./task-assignments.mjs";

export const FEATURE_LINK_MAX = 2000;

// The states a session's own state cannot show.
const OUTCOME_STATES = new Set(["needs_review", "stalled", "blocked", "done"]);

const REFERENCE = `SELECT t.repository_id AS repositoryId, t.number AS number, t.state AS state,
  t.feature_id AS featureId, f.name AS featureName
  FROM tasks t LEFT JOIN features f ON f.id = t.feature_id WHERE t.session_id = ?`;
const ASSIGNED_REFERENCE = `SELECT t.repository_id AS repositoryId, t.number AS number, t.state AS state,
  t.feature_id AS featureId, f.name AS featureName
  FROM tasks t LEFT JOIN features f ON f.id = t.feature_id WHERE t.repository_id = ? AND t.number = ?`;
const REVIEW_REFERENCE = `SELECT t.repository_id AS repositoryId, t.number AS number, t.state AS state,
  t.feature_id AS featureId, f.name AS featureName
  FROM task_reviewers r JOIN tasks t ON t.repository_id = r.repository_id AND t.number = r.number
  LEFT JOIN features f ON f.id = t.feature_id WHERE r.session_id = ? ORDER BY r.at DESC, r.rowid DESC LIMIT 1`;

const safeName = (value) => (typeof value === "string" ? normalizeFeatureName(value) ?? null : null);

function reference(database, row) {
  const id = taskIdFromNumber(row.number);
  if (id === undefined) return null;
  const feature = row.featureId === null ? null : safeName(row.featureName);
  // A feature whose stored name does not validate is served as no feature, never as raw text.
  const attached = feature !== null;
  return {
    id,
    repositoryId: row.repositoryId,
    state: OUTCOME_STATES.has(row.state) ? row.state : null,
    featureId: attached ? row.featureId : null,
    feature: attached ? feature : null,
    issue: readTaskSource(database, row.repositoryId, row.number),
  };
}

export function sessionTaskReferences({ database, sessionIds }) {
  const references = new Map();
  const statement = preparedStatement(database, REFERENCE);
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== "string" || references.has(sessionId)) continue;
    const row = statement.get(sessionId);
    const task = row ? reference(database, row) : null;
    if (task) references.set(sessionId, task);
  }
  return references;
}

// The task each session reviewed, from the durable reviewer record, marked with the review role.
export function sessionReviewReferences({ database, sessionIds }) {
  const references = new Map();
  const statement = preparedStatement(database, REVIEW_REFERENCE);
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== "string" || references.has(sessionId)) continue;
    const row = statement.get(sessionId);
    const task = row ? reference(database, row) : null;
    if (task) references.set(sessionId, { ...task, role: "review" });
  }
  return references;
}

// The tasks each session is assigned to, beside the one it was started for: the same reference, in board and number order.
export function sessionAssignedReferences({ database, sessionIds }) {
  const references = new Map();
  const statement = preparedStatement(database, ASSIGNED_REFERENCE);
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== "string" || references.has(sessionId)) continue;
    const tasks = [];
    for (const assigned of sessionAssignedTasks(database, sessionId)) {
      const row = statement.get(assigned.repositoryId, assigned.number);
      const task = row ? reference(database, row) : null;
      if (task) tasks.push(task);
    }
    if (tasks.length > 0) references.set(sessionId, tasks);
  }
  return references;
}

export function featureSessions({ database, featureId }) {
  if (typeof featureId !== "string" || !FEATURE_ID.test(featureId)) return null;
  const feature = preparedStatement(database, "SELECT name FROM features WHERE id = ?").get(featureId);
  const name = feature ? safeName(feature.name) : null;
  if (name === null) return null;
  const sessionIds = preparedStatement(database, "SELECT session_id AS sessionId FROM tasks WHERE feature_id = ? AND session_id IS NOT NULL")
    .all(featureId).map((row) => row.sessionId);
  return { id: featureId, name, sessionIds };
}

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
