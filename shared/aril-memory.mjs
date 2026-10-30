// Aril's memory: short lines about how the owner likes to work. A repository's memory lives in its task store and the owner's memory
// (the same lines, for every repository) in desktop main. Both reach Aril's prompt within the same size bound. Pure and shared, so the
// desktop that writes the prompt and the Settings page that shows the bound agree.

/** The bounds of a memory: how many entries, how long a line, and how many characters of entry text one prompt carries. */
export const ARIL_MEMORY = Object.freeze({ entries: 100, entryLength: 300, promptLength: 6_000 });

const LINE = /^[^\p{Cc}\u2028\u2029]*$/u;

/** Whether `value` is a memory line: one nonblank line of at most 300 characters, with no control character. */
export function isMemoryLine(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= ARIL_MEMORY.entryLength && LINE.test(value);
}

/**
 * The entries one prompt carries, oldest first. Entries are taken newest first while their text fits `limit` characters in total, and
 * the rest are left out and counted. `entries` are `{ id, text, createdAt }` in any order; a malformed one is ignored.
 */
export function fitMemory(entries, limit = ARIL_MEMORY.promptLength) {
  const valid = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry.text === "string" && Number.isSafeInteger(entry.id))
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.id - right.id).slice(0, ARIL_MEMORY.entries);
  let used = 0;
  const kept = [];
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const length = Math.min(valid[index].text.length, ARIL_MEMORY.entryLength);
    if (used + length > limit) break;
    used += length;
    kept.unshift(valid[index]);
  }
  return { entries: kept, omitted: valid.length - kept.length, used };
}
