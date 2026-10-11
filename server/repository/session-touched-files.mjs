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

function recordedFiles(value, agents) {
  const agentById = new Map(agents.map((agent) => [agent?.id, agent]));
  const files = Array.isArray(value?.files) ? value.files.map((entry) => recordedFile(entry, agentById)).filter(Boolean) : [];
  return {
    readiness: FILE_HISTORY_READINESS.has(value?.readiness) ? value.readiness : "unavailable",
    files: files.slice(0, MAX_SESSION_FILE_HISTORY_FILES),
    truncated: Boolean(value?.truncated),
  };
}

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

export function touchedFileCount(touchedFiles) {
  return touchedFiles?.readiness === "ready" && Array.isArray(touchedFiles.files) ? touchedFiles.files.length : null;
}
