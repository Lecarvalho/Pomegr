// The session Repository tab's Touched here list and its session-tab count, built in one place
// from two already-recorded inputs: the committed file-history block (recorded tool changes) and
// the recorder's Git-observed block (files this session's own commits changed). Pure: no I/O, no
// Git, no clock, so a historical session can never pick up current working-tree state here.
//
// Privacy: every entry carries only fields the two inputs already allowed. A recorded entry is a
// bounded safe repository-relative path, the opaque file identity, a fixed change kind, a bounded
// count, an observation time, and at most 12 agents (normalized ID, label, assignment, latest
// reported model). A committed entry is a safe path and a fixed net change, never an agent,
// request, or edit count: it is a time match with one of the session's Git commands, not proof of
// authorship. Either input that fails validation contributes nothing rather than a partial shape.
// See AGENTS.md ("File-change history") and docs/internal/architecture/observation-cache.md.

import { fileChangeAgentIdentity, SAFE_FILE_CHANGE_AGENT_ID } from "./file-change-agents.mjs";
import { isSafeRecordedRepositoryPath } from "./repository-snapshot.mjs";

const GIT_OBSERVED_SOURCES = new Set(["committed"]);
const GIT_OBSERVED_CHANGES = new Set(["added", "modified", "deleted"]);
const MAX_GIT_OBSERVED_FILES = 200;
const FILE_HISTORY_READINESS = new Set(["loading", "ready", "unavailable", "rebuilding"]);
const FILE_CHANGE_KINDS = new Set(["created", "edited", "deleted", "moved"]);
const FILE_ID_PATTERN = /^f[1-9][0-9]{0,15}$/u;
const MAX_SESSION_FILE_HISTORY_FILES = 200;
const MAX_SESSION_FILE_HISTORY_AGENTS = 12;

// Recorded agents for one file: the normalized agent ID from the index, its change count, and
// its label, assignment, and latest reported model. The matching visible agent in this same
// session supplies each field when it has one; otherwise the index's recorded identity does.
function recordedAgents(value, agentById) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const agents = [];
  for (const agent of value) {
    if (agents.length >= MAX_SESSION_FILE_HISTORY_AGENTS) break;
    if (!agent || typeof agent.agentId !== "string" || !SAFE_FILE_CHANGE_AGENT_ID.test(agent.agentId) || seen.has(agent.agentId)) continue;
    if (!Number.isSafeInteger(agent.changeCount) || agent.changeCount < 1) continue;
    seen.add(agent.agentId);
    const visible = fileChangeAgentIdentity(agentById.get(agent.agentId));
    const recorded = fileChangeAgentIdentity(agent);
    agents.push({
      id: agent.agentId,
      label: visible.label ?? recorded.label,
      assignment: visible.assignment ?? recorded.assignment,
      model: visible.model ?? recorded.model,
      changeCount: agent.changeCount,
    });
  }
  return agents;
}

function recordedFile(value, agentById) {
  if (!value || typeof value.fileId !== "string" || !FILE_ID_PATTERN.test(value.fileId)) return null;
  if (!isSafeRecordedRepositoryPath(value.path) || !FILE_CHANGE_KINDS.has(value.kind)) return null;
  if (!Number.isSafeInteger(value.changeCount) || value.changeCount < 0) return null;
  if (typeof value.lastObservedAt !== "string" || !Number.isFinite(Date.parse(value.lastObservedAt))) return null;
  return {
    path: value.path, source: "recorded", fileId: value.fileId, kind: value.kind, changeCount: value.changeCount,
    lastObservedAt: value.lastObservedAt, agents: recordedAgents(value.agents, agentById),
  };
}

function committedFile(value) {
  if (!isSafeRecordedRepositoryPath(value?.path) || !GIT_OBSERVED_SOURCES.has(value?.source)) return null;
  return { path: value.path, source: value.source, change: GIT_OBSERVED_CHANGES.has(value.change) ? value.change : null };
}

// Re-validates the committed file-history-domain block: an invalid or missing block degrades to
// unavailable rather than ever letting an unvalidated path or count reach the browser.
function recordedFiles(value, agents) {
  const agentById = new Map(agents.map((agent) => [agent?.id, agent]));
  const files = Array.isArray(value?.files) ? value.files.map((entry) => recordedFile(entry, agentById)).filter(Boolean) : [];
  return {
    readiness: FILE_HISTORY_READINESS.has(value?.readiness) ? value.readiness : "unavailable",
    files: files.slice(0, MAX_SESSION_FILE_HISTORY_FILES),
    truncated: Boolean(value?.truncated),
  };
}

// Re-validates the already recorded Git-observed block (the recorder's persisted snapshot for this
// session, live or historical). One malformed entry rejects the whole block, so a partially valid
// shape never leaks; null means no committed entries.
function committedFiles(value) {
  if (!value || !Array.isArray(value.files) || value.files.length > MAX_GIT_OBSERVED_FILES || typeof value.truncated !== "boolean") return null;
  const files = [];
  for (const file of value.files) {
    const normalized = committedFile(file);
    if (!normalized) return null;
    files.push(normalized);
  }
  return { files, truncated: value.truncated };
}

/**
 * The finished Touched here list. `fileHistory` is the committed recorded file-history block,
 * `gitObserved` the recorded Git-observed block, and `agents` the session's visible normalized
 * agents. Entries are sorted by path and a path appears once: a path both recorded and committed
 * is its recorded entry only, because only a path no tool touched is listed as committed.
 * Committed entries are listed whatever the recorded history's readiness. `readiness` is the
 * recorded history's, and `truncated` is true when either source was cut at its cap.
 */
export function sessionTouchedFiles({ fileHistory, gitObserved, agents } = {}) {
  const recorded = recordedFiles(fileHistory, Array.isArray(agents) ? agents : []);
  const committed = committedFiles(gitObserved);
  const byPath = new Map();
  for (const file of recorded.files) if (!byPath.has(file.path)) byPath.set(file.path, file);
  for (const file of committed?.files ?? []) if (!byPath.has(file.path)) byPath.set(file.path, file);
  return {
    readiness: recorded.readiness,
    files: [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    truncated: recorded.truncated || Boolean(committed?.truncated),
  };
}

/**
 * The session tab chip's count of the Touched here list. Only a count leaves the monitor for the
 * summary; it is null until the recorded history is ready so the chip never shows a partial or
 * unknown figure.
 */
export function touchedFileCount(touchedFiles) {
  return touchedFiles?.readiness === "ready" && Array.isArray(touchedFiles.files) ? touchedFiles.files.length : null;
}
