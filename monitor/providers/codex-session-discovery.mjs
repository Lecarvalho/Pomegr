import fs from "node:fs";
import path from "node:path";
import { isSafeCodexSessionId, readCodexRolloutHeader } from "./codex-session-metadata.mjs";

export function timestampValue(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function compareCodexMetadata(left, right) {
  const updated = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
  if (updated) return updated;
  return left.localId.localeCompare(right.localId);
}

export function boundedInteger(value, fallback, maximum) {
  return Number.isInteger(value) ? Math.max(1, Math.min(maximum, value)) : fallback;
}

export function mergeCodexMetadata(items) {
  const byId = new Map();
  for (const item of [...items].sort(compareCodexMetadata)) {
    const previous = byId.get(item.localId);
    if (!previous) {
      byId.set(item.localId, item);
      continue;
    }
    const preferred = timestampValue(item.updatedAt) > timestampValue(previous.updatedAt) ? item : previous;
    const alternate = preferred === item ? previous : item;
    byId.set(item.localId, {
      ...preferred,
      title: preferred.title !== "Untitled session" ? preferred.title : alternate.title,
      cwd: preferred.cwd || alternate.cwd,
      project: preferred.cwd ? preferred.project : alternate.project,
      createdAt: preferred.createdAt || alternate.createdAt,
      recordedGitBranch: preferred.recordedGitBranch || alternate.recordedGitBranch,
      sessionId: preferred.sessionId || alternate.sessionId,
      parentThreadId: preferred.parentThreadId || alternate.parentThreadId,
      forkedFromId: preferred.forkedFromId || alternate.forkedFromId,
      agentPath: preferred.agentPath || alternate.agentPath,
      approvalReviewer: preferred.approvalReviewer || alternate.approvalReviewer,
      agentNickname: preferred.agentNickname || alternate.agentNickname,
      agentRole: preferred.agentRole || alternate.agentRole,
      agentAssignment: preferred.agentAssignment || alternate.agentAssignment,
      runtimeStatus: preferred.runtimeStatus || alternate.runtimeStatus,
      liveStatus: preferred.liveStatus || alternate.liveStatus,
      liveness: preferred.liveness || alternate.liveness,
      archived: item.archived && previous.archived,
      rolloutFile: item.rolloutFile || previous.rolloutFile,
    });
  }
  return [...byId.values()].sort(compareCodexMetadata);
}

export function expandCodexSelectedMetadata(metadataById, selectedIds) {
  let changed = true;
  while (changed) {
    changed = false;
    const relatedSessionIds = new Set([...selectedIds].flatMap((id) => {
      const sessionId = metadataById.get(id)?.sessionId;
      return sessionId ? [id, sessionId] : [id];
    }));
    for (const metadata of metadataById.values()) {
      if (selectedIds.has(metadata.localId)) continue;
      const hasSelectedParent = [metadata.parentThreadId, metadata.forkedFromId].some((id) => id && selectedIds.has(id));
      const sharesSelectedSession = metadata.sessionId && metadata.sessionId !== metadata.localId && relatedSessionIds.has(metadata.sessionId);
      if (!hasSelectedParent && !sharesSelectedSession) continue;
      selectedIds.add(metadata.localId);
      changed = true;
    }
  }
}

export function mergeFreshCodexSessionTreeMetadata(discovered, sessionTree) {
  const merged = mergeCodexMetadata([...discovered, ...sessionTree.metadata]);
  const freshById = new Map(sessionTree.metadata.filter((item) => sessionTree.freshIds.has(item.localId)).map((item) => [item.localId, item]));
  return merged.map((item) => {
    const fresh = freshById.get(item.localId);
    return fresh ? {
      ...item,
      updatedAt: fresh.updatedAt || item.updatedAt,
      sessionId: fresh.sessionId,
      parentThreadId: fresh.parentThreadId,
      forkedFromId: fresh.forkedFromId,
      agentPath: fresh.agentPath || item.agentPath,
      approvalReviewer: fresh.approvalReviewer || item.approvalReviewer,
      sourceKind: fresh.sourceKind,
      agentNickname: fresh.agentNickname,
      agentRole: fresh.agentRole,
      agentAssignment: fresh.agentAssignment || item.agentAssignment,
      runtimeStatus: fresh.runtimeStatus,
    } : item;
  });
}

export function appServerResponseData(response) {
  const value = response?.result ?? response;
  return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : null;
}

export function appServerResponseThread(response) {
  const value = response?.result ?? response;
  return value?.thread && typeof value.thread === "object" ? value.thread : null;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function trustedAppServerRolloutFile(thread, roots) {
  if (!isSafeCodexSessionId(thread?.id) || typeof thread?.path !== "string" || !thread.path.trim()) return null;
  let candidate;
  try {
    candidate = fs.realpathSync(path.resolve(thread.path));
    if (!fs.statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  const allowed = roots.some((root) => {
    try { return pathIsWithin(fs.realpathSync(root), candidate); } catch { return false; }
  });
  if (!allowed) return null;
  const header = readCodexRolloutHeader(candidate);
  return header?.localId === thread.id ? candidate : null;
}
