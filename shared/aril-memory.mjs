// Aril's memory: free text about how the owner likes to work, one for the owner (every repository, kept by desktop main) and one for each
// repository (kept in its task store). Both are plain text of at most 6,000 characters and reach Aril's prompt whole. Pure and shared, so
// the desktop that edits and prompts, the monitor that stores a repository's text, and the Settings page that counts agree on one rule.

/** The bounds of a memory: the characters of its text, one line Aril adds, and the lines Aril may add or remove in one update. */
export const ARIL_MEMORY = Object.freeze({ textLength: 6_000, lineLength: 300, updateLines: 10 });

/** Who wrote the text last. A migration from the older entries counts as the owner's own words. */
export const ARIL_MEMORY_AUTHORS = Object.freeze(["owner", "aril"]);

// Text may hold line breaks and tabs, and no other control character.
const CONTROL = /[\p{Cc}\u{2028}\u{2029}]/u;
const ONE_LINE = /^[^\p{Cc}\u{2028}\u{2029}]*$/u;
const bare = (text) => text.replaceAll("\n", "").replaceAll("\t", "");

/** Line breaks as `\n`, the one form a memory keeps. */
export const normalizeMemoryText = (value) => (typeof value === "string" ? value.replace(/\r\n?/gu, "\n") : value);

/** Whether `value` is a memory text: a string of at most 6,000 characters with no control character but a line break or a tab. */
export function isMemoryText(value) {
  return typeof value === "string" && value.length <= ARIL_MEMORY.textLength && !CONTROL.test(bare(value));
}

/** Whether `value` is one line Aril may add: nonblank, at most 300 characters, with no control character. */
export function isMemoryLine(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= ARIL_MEMORY.lineLength && ONE_LINE.test(value);
}

// A line as it is compared: without its list marker and the spaces around it.
const bareLine = (line) => line.trim().replace(/^-\s+/u, "").trim();

/**
 * The text that the older entries (a list of lines, each with a creation time and an ID) become: one `- ` line for each, oldest first. When
 * that is longer than 6,000 characters the newest lines that fit stay as the text and the whole of it is kept as `previous`, so nothing
 * is lost. `entries` are `{ id, text, createdAt, updatedAt }` in any order; a malformed one is ignored.
 */
export function legacyMemory(entries) {
  const valid = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry.text === "string" && Number.isSafeInteger(entry.id))
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.id - right.id);
  const lines = valid.map((entry) => `- ${entry.text}`);
  const whole = lines.join("\n");
  const updatedAt = valid.reduce((latest, entry) => Math.max(latest, Number.isSafeInteger(entry.updatedAt) ? entry.updatedAt : 0), 0) || null;
  if (whole.length <= ARIL_MEMORY.textLength) return { text: whole, previous: null, updatedAt };
  let used = 0;
  const kept = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const length = lines[index].length + (kept.length > 0 ? 1 : 0);
    if (used + length > ARIL_MEMORY.textLength) break;
    used += length;
    kept.unshift(lines[index]);
  }
  return { text: kept.join("\n"), previous: whole, updatedAt };
}

/**
 * Applies one update to a memory text: the lines to add, and the lines to remove. A line to remove must be a line of the text (compared
 * without its `- ` marker); one that is not makes the whole update `not_found`. A line to add that is already there is left out. Added
 * lines go last, as `- ` lines. The result must fit 6,000 characters or the update is `too_long`. Nothing is guessed: any part outside
 * the contract answers `invalid`. Answers `{ ok: true, text, added, removed }` (both counts zero when nothing changed).
 */
export function applyMemoryUpdate(text, update) {
  if (!isMemoryText(text) || !update || typeof update !== "object" || !Array.isArray(update.add) || !Array.isArray(update.remove)) return { ok: false, error: "invalid" };
  const { add, remove } = update;
  if (add.length > ARIL_MEMORY.updateLines || remove.length > ARIL_MEMORY.updateLines || add.length + remove.length === 0) return { ok: false, error: "invalid" };
  if (![...add, ...remove].every(isMemoryLine)) return { ok: false, error: "invalid" };
  let lines = text.split("\n");
  let removed = 0;
  for (const target of remove.map(bareLine)) {
    const kept = lines.filter((line) => bareLine(line) !== target);
    if (kept.length === lines.length) return { ok: false, error: "not_found" };
    removed += lines.length - kept.length;
    lines = kept;
  }
  let added = 0;
  for (const line of add.map(bareLine)) {
    if (line === "" || lines.some((existing) => bareLine(existing) === line)) continue;
    lines.push(`- ${line}`);
    added += 1;
  }
  const next = lines.join("\n").replace(/\n{3,}/gu, "\n\n").replace(/^\n+/u, "").trimEnd();
  if (next.length > ARIL_MEMORY.textLength) return { ok: false, error: "too_long" };
  return { ok: true, text: next, added, removed };
}
