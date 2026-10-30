// The space a repository's thread takes on disk, and the flush that gives it back. The thread is the repository's saved conversations
// and the images in them, under the chat's directory (`<directory>/<repository ID>/`): its size is the bytes of those files, and nothing
// else is read for it. Only desktop main asks, for the owner in the desktop window.
//
// A flush removes the oldest half of the thread's messages (rounded down), by the order of the thread, with the images those messages
// carry. A conversation left without a message goes with its image folder. It never touches the repository's summary file, so what
// Aril concluded from the removed messages stays; it never touches the newest half, the memory, the settings, or the board. A message
// keeps its ID. Nothing is flushed while a turn, a follow-up, or a compaction of the repository runs.

import * as fs from "node:fs/promises";
import path from "node:path";

import { conversationImages } from "./agent-chat-images.mjs";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const refused = (error) => Object.freeze({ ok: false, error });

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

/**
 * `directory` is the chat's directory, `store` and `images` are the chat's own, and `busy(repositoryId)` says whether a turn, a follow-up,
 * or a compaction of that repository runs or waits.
 */
export function createThreadSpace({ directory, store, images, busy, filesystem = fs }) {
  const flushing = new Set();
  const folder = (repositoryId) => path.join(directory, repositoryId);

  async function size(repositoryId) {
    return { repositoryId, bytes: await folderBytes(filesystem, folder(repositoryId)), messages: (await store.index(repositoryId)).reduce((sum, meta) => sum + meta.messages, 0) };
  }

  return Object.freeze({
    size,
    /** Every repository that has a folder under the chat's directory: its bytes and its number of messages. */
    async sizes() {
      let names = [];
      try { names = (await filesystem.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && REPOSITORY_ID.test(entry.name)).map((entry) => entry.name); } catch { return []; }
      const found = [];
      for (const repositoryId of names) found.push(await size(repositoryId));
      return found;
    },
    /** Removes the oldest half of the thread's messages. Answers `{ ok: true, messages, conversations, images, freed }` or a refusal. */
    async flush(repositoryId) {
      if (!REPOSITORY_ID.test(String(repositoryId))) return refused("invalid");
      if (busy(repositoryId) || flushing.has(repositoryId)) return refused("busy");
      flushing.add(repositoryId);
      try {
        const before = await folderBytes(filesystem, folder(repositoryId));
        const conversations = [];
        const keys = [];
        for (const meta of await store.index(repositoryId)) {
          if (meta.messages === 0) continue;
          const conversation = await store.read(repositoryId, meta.id);
          if (!conversation) continue;
          conversations.push(conversation);
          const created = Date.parse(conversation.createdAt);
          conversation.messages.forEach((message, index) => keys.push({ at: Date.parse(message.at), created, conversation: conversation.id, index }));
        }
        const remove = Math.floor(keys.length / 2);
        if (remove < 1) return refused("not_found");
        // How many messages leave each conversation: the oldest of the thread, which in a conversation are its first.
        const leaving = new Map();
        for (const key of keys.sort(compare).slice(0, remove)) leaving.set(key.conversation, (leaving.get(key.conversation) ?? 0) + 1);
        let messages = 0;
        let whole = 0;
        let pictures = 0;
        // The conversations that go whole, then the one the cut runs through. A failure stops the flush and leaves what was done.
        for (const conversation of conversations.filter((entry) => leaving.has(entry.id))) {
          const count = leaving.get(conversation.id);
          const gone = conversation.messages.slice(0, count);
          if (count >= conversation.messages.length) {
            if (!await store.remove(repositoryId, conversation.id)) return refused("unavailable");
            await images?.removeConversation(repositoryId, conversation.id);
            whole += 1;
          } else {
            if (!await store.save(repositoryId, { ...conversation, messages: conversation.messages.slice(count) })) return refused("unavailable");
            await images?.removeImages(repositoryId, conversation.id, conversationImages(gone));
          }
          messages += count;
          pictures += conversationImages(gone).length;
        }
        const after = await folderBytes(filesystem, folder(repositoryId));
        return { ok: true, messages, conversations: whole, images: pictures, freed: Math.max(0, before - after) };
      } catch {
        return refused("unavailable");
      } finally {
        flushing.delete(repositoryId);
      }
    },
  });
}
