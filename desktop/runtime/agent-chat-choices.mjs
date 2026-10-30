// The choices Aril may offer under an answer: up to four quick replies, or one multiple-choice question. They are read from a
// fenced block, validated strictly, and stored on the answer. A choice only ever becomes the owner's own message: nothing here
// applies, starts, or changes anything. A block that cannot be read is dropped and the answer text stays.

import { hideMemory } from "./agent-chat-memory.mjs";
import { visibleAnswer } from "./agent-chat-proposal.mjs";

export const CHOICES_FENCE = "pomegr-replies";
export const REPLIES_MAX = 4;
export const REPLY_LENGTH = 40;
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
export const QUESTION_LENGTH = 120;
export const OPTION_LABEL_LENGTH = 60;
export const OPTION_DETAIL_LENGTH = 120;

const BLOCK_LIMIT_BYTES = 8 * 1024;
const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const FENCE = new RegExp(`(^|\\n)\`\`\`${CHOICES_FENCE}[^\\n]*\\n([\\s\\S]*?)\\n?\`\`\`[ \\t]*\\r?(?=\\n|$)`, "gu");
const OPEN_FENCE = new RegExp(`(^|\\n)\`\`\`${CHOICES_FENCE}[\\s\\S]*$`, "u");

const isPlainObject = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// One non-empty line within the bound, trimmed; null when it is anything else.
function line(value, limit) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= limit && ONE_LINE.test(trimmed) ? trimmed : null;
}

const distinct = (labels) => new Set(labels.map((label) => label.toLowerCase())).size === labels.length;

/**
 * The choices of an answer in their one stored shape, or null when anything is outside the contract.
 * `{ replies: [label, ...] }` holds 1 to 4 quick replies. `{ question, options: [{ label, detail }, ...] }` holds one
 * question and 2 to 4 options, the recommended one first. Labels are one line each and do not repeat, whatever their case.
 */
export function normalizeChoices(source) {
  if (!isPlainObject(source)) return null;
  const keys = Object.keys(source);
  if (keys.length === 1 && keys[0] === "replies") {
    const { replies } = source;
    if (!Array.isArray(replies) || replies.length < 1 || replies.length > REPLIES_MAX) return null;
    const labels = replies.map((reply) => line(reply, REPLY_LENGTH));
    return labels.every(Boolean) && distinct(labels) ? { replies: labels } : null;
  }
  if (keys.length === 2 && Object.hasOwn(source, "question") && Object.hasOwn(source, "options")) {
    const question = line(source.question, QUESTION_LENGTH);
    const { options } = source;
    if (!question || !Array.isArray(options) || options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) return null;
    const rows = options.map((option) => {
      if (!isPlainObject(option) || Object.keys(option).length !== 2 || !Object.hasOwn(option, "label") || !Object.hasOwn(option, "detail")) return null;
      const label = line(option.label, OPTION_LABEL_LENGTH);
      const detail = line(option.detail, OPTION_DETAIL_LENGTH);
      return label && detail ? { label, detail } : null;
    });
    return rows.every(Boolean) && distinct(rows.map(({ label }) => label)) ? { question, options: rows } : null;
  }
  return null;
}

/** The labels the owner may tap, in the order they are drawn. */
export const choiceLabels = (choices) => (choices.replies ?? choices.options.map(({ label }) => label));

const tidy = (text) => text.replace(/\n{3,}/gu, "\n\n").trim();

/**
 * Splits an agent answer into the text to show and the choices it carries. `unreadable` is true when the answer holds a
 * block that is malformed, repeated, never closed, or outside the contract: no choice is offered then and nothing is guessed.
 */
export function extractChoices(answer) {
  if (typeof answer !== "string") return { text: "", choices: null, unreadable: false };
  const bodies = [];
  let text = answer.replace(FENCE, (_match, lead, body) => { bodies.push(body); return lead; });
  // A block the agent never closed is not shown as text either.
  const open = OPEN_FENCE.test(text);
  if (open) text = text.replace(OPEN_FENCE, "");
  text = tidy(text);
  if (bodies.length === 0) return { text, choices: null, unreadable: open };
  if (bodies.length > 1 || open || Buffer.byteLength(bodies[0], "utf8") > BLOCK_LIMIT_BYTES) return { text, choices: null, unreadable: true };
  let parsed;
  try { parsed = JSON.parse(bodies[0]); } catch { return { text, choices: null, unreadable: true }; }
  const choices = normalizeChoices(parsed);
  return choices ? { text, choices, unreadable: false } : { text, choices: null, unreadable: true };
}

/**
 * The text of an answer as the panel shows it while it is written, or when it did not complete: without a proposal block, a choices
 * block, or a memory block, closed or begun.
 */
export function shownAnswer(partial) {
  const text = hideMemory(visibleAnswer(partial));
  return text.replace(FENCE, (_match, lead) => lead).replace(OPEN_FENCE, "").replace(/\n{3,}/gu, "\n\n").trimEnd();
}

/** What the prompt's conversation says about the choices of an answer, so a later answer never assumes buttons the owner did not see. */
export function choicesHistory(message) {
  if (message.choices) {
    const { choices } = message;
    return [choices.replies
      ? `[You offered these quick replies: ${choices.replies.join(" | ")}.]`
      : `[You asked "${choices.question}" with these options, the first one recommended: ${choices.options.map(({ label }) => label).join(" | ")}.]`];
  }
  return message.choicesUnreadable ? ["[Pomegr could not read the choices block of this answer, so the owner saw no quick replies or options.]"] : [];
}
