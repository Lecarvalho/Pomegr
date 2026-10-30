// The images the owner sends to Aril: private files under the chat's own directory, beside the saved conversations.
// Only desktop main reads or writes them. A conversation's message list is the authority: a file no message names is
// never served, and an image waits in the staged folder only until the message that names it is sent.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { chatImageIds } from "./agent-chat-proposal.mjs";

export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_IMAGES_PER_MESSAGE = 4;
export const CHAT_IMAGES_PER_CONVERSATION = 40;
export const CHAT_IMAGE_TYPES = Object.freeze(["png", "jpeg", "gif", "webp"]);
export const CHAT_IMAGE_ID = /^img-[0-9a-f]{12}$/u;
export const CHAT_IMAGE_FILE = /^img-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/u;
// Images that were added to a message that was never sent. The oldest are removed past this count.
export const STAGED_IMAGE_LIMIT = 16;

const IMAGE_DIRECTORY = "images";
const STAGED_DIRECTORY = "staged";
const EXTENSIONS = Object.freeze({ png: "png", jpeg: "jpg", gif: "gif", webp: "webp" });
const TYPE_OF_EXTENSION = Object.freeze({ png: "png", jpg: "jpeg", gif: "gif", webp: "webp" });
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const CONVERSATION_ID = /^chat-[0-9a-f]{12}$/u;

const startsWith = (bytes, signature, offset = 0) => bytes.length >= offset + signature.length
  && signature.every((value, index) => bytes[offset + index] === value);

/** The fixed type of an image from its leading bytes, or null when it is none of the four. */
export function sniffChatImageType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** The images of one stored message, `{ id, type, bytes }` each; null when the list is outside the contract. */
export function normalizeChatImages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_IMAGES_PER_MESSAGE) return null;
  const images = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || !CHAT_IMAGE_ID.test(entry.id) || !CHAT_IMAGE_TYPES.includes(entry.type)
      || !Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > CHAT_IMAGE_MAX_BYTES) return null;
    images.push({ id: entry.id, type: entry.type, bytes: entry.bytes });
  }
  return new Set(images.map((image) => image.id)).size === images.length ? images : null;
}

/** Every image the owner sent in a conversation, in the order of its messages. */
export function conversationImages(messages) {
  const images = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "user" && Array.isArray(message.images)) images.push(...message.images);
  }
  return images;
}

export const newChatImageId = () => `img-${randomBytes(6).toString("hex")}`;

