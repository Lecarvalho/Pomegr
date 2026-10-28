// The thread of one repository: one continuous conversation with Aril, as a view over the repository's saved conversations in
// message-time order. Nothing here reads or writes a file itself. A repository holds any number of conversations, so every read of
// the thread goes through a `source`, the index of the conversations (`store.index`) with a read of one conversation's messages,
// and takes conversations newest first and stops as soon as the page, the matches, or the history it needs are complete. It
// answers nothing that `read` of those conversations does not already answer.

import { MESSAGE_LIMIT } from "./agent-chat-store.mjs";

export const THREAD_PAGE = 60;
export const SEARCH_LIMIT = 20;
export const SEARCH_QUERY_LIMIT = 100;
// The conversations one `list` answer holds, newest first. It is the size of an answer, not a limit on what a repository keeps.
export const LIST_LIMIT = 50;
// Pages read to fill the history of one prompt: 6,000 messages, far more than its 24,000 characters hold.
const HISTORY_PAGES = 100;
// A snippet shows this much of the message before the match and after it, with the match between.
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;
// Messages searched between two pauses.
const SEARCH_BATCH = 200;
const CURSOR_LIMIT = 200;
const CURSOR_FORM = /^[A-Za-z0-9_-]{1,200}$/u;
const CONVERSATION_ID = /^chat-[0-9a-f]{12}$/u;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

const refused = (error) => Object.freeze({ ok: false, error });
const INVALID = refused("invalid");

const hasExactly = (payload, keys) => Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));

/** The thread of a repository as the reads below take it: its index entries, and a read of one conversation's messages. */
export const threadSource = (store, repositoryId, metas) => ({ metas, read: (id) => store.read(repositoryId, id) });

// The order of the thread: the time of a message, then the creation of its conversation, then the conversation, then its place in it.
function compare(left, right) {
  return left.at - right.at || left.created - right.created || (left.conversation < right.conversation ? -1 : left.conversation > right.conversation ? 1 : 0) || left.index - right.index;
}

/** The messages of one conversation with their sort keys, in the order they are stored. */
function entriesOf(conversation) {
  const created = Date.parse(conversation.createdAt);
  return conversation.messages.map((message, index) => ({ message, conversationId: conversation.id, key: { at: Date.parse(message.at), created, conversation: conversation.id, index } }));
}

const byKey = (left, right) => compare(left.key, right.key);

const encodeCursor = (key) => Buffer.from(JSON.stringify([key.at, key.created, key.conversation, key.index]), "utf8").toString("base64url");

// A cursor names the oldest message of the page before it. It is opaque to a client, and only this reads it back.
function decodeCursor(value) {
  if (typeof value !== "string" || value.length > CURSOR_LIMIT || !CURSOR_FORM.test(value)) return null;
  try {
    const [at, created, conversation, index] = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const key = { at, created, conversation, index };
    // Only the form this module writes is a cursor, so a decoder that skips a stray character cannot make a second spelling of one.
    return Number.isSafeInteger(at) && Number.isSafeInteger(created) && typeof conversation === "string" && CONVERSATION_ID.test(conversation)
      && Number.isSafeInteger(index) && index >= 0 && index < MESSAGE_LIMIT && encodeCursor(key) === value ? key : null;
  } catch { return null; }
}

/**
 * One page of the thread: the newest `limit` messages before the cursor, oldest first, each with its conversation, and the cursor of the
 * page before. A conversation holds messages from its index entry's `from` to its `to`, so conversations are read from the one that
 * can reach the newest message, and reading stops when the next one cannot reach above the oldest message of the page. Null for a
 * cursor this module did not write.
 */
