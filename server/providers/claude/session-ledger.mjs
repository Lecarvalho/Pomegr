import path from "node:path";
import { isClaudeSessionFileLive, statSafe } from "../../normalize/session-discovery.mjs";

export const CLAUDE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function claudeSourceLedgerHeader(file, activityMs) {
  return {
    localId: path.basename(file, ".jsonl"),
    parentId: null,
    forkedFromId: null,
    groupId: null,
    archived: false,
    createdAt: null,
    lastRecordAt: null,
    preference: Number.isFinite(activityMs) ? activityMs : null,
  };
}

export function ingestClaudeDiscovery(ledger, files) {
  ledger.ingestHeaders(files.map(({ file, activityMs }) => ({ file, header: claudeSourceLedgerHeader(file, activityMs) })).reverse());
}

export function parseClaudeSessionLedgerHeader(file) {
  const stat = statSafe(file);
  if (!stat || !stat.isFile()) return null;
  const localId = path.basename(file, ".jsonl");
  if (!CLAUDE_SESSION_ID_PATTERN.test(localId)) return null;
  return claudeSourceLedgerHeader(file, stat.mtimeMs);
}

export function createClaudeSessionResolver({ ledger, discover, readRegistry, explicitFile, registryAvailable, now, selectFile }) {
  return (localSessionId) => {
    const explicit = explicitFile();
    const eligible = Boolean(localSessionId)
      && CLAUDE_SESSION_ID_PATTERN.test(localSessionId)
      && !(explicit && path.basename(explicit, ".jsonl") === localSessionId);
    if (eligible) {
      const located = ledger.locate(localSessionId);
      if (located?.file) {
        const stat = statSafe(located.file);
        if (stat) {
          const { registry, closedSessionIds } = readRegistry();
          const historical = !isClaudeSessionFileLive(located.file, {
            explicitFile: explicit,
            registrySessionIds: registry.keys(),
            closedSessionIds,
            registryAvailable: registryAvailable(),
            nowMs: now(),
            agentDir: path.join(path.dirname(located.file), path.basename(located.file, ".jsonl"), "subagents"),
          });
          return { mainFile: located.file, historical, registry };
        }
        if (ledger.recentMiss(localSessionId)) return null;
      } else if (ledger.recentMiss(localSessionId)) {
        return null;
      }
    }
    const discovered = discover();
    const mainFile = localSessionId ? selectFile(localSessionId, discovered.files) : discovered.liveFile;
    if (!mainFile) {
      if (eligible) ledger.rememberMiss(localSessionId);
      return null;
    }
    return { mainFile, historical: !discovered.liveFiles.has(mainFile), registry: discovered.registry };
  };
}