export function createAgentChatImages({ directory, filesystem = fs } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new TypeError("Invalid agent chat directory");

  const root = (repositoryId) => path.join(directory, repositoryId, IMAGE_DIRECTORY);
  const staged = (repositoryId) => path.join(root(repositoryId), STAGED_DIRECTORY);
  const folder = (repositoryId, conversationId) => path.join(root(repositoryId), conversationId);
  const fileName = (image) => `${image.id}.${EXTENSIONS[image.type]}`;
  const inRepository = (repositoryId) => typeof repositoryId === "string" && REPOSITORY_ID.test(repositoryId);
  const located = (repositoryId, conversationId) => inRepository(repositoryId) && typeof conversationId === "string" && CONVERSATION_ID.test(conversationId);

  async function stagedNames(repositoryId) {
    try { return (await filesystem.readdir(staged(repositoryId))).filter((name) => CHAT_IMAGE_FILE.test(name)); } catch { return []; }
  }

  // An image of a message that was never sent is not kept for ever.
  async function evict(repositoryId) {
    const names = await stagedNames(repositoryId);
    if (names.length <= STAGED_IMAGE_LIMIT) return;
    const aged = [];
    for (const name of names) {
      try { aged.push({ name, at: (await filesystem.stat(path.join(staged(repositoryId), name))).mtimeMs }); } catch { /* already gone */ }
    }
    aged.sort((left, right) => right.at - left.at);
    for (const entry of aged.slice(STAGED_IMAGE_LIMIT)) await filesystem.unlink(path.join(staged(repositoryId), entry.name)).catch(() => {});
  }

  return Object.freeze({
    /** Keeps the bytes of one image until a message names it. Answers `{ id, type, bytes }`, or null when the bytes are no image. */
    async stage(repositoryId, bytes) {
      if (!inRepository(repositoryId) || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > CHAT_IMAGE_MAX_BYTES) return null;
      const type = sniffChatImageType(bytes);
      if (!type) return null;
      const image = { id: newChatImageId(), type, bytes: bytes.byteLength };
      await filesystem.mkdir(staged(repositoryId), { recursive: true });
      await filesystem.writeFile(path.join(staged(repositoryId), fileName(image)), bytes, { flag: "wx", mode: 0o600 });
      await evict(repositoryId);
      return image;
    },

    /** Moves the staged images a message names into its conversation. Null when one of them is not there; nothing moves then. */
    async claim(repositoryId, conversationId, ids) {
      if (!located(repositoryId, conversationId) || chatImageIds(ids) === null) return null;
      const names = await stagedNames(repositoryId);
      const found = [];
      for (const id of ids) {
        const name = names.find((candidate) => candidate.startsWith(`${id}.`));
        if (!name) return null;
        let size = 0;
        try { size = (await filesystem.stat(path.join(staged(repositoryId), name))).size; } catch { return null; }
        if (size < 1 || size > CHAT_IMAGE_MAX_BYTES) return null;
        found.push({ name, image: { id, type: TYPE_OF_EXTENSION[name.slice(name.lastIndexOf(".") + 1)], bytes: size } });
      }
      try {
        await filesystem.mkdir(folder(repositoryId, conversationId), { recursive: true });
        for (const entry of found) await filesystem.rename(path.join(staged(repositoryId), entry.name), path.join(folder(repositoryId, conversationId), entry.name));
      } catch { return null; }
      return found.map((entry) => entry.image);
    },

    /** The bytes of one image a message of the conversation names, or null when the file is not what the message recorded. */
    async read(repositoryId, conversationId, image) {
      if (!located(repositoryId, conversationId) || normalizeChatImages([image]) === null) return null;
      try {
        const bytes = new Uint8Array(await filesystem.readFile(path.join(folder(repositoryId, conversationId), fileName(image))));
        return bytes.byteLength === image.bytes && sniffChatImageType(bytes) === image.type ? bytes : null;
      } catch { return null; }
    },

    /** The absolute file of each listed image that is still there with its recorded size: `{ id, type, file }`. */
    async files(repositoryId, conversationId, images) {
      if (!located(repositoryId, conversationId)) return [];
      const present = [];
      for (const image of Array.isArray(images) ? images : []) {
        if (normalizeChatImages([image]) === null) continue;
        const file = path.join(folder(repositoryId, conversationId), fileName(image));
        try { if ((await filesystem.stat(file)).size === image.bytes) present.push({ id: image.id, type: image.type, file }); } catch { /* gone: not listed */ }
      }
      return present;
    },

    /** The folder that holds a conversation's images and nothing else. */
    folder(repositoryId, conversationId) {
      return located(repositoryId, conversationId) ? folder(repositoryId, conversationId) : null;
    },

    /** Removes the files of the listed images of one conversation, and nothing else. Answers how many it removed. */
    async removeImages(repositoryId, conversationId, list) {
      if (!located(repositoryId, conversationId)) return 0;
      let removed = 0;
      for (const image of Array.isArray(list) ? list : []) {
        if (normalizeChatImages([image]) === null) continue;
        try { await filesystem.unlink(path.join(folder(repositoryId, conversationId), fileName(image))); removed += 1; } catch { /* already gone */ }
      }
      return removed;
    },

    async removeConversation(repositoryId, conversationId) {
      if (!located(repositoryId, conversationId)) return;
      await filesystem.rm(folder(repositoryId, conversationId), { recursive: true, force: true }).catch(() => {});
    },
  });
}
