import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const SESSION_TITLE_MAX_LENGTH = 80;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_TITLE_CHARACTER_PATTERN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_TITLE_RECORD_BYTES = 16 * 1024;

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
 * The Agent SDK currently folds an automatic `ai-title` into
 * SDKSessionInfo.customTitle, despite documenting that field as user-set. Read
 * only native custom-title records so an automatic title cannot suppress the
 * native rename mutation. No other transcript content leaves this process.
 */
export async function readExplicitSessionTitle(transcriptPath, sessionId) {
  if (sessionIdFromTranscriptPath(transcriptPath) !== sessionId) return { status: "unavailable", title: null };

  let title = null;
  let handle;
  let input;
  let lines;
  try {
    handle = await fs.promises.open(transcriptPath, "r");
    const [opened, linked] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.promises.lstat(transcriptPath, { bigint: true }),
    ]);
    if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()) return { status: "unavailable", title: null };
    if (opened.size > BigInt(MAX_TRANSCRIPT_BYTES)) return { status: "unavailable", title: null };
    if (opened.dev !== linked.dev || opened.ino !== linked.ino) return { status: "unavailable", title: null };

    input = handle.createReadStream({ encoding: "utf8", autoClose: false });
    lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes("customTitle")) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_TITLE_RECORD_BYTES) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== "custom-title") continue;
      const recordSessionId = record.sessionId ?? record.session_id;
      if (recordSessionId !== undefined && recordSessionId !== sessionId) continue;
      if (typeof record.customTitle === "string" && record.customTitle.trim()) title = record.customTitle;
    }
  } catch {
    return { status: "unavailable", title: null };
  } finally {
    lines?.close();
    input?.destroy();
    await handle?.close().catch(() => undefined);
  }
  return { status: "available", title };
}

export function createSessionTitleRenamer({ readExplicitTitle, renameSession }) {
  const pendingBySession = new Map();

  return async function renameCurrentSession({ sessionId, directory, transcriptPath, title }) {
    const normalizedTitle = normalizeSessionTitle(title);
    if (!normalizedTitle) return { status: "rejected" };
    if (!validSessionId(sessionId)) return { status: "unavailable" };
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return { status: "unavailable" };

    const previous = pendingBySession.get(sessionId) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      try {
        const initial = await readExplicitTitle(transcriptPath, sessionId);
        if (initial?.status !== "available") return { status: "unavailable" };
        if (initial.title) return { status: "preserved" };

        const current = await readExplicitTitle(transcriptPath, sessionId);
        if (current?.status !== "available") return { status: "unavailable" };
        if (current.title) return { status: "preserved" };

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
