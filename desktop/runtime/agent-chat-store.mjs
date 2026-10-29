// The saved conversations of the Pomegr agent chat: one private JSON file per conversation, under the desktop data
// root. Only desktop main reads or writes them; nothing here is observed, indexed, logged, or sent anywhere. A repository holds
// any number of conversations, so the store keeps an index of them in memory and the messages of only a few.

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { ARIL_FOLLOW_UP_END_REASONS } from "../../shared/aril-follow-up.mjs";
import { normalizeChatImages } from "./agent-chat-images.mjs";
import { normalizeTiming } from "./agent-chat-timing.mjs";
import { BOARD_OPERATIONS, normalizeOperation, PROPOSAL_OPERATION_LIMIT, PROPOSAL_SUMMARY_LIMIT, QUEUE_OPERATION, QUEUE_RESULTS, queueProposalState, START_FAILURES, START_OPERATION, startProposalTask, WORKTREE_RESULTS } from "./agent-chat-proposal.mjs";

export const AGENT_CHAT_DIRECTORY = "agent-chat-v1";
export const MESSAGE_LIMIT = 200;
export const MESSAGE_LENGTH = 4000;
export const ANSWER_LENGTH = 32_000;
export const TITLE_LENGTH = 80;

const VERSION = 1;
const FILE_LIMIT_BYTES = 12 * 1024 * 1024;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const CONVERSATION_ID = /^chat-[0-9a-f]{12}$/u;
const PROPOSAL_ID = /^p-[0-9a-f]{12}$/u;
const MESSAGE_ID = /^m-[1-9][0-9]{0,5}$/u;
const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const TURN_STATUSES = new Set(["complete", "stopped", "failed", "timed_out", "interrupted"]);
const PROPOSAL_STATES = new Set(["pending", "applied", "partial", "dismissed"]);
const RESULT_ERRORS = new Set(["invalid", "not_found", "limit", "conflict", "unsupported", "unavailable", "skipped"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const instant = (value) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const bounded = (value, limit, { empty = false } = {}) => typeof value === "string" && value.length <= limit && (empty || value.length > 0);

export const newConversationId = () => `chat-${randomBytes(6).toString("hex")}`;
export const newProposalId = () => `p-${randomBytes(6).toString("hex")}`;

/** The first line of a message, cut to a title. */
export function conversationTitle(text) {
  const line = String(text).split(/\r?\n/u).map((part) => part.trim()).find(Boolean) ?? "New conversation";
  return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1)}…`;
}

// The stored operation is already normalized, so it reads back through the agent-facing shape it came from.
function storedOperation(operation, grantWrite) {
  if (!isPlainObject(operation) || !BOARD_OPERATIONS.includes(operation.op)) return null;
  const { run, completeWhen, placeAfter, after, ...rest } = operation;
  const source = { ...rest };
  if (after !== undefined) source[grantWrite ? "runs_after" : "after"] = after;
  if (placeAfter !== undefined) source.place_after = placeAfter;
  if (run !== undefined) { if (!isPlainObject(run)) return null; Object.assign(source, run); }
  if (completeWhen !== undefined) {
    if (!isPlainObject(completeWhen)) return null;
    if (Object.hasOwn(completeWhen, "checks")) source.complete_when = completeWhen.checks;
    if (Object.hasOwn(completeWhen, "own")) source.own_condition = completeWhen.own;
  }
  return normalizeOperation(source, { grantWrite });
}

function storedResult(result) {
  if (!isPlainObject(result) || typeof result.ok !== "boolean") return null;
  if (result.worktree !== undefined) return WORKTREE_RESULTS.includes(result.worktree) && result.ok === (result.worktree === "removed")
    ? { ok: result.ok, worktree: result.worktree, ...(result.ok ? {} : { error: result.worktree }) } : null;
  // The outcome of a start: launched, or the fixed status that held or failed it.
  if (result.start !== undefined) {
    if (result.ok) return result.start === "started" ? { ok: true, start: "started" } : null;
    return result.error === "not_started" && START_FAILURES.includes(result.start) ? { ok: false, error: "not_started", start: result.start } : null;
  }
  // The outcome of a queue change the monitor accepted. One it refused is an ordinary failure.
  if (result.queue !== undefined) return result.ok && QUEUE_RESULTS.includes(result.queue) ? { ok: true, queue: result.queue } : null;
  const taskId = typeof result.taskId === "string" && TASK_ID.test(result.taskId) ? { taskId: result.taskId } : {};
  if (result.ok) return { ok: true, ...taskId };
  // `part` says where the operation failed: at an image (the task was created, or is there, and the image was not
  // attached), or at the placement of a task it created.
  if (result.part !== undefined && result.part !== "images" && result.part !== "placement") return null;
  const part = result.part === undefined ? {} : { part: result.part };
  return typeof result.error === "string" && RESULT_ERRORS.has(result.error) ? { ok: false, error: result.error, ...taskId, ...part } : null;
}

function storedProposal(proposal) {
  if (!isPlainObject(proposal) || typeof proposal.id !== "string" || !PROPOSAL_ID.test(proposal.id) || !PROPOSAL_STATES.has(proposal.state)
    || !bounded(proposal.summary, PROPOSAL_SUMMARY_LIMIT) || !Array.isArray(proposal.operations)
    || proposal.operations.length === 0 || proposal.operations.length > PROPOSAL_OPERATION_LIMIT) return null;
  const grantWrite = proposal.appliedBy === "grant";
  if (grantWrite && (proposal.state !== "applied" || proposal.operations.length > 5)) return null;
  const operations = proposal.operations.map((operation) => storedOperation(operation, grantWrite));
  if (operations.some((operation) => operation === null)) return null;
  const worktrees = operations.some(({ op }) => op === "remove_worktree");
  if (worktrees && (operations.length > 30 || !operations.every(({ op }) => op === "remove_worktree"))) return null;
  const start = operations.some((operation) => operation.op === START_OPERATION);
  // A start stands alone, and it either launched (`applied`) or waits for the owner's next answer.
  if (start && (operations.length !== 1 || proposal.state === "partial")) return null;
  // A queue change stands alone too, and it is `applied` only when the monitor accepted the state it asked for.
  const queueOn = queueProposalState({ operations });
  if (operations.some((operation) => operation.op === QUEUE_OPERATION) && (queueOn === null || proposal.state === "partial")) return null;
  const stored = { id: proposal.id, summary: proposal.summary, operations, state: proposal.state };
  if (grantWrite) stored.appliedBy = "grant";
  if (proposal.results !== undefined) {
    if (!Array.isArray(proposal.results) || proposal.results.length !== operations.length) return null;
    const results = proposal.results.map(storedResult);
    if (results.some((result) => result === null)) return null;
    // Worktree removals run independently: the proposal is `applied` only when every worktree was removed, else `partial`.
    if (results.some((result) => (result.worktree !== undefined) !== worktrees)) return null;
    if (worktrees && (proposal.state === "applied" ? !results.every(({ ok }) => ok) : proposal.state !== "partial" || results.every(({ ok }) => ok))) return null;
    if (results.some((result) => result.start !== undefined) !== start) return null;
    if (start && results[0].ok !== (proposal.state === "applied")) return null;
    if (results.some((result) => result.queue !== undefined) && queueOn === null) return null;
    if (queueOn !== null && (results[0].ok !== (proposal.state === "applied") || results[0].taskId !== undefined
      || (results[0].ok && !(queueOn ? ["on", "blocked"] : ["off"]).includes(results[0].queue)))) return null;
    stored.results = results;
  }
  return stored;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

// The effort of a record: `{ effort }` for a known level, `{}` for none (an older record has no effort, which reads as null),
// and `undefined` for a value that is neither, so the record is refused as a model outside the contract is.
function storedEffort(value) {
  if (value === undefined || value === null) return {};
  return typeof value === "string" && EFFORTS.has(value) ? { effort: value } : undefined;
}

function storedMessage(message) {
  if (!isPlainObject(message) || typeof message.id !== "string" || !MESSAGE_ID.test(message.id) || !instant(message.at)) return null;
  if (message.role === "user") {
    if (!bounded(message.text, MESSAGE_LENGTH)) return null;
    const stored = { id: message.id, role: "user", text: message.text, at: message.at };
    if (message.images !== undefined) {
      const images = normalizeChatImages(message.images);
      if (!images) return null;
      stored.images = images;
    }
    return stored;
  }
  if (message.role !== "agent" || !bounded(message.text, ANSWER_LENGTH, { empty: true }) || !PROVIDERS.has(message.provider)
    || !(message.model === null || (typeof message.model === "string" && MODEL.test(message.model))) || !TURN_STATUSES.has(message.status)) return null;
  const effort = storedEffort(message.effort);
  if (effort === undefined) return null;
  const stored = { id: message.id, role: "agent", text: message.text, at: message.at, provider: message.provider, model: message.model, ...effort, status: message.status };
  if (message.proposal !== undefined) {
    const proposal = storedProposal(message.proposal);
    if (!proposal) return null;
    stored.proposal = proposal;
  }
  if (message.proposalUnreadable === true) stored.proposalUnreadable = true;
  // How long the run took and how large its prompt was, as numbers. A record without one, or with one outside the contract, keeps the message.
  const timing = normalizeTiming(message.timing);
  if (timing) stored.timing = timing;
  // A grant follow-up is a fixed line Pomegr wrote from the task log, with no provider run: it never carries a proposal.
  if (message.grantFollowUp !== undefined) {
    if (message.grantFollowUp !== true || stored.proposal || stored.proposalUnreadable || stored.timing || message.followUp !== undefined || stored.status !== "complete") return null;
    stored.grantFollowUp = true;
  }
  // A follow-up may offer another board proposal, but never a session start or queue-state change.
  if (message.followUp !== undefined) {
    if (typeof message.followUp !== "string" || !PROPOSAL_ID.test(message.followUp)) return null;
    if (stored.proposal && (startProposalTask(stored.proposal) || queueProposalState(stored.proposal) !== null || stored.proposal.operations.some(({ op }) => op === "remove_worktree"))) return null;
    stored.followUp = message.followUp;
  }
  return stored;
}

/** A conversation inside the stored contract, or null. */
// The last follow-up written: its grant, task-log position, end, and message; before the first, all null.
function followUpMark(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 4 || !["grant", "through", "ended", "messageId"].every((key) => Object.hasOwn(value, key))) return null;
  if (value.grant === null) return value.through === null && value.ended === null && value.messageId === null ? { grant: null, through: null, ended: null, messageId: null } : null;
  return Number.isSafeInteger(value.grant) && value.grant > 0 && Number.isSafeInteger(value.through) && value.through >= 0
    && (value.ended === null || ARIL_FOLLOW_UP_END_REASONS.includes(value.ended)) && typeof value.messageId === "string" && MESSAGE_ID.test(value.messageId)
    ? { grant: value.grant, through: value.through, ended: value.ended, messageId: value.messageId } : null;
}

export function normalizeConversation(value) {
  if (!isPlainObject(value) || typeof value.id !== "string" || !CONVERSATION_ID.test(value.id) || !bounded(value.title, TITLE_LENGTH)
    || !PROVIDERS.has(value.provider) || !(value.model === null || (typeof value.model === "string" && MODEL.test(value.model)))
    || !instant(value.createdAt) || !instant(value.updatedAt) || !Array.isArray(value.messages) || value.messages.length > MESSAGE_LIMIT) return null;
  const effort = storedEffort(value.effort);
  if (effort === undefined) return null;
  const messages = value.messages.map(storedMessage);
  if (messages.some((message) => message === null) || new Set(messages.map((message) => message.id)).size !== messages.length) return null;
  // `grantFollowUps` marks the repository's follow-up conversation and names the last follow-up written into it.
  const mark = value.grantFollowUps === undefined ? undefined : followUpMark(value.grantFollowUps);
  if (mark === null) return null;
  return { id: value.id, title: value.title, provider: value.provider, model: value.model, ...effort, createdAt: value.createdAt, updatedAt: value.updatedAt, messages,
    ...(mark === undefined ? {} : { grantFollowUps: mark }) };
}

/**
 * What the store keeps in memory of a conversation: its index entry, without its messages. The thread, the routing of a message, the
 * list, and the grant follow-ups read this, and read a conversation only when they need its messages. `from` and `to` are the times
 * of its oldest and newest message in milliseconds (both null when it holds none), which is what lets a page or a search of the
 * thread stop once the next conversation cannot reach it. `answeredAt` is the time of its newest complete answer of Aril's own run.
 */
export function conversationMeta(conversation) {
  const times = conversation.messages.map((message) => Date.parse(message.at));
  const answered = conversation.messages.filter((message) => message.role === "agent" && message.status === "complete" && message.grantFollowUp !== true).map((message) => Date.parse(message.at));
  return Object.freeze({
    id: conversation.id, title: conversation.title, provider: conversation.provider, model: conversation.model, ...(conversation.effort ? { effort: conversation.effort } : {}),
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, messages: conversation.messages.length,
    images: conversation.messages.reduce((count, message) => count + (message.role === "user" ? (message.images?.length ?? 0) : 0), 0),
    lastRole: conversation.messages.at(-1)?.role ?? null,
    answeredAt: answered.length > 0 ? Math.max(...answered) : null,
    from: times.length > 0 ? Math.min(...times) : null, to: times.length > 0 ? Math.max(...times) : null,
    ...(conversation.grantFollowUps ? { grantFollowUps: Object.freeze({ ...conversation.grantFollowUps }) } : {}),
  });
}

// The conversations whose messages are held in memory at once, most recently used first. Every other message stays in its file until it is asked for.
const BODIES_IN_MEMORY = 16;

export function createAgentChatStore({ directory, filesystem = fs, now = () => new Date() } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new TypeError("Invalid agent chat directory");
  // For each repository, the index of its conversations; and the few conversations read lately, by `repositoryId/id`.
  const indexes = new Map();
  const recent = new Map();
  // A conversation that was made and not yet written has no file: its messages stay here until its first save.
  const unwritten = new Map();
  const writes = new Map();

  const folder = (repositoryId) => path.join(directory, repositoryId);
  const file = (repositoryId, id) => path.join(folder(repositoryId), `${id}.json`);
  const keyOf = (repositoryId, id) => `${repositoryId}/${id}`;

  function remember(key, conversation) {
    recent.delete(key);
    recent.set(key, conversation);
    while (recent.size > BODIES_IN_MEMORY) recent.delete(recent.keys().next().value);
  }

  // The conversation in one file, inside the contract, or null. A file outside it is left as it is: never listed, never overwritten.
  async function readConversation(repositoryId, id) {
    try {
      const target = file(repositoryId, id);
      if ((await filesystem.stat(target)).size > FILE_LIMIT_BYTES) return null;
      const parsed = JSON.parse(await filesystem.readFile(target, "utf8"));
      const conversation = isPlainObject(parsed) && parsed.version === VERSION && parsed.repositoryId === repositoryId ? normalizeConversation(parsed.conversation) : null;
      return conversation && conversation.id === id ? conversation : null;
    } catch { return null; }
  }

  // Reads the files of a repository once, one at a time, and keeps only the index of each: a repository can hold any number of conversations.
  function load(repositoryId) {
    if (indexes.has(repositoryId)) return indexes.get(repositoryId);
    const metas = (async () => {
      const found = new Map();
      let names = [];
      try { names = await filesystem.readdir(folder(repositoryId)); } catch { names = []; }
      for (const name of names) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!CONVERSATION_ID.test(id)) continue;
        const conversation = await readConversation(repositoryId, id);
        if (conversation) found.set(id, conversationMeta(conversation));
      }
      return found;
    })();
    indexes.set(repositoryId, metas);
    return metas;
  }

  // One write per conversation at a time, each replacing the file whole.
  function write(repositoryId, conversation) {
    const key = keyOf(repositoryId, conversation.id);
    const run = async () => {
      const serialized = `${JSON.stringify({ version: VERSION, repositoryId, conversation })}\n`;
      if (Buffer.byteLength(serialized, "utf8") > FILE_LIMIT_BYTES) return false;
      const target = file(repositoryId, conversation.id);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await filesystem.mkdir(folder(repositoryId), { recursive: true });
        await filesystem.writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await filesystem.rename(temporary, target);
        return true;
      } catch {
        await filesystem.unlink(temporary).catch(() => {});
        return false;
      }
    };
    const next = (writes.get(key) ?? Promise.resolve()).then(run, run);
    writes.set(key, next);
    void next.finally(() => { if (writes.get(key) === next) writes.delete(key); });
    return next;
  }

  const valid = (repositoryId, id) => typeof repositoryId === "string" && REPOSITORY_ID.test(repositoryId) && (id === undefined || (typeof id === "string" && CONVERSATION_ID.test(id)));

  return Object.freeze({
    /** The index entry of every conversation of the repository, most recently updated first. It holds no message. */
    async index(repositoryId) {
      if (!valid(repositoryId)) return [];
      return [...(await load(repositoryId)).values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    },
    /** One conversation with its messages, or null. */
    async read(repositoryId, id) {
      if (!valid(repositoryId, id) || id === undefined) return null;
      const metas = await load(repositoryId);
      if (!metas.has(id)) return null;
      const key = keyOf(repositoryId, id);
      if (unwritten.has(key)) return unwritten.get(key);
      if (recent.has(key)) { const conversation = recent.get(key); remember(key, conversation); return conversation; }
      // A save that is still being written is the newest content, so its file is read once it is there.
      await (writes.get(key) ?? Promise.resolve()).catch(() => {});
      const conversation = await readConversation(repositoryId, id);
      // A save that came meanwhile holds newer content than this read.
      if (unwritten.has(key)) return unwritten.get(key);
      if (recent.has(key)) return recent.get(key);
      // A conversation removed meanwhile is gone.
      if (!metas.has(id)) return null;
      if (conversation) remember(key, conversation);
      return conversation;
    },
    /** A new, empty conversation, kept in memory until its first save. */
    async create(repositoryId, { provider, model, effort, title, grantFollowUps }) {
      if (!valid(repositoryId)) return null;
      const metas = await load(repositoryId);
      const at = now().toISOString();
      const conversation = normalizeConversation({ id: newConversationId(), title, provider, model, effort, createdAt: at, updatedAt: at, messages: [], ...(grantFollowUps === undefined ? {} : { grantFollowUps }) });
      if (conversation) {
        metas.set(conversation.id, conversationMeta(conversation));
        unwritten.set(keyOf(repositoryId, conversation.id), conversation);
      }
      return conversation;
    },
    /** Replaces the stored conversation; answers whether the file was written. A refused one changes nothing. */
    async save(repositoryId, conversation) {
      const next = valid(repositoryId) ? normalizeConversation(conversation) : null;
      if (!next) return false;
      const metas = await load(repositoryId);
      const previous = metas.get(next.id);
      if (!previous) return false;
      const key = keyOf(repositoryId, next.id);
      const meta = conversationMeta(next);
      const neverWritten = unwritten.get(key);
      metas.set(next.id, meta);
      unwritten.delete(key);
      remember(key, next);
      const written = await write(repositoryId, next);
      // A write that failed leaves the conversation as it is on disk.
      if (!written && metas.get(next.id) === meta) {
        metas.set(next.id, previous);
        recent.delete(key);
        if (neverWritten) unwritten.set(key, neverWritten);
      }
      return written;
    },
    async remove(repositoryId, id) {
      if (!valid(repositoryId, id) || id === undefined) return false;
      const metas = await load(repositoryId);
      if (!metas.delete(id)) return false;
      const key = keyOf(repositoryId, id);
      recent.delete(key);
      unwritten.delete(key);
      await (writes.get(key) ?? Promise.resolve()).catch(() => {});
      try { await filesystem.unlink(file(repositoryId, id)); } catch { /* never written, or already gone */ }
      return true;
    },
  });
}
