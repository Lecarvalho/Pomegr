// The owner's memory: free text about how this owner likes to work with Aril in every repository, as a repository's memory holds text for
// that repository (same limits: `shared/aril-memory.mjs`). Desktop main keeps it in one private file under the data root. The owner edits it
// in Settings on the desktop, and Aril keeps it current by itself through `apply`, a fixed update that desktop main validates; a paired device
// can only read it. It is guidance: it grants Aril no authority.
//
// The file holds `{ version: 2, text, previous, updatedAt, updatedBy }`: the text, the text before the last change, and who wrote the text
// last (`owner` or `aril`) and when. The first version held a list of lines. It is read as text, one `- ` line for each, oldest first, and the
// file is replaced by one atomic rename; until that succeeds the file stays as it was, and the text is served from memory.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { applyMemoryUpdate, ARIL_MEMORY, isMemoryLine, isMemoryText, legacyMemory, normalizeMemoryText } from "../../shared/aril-memory.mjs";

export const OWNER_MEMORY_FILE = "owner-memory.json";

const VERSION = 2;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const refused = (error) => Object.freeze({ ok: false, error });
const EMPTY = Object.freeze({ text: "", previous: null, updatedAt: null, updatedBy: null });

function legacyEntry(value) {
  return isPlainObject(value) && Number.isSafeInteger(value.id) && value.id > 0 && isMemoryLine(value.text)
    && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt)
    ? { id: value.id, text: value.text, createdAt: value.createdAt, updatedAt: value.updatedAt } : null;
}

// The memory a parsed file holds, or null when the file is outside both versions.
function fromFile(parsed) {
  if (!isPlainObject(parsed)) return null;
  if (parsed.version === VERSION) {
    const { text, previous, updatedAt, updatedBy } = parsed;
    return isMemoryText(text) && (previous === null || (typeof previous === "string" && previous.length <= 40_000))
      && (updatedAt === null || Number.isSafeInteger(updatedAt)) && [null, "owner", "aril"].includes(updatedBy) ? { memory: { text, previous, updatedAt, updatedBy }, legacy: false } : null;
  }
  if (parsed.version === 1 && Array.isArray(parsed.entries) && Number.isSafeInteger(parsed.next)) {
    const read = parsed.entries.map(legacyEntry);
    if (!read.every(Boolean) || read.length > 100 || new Set(read.map((entry) => entry.id)).size !== read.length) return null;
    const { text, previous, updatedAt } = legacyMemory(read);
    return { memory: read.length === 0 ? { ...EMPTY } : { text, previous, updatedAt, updatedBy: "owner" }, legacy: true };
  }
  return null;
}

/**
 * `file` is an absolute path, or none for a memory held in memory. The file is read at the first use. A file outside the contract reads as
 * empty and is left as it is until the owner changes the memory. Each change answers `{ ok: true, ... }` or `{ ok: false, error }` with
 * `invalid`, `limit` (over 6,000 characters), `not_found` (a line Aril asked to remove is not there), or `unavailable` (not written).
 */
export function createOwnerMemory({ file = null, filesystem = fs, now = () => Date.now() } = {}) {
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file))) throw new TypeError("The owner's memory needs an absolute file");
  let held = null;
  let queue = Promise.resolve();

  async function persist(memory) {
    if (file === null) return true;
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await filesystem.mkdir(path.dirname(file), { recursive: true });
      await filesystem.writeFile(temporary, `${JSON.stringify({ version: VERSION, ...memory })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await filesystem.rename(temporary, file);
      return true;
    } catch {
      await filesystem.unlink(temporary).catch(() => {});
      return false;
    }
  }

  async function load() {
    if (held) return held;
    let memory = { ...EMPTY };
    let legacy = false;
    if (file !== null) {
      try {
        const read = fromFile(JSON.parse(await filesystem.readFile(file, "utf8")));
        if (read) ({ memory, legacy } = read);
      } catch { /* No file, or one outside the contract: empty. */ }
    }
    held = memory;
    // The older file becomes the new one at the first use. If it cannot be written, it stays readable and is replaced by the next change.
    if (legacy) await persist(memory);
    return held;
  }

  // One change at a time. A change that cannot be written is not kept.
  function change(work) {
    const run = queue.then(async () => {
      const current = await load();
      const outcome = work(current);
      if (outcome.ok === false) return outcome;
      if (outcome.memory && !await persist(outcome.memory)) return refused("unavailable");
      if (outcome.memory) held = outcome.memory;
      return outcome.answer;
    });
    queue = run.catch(() => {});
    return run;
  }

  return Object.freeze({
    /** The memory: `{ text, previous, updatedAt, updatedBy }`. */
    async read() {
      await queue.catch(() => {});
      return { ...(await load()) };
    },
    /** The owner replaces the text whole. The text before it is kept as `previous`. */
    set: (value) => change((current) => {
      const text = normalizeMemoryText(value);
      if (typeof text !== "string") return refused("invalid");
      if (text.length > ARIL_MEMORY.textLength) return refused("limit");
      if (!isMemoryText(text)) return refused("invalid");
      if (text === current.text) return { answer: { ok: true, memory: { ...current } } };
      const memory = { text, previous: current.text, updatedAt: now(), updatedBy: "owner" };
      return { memory, answer: { ok: true, memory: { ...memory } } };
    }),
    /** Aril's update: the lines to add and to remove, applied to the text as it is (`applyMemoryUpdate`). Answers the counts. */
    apply: (update) => change((current) => {
      const result = applyMemoryUpdate(current.text, update);
      if (!result.ok) return refused(result.error === "too_long" ? "limit" : result.error);
      if (result.added + result.removed === 0) return { answer: { ok: true, added: 0, removed: 0 } };
      return { memory: { text: result.text, previous: current.text, updatedAt: now(), updatedBy: "aril" }, answer: { ok: true, added: result.added, removed: result.removed } };
    }),
  });
}
