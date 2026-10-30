// How long one provider run of the chat took, and how large its prompt was, as numbers only. The chat records them on the answer of
// an owner's message and on the summary a compaction run wrote, so a later change can aim at the slow step. A timing holds no
// text, no path, and no name: the milliseconds from the start of the process to its first provider event, to the first words
// of the answer, and to its end, and the length in characters of each part of the prompt. An owner's message adds the
// milliseconds each step of its preparation took before the process started, and the effort routing that chose the run's effort.

import { CHAT_EFFORTS } from "./agent-chat-runner.mjs";

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

// The effort levels Jev chooses between, and why the run kept the owner's effort when Jev did not lower it. Fixed words: no error text.
export const ROUTE_EFFORTS = Object.freeze(["low", "medium", "high"]);
export const ROUTE_REASONS = Object.freeze(["kept", "timeout", "error", "invalid", "images"]);

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
 * A route inside the contract, or null: `{ effort, by: "jev", ms }` when Jev lowered the owner's effort, else `{ effort, by: "owner", reason,
 * ms? }`, where `effort` is the owner's (null for the provider's own), `reason` a fixed word, and `ms` the time Jev took or was waited for,
 * absent when it was not asked. Whole milliseconds only; no text.
 */
export function normalizeRoute(value) {
  if (!isPlainObject(value)) return null;
  if (value.by === "jev") {
    return sameKeys(value, ["effort", "by", "ms"]) && ROUTE_EFFORTS.includes(value.effort) && whole(value.ms, TIMING_MAX_MS) ? { effort: value.effort, by: "jev", ms: value.ms } : null;
  }
  const withMs = Object.hasOwn(value, "ms");
  if (value.by !== "owner" || !sameKeys(value, ["effort", "by", "reason", ...(withMs ? ["ms"] : [])]) || !(value.effort === null || CHAT_EFFORTS.includes(value.effort))
    || !ROUTE_REASONS.includes(value.reason) || (withMs && !whole(value.ms, TIMING_MAX_MS))) return null;
  return { effort: value.effort, by: "owner", reason: value.reason, ...(withMs ? { ms: value.ms } : {}) };
}

/**
 * A timing inside the contract, or null: `{ eventMs, textMs, doneMs, prompt, prepare?, warm?, route? }`. `eventMs` and `textMs` are null when the
 * run ended before a provider event or before any words. A record without one, such as an older version wrote, simply has none, and a
 * `prepare` or `route` outside its contract, or a `warm` that is not `true`, is left out without the rest of the timing. `warm` says that a
 * [warm run](../../docs/internal/architecture/agent-chat.md#the-warm-run) answered: its times are measured from the moment the prompt was
 * written, as every run's are.
 */
export function normalizeTiming(value) {
  const keys = ["eventMs", "textMs", "doneMs", "prompt"];
  const optional = isPlainObject(value) ? ["prepare", "warm", "route"].filter((key) => Object.hasOwn(value, key)) : [];
  if (!isPlainObject(value) || !sameKeys(value, [...keys, ...optional]) || !isPlainObject(value.prompt) || !sameKeys(value.prompt, PROMPT_PARTS)) return null;
  const { eventMs, textMs, doneMs } = value;
  if (!whole(doneMs, TIMING_MAX_MS) || !(eventMs === null || (whole(eventMs, TIMING_MAX_MS) && eventMs <= doneMs))
    || !(textMs === null || (whole(textMs, TIMING_MAX_MS) && textMs <= doneMs && (eventMs === null || eventMs <= textMs)))) return null;
  if (!PROMPT_PARTS.every((part) => whole(value.prompt[part], PROMPT_PART_MAX))) return null;
  const prepare = normalizePrepare(value.prepare);
  const route = normalizeRoute(value.route);
  return { eventMs, textMs, doneMs, prompt: Object.fromEntries(PROMPT_PARTS.map((part) => [part, value.prompt[part]])), ...(prepare ? { prepare } : {}), ...(value.warm === true ? { warm: true } : {}), ...(route ? { route } : {}) };
}

/**
 * The timing to store from what the run measured (`{ eventMs, textMs, doneMs, warm? }`, milliseconds or null, and `warm: true` for a
 * warm run), the lengths of the prompt parts, and optionally the preparation's milliseconds by step: whole numbers, cut to the
 * bounds, or null when the run measured nothing usable. A preparation that is not usable is left out; the timing keeps the run. `route` is
 * the [effort routing](../../docs/internal/architecture/agent-chat.md#effort-routing) record of the turn, present when a Jev key was set.
 */
export function timingOf(measured, sections, prepare = null, route = null) {
  if (!isPlainObject(measured) || !isPlainObject(sections)) return null;
  const doneMs = clamp(measured.doneMs, TIMING_MAX_MS);
  if (doneMs === null) return null;
  const prompt = Object.fromEntries(PROMPT_PARTS.map((part) => [part, clamp(sections[part] ?? 0, PROMPT_PART_MAX) ?? 0]));
  const prepared = isPlainObject(prepare) ? { prepare: Object.fromEntries(Object.entries(prepare).map(([name, ms]) => [name, clamp(ms, TIMING_MAX_MS)])) } : {};
  return normalizeTiming({ eventMs: clamp(measured.eventMs, TIMING_MAX_MS), textMs: clamp(measured.textMs, TIMING_MAX_MS), doneMs, prompt, ...prepared, ...(measured.warm === true ? { warm: true } : {}), ...(route ? { route } : {}) });
}
