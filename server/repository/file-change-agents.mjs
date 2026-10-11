import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { normalizedRequestModel } from "../normalize/request-snapshots.mjs";

export const SAFE_FILE_CHANGE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
export const MAX_FILE_CHANGE_AGENT_LABEL = 200;
export const MAX_FILE_CHANGE_AGENT_ASSIGNMENT = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function oneLine(value, maximum) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maximum || CONTROL_CHARACTERS.test(text)) return null;
  return text;
}

export function fileChangeAgentIdentity(value) {
  const model = normalizedRequestModel(value?.model);
  return {
    label: oneLine(value?.label, MAX_FILE_CHANGE_AGENT_LABEL),
    assignment: oneLine(value?.assignment, MAX_FILE_CHANGE_AGENT_ASSIGNMENT),
    model: model && model.toLowerCase() !== "unknown" ? model : null,
  };
}

export function recordFileChangeAgents(store, sessionId, agentIds, publicAgents, observedAt) {
  if (!agentIds.size || !Array.isArray(publicAgents) || !Number.isFinite(observedAt)) return;
  const statement = preparedStatement(store.database, `
    INSERT INTO file_change_agents (session_id, agent_id, label, assignment, model, observed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id, agent_id) DO UPDATE SET
      label = COALESCE(excluded.label, label),
      assignment = COALESCE(excluded.assignment, assignment),
      model = COALESCE(excluded.model, model),
      observed_at = MAX(observed_at, excluded.observed_at)
  `);
  for (const agent of publicAgents) {
    if (typeof agent?.id !== "string" || !agentIds.has(agent.id) || !SAFE_FILE_CHANGE_AGENT_ID.test(agent.id)) continue;
    const identity = fileChangeAgentIdentity(agent);
    if (!identity.label && !identity.assignment && !identity.model) continue;
    statement.run(sessionId, agent.id, identity.label, identity.assignment, identity.model, observedAt);
  }
}

export function readFileChangeAgents(store, sessionId, agentIds) {
  const identities = new Map();
  const ids = [...agentIds].filter((agentId) => typeof agentId === "string" && SAFE_FILE_CHANGE_AGENT_ID.test(agentId));
  if (!ids.length) return identities;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = preparedStatement(store.database, `
    SELECT agent_id AS agentId, label, assignment, model
    FROM file_change_agents
    WHERE session_id = ? AND agent_id IN (${placeholders})
  `).all(sessionId, ...ids);
  for (const row of rows) identities.set(row.agentId, fileChangeAgentIdentity(row));
  return identities;
}
