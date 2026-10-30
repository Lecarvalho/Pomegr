// The owner's memory: short lines about how this owner likes to work with Aril in every repository, as a repository's memory holds them
// for that repository (same entry shape and limits: `shared/aril-memory.mjs`). Desktop main keeps it in one private file under the data
// root. Only the owner edits it, in Settings on the desktop; Aril reads it in each prompt and cannot change it, and a paired device can
// only read it. It is guidance: it grants Aril no authority.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { ARIL_MEMORY, isMemoryLine } from "../../shared/aril-memory.mjs";

export const OWNER_MEMORY_FILE = "owner-memory.json";

const VERSION = 1;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const refused = (error) => Object.freeze({ ok: false, error });

function entryOf(value) {
  return isPlainObject(value) && Number.isSafeInteger(value.id) && value.id > 0 && isMemoryLine(value.text)
    && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt)
    ? { id: value.id, text: value.text, createdAt: value.createdAt, updatedAt: value.updatedAt } : null;
}

/**
 * `file` is an absolute path, or none for a memory held in memory. The file is read at the first use. A file outside the contract reads as
 * empty and is left as it is until the owner changes the memory. Each answer is `{ ok: true, ... }` or `{ ok: false, error }` with `invalid`,
 * `limit`, `not_found`, or `unavailable`.
 */
export function createOwnerMemory({ file = null, filesystem = fs, now = () => Date.now() } = {}) {
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file))) throw new TypeError("The owner's memory needs an absolute file");
  let held = null;
  let queue = Promise.resolve();

  async function load() {
    if (held) return held;
    let entries = [];
    let next = 1;
    if (file !== null) {
      try {
        const parsed = JSON.parse(await filesystem.readFile(file, "utf8"));
        if (isPlainObject(parsed) && parsed.version === VERSION && Array.isArray(parsed.entries) && Number.isSafeInteger(parsed.next)) {
          const read = parsed.entries.map(entryOf);
          if (read.every(Boolean) && read.length <= ARIL_MEMORY.entries && new Set(read.map((entry) => entry.id)).size === read.length) {
            entries = read;
            next = Math.max(parsed.next, 1 + Math.max(0, ...read.map((entry) => entry.id)));
          }
        }
      } catch { /* No file, or one outside the contract: empty. */ }
    }
    held = { entries, next };
    return held;
  }

  async function persist(state) {
    if (file === null) return true;
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await filesystem.mkdir(path.dirname(file), { recursive: true });
      await filesystem.writeFile(temporary, `${JSON.stringify({ version: VERSION, next: state.next, entries: state.entries })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await filesystem.rename(temporary, file);
      return true;
    } catch {
      await filesystem.unlink(temporary).catch(() => {});
      return false;
    }
  }

  // One change at a time. A change that cannot be written is not kept.
  function change(work) {
    const run = queue.then(async () => {
      const state = await load();
      const outcome = work(state);
      if (outcome.ok === false) return outcome;
      if (!await persist(outcome.state)) return refused("unavailable");
      held = outcome.state;
      return outcome.answer;
    });
    queue = run.catch(() => {});
    return run;
  }

  const sorted = (entries) => [...entries].sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);

  return Object.freeze({
    /** The entries, oldest first. */
    async read() {
      await queue.catch(() => {});
      return sorted((await load()).entries).map((entry) => ({ ...entry }));
    },
    add: (text) => change((state) => {
      if (!isMemoryLine(text)) return refused("invalid");
      if (state.entries.length >= ARIL_MEMORY.entries) return refused("limit");
      const at = now();
      const entry = { id: state.next, text, createdAt: at, updatedAt: at };
      return { state: { entries: [...state.entries, entry], next: state.next + 1 }, answer: { ok: true, entry: { ...entry } } };
    }),
    update: (id, text) => change((state) => {
      if (!Number.isSafeInteger(id) || !isMemoryLine(text)) return refused("invalid");
      const found = state.entries.find((entry) => entry.id === id);
      if (!found) return refused("not_found");
      const entry = { ...found, text, updatedAt: now() };
      return { state: { ...state, entries: state.entries.map((candidate) => (candidate.id === id ? entry : candidate)) }, answer: { ok: true, entry: { ...entry } } };
    }),
    remove: (id) => change((state) => {
      if (!Number.isSafeInteger(id)) return refused("invalid");
      if (!state.entries.some((entry) => entry.id === id)) return refused("not_found");
      return { state: { ...state, entries: state.entries.filter((entry) => entry.id !== id) }, answer: { ok: true } };
    }),
  });
}
