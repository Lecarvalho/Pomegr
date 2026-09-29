import path from "node:path";
import { isClaudeSessionFileLive, statSafe } from "../../normalize/session-discovery.mjs";

/** A Claude session's local ID is always its main transcript file's own basename, so this
 * module never needs to read a file's content to name it. It only needs enough of the file
 * to exist to be worth indexing. */
export const CLAUDE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Translate one `{ file, activityMs }` discovery row into the source ledger's bounded,
 * provider-neutral header shape. Claude sessions carry no provider-native parent/fork/group
 * relation the ledger's family closure could use, so those fields stay null; only `locate()`
 * is exercised for Claude, not `family()`. `preference` carries discovery's own recorded
 * activity time so the ledger's preferred-copy rule reproduces discovery's own choice
 * (newest activity wins) regardless of ingestion order, matching `listSessionFiles`. */
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

/** Index one discovery pass. Discovery lists newest activity first while the ledger evicts
 * its oldest insertion first, so the batch goes in oldest first: over the entry bound the
 * least recent sessions leave, never the newest. */
export function ingestClaudeDiscovery(ledger, files) {
  ledger.ingestHeaders(files.map(({ file, activityMs }) => ({ file, header: claudeSourceLedgerHeader(file, activityMs) })).reverse());
}

/** The source ledger's `parseHeader` hook for Claude: given a path a notification claims is
 * a new main transcript, this confirms only that a file exists there (one stat, no read) and
 * names it from its own basename. `preference` falls back to file mtime, since a notice
 * predates the next full discovery pass that would supply a precise activity time. */
export function parseClaudeSessionLedgerHeader(file) {
  const stat = statSafe(file);
  if (!stat || !stat.isFile()) return null;
  const localId = path.basename(file, ".jsonl");
  if (!CLAUDE_SESSION_ID_PATTERN.test(localId)) return null;
  return claudeSourceLedgerHeader(file, stat.mtimeMs);
}

/**
 * Resolves one session's main file, live/historical state and registry snapshot: from the
 * shared source ledger when it already knows the session (re-verified with one file stat so
 * a deleted or replaced file is never served stale), otherwise from the caller's full
 * discovery. The explicit session file and malformed IDs always take discovery. An ID the
 * ledger neither knows nor has recently missed on triggers one discovery pass; if that pass
 * still cannot find it, the miss is remembered so a repeated read of the same unknown ID
 * does not walk the tree again until the ledger's own miss TTL expires or a notification
 * ingests the ID first.
 */
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
        // The indexed file is gone: one full discovery pass below finds a moved copy, and a
        // miss it records stops later reads from walking again inside the TTL.
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
