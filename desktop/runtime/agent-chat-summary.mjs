// The summary of a repository's thread: what Aril concluded in the part of the conversation that no longer fits in a prompt, kept
// as one private JSON file beside the repository's conversations. Only desktop main reads or writes it. The text is derived from the
// owner's own conversation, is sent only to the provider of that repository's later runs, and is never returned to a browser or a
// paired device: the thread answers only where the summary ends (see `summarizedView`).

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { normalizeTiming } from "./agent-chat-timing.mjs";

// The longest summary Pomegr stores. The instructions of a compaction ask for less, so a run that goes over is refused and not cut.
export const SUMMARY_LENGTH = 6_000;
export const SUMMARY_FILE = "summary.json";

const VERSION = 1;
const FILE_LIMIT_BYTES = 64 * 1024;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const CONVERSATION_ID = /^chat-[0-9a-f]{12}$/u;
const MESSAGE_ID = /^m-[1-9][0-9]{0,5}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]*$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const instant = (value) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));

/**
 * A summary record inside the contract, or null: `{ text, through, at, provider, model, effort?, timing? }`. `through` is the thread
 * position of the newest message the text covers (`{ conversationId, messageId, at }`), and `at` is when the summary was written. A
 * `timing` outside its contract is left out; the record keeps its text.
 */
export function normalizeSummary(value) {
  if (!isPlainObject(value) || typeof value.text !== "string" || value.text.trim() === "" || value.text.length > SUMMARY_LENGTH || !TEXT.test(value.text)) return null;
  const { through } = value;
  if (!isPlainObject(through) || typeof through.conversationId !== "string" || !CONVERSATION_ID.test(through.conversationId)
    || typeof through.messageId !== "string" || !MESSAGE_ID.test(through.messageId) || !instant(through.at)) return null;
  if (!instant(value.at) || !PROVIDERS.has(value.provider) || !(value.model === null || (typeof value.model === "string" && MODEL.test(value.model)))) return null;
  if (!(value.effort === undefined || value.effort === null || (typeof value.effort === "string" && EFFORTS.has(value.effort)))) return null;
  const timing = normalizeTiming(value.timing);
  return {
    text: value.text, through: { conversationId: through.conversationId, messageId: through.messageId, at: through.at }, at: value.at,
    provider: value.provider, model: value.model, ...(value.effort ? { effort: value.effort } : {}), ...(timing ? { timing } : {}),
  };
}

/** What a client may know of a summary: where it ends and when it was written, never its text. Null for none. */
export function summarizedView(summary) {
  return summary ? { through: { ...summary.through }, at: summary.at } : null;
}

/**
 * The summaries of the repositories, one file each under the chat's directory: `<directory>/<repository ID>/summary.json`, holding
 * `{ version: 1, repositoryId, summary }`. A file outside the contract reads as none and is not overwritten until a new summary is
 * written. A write replaces the file whole, through a temporary file and a rename.
 */
export function createAgentChatSummaries({ directory, filesystem = fs } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new TypeError("Invalid agent chat directory");
  const cache = new Map();
  const writes = new Map();
  const file = (repositoryId) => path.join(directory, repositoryId, SUMMARY_FILE);
  const valid = (repositoryId) => typeof repositoryId === "string" && REPOSITORY_ID.test(repositoryId);

  async function load(repositoryId) {
    try {
      const target = file(repositoryId);
      if ((await filesystem.stat(target)).size > FILE_LIMIT_BYTES) return null;
      const parsed = JSON.parse(await filesystem.readFile(target, "utf8"));
      return isPlainObject(parsed) && parsed.version === VERSION && parsed.repositoryId === repositoryId ? normalizeSummary(parsed.summary) : null;
    } catch { return null; }
  }

  return Object.freeze({
    /** The repository's summary, or null when it has none or its file is outside the contract. */
    async read(repositoryId) {
      if (!valid(repositoryId)) return null;
      await (writes.get(repositoryId) ?? Promise.resolve()).catch(() => {});
      if (!cache.has(repositoryId)) cache.set(repositoryId, await load(repositoryId));
      return cache.get(repositoryId);
    },
    /** Replaces the repository's summary; answers whether it was written. A summary outside the contract changes nothing. */
    async write(repositoryId, summary) {
      const next = valid(repositoryId) ? normalizeSummary(summary) : null;
      if (!next) return false;
      const run = async () => {
        const serialized = `${JSON.stringify({ version: VERSION, repositoryId, summary: next })}\n`;
        const target = file(repositoryId);
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await filesystem.mkdir(path.dirname(target), { recursive: true });
          await filesystem.writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
          await filesystem.rename(temporary, target);
          cache.set(repositoryId, next);
          return true;
        } catch {
          await filesystem.unlink(temporary).catch(() => {});
          return false;
        }
      };
      const queued = (writes.get(repositoryId) ?? Promise.resolve()).then(run, run);
      writes.set(repositoryId, queued);
      void queued.finally(() => { if (writes.get(repositoryId) === queued) writes.delete(repositoryId); });
      return queued;
    },
  });
}