export async function threadPage(source, { before = null, limit = THREAD_PAGE } = {}) {
  const cursor = before === null ? null : decodeCursor(before);
  if (before !== null && !cursor) return null;
  const ceiling = cursor ? cursor.at : Number.POSITIVE_INFINITY;
  const reach = (meta) => Math.min(meta.to, ceiling);
  const candidates = source.metas.filter((meta) => meta.messages > 0 && meta.from <= ceiling).sort((left, right) => reach(right) - reach(left));
  let kept = [];
  let trimmed = false;
  let visited = 0;
  for (; visited < candidates.length; visited += 1) {
    if (kept.length >= limit && reach(candidates[visited]) < kept[0].key.at) break;
    const conversation = await source.read(candidates[visited].id);
    if (!conversation) continue;
    kept = [...kept, ...entriesOf(conversation).filter((entry) => cursor === null || compare(entry.key, cursor) < 0)].sort(byKey);
    if (kept.length > limit) { kept = kept.slice(-limit); trimmed = true; }
  }
  // Something older exists when a message was cut from the page, or when a conversation that was not read starts before the page does.
  let older = trimmed;
  for (; !older && visited < candidates.length; visited += 1) {
    const meta = candidates[visited];
    if (meta.from < kept[0].key.at) older = true;
    else if (meta.from === kept[0].key.at) {
      const conversation = await source.read(meta.id);
      older = conversation !== null && entriesOf(conversation).some((entry) => compare(entry.key, kept[0].key) < 0);
    }
  }
  return {
    messages: kept.map(({ message, conversationId }) => ({ conversationId, ...message })),
    before: older ? encodeCursor(kept[0].key) : null,
  };
}

/**
 * The newest earlier messages of the thread, oldest first, for the prompt: pages are read back from the newest until `enough(messages)`
 * says the messages read already fill the history, so the older conversations are not read.
 */
export async function threadHistory(source, enough) {
  let messages = [];
  let before = null;
  for (let pages = 0; pages < HISTORY_PAGES; pages += 1) {
    const page = await threadPage(source, { before });
    if (!page) break;
    messages = [...page.messages, ...messages];
    before = page.before;
    if (before === null || enough(messages)) break;
  }
  return messages;
}

/**
 * The conversation the next message goes to: the most recently updated one that is not a grant follow-up conversation and has room for the
 * message and its answer. `fits` adds a rule of the caller. Null when a new conversation is needed. `metas` come newest first, as the
 * store indexes them. A repository never refuses a message for being full: a new conversation is always made.
 */
export function currentConversation(metas, fits = () => true) {
  return metas.find((meta) => meta.grantFollowUps === undefined && meta.messages <= MESSAGE_LIMIT - 2 && fits(meta)) ?? null;
}

/** The provider, model, and effort the thread last ran with: those of the newest conversation that is not a grant follow-up conversation. */
export function lastRun(metas) {
  const last = metas.find((meta) => meta.grantFollowUps === undefined);
  return last ? { provider: last.provider, model: last.model, ...(last.effort ? { effort: last.effort } : {}) } : null;
}

/** The newest time any conversation of the thread was updated, or null before the first: one cheap sign that something changed. */
export const lastUpdate = (metas) => metas.reduce((newest, meta) => (newest === null || Date.parse(meta.updatedAt) > Date.parse(newest) ? meta.updatedAt : newest), null);

/** The time of the newest complete answer of Aril's own run in any conversation, or null. */
export const lastAnswer = (metas) => metas.reduce((newest, meta) => (meta.answeredAt !== null && (newest === null || meta.answeredAt > newest) ? meta.answeredAt : newest), null);

// Lower case without changing a length, so an index in the folded text is an index in the text. A letter whose lower case differs in length stays as it is.
function fold(text) {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text.replace(/[\s\S]/gu, (character) => { const next = character.toLowerCase(); return next.length === character.length ? next : character; });
}

// A cut never splits a surrogate pair.
const lowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;
const highSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

