// Effort routing with Jev: an option that is off until the owner has set a Jev key. On each owner message desktop main asks Jev, in parallel
// with the preparation of the turn, how much effort Aril's reply needs, and the run may use a LOWER effort than the owner chose in the
// composer. The owner's effort is a ceiling: Jev never raises it, never changes the provider or the model, and never delays the turn by
// more than its own timeout. Jev sees the owner's message and the end of Aril's previous answer, and nothing else. The key is read here
// and goes nowhere but the `Authorization` header of that one call: never a log, a record, a prompt, the monitor, or a renderer.

import { CHAT_EFFORTS } from "./agent-chat-runner.mjs";
import { createJevTransport } from "./agent-chat-jev-transport.mjs";
import { ROUTE_EFFORTS, ROUTE_PHASES } from "./agent-chat-timing.mjs";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
// No answer in this time means the owner's effort; the call is never retried.
export const JEV_TIMEOUT_MS = 1_500;
// How much of the end of Aril's previous answer Jev sees.
export const JEV_PREVIOUS_LIMIT = 2_000;
// An answer larger than this is not an answer.
const ANSWER_LIMIT = 64 * 1024;

export const JEV_INSTRUCTIONS = [
  "Aril is a coding assistant that reads a software team's task board and answers its owner.",
  "Decide how much reasoning effort Aril needs for its next reply to the owner's latest message, using the end of its previous answer as context.",
  "Judge by the work Aril must do next, not by how short the message is.",
  "low: the reply needs little thought: an acknowledgment, thanks, a simple yes or no to a simple question, a short confirmation, or small talk.",
  "medium: a focused question or one clear request that needs some looking up or a short explanation.",
  "high: planning, scanning the backlog, diagnosing a problem, comparing options, or any multi-step reasoning, and anything long, unclear, or risky,",
  "including a short reply that approves or asks for that kind of work.",
  "When in doubt, choose the higher level.",
].join(" ");

/**
 * The text Jev is given: the owner's message and the end of Aril's previous answer, each under a plain label, and nothing else. No board,
 * task text, image, repository name, path, or earlier part of the conversation.
 */
export function jevState({ text, previous }) {
  const end = typeof previous === "string" ? previous.slice(-JEV_PREVIOUS_LIMIT) : "";
  return `Owner's message:\n${text}\n\nEnd of Aril's previous answer (at most ${JEV_PREVIOUS_LIMIT} characters):\n${end === "" ? "(none)" : end}`;
}

/** The request body: one `choice` question and the state. */
export function jevBody(state) {
  return JSON.stringify({
    state, model: JEV_MODEL,
    questions: { effort: { type: "choice", instructions: JEV_INSTRUCTIONS, criteria: { low: null, medium: null, high: null } } },
  });
}

/**
 * The effort a run uses when Jev chose `chosen` and the owner chose `owner` (null for the provider's own): the lower of the two on the
 * ordered scale `low`, `medium`, `high`, `xhigh`. With no owner effort the provider's own level is unknown, so only `low`, which no level
 * is below, can lower it; any other answer leaves it as it is. Never higher than the owner's.
 */
export function loweredEffort(owner, chosen) {
  const rank = (level) => CHAT_EFFORTS.indexOf(level);
  if (!ROUTE_EFFORTS.includes(chosen)) return owner;
  if (owner === null) return chosen === "low" ? "low" : null;
  return rank(chosen) < rank(owner) ? chosen : owner;
}

/** The newest answer of Aril's own run in a conversation, as the shown text it stored, or "" before the first. A grant's fixed line is not a run. */
export function previousAnswer(messages) {
  const found = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message.role === "agent" && message.grantFollowUp !== true && typeof message.text === "string" && message.text !== "");
  return found ? found.text : "";
}

// Jev's choice from its answer, or null for an answer that is not exactly one of the three levels.
function chosenEffort(raw) {
  if (typeof raw !== "string" || raw.length > ANSWER_LIMIT) return null;
  try {
    const answer = JSON.parse(raw)?.answers?.effort;
    return answer?.type === "choice" && ROUTE_EFFORTS.includes(answer.choice) ? answer.choice : null;
  } catch { return null; }
}

/**
 * The routing of a desktop's turns. `key` is the key store (`read()` answers the Jev key or null; `peek()`, when it has one, answers it
 * without waiting once it was read), `fetch` makes the one call in place of the transport, `transport` is the one that does by default
 * (`agent-chat-jev-transport.mjs`: a name lookup off the thread pool, a kept connection, and `preconnect`), and `clock` is a monotonic
 * clock in milliseconds. `route({ text, previous, effort, images })` answers `{ effort, route }` and never rejects: `effort` is the one the
 * run uses, and `route` the record for the answer's timing, or null when no key is set (nothing was asked and nothing is recorded).
 * A message with images is not asked: Jev cannot see them, and a short message about a picture can need real work.
 * With the key already read, the request is made before `route` returns, so it goes out before the turn's other reads start.
 * `preconnect()` opens the connection ahead, only when a key is set; it sends no request, no key, and no text.
 */
export function createJevRouting({ key, fetch: fetchImpl = null, transport: given = null, clock = () => performance.now(), timeoutMs = JEV_TIMEOUT_MS }) {
  let own = null;
  const carrier = () => given ?? (fetchImpl ? null : (own ??= createJevTransport()));
  const send = (url, init) => (fetchImpl ?? carrier().fetch)(url, init);

  async function ask(secret, state) {
    const controller = new AbortController();
    let timer;
    let readPhase = () => null;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        let phase = null;
        try { phase = readPhase(); } catch { /* the call is given up without saying where it waited */ }
        resolve({ reason: "timeout", ...(ROUTE_PHASES.includes(phase) ? { phase } : {}) });
        controller.abort();
      }, timeoutMs);
      // Not unref'd: a send awaits this answer, and the timer is cleared as soon as Jev answers.
    });
    const call = (async () => {
      const response = await send(JEV_URL, {
        method: "POST", redirect: "error", cache: "no-store", signal: controller.signal, watch: (read) => { readPhase = read; },
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: jevBody(state),
      });
      if (!response.ok) return { reason: "error" };
      const choice = chosenEffort(await response.text());
      return choice ? { choice } : { reason: "invalid" };
    })().catch(() => ({ reason: "error" }));
    try { return await Promise.race([call, expired]); } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    async route({ text, previous = "", effort = null, images = 0 }) {
      try {
        const held = key?.peek?.();
        const secret = held !== undefined ? held : key ? await key.read() : null;
        if (!secret) return { effort, route: null };
        if (images > 0) return { effort, route: { effort, by: "owner", reason: "images" } };
        const started = clock();
        const answer = await ask(secret, jevState({ text, previous }));
        const ms = Math.max(0, Math.round(clock() - started));
        if (!answer.choice) return { effort, route: { effort, by: "owner", reason: answer.reason, ms, ...(answer.phase ? { phase: answer.phase } : {}) } };
        const used = loweredEffort(effort, answer.choice);
        return used === effort ? { effort, route: { effort, by: "owner", reason: "kept", ms } } : { effort: used, route: { effort: used, by: "jev", ms } };
      } catch {
        // Whatever went wrong, the turn goes on with the owner's effort and records nothing about it.
        return { effort, route: null };
      }
    },
    /** Opens the connection to Jev ahead of a send. Nothing without a key; answers whether a connection is ready, and never rejects. */
    async preconnect() {
      try {
        const using = carrier();
        if (!using?.preconnect || !key || !await key.read()) return false;
        return await using.preconnect() === true;
      } catch { return false; }
    },
  });
}
