// Recorded identity of the agents that changed files, kept beside the file-change index so
// file history can name them after their session leaves the monitor's memory. One row per
// (session, agent) that has a recorded `file_changes` row: the agent's display label, its
// optional provider-recorded assignment, and its latest reported model identifier. The
// model is the agent's latest value, never the model of the request that made a change.
//
// Privacy: only these three bounded one-line values, all already served to the browser as
// normalized agent fields, are persisted. Never prompts, descriptions, provider-native agent
// kinds, paths, or raw provider records. See AGENTS.md ("File-change history") and
// docs/internal/architecture/observation-cache.md.

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

/** Validated display fields for one agent; every field is null when missing or unsafe. */
export function fileChangeAgentIdentity(value) {
  const model = normalizedRequestModel(value?.model);
  return {
    label: oneLine(value?.label, MAX_FILE_CHANGE_AGENT_LABEL),
    assignment: oneLine(value?.assignment, MAX_FILE_CHANGE_AGENT_ASSIGNMENT),
    model: model && model.toLowerCase() !== "unknown" ? model : null,
  };
}

/**
 * Upserts the identity of each given agent from a committed snapshot's normalized agents.
 * An agent the snapshot no longer lists, or whose fields are all unavailable, keeps its
 * last recorded row; a field that becomes unavailable keeps its last recorded value.
 */
export function recordFileChangeAgents(store, sessionId, agentIds, publicAgents, observedAt) {
  if (!agentIds.size || !Array.isArray(publicAgents) || !Number.isFinite(observedAt)) return;
  const statement = store.database.prepare(`
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

/** Recorded identities for one session's agents, keyed by agent ID; absent agents are omitted. */
export function readFileChangeAgents(store, sessionId, agentIds) {
  const identities = new Map();
  const ids = [...agentIds].filter((agentId) => typeof agentId === "string" && SAFE_FILE_CHANGE_AGENT_ID.test(agentId));
  if (!ids.length) return identities;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = store.database.prepare(`
    SELECT agent_id AS agentId, label, assignment, model
    FROM file_change_agents
    WHERE session_id = ? AND agent_id IN (${placeholders})
  `).all(sessionId, ...ids);
  for (const row of rows) identities.set(row.agentId, fileChangeAgentIdentity(row));
  return identities;
}
