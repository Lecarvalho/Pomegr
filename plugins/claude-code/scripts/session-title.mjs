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

export function createSessionTitleRenamer({ getSessionInfo, renameSession }) {
  const pendingBySession = new Map();

  return async function renameCurrentSession({ sessionId, directory, title }) {
    const normalizedTitle = normalizeSessionTitle(title);
    if (!normalizedTitle) return { status: "rejected" };
    if (!validSessionId(sessionId)) return { status: "unavailable" };
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return { status: "unavailable" };

    const previous = pendingBySession.get(sessionId) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      try {
        const initial = await getSessionInfo(sessionId, { dir: directory });
        if (!initial) return { status: "unavailable" };
        if (typeof initial.customTitle === "string" && initial.customTitle.trim()) return { status: "preserved" };

        const current = await getSessionInfo(sessionId, { dir: directory });
        if (!current) return { status: "unavailable" };
        if (typeof current.customTitle === "string" && current.customTitle.trim()) return { status: "preserved" };

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
