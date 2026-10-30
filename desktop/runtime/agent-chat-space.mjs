// The space a repository's thread takes on disk, and the flush that gives it back. The thread is the repository's saved conversations
// and the images in them, under the chat's directory (`<directory>/<repository ID>/`): its size is the bytes of those files, and nothing
// else is read for it. Only desktop main asks, for the owner in the desktop window.
//
// Two flushes remove the oldest messages of the thread, by the order of the thread, with the images those messages carry. A conversation
// left without a message goes with its image folder. Neither touches the repository's summary file, so what Aril concluded from the
// removed messages stays; neither touches the newest message, the memory, the settings, or the board. A message keeps its ID.
// - The owner's flush removes the oldest half of the messages (rounded down).
// - The automatic flush runs once a thread passes the owner's limit ("Flush oldest at"): it removes the oldest messages until the thread is
//   at or below 75% of that limit. Messages that no summary covers yet are gone with it.
// Nothing is flushed while a turn, a follow-up, a compaction, or another flush of the repository runs or waits, and a flush that is asked
// for then does nothing: the caller asks again when the repository is idle.

import * as fs from "node:fs/promises";
import path from "node:path";

import { conversationImages } from "./agent-chat-images.mjs";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const refused = (error) => Object.freeze({ ok: false, error });
/** An automatic flush leaves the thread at or below this share of the limit. */
export const AUTO_FLUSH_TARGET = 0.75;
// The estimate of the bytes a cut frees is checked against the folder; a cut that fell short is made again, a few times at most.
const AUTO_FLUSH_ROUNDS = 4;

// The order of the thread (see agent-chat-thread.mjs): the time of a message, then the creation of its conversation, then the conversation,
// then its place in it.
const compare = (left, right) => left.at - right.at || left.created - right.created
  || (left.conversation < right.conversation ? -1 : left.conversation > right.conversation ? 1 : 0) || left.index - right.index;

/** The bytes of every file under `folder`, or 0 when it is not there. Nothing is followed outside it: a link counts as itself. */
async function folderBytes(filesystem, folder) {
  let total = 0;
  let entries = [];
  try { entries = await filesystem.readdir(folder, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) total += await folderBytes(filesystem, target);
    else if (entry.isFile()) total += await filesystem.stat(target).then((stat) => stat.size, () => 0);
  }
  return total;
}

/** What a message takes on disk, about: its stored text and the images it carries. */
const weigh = (message) => Buffer.byteLength(JSON.stringify(message), "utf8") + conversationImages([message]).reduce((sum, image) => sum + (Number.isSafeInteger(image.bytes) ? image.bytes : 0), 0);

/**
 * `directory` is the chat's directory, `store` and `images` are the chat's own, and `busy(repositoryId)` says whether a turn, a follow-up,
 * or a compaction of that repository runs or waits. `limit()` is the owner's limit in bytes, 0 for Never.
 */
