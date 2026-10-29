// How long one provider run of the chat took, and how large its prompt was, as numbers only. The chat records them on the answer of
// an owner's message and on the summary a compaction run wrote, so a later change can aim at the slow step. A timing holds no
// text, no path, and no name: the milliseconds from the start of the process to its first provider event, to the first words
// of the answer, and to its end, and the length in characters of each part of the prompt. An owner's message adds the
// milliseconds each step of its preparation took before the process started.

// An hour: far above the ten minutes a turn may take, so a clock that jumped cannot store a number beyond the bound.
export const TIMING_MAX_MS = 3_600_000;
// A prompt part is at most the whole prompt: 200,000 characters. The bound leaves room above it.
export const PROMPT_PART_MAX = 1_000_000;
// The parts of a prompt, in order: the fixed instructions, the board snapshot, the task log, the summary with the conversation,
// the owner's message (or the follow-up or grant request), and everything else (workflow changes, worktrees, GitHub, images, framing).
export const PROMPT_PARTS = Object.freeze(["instructions", "board", "taskLog", "conversation", "message", "other"]);
// The steps of a turn's preparation, in the order a panel names them. Each is one read or one piece of work before the provider
// process starts; `total` is the time from receiving the owner's message to starting the process, and no step is longer than it.
export const PREPARE_STEPS = Object.freeze(["board", "root", "runs", "taskLog", "github", "workflow", "worktrees", "instructions", "context", "environment", "store", "declare", "server", "total"]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const whole = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const sameKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const clamp = (value, max) => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : null);

/**
 * A preparation record inside the contract, or null: whole milliseconds by step name, with `total` always there and the steps the
 * turn did not need (no GitHub, no instructions file) absent. A step longer than the total, a name outside the steps, or any value
 * but a whole number in range is outside the contract.
 */
export function normalizePrepare(value) {
  if (!isPlainObject(value) || !whole(value.total, TIMING_MAX_MS)) return null;
  const names = Object.keys(value);
  if (!names.every((name) => PREPARE_STEPS.includes(name) && whole(value[name], value.total))) return null;
  return Object.fromEntries(PREPARE_STEPS.filter((name) => Object.hasOwn(value, name)).map((name) => [name, value[name]]));
}

/**
 * A timing inside the contract, or null: `{ eventMs, textMs, doneMs, prompt, prepare? }`. `eventMs` and `textMs` are null when the run
 * ended before a provider event or before any words. A record without one, such as an older version wrote, simply has none, and a
 * `prepare` outside its contract is left out without the rest of the timing.
 */
export function normalizeTiming(value) {
  const keys = ["eventMs", "textMs", "doneMs", "prompt"];
  if (!isPlainObject(value) || !sameKeys(value, Object.hasOwn(value, "prepare") ? [...keys, "prepare"] : keys) || !isPlainObject(value.prompt) || !sameKeys(value.prompt, PROMPT_PARTS)) return null;
  const { eventMs, textMs, doneMs } = value;
  if (!whole(doneMs, TIMING_MAX_MS) || !(eventMs === null || (whole(eventMs, TIMING_MAX_MS) && eventMs <= doneMs))
    || !(textMs === null || (whole(textMs, TIMING_MAX_MS) && textMs <= doneMs && (eventMs === null || eventMs <= textMs)))) return null;
  if (!PROMPT_PARTS.every((part) => whole(value.prompt[part], PROMPT_PART_MAX))) return null;
  const prepare = normalizePrepare(value.prepare);
  return { eventMs, textMs, doneMs, prompt: Object.fromEntries(PROMPT_PARTS.map((part) => [part, value.prompt[part]])), ...(prepare ? { prepare } : {}) };
}

/**
 * The timing to store from what the run measured (`{ eventMs, textMs, doneMs }`, milliseconds or null), the lengths of the prompt
 * parts, and optionally the preparation's milliseconds by step: whole numbers, cut to the bounds, or null when the run measured
 * nothing usable. A preparation that is not usable is left out; the timing keeps the run.
 */
export function timingOf(measured, sections, prepare = null) {
  if (!isPlainObject(measured) || !isPlainObject(sections)) return null;
  const doneMs = clamp(measured.doneMs, TIMING_MAX_MS);
  if (doneMs === null) return null;
  const prompt = Object.fromEntries(PROMPT_PARTS.map((part) => [part, clamp(sections[part] ?? 0, PROMPT_PART_MAX) ?? 0]));
  const prepared = isPlainObject(prepare) ? { prepare: Object.fromEntries(Object.entries(prepare).map(([name, ms]) => [name, clamp(ms, TIMING_MAX_MS)])) } : {};
  return normalizeTiming({ eventMs: clamp(measured.eventMs, TIMING_MAX_MS), textMs: clamp(measured.textMs, TIMING_MAX_MS), doneMs, prompt, ...prepared });
}
