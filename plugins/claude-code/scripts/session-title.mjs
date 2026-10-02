import path from "node:path";

export const SESSION_TITLE_MAX_LENGTH = 80;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_TITLE_CHARACTER_PATTERN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

export function normalizeSessionTitle(value) {
  if (typeof value !== "string" || UNSAFE_TITLE_CHARACTER_PATTERN.test(value)) return null;
  const title = value.trim().replace(/ {2,}/g, " ");
  if (!title || [...title].length > SESSION_TITLE_MAX_LENGTH) return null;
  return title;
}

export function validSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/**
 * Claude supplies the current transcript path itself; the MCP input never does.
 * Prefer that host-owned identity after /clear, where provider message metadata
 * can still carry the preceding session ID.
 */
export function sessionIdFromTranscriptPath(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return null;
  const match = /^([0-9a-f-]+)\.jsonl$/i.exec(path.basename(transcriptPath));
  return match && validSessionId(match[1]) ? match[1] : null;
}

/**
 * A new title always replaces the current one, whether it was automatic,
 * carried over by /clear, or set earlier in this session.
 */
export function createSessionTitleRenamer({ renameSession }) {
  const pendingBySession = new Map();

  return async function renameCurrentSession({ sessionId, directory, title }) {
    const normalizedTitle = normalizeSessionTitle(title);
    if (!normalizedTitle) return { status: "rejected" };
    if (!validSessionId(sessionId)) return { status: "unavailable" };
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return { status: "unavailable" };

    const previous = pendingBySession.get(sessionId) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      try {
        await renameSession(sessionId, normalizedTitle, { dir: directory });
        return { status: "renamed" };
      } catch {
        return { status: "unavailable" };
      }
    });

    pendingBySession.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (pendingBySession.get(sessionId) === operation) pendingBySession.delete(sessionId);
    }
  };
}
