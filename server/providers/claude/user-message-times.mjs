import { isClaudeDirectUserInput, userInputContentType } from "./activity-events.mjs";

/** Newest user-message times retained per session; mirrors the evidence-schema bound. */
export const CLAUDE_USER_MESSAGE_TIME_LIMIT = 256;
const MAX_REQUESTED_INPUT_IDS = 256;
// Canonical four-digit-year ISO range, so every retained time serializes to one fixed spelling.
const MAX_TIME_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
// Claude Code writes this marker as a user record when a turn is cancelled; it is not a message.
const INTERRUPTION_MARKER = /^\[Request interrupted by user[^\]]{0,64}\]$/u;

export function createClaudeUserMessageTimeState() {
  return { requestedInputIds: new Set(), times: [] };
}

function isInterruptionMarker(record) {
  const content = record.message?.content;
  const parts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.map((part) => (part?.type === "text" ? part.text : null)) : [];
  return parts.length > 0 && parts.every((text) => typeof text === "string" && INTERRUPTION_MARKER.test(text.trim()));
}

/**
 * A real user turn in the main conversation: direct input (not a slash-command echo or a
 * local-command output wrapper, the same rule session work start uses), or the answer to a
 * requested input. Sidechain records and interruption markers are never user messages.
 */
function isUserMessage(record, requestedInputIds) {
  if (record.isSidechain === true || isInterruptionMarker(record)) return false;
  if (isClaudeDirectUserInput(record)) return true;
  const content = record.message?.content;
  return Array.isArray(content) && Boolean(userInputContentType(record, requestedInputIds))
    && content.some((part) => part?.type === "tool_result" && requestedInputIds.has(part.tool_use_id));
}

/**
 * Adapter-private reducer over main-transcript records. It retains only the recorded time of each
 * user message (ascending epoch milliseconds, newest CLAUDE_USER_MESSAGE_TIME_LIMIT) and the
 * opaque IDs of pending input requests. A record without a parseable recorded timestamp is
 * skipped: no file time ever stands in for it. Message content, type, and IDs are never retained.
 * The state is updated in place and returned.
 */
export function reduceClaudeUserMessageTimes(state, record) {
  if (!record || typeof record !== "object") return state;
  if (isUserMessage(record, state.requestedInputIds)) {
    const raw = record.timestamp || record.message?.timestamp;
    const time = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (Number.isFinite(time) && time >= 0 && time <= MAX_TIME_MS) {
      const times = state.times;
      let index = times.length;
      while (index > 0 && times[index - 1] > time) index -= 1;
      times.splice(index, 0, time);
      if (times.length > CLAUDE_USER_MESSAGE_TIME_LIMIT) times.shift();
    }
  }
  if (record.type === "assistant" && record.isSidechain !== true && Array.isArray(record.message?.content)) {
    for (const part of record.message.content) {
      if (part?.type !== "tool_use" || part.name !== "AskUserQuestion" || typeof part.id !== "string" || !part.id || part.id.length > 256) continue;
      state.requestedInputIds.add(part.id);
      if (state.requestedInputIds.size > MAX_REQUESTED_INPUT_IDS) state.requestedInputIds.delete(state.requestedInputIds.values().next().value);
    }
  }
  return state;
}

/** Canonical UTC ISO strings, oldest to newest, from a reduction state. */
export function claudeUserMessageTimesFromState(state) {
  return Array.isArray(state?.times) ? state.times.map((time) => new Date(time).toISOString()) : [];
}

/** The same reduction over records already held in memory (a complete-history read). */
export function claudeUserMessageTimes(records) {
  const state = createClaudeUserMessageTimeState();
  for (const record of Array.isArray(records) ? records : []) reduceClaudeUserMessageTimes(state, record);
  return claudeUserMessageTimesFromState(state);
}
