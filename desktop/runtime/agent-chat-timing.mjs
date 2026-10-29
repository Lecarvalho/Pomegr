// How long one provider run of the chat took, and how large its prompt was, as numbers only. The chat records them on the answer of
// an owner's message and on the summary a compaction run wrote, so a later change can aim at the slow step. A timing holds no
// text, no path, and no name: the milliseconds from the start of the process to its first provider event, to the first words
// of the answer, and to its end, and the length in characters of each part of the prompt.

// An hour: far above the ten minutes a turn may take, so a clock that jumped cannot store a number beyond the bound.
export const TIMING_MAX_MS = 3_600_000;
// A prompt part is at most the whole prompt: 200,000 characters. The bound leaves room above it.
export const PROMPT_PART_MAX = 1_000_000;
// The parts of a prompt, in order: the fixed instructions, the board snapshot, the task log, the summary with the conversation,
// the owner's message (or the follow-up or grant request), and everything else (workflow changes, worktrees, GitHub, images, framing).
export const PROMPT_PARTS = Object.freeze(["instructions", "board", "taskLog", "conversation", "message", "other"]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const whole = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const sameKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const clamp = (value, max) => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : null);

/**
 * A timing inside the contract, or null: `{ eventMs, textMs, doneMs, prompt }`. `eventMs` and `textMs` are null when the run ended
 * before a provider event or before any words. A record without one, such as an older version wrote, simply has none.
 */
export function normalizeTiming(value) {
  if (!isPlainObject(value) || !sameKeys(value, ["eventMs", "textMs", "doneMs", "prompt"]) || !isPlainObject(value.prompt) || !sameKeys(value.prompt, PROMPT_PARTS)) return null;
  const { eventMs, textMs, doneMs } = value;
  if (!whole(doneMs, TIMING_MAX_MS) || !(eventMs === null || (whole(eventMs, TIMING_MAX_MS) && eventMs <= doneMs))
    || !(textMs === null || (whole(textMs, TIMING_MAX_MS) && textMs <= doneMs && (eventMs === null || eventMs <= textMs)))) return null;
  if (!PROMPT_PARTS.every((part) => whole(value.prompt[part], PROMPT_PART_MAX))) return null;
  return { eventMs, textMs, doneMs, prompt: Object.fromEntries(PROMPT_PARTS.map((part) => [part, value.prompt[part]])) };
}

/**
 * The timing to store from what the run measured (`{ eventMs, textMs, doneMs }`, milliseconds or null) and the lengths of the
 * prompt parts: whole numbers, cut to the bounds, or null when the run measured nothing usable.
 */
export function timingOf(measured, sections) {
  if (!isPlainObject(measured) || !isPlainObject(sections)) return null;
  const doneMs = clamp(measured.doneMs, TIMING_MAX_MS);
  if (doneMs === null) return null;
  const prompt = Object.fromEntries(PROMPT_PARTS.map((part) => [part, clamp(sections[part] ?? 0, PROMPT_PART_MAX) ?? 0]));
  return normalizeTiming({ eventMs: clamp(measured.eventMs, TIMING_MAX_MS), textMs: clamp(measured.textMs, TIMING_MAX_MS), doneMs, prompt });
}