function snippetAround(text, index, length) {
  let start = Math.max(0, index - SNIPPET_BEFORE);
  let end = Math.min(text.length, index + length + SNIPPET_AFTER);
  if (start > 0 && lowSurrogate(text.charCodeAt(start))) start += 1;
  if (end < text.length && highSurrogate(text.charCodeAt(end - 1))) end -= 1;
  const plain = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${plain}${end < text.length ? "…" : ""}`;
}

const defer = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The newest messages whose text holds the query, whatever its case: a plain substring, never a pattern. Conversations are read one at a
 * time, newest first, and reading stops when the matches are complete and the next conversation cannot reach above the twentieth. A
 * long thread is read in batches, with `pause` between them, so that a search does not hold up the desktop's main process.
 */
export async function searchThread(source, query, pause = defer) {
  const needle = fold(query);
  const candidates = source.metas.filter((meta) => meta.messages > 0).sort((left, right) => right.to - left.to);
  let found = [];
  let scanned = 0;
  for (const meta of candidates) {
    if (found.length >= SEARCH_LIMIT && meta.to < found[SEARCH_LIMIT - 1].entry.key.at) break;
    const conversation = await source.read(meta.id);
    if (!conversation) continue;
    for (const entry of entriesOf(conversation)) {
      scanned += 1;
      if (scanned % SEARCH_BATCH === 0) await pause();
      const index = fold(entry.message.text).indexOf(needle);
      if (index >= 0) found.push({ entry, index });
    }
    found = found.sort((left, right) => byKey(right.entry, left.entry)).slice(0, SEARCH_LIMIT);
  }
  return found.map(({ entry: { message, conversationId }, index }) => ({ conversationId, messageId: message.id, at: message.at, role: message.role, snippet: snippetAround(message.text, index, needle.length) }));
}

/**
 * The two read operations of the thread. `settle(repositoryId, conversation)` repairs a conversation whose answer was lost, and
 * `turn(repositoryId)` answers the turn of the repository that runs or waits, in the shape `read` answers it, or null.
 */
export function createAgentChatThread({ store, settle, turn }) {
  // A conversation that ends on the owner's message may have lost its answer: only those are read to be repaired.
  async function indexOf(repositoryId) {
    for (const meta of await store.index(repositoryId)) {
      if (meta.lastRole !== "user") continue;
      const conversation = await store.read(repositoryId, meta.id);
      if (conversation) await settle(repositoryId, conversation);
    }
    return await store.index(repositoryId);
  }

  return Object.freeze({
    /** `{ repositoryId, before?, limit? }`: the newest page of the thread, or the page before a cursor. */
    async thread(payload) {
      const keys = ["repositoryId", ...["before", "limit"].filter((key) => Object.hasOwn(payload, key))];
      if (!hasExactly(payload, keys) || !REPOSITORY_ID.test(String(payload.repositoryId)) || (keys.includes("before") && typeof payload.before !== "string")) return INVALID;
      const limit = Object.hasOwn(payload, "limit") ? payload.limit : THREAD_PAGE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > THREAD_PAGE) return INVALID;
      const metas = await indexOf(payload.repositoryId);
      const page = await threadPage(threadSource(store, payload.repositoryId, metas), { before: Object.hasOwn(payload, "before") ? payload.before : null, limit });
      if (!page) return INVALID;
      return { ok: true, ...page, turn: turn(payload.repositoryId), sendTo: currentConversation(metas)?.id ?? null, run: lastRun(metas), updatedAt: lastUpdate(metas) };
    },
    /** `{ repositoryId, query }`: up to `SEARCH_LIMIT` matches, newest first. */
    async search(payload) {
      if (!hasExactly(payload, ["repositoryId", "query"]) || !REPOSITORY_ID.test(String(payload.repositoryId)) || typeof payload.query !== "string") return INVALID;
      const query = payload.query.trim();
      if (query === "" || query.length > SEARCH_QUERY_LIMIT || CONTROL.test(query)) return INVALID;
      return { ok: true, matches: await searchThread(threadSource(store, payload.repositoryId, await store.index(payload.repositoryId)), query) };
    },
  });
}