export function createThreadSpace({ directory, store, images, busy, limit = () => 0, filesystem = fs }) {
  const flushing = new Set();
  const folder = (repositoryId) => path.join(directory, repositoryId);

  async function size(repositoryId) {
    return { repositoryId, bytes: await folderBytes(filesystem, folder(repositoryId)), messages: (await store.index(repositoryId)).reduce((sum, meta) => sum + meta.messages, 0) };
  }

  async function repositories() {
    try { return (await filesystem.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && REPOSITORY_ID.test(entry.name)).map((entry) => entry.name); } catch { return []; }
  }

  /** The thread's conversations and its messages in order, each with the bytes it takes. */
  async function thread(repositoryId) {
    const conversations = [];
    const keys = [];
    for (const meta of await store.index(repositoryId)) {
      if (meta.messages === 0) continue;
      const conversation = await store.read(repositoryId, meta.id);
      if (!conversation) continue;
      conversations.push(conversation);
      const created = Date.parse(conversation.createdAt);
      conversation.messages.forEach((message, index) => keys.push({ at: Date.parse(message.at), created, conversation: conversation.id, index, weight: weigh(message) }));
    }
    return { conversations, keys: keys.sort(compare) };
  }

  /** Removes the oldest `count` messages of the thread. A failure stops it and leaves what was done; each step leaves the store whole. */
  async function removeOldest(repositoryId, count) {
    const before = await folderBytes(filesystem, folder(repositoryId));
    const { conversations, keys } = await thread(repositoryId);
    // The newest message always stays.
    const remove = Math.min(count, keys.length - 1);
    if (remove < 1) return refused("not_found");
    // How many messages leave each conversation: the oldest of the thread, which in a conversation are its first.
    const leaving = new Map();
    for (const key of keys.slice(0, remove)) leaving.set(key.conversation, (leaving.get(key.conversation) ?? 0) + 1);
    let messages = 0;
    let whole = 0;
    let pictures = 0;
    // The conversations that go whole, then the one the cut runs through.
    for (const conversation of conversations.filter((entry) => leaving.has(entry.id))) {
      const cut = leaving.get(conversation.id);
      const gone = conversation.messages.slice(0, cut);
      if (cut >= conversation.messages.length) {
        if (!await store.remove(repositoryId, conversation.id)) return refused("unavailable");
        await images?.removeConversation(repositoryId, conversation.id);
        whole += 1;
      } else {
        if (!await store.save(repositoryId, { ...conversation, messages: conversation.messages.slice(cut) })) return refused("unavailable");
        await images?.removeImages(repositoryId, conversation.id, conversationImages(gone));
      }
      messages += cut;
      pictures += conversationImages(gone).length;
    }
    const after = await folderBytes(filesystem, folder(repositoryId));
    return { ok: true, messages, conversations: whole, images: pictures, freed: Math.max(0, before - after) };
  }

  // One flush of a repository at a time, and none while it is busy. The lock is held until the flush ends.
  async function locked(repositoryId, work) {
    if (busy(repositoryId) || flushing.has(repositoryId)) return refused("busy");
    flushing.add(repositoryId);
    try { return await work(); } catch { return refused("unavailable"); } finally { flushing.delete(repositoryId); }
  }

  /**
   * The automatic flush of one repository: when its thread is over the limit and nothing of it runs, removes the oldest messages until the
   * thread is at or below 75% of the limit. Answers `{ ok: true, flushed: false, reason }` (`never`, `under`, or `busy`) or, when it flushed,
   * `{ ok: true, flushed: true, messages, conversations, images, freed }`, or a refusal. It never throws.
   */
  async function autoFlush(repositoryId) {
    const bytes = limit();
    if (!REPOSITORY_ID.test(String(repositoryId))) return refused("invalid");
    if (!(bytes > 0)) return { ok: true, flushed: false, reason: "never" };
    if (busy(repositoryId) || flushing.has(repositoryId)) return { ok: true, flushed: false, reason: "busy" };
    const outcome = await locked(repositoryId, async () => {
      if (await folderBytes(filesystem, folder(repositoryId)) <= bytes) return { ok: true, flushed: false, reason: "under" };
      const target = Math.floor(bytes * AUTO_FLUSH_TARGET);
      const total = { messages: 0, conversations: 0, images: 0, freed: 0 };
      const result = () => (total.messages > 0 ? { ok: true, flushed: true, ...total } : { ok: true, flushed: false, reason: "under" });
      for (let round = 0; round < AUTO_FLUSH_ROUNDS; round += 1) {
        const now = await folderBytes(filesystem, folder(repositoryId));
        if (now <= target) break;
        const { keys } = await thread(repositoryId);
        // The oldest messages whose estimated bytes bring the folder to the target; the newest message is not one of them.
        let count = 0;
        let estimate = 0;
        while (count < keys.length - 1 && now - estimate > target) estimate += keys[count++].weight;
        const cut = await removeOldest(repositoryId, count);
        if (!cut.ok) return cut.error === "not_found" ? result() : total.messages > 0 ? result() : cut;
        for (const field of Object.keys(total)) total[field] += cut[field];
      }
      return result();
    });
    return outcome.error === "busy" ? { ok: true, flushed: false, reason: "busy" } : outcome;
  }

  return Object.freeze({
    size,
    /** Every repository that has a folder under the chat's directory: its bytes and its number of messages. */
    async sizes() {
      const found = [];
      for (const repositoryId of await repositories()) found.push(await size(repositoryId));
      return found;
    },
    /** Whether a flush of the repository is running now: a message of the owner waits for it. */
    flushing: (repositoryId) => flushing.has(repositoryId),
    /** The owner's flush: removes the oldest half of the thread's messages. Answers `{ ok: true, messages, conversations, images, freed }` or a refusal. */
    flush(repositoryId) {
      if (!REPOSITORY_ID.test(String(repositoryId))) return Promise.resolve(refused("invalid"));
      return locked(repositoryId, async () => removeOldest(repositoryId, Math.floor((await thread(repositoryId)).keys.length / 2)));
    },
    autoFlush,
    /** Asks the automatic flush of every repository that has a thread, one after another. */
    async sweep() {
      const results = [];
      for (const repositoryId of await repositories()) results.push({ repositoryId, ...await autoFlush(repositoryId) });
      return results;
    },
  });
}
