import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CODEX_CATALOG_LIMIT = 50;
export const DEFAULT_CODEX_SCAN_LIMIT = 500;
const DEFAULT_INDEX_BYTES = 1024 * 1024;
const DEFAULT_HEADER_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 160;
const MAX_AGENT_PATH_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_BRANCH_LENGTH = 256;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOP_LEVEL_SOURCE_KINDS = new Set(["cli", "vscode", "exec", "appServer", "unknown"]);

function boundedText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function boundedPath(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_PATH_LENGTH);
}

export function isSafeCodexSessionId(value) {
  return typeof value === "string" && SAFE_SESSION_ID.test(value);
}

export function codexTimestamp(value) {
  let milliseconds;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim()) {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function codexSourceKind(source) {
  if (typeof source === "string") {
    if (source === "app_server") return "appServer";
    if (source === "sub_agent") return "subAgent";
    return TOP_LEVEL_SOURCE_KINDS.has(source) ? source : "unknown";
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return "unknown";
  const subagent = source.subAgent ?? source.subagent;
  if (subagent === "review") return "subAgentReview";
  if (subagent === "compact") return "subAgentCompact";
  if (subagent && typeof subagent === "object" && ("thread_spawn" in subagent || "threadSpawn" in subagent)) return "subAgentThreadSpawn";
  if (subagent !== undefined) return "subAgentOther";
  return "unknown";
}

export function isCodexApprovalReviewerSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const subagent = source.subAgent ?? source.subagent;
  return Boolean(subagent && typeof subagent === "object" && subagent.other === "guardian");
}

function projectFromCwd(cwd) {
  if (!cwd) return "Unknown project";
  const segments = cwd.split(/[\\/]+/).filter(Boolean);
  return boundedText(segments.at(-1), MAX_TITLE_LENGTH) || "Unknown project";
}

function readBoundedFile(file, maximum, fromEnd = false) {
  let stat;
  try { stat = fs.statSync(file); } catch { return ""; }
  if (!stat.isFile() || stat.size <= 0) return "";
  const bytes = Math.min(stat.size, maximum);
  const buffer = Buffer.alloc(bytes);
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    fs.readSync(descriptor, buffer, 0, bytes, fromEnd ? Math.max(0, stat.size - bytes) : 0);
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let text = buffer.toString("utf8");
  if (fromEnd && stat.size > bytes) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  return text;
}

export function readCodexSessionIndex(indexFile, maximumBytes = DEFAULT_INDEX_BYTES) {
  const names = new Map();
  for (const line of readBoundedFile(indexFile, maximumBytes, true).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!isSafeCodexSessionId(entry?.id)) continue;
      const title = boundedText(entry.thread_name, MAX_TITLE_LENGTH);
      if (!title) continue;
      names.set(entry.id, { title, updatedAt: codexTimestamp(entry.updated_at) });
    } catch {
      // The index is append-only; malformed and truncated lines are ignored independently.
    }
  }
  return names;
}

function sessionParentId(payload) {
  const direct = payload?.parentThreadId ?? payload?.parent_thread_id;
  if (isSafeCodexSessionId(direct)) return direct;
  const subagent = payload?.source?.subAgent ?? payload?.source?.subagent;
  const spawned = subagent?.thread_spawn ?? subagent?.threadSpawn;
  const parent = spawned?.parent_thread_id ?? spawned?.parentThreadId;
  return isSafeCodexSessionId(parent) ? parent : null;
}

function sessionSpawnMetadata(payload) {
  const subagent = payload?.source?.subAgent ?? payload?.source?.subagent;
  const spawned = subagent?.thread_spawn ?? subagent?.threadSpawn;
  return spawned && typeof spawned === "object" ? spawned : {};
}

function safeRelatedId(value) {
  return isSafeCodexSessionId(value) ? value : null;
}

export function codexThreadRuntimeStatus(status) {
  const type = typeof status === "string" ? status : status?.type;
  if (!["notLoaded", "idle", "systemError", "active"].includes(type)) return null;
  return type === "active" ? { type, activeFlags: Array.isArray(status?.activeFlags)
    ? status.activeFlags.filter((flag) => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)).sort()
    : [] } : { type };
}

