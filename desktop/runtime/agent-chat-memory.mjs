// Aril keeps its two memories current by itself, in one fixed way. An answer may end with one fenced block tagged `pomegr-memory`:
// `{ "updates": [{ "scope": "owner" | "repository", "add": [...], "remove": [...] }] }`, one or two updates with distinct scopes. This module
// reads the block strictly, and desktop main applies each update to the memory its scope names, with no Apply of the owner:
// - `owner` is the owner's memory, for every repository, kept by desktop main.
// - `repository` is the memory of the repository the thread belongs to, kept in its task store. A block cannot name another repository.
// Aril's run never writes a file: it only answers text. A block that is malformed, repeated, never closed, or outside the contract is
// dropped and applies nothing. An update that would pass 6,000 characters, or removes a line the memory does not hold, applies nothing.
// Only an owner's message can carry an update, and only while Aril is On. The owner sees one fixed line for each update.

import { ARIL_MEMORY, isMemoryLine } from "../../shared/aril-memory.mjs";

export const MEMORY_FENCE = "pomegr-memory";
export const MEMORY_SCOPES = Object.freeze(["owner", "repository"]);

const BLOCK_LIMIT_BYTES = 8 * 1024;
const FENCE = new RegExp(`(^|\\n)\`\`\`${MEMORY_FENCE}[^\\n]*\\n([\\s\\S]*?)\\n?\`\`\`[ \\t]*\\r?(?=\\n|$)`, "gu");
const OPEN_FENCE = new RegExp(`(^|\\n)\`\`\`${MEMORY_FENCE}[\\s\\S]*$`, "u");

const isPlainObject = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const only = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

// The lines of one list, trimmed; null when the list or a line is outside the contract.
function lines(value) {
  if (!Array.isArray(value) || value.length > ARIL_MEMORY.updateLines || !value.every(isMemoryLine)) return null;
  return value.map((line) => line.trim());
}

/**
 * The updates of a block in their one stored shape, or null when anything is outside the contract: one or two updates with distinct scopes
 * (`owner`, `repository`), each with exactly `scope`, `add`, and `remove`, at most 10 lines in each list, every line one nonblank line of
 * at most 300 characters, and at least one line to add or remove.
 */
export function normalizeMemoryUpdates(source) {
  if (!isPlainObject(source) || !only(source, ["updates"]) || !Array.isArray(source.updates) || source.updates.length < 1 || source.updates.length > MEMORY_SCOPES.length) return null;
  const updates = [];
  for (const item of source.updates) {
    if (!isPlainObject(item) || !only(item, ["scope", "add", "remove"]) || !MEMORY_SCOPES.includes(item.scope)) return null;
    const add = lines(item.add);
    const remove = lines(item.remove);
    if (!add || !remove || add.length + remove.length === 0) return null;
    updates.push({ scope: item.scope, add, remove });
  }
  return new Set(updates.map(({ scope }) => scope)).size === updates.length ? updates : null;
}

const tidy = (text) => text.replace(/\n{3,}/gu, "\n\n").trim();

/**
 * Splits an agent answer into the text to show and the memory updates it carries. `unreadable` is true when the answer holds a block that
 * is malformed, repeated, never closed, or outside the contract: nothing is applied and nothing is guessed.
 */
export function extractMemory(answer) {
  if (typeof answer !== "string") return { text: "", updates: null, unreadable: false };
  const bodies = [];
  let text = answer.replace(FENCE, (_match, lead, body) => { bodies.push(body); return lead; });
  // A block the agent never closed is not shown as text either.
  const open = OPEN_FENCE.test(text);
  if (open) text = text.replace(OPEN_FENCE, "");
  text = tidy(text);
  if (bodies.length === 0) return { text, updates: null, unreadable: open };
  if (bodies.length > 1 || open || Buffer.byteLength(bodies[0], "utf8") > BLOCK_LIMIT_BYTES) return { text, updates: null, unreadable: true };
  let parsed;
  try { parsed = JSON.parse(bodies[0]); } catch { return { text, updates: null, unreadable: true }; }
  const updates = normalizeMemoryUpdates(parsed);
  return updates ? { text, updates, unreadable: false } : { text, updates: null, unreadable: true };
}

/** The text of an answer as the panel shows it while it is written: without a memory block, closed or begun. */
export const hideMemory = (partial) => partial.replace(FENCE, (_match, lead) => lead).replace(OPEN_FENCE, "");

const WHERE = Object.freeze({ owner: "you", repository: "this repository" });
const WHY = Object.freeze({ limit: "too long", not_found: "a line to remove is not there", invalid: "not valid", off: "Aril is off", unreadable: "the update could not be read" });
const count = (number, word) => `${number} ${word}`;

/**
 * Applies what an owner's message carried and puts one fixed line for each update after the answer: `Memory updated: you · 2 added · 1 removed`,
 * `Memory already up to date: this repository`, or `Memory not updated: you · too long`. `found` is `extractMemory`'s answer. `apply` holds one
 * function for each scope that takes `{ add, remove }` and answers `{ ok: true, added, removed }` or `{ ok: false, error }`; `on()` says whether Aril
 * is On. Nothing a function throws or answers outside this shape reaches the line. `read` is `{ text, ... }`; the rest of it is kept.
 */
export async function recordMemory(read, found, { on, apply }, answerLimit) {
  if (!found.updates && !found.unreadable) return read;
  const results = [];
  if (found.unreadable) results.push(`Memory not updated: ${WHY.unreadable}`);
  for (const { scope, add, remove } of found.updates ?? []) {
    if (!on()) { results.push(`Memory not updated: ${WHERE[scope]} · ${WHY.off}`); continue; }
    let result;
    try { result = await apply[scope]({ add, remove }); } catch { /* Fixed refusal below. */ }
    if (result?.ok === true && Number.isSafeInteger(result.added) && Number.isSafeInteger(result.removed)) {
      results.push(result.added + result.removed === 0 ? `Memory already up to date: ${WHERE[scope]}`
        : `Memory updated: ${[WHERE[scope], result.added > 0 ? count(result.added, "added") : null, result.removed > 0 ? count(result.removed, "removed") : null].filter(Boolean).join(" · ")}`);
    } else {
      results.push(`Memory not updated: ${WHERE[scope]} · ${Object.hasOwn(WHY, result?.error) && result.error !== "off" ? WHY[result.error] : "could not be saved"}`);
    }
  }
  const recorded = results.join("\n");
  return { ...read, text: [read.text.slice(0, Math.max(0, answerLimit - recorded.length - 2)).trimEnd(), recorded].filter(Boolean).join("\n\n") };
}