export function readCodexRolloutHeader(file, options = {}) {
  const maximumBytes = options.maximumBytes ?? DEFAULT_HEADER_BYTES;
  let sessionRecord = null;
  for (const line of readBoundedFile(file, maximumBytes).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "session_meta" && record.payload && typeof record.payload === "object") {
        sessionRecord = record;
        break;
      }
    } catch {
      // Live writes and damaged history can leave one bad line without invalidating the file.
    }
  }
  if (!sessionRecord) return null;
  const payload = sessionRecord.payload;
  const localId = payload.id ?? payload.thread_id;
  if (!isSafeCodexSessionId(localId)) return null;
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cwd = boundedPath(payload.cwd);
  const sourceKind = codexSourceKind(payload.source);
  const parentThreadId = sessionParentId(payload);
  const spawned = sessionSpawnMetadata(payload);
  return {
    localId,
    provider: "codex",
    source: "Codex",
    title: boundedText(payload.thread_name, MAX_TITLE_LENGTH) || "Untitled session",
    project: projectFromCwd(cwd),
    cwd,
    createdAt: codexTimestamp(payload.timestamp ?? sessionRecord.timestamp),
    updatedAt: stat.mtime.toISOString(),
    sourceKind,
    approvalReviewer: isCodexApprovalReviewerSource(payload.source),
    sessionId: safeRelatedId(payload.sessionId ?? payload.session_id) || localId,
    parentThreadId,
    forkedFromId: safeRelatedId(payload.forkedFromId ?? payload.forked_from_id),
    agentPath: boundedText(payload.agentPath ?? payload.agent_path ?? spawned.agent_path ?? spawned.agentPath, MAX_AGENT_PATH_LENGTH),
    agentNickname: boundedText(payload.agentNickname ?? payload.agent_nickname ?? spawned.agent_nickname ?? spawned.agentNickname, MAX_TITLE_LENGTH),
    agentRole: boundedText(payload.agentRole ?? payload.agent_role ?? spawned.agent_role ?? spawned.agentRole, MAX_TITLE_LENGTH),
    runtimeStatus: null,
    recordedGitBranch: boundedText(payload.git?.branch, MAX_BRANCH_LENGTH),
    archived: Boolean(options.archived),
    rolloutFile: file,
  };
}

function walkRecentRollouts(root, maximumFiles, maximumDepth = 5) {
  const files = [];
  function visit(directory, depth) {
    if (files.length >= maximumFiles || depth > maximumDepth) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      if (files.length >= maximumFiles) break;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) files.push(full);
    }
  }
  visit(root, 0);
  return files;
}

export function listCodexRolloutMetadata(root, options = {}) {
  const requestedMaximum = Number.isInteger(options.maximumFiles) ? options.maximumFiles : DEFAULT_CODEX_SCAN_LIMIT;
  const maximumFiles = Math.max(1, Math.min(DEFAULT_CODEX_SCAN_LIMIT, requestedMaximum));
  return walkRecentRollouts(root, maximumFiles)
    .flatMap((file) => {
      const metadata = readCodexRolloutHeader(file, { archived: options.archived });
      return metadata ? [metadata] : [];
    });
}

export function normalizeCodexThreadMetadata(thread, options = {}) {
  const localId = thread?.id ?? thread?.threadId;
  if (!isSafeCodexSessionId(localId) || thread?.ephemeral === true) return null;
  const cwd = boundedPath(thread.cwd);
  const explicitTitle = boundedText(thread.name, MAX_TITLE_LENGTH);
  const indexName = boundedText(options.indexName, MAX_TITLE_LENGTH);
  const localSessionId = safeRelatedId(thread.sessionId) || localId;
  return {
    localId,
    provider: "codex",
    source: "Codex",
    title: explicitTitle || indexName || "Untitled session",
    project: projectFromCwd(cwd),
    cwd,
    createdAt: codexTimestamp(thread.createdAt),
    updatedAt: codexTimestamp(thread.updatedAt) || codexTimestamp(thread.recencyAt),
    sourceKind: codexSourceKind(thread.source),
    approvalReviewer: isCodexApprovalReviewerSource(thread.source),
    sessionId: localSessionId,
    parentThreadId: isSafeCodexSessionId(thread.parentThreadId) ? thread.parentThreadId : null,
    forkedFromId: safeRelatedId(thread.forkedFromId),
    agentPath: boundedText(thread.agentPath, MAX_AGENT_PATH_LENGTH),
    agentNickname: boundedText(thread.agentNickname, MAX_TITLE_LENGTH),
    agentRole: boundedText(thread.agentRole, MAX_TITLE_LENGTH),
    agentAssignment: explicitTitle || null,
    runtimeStatus: codexThreadRuntimeStatus(thread.status),
    recordedGitBranch: boundedText(thread.gitInfo?.branch, MAX_BRANCH_LENGTH),
    archived: Boolean(options.archived),
    rolloutFile: null,
  };
}

export function isTopLevelCodexSession(metadata) {
  return Boolean(metadata && !metadata.parentThreadId && TOP_LEVEL_SOURCE_KINDS.has(metadata.sourceKind));
}
