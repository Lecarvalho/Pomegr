"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AGENT_CHAT_ACTIVITIES, AGENT_CHAT_BOARD_OPERATIONS, AGENT_CHAT_BOUNDS, AGENT_CHAT_CONVERSATION_ID_PATTERN, AGENT_CHAT_ERRORS, AGENT_CHAT_IMAGE_ID_PATTERN, AGENT_CHAT_MESSAGE_ID_PATTERN, AGENT_CHAT_PREPARE_STEPS, AGENT_CHAT_PROPOSAL_ID_PATTERN, AGENT_CHAT_ROUTE_PHASES, AGENT_CHAT_ROUTE_REASONS,
  AGENT_CHAT_PROPOSAL_STATES, AGENT_CHAT_QUEUE_RESULTS, AGENT_CHAT_START_FAILURES, AGENT_CHAT_TURN_STATUSES, AGENT_CHAT_WORKTREE_RESULTS,
  type AgentChatActionFailure, type AgentChatActivity, type AgentChatAgentMessage, type AgentChatBoardOperation, type AgentChatChoices, type AgentChatConversation, type AgentChatConversationSummary,
  type AgentChatDoneResult, type AgentChatError, type AgentChatImage, type AgentChatListResult, type AgentChatMessage, type AgentChatOperationName, type AgentChatOperationResult, type AgentChatPrepare,
  type AgentChatProposal, type AgentChatProvider, type AgentChatReadResult, type AgentChatRoute, type AgentChatRoutePhase, type AgentChatRouteReason, type AgentChatSearchMatch, type AgentChatSearchResult, type AgentChatSendResult, type AgentChatThreadMessage,
  type AgentChatThreadResult, type AgentChatThreadRun, type AgentChatThreadSummary, type AgentChatTiming, type AgentChatTurn,
} from "../shared/agent-chat-contract";
import { TASK_EFFORTS, TASK_IMAGE_TYPES, type TaskEffort } from "../shared/task-contract";
import { useClientAccess } from "./hooks/ClientAccessContext";

// Client of the Pomegr agent chat. The desktop app owns the chat: this module only asks it, through the desktop
// bridge in the app window or through the paired-device route on a phone. Nothing is kept in browser storage.

const DESKTOP_POLL_MS = 500;
const PAIRED_POLL_MS = 1_000;
// While the panel is open and no answer is being written, the list is asked at this slower pace, so a message sent from
// another device, and the turn it starts, reach this panel.
const IDLE_POLL_MS = 5_000;
const PAIRED_PATH = "/api/agent-chat";
// Older pages the thread loads to bring one message into view: ten pages are 600 messages.
const REVEAL_PAGES = 10;
// The message field must keep its focus this long before the panel asks the desktop to warm a run, so a burst of focus events (the
// panel focusing the field as it opens, then a click into it) asks once.
export const WARM_DEBOUNCE_MS = 250;

type Bridge = { agentChat(operation: AgentChatOperationName, payload: unknown): Promise<unknown> };
type Json = Record<string, unknown>;

export type AgentChatAvailability = "pending" | "desktop" | "paired" | "absent";

function bridge(): Bridge | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as Window & { pomegrDesktop?: Partial<Bridge> }).pomegrDesktop;
  return typeof candidate?.agentChat === "function" ? candidate as Bridge : undefined;
}

const subscribeBridge = () => () => {};

/** Where the chat can be reached from this client, decided once so the launcher is never drawn and then removed. */
export function useAgentChatAvailability(): AgentChatAvailability {
  const desktop = useSyncExternalStore<"pending" | "yes" | "no">(subscribeBridge, () => (bridge() ? "yes" : "no"), () => "pending");
  const { mode } = useClientAccess();
  if (desktop === "yes") return "desktop";
  if (desktop === "pending" || mode === "unknown") return "pending";
  return mode === "lan" ? "paired" : "absent";
}

const record = (value: unknown): Json | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const text = (value: unknown): value is string => typeof value === "string";
const UNAVAILABLE = { ok: false, error: "unavailable" } as const;
const NO_IMAGES: readonly AgentChatImage[] = [];

async function request(operation: AgentChatOperationName, payload: Json): Promise<Json | null> {
  try {
    const desktop = bridge();
    if (desktop) return record(await desktop.agentChat(operation, payload));
    const response = await fetch(PAIRED_PATH, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, payload }) });
    return response.ok ? record(await response.json().catch(() => null)) : null;
  } catch {
    return null;
  }
}

function failure(answer: Json | null): { ok: false; error: AgentChatError } {
  const error = answer?.ok === false && text(answer.error) && (AGENT_CHAT_ERRORS as readonly string[]).includes(answer.error) ? answer.error as AgentChatError : "unavailable";
  return { ok: false, error };
}

function parseResult(value: unknown): AgentChatOperationResult | null {
  const result = record(value);
  if (!result || typeof result.ok !== "boolean") return null;
  if (result.worktree !== undefined) {
    const worktree = AGENT_CHAT_WORKTREE_RESULTS.find((state) => state === result.worktree);
    if (!worktree || result.ok !== (worktree === "removed")) return null;
    return worktree === "removed" ? { ok: true, worktree } : { ok: false, worktree, error: worktree };
  }
  if (result.start !== undefined) {
    if (result.ok) return result.start === "started" ? { ok: true, start: "started" } : null;
    const start = AGENT_CHAT_START_FAILURES.find((status) => status === result.start);
    return start && result.error === "not_started" ? { ok: false, error: "not_started", start } : null;
  }
  if (result.queue !== undefined) {
    const queue = AGENT_CHAT_QUEUE_RESULTS.find((state) => state === result.queue);
    return result.ok && queue ? { ok: true, queue } : null;
  }
  const taskId = text(result.taskId) ? { taskId: result.taskId } : {};
  if (result.ok) return { ok: true, ...taskId };
  const part = result.part === "images" || result.part === "placement" ? { part: result.part as "images" | "placement" } : {};
  return text(result.error) && result.error !== "not_started" ? { ok: false, error: result.error as AgentChatActionFailure, ...taskId, ...part } : null;
}

const imageIds = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= AGENT_CHAT_BOUNDS.imagesPerMessage
  && value.every((id) => text(id) && AGENT_CHAT_IMAGE_ID_PATTERN.test(id));

export function parseAgentChatImage(value: unknown): AgentChatImage | null {
  const image = record(value);
  const type = TASK_IMAGE_TYPES.find((candidate) => candidate === image?.type);
  if (!image || !type || !text(image.id) || !AGENT_CHAT_IMAGE_ID_PATTERN.test(image.id) || typeof image.bytes !== "number" || !Number.isInteger(image.bytes)
    || image.bytes < 1 || image.bytes > AGENT_CHAT_BOUNDS.imageBytes) return null;
  return { id: image.id, type, bytes: image.bytes };
}

function parseProposal(value: unknown): AgentChatProposal | null {
  const proposal = record(value);
  if (!proposal || !text(proposal.id) || !AGENT_CHAT_PROPOSAL_ID_PATTERN.test(proposal.id) || !text(proposal.summary) || !Array.isArray(proposal.operations)
    || !(AGENT_CHAT_PROPOSAL_STATES as readonly string[]).includes(proposal.state as string)) return null;
  const operations = proposal.operations.filter((entry): entry is AgentChatBoardOperation => {
    const operation = record(entry);
    return Boolean(operation) && (AGENT_CHAT_BOARD_OPERATIONS as readonly string[]).includes(operation!.op as string)
      && (operation!.op !== "set_queue" || typeof operation!.on === "boolean")
      && (operation!.op !== "remove_worktree" || (text(operation!.id) && typeof operation!.branch === "boolean"))
      && (operation!.images === undefined ? operation!.op !== "attach_images" : imageIds(operation!.images));
  });
  if (operations.length !== proposal.operations.length) return null;
  const parsed: AgentChatProposal = { id: proposal.id, summary: proposal.summary, operations, state: proposal.state as AgentChatProposal["state"] };
  if (Array.isArray(proposal.results)) {
    const results = proposal.results.map(parseResult);
    if (results.length === operations.length && results.every((result) => result !== null)) parsed.results = results as AgentChatOperationResult[];
  }
  return parsed;
}

const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/u;

function choiceLine(value: unknown, limit: number): string | null {
  if (!text(value)) return null;
  const line = value.trim();
  return line.length > 0 && line.length <= limit && !BREAKS.test(line) ? line : null;
}

const distinct = (labels: readonly string[]) => new Set(labels.map((label) => label.toLowerCase())).size === labels.length;

/** The quick replies or the one question of an answer, inside the stored shape and its bounds. Anything else is not drawn; the message keeps its text. */
export function parseChoices(value: unknown): AgentChatChoices | null {
  const choices = record(value);
  if (!choices) return null;
  const keys = Object.keys(choices);
  if (keys.length === 1 && Array.isArray(choices.replies)) {
    if (choices.replies.length < 1 || choices.replies.length > AGENT_CHAT_BOUNDS.replies) return null;
    const replies = choices.replies.map((reply) => choiceLine(reply, AGENT_CHAT_BOUNDS.replyLength));
    return replies.every((reply): reply is string => reply !== null) && distinct(replies) ? { replies } : null;
  }
  const question = keys.length === 2 ? choiceLine(choices.question, AGENT_CHAT_BOUNDS.questionLength) : null;
  if (!question || !Array.isArray(choices.options) || choices.options.length < AGENT_CHAT_BOUNDS.options.min || choices.options.length > AGENT_CHAT_BOUNDS.options.max) return null;
  const options = choices.options.map((entry) => {
    const option = record(entry);
    const label = option && Object.keys(option).length === 2 ? choiceLine(option.label, AGENT_CHAT_BOUNDS.optionLabelLength) : null;
    const detail = option ? choiceLine(option.detail, AGENT_CHAT_BOUNDS.optionDetailLength) : null;
    return label && detail ? { label, detail } : null;
  });
  return options.every((option) => option !== null) && distinct(options.map((option) => option!.label)) ? { question, options: options as { label: string; detail: string }[] } : null;
}

/** The effort of a record: only a known value. A record without one, an older record, reads as none. */
const effortOf = (value: unknown): { effort: TaskEffort } | Record<string, never> => ((TASK_EFFORTS as readonly string[]).includes(value as string) ? { effort: value as TaskEffort } : {});

const PROMPT_PARTS = ["instructions", "board", "taskLog", "conversation", "message", "other"] as const;
const wholeNumber = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** The milliseconds of each step of a turn's preparation: whole numbers inside their bounds, `total` there, no step longer than it, or nothing. */
function parsePrepare(value: unknown): AgentChatPrepare | null {
  const prepare = record(value);
  if (!prepare || !wholeNumber(prepare.total, AGENT_CHAT_BOUNDS.timingMs)) return null;
  const steps: readonly string[] = AGENT_CHAT_PREPARE_STEPS;
  if (!Object.keys(prepare).every((name) => steps.includes(name) && wholeNumber(prepare[name], prepare.total as number))) return null;
  return Object.fromEntries(AGENT_CHAT_PREPARE_STEPS.filter((name) => Object.hasOwn(prepare, name)).map((name) => [name, prepare[name]])) as AgentChatPrepare;
}

/** The effort routing of a turn: a fixed shape with whole milliseconds and fixed words, or nothing. A route outside the contract is left out. */
function parseRoute(value: unknown): AgentChatRoute | null {
  const route = record(value);
  if (!route) return null;
  const ms = route.ms;
  const timed = ms === undefined || wholeNumber(ms, AGENT_CHAT_BOUNDS.timingMs);
  if (route.by === "jev") return (route.effort === "low" || route.effort === "medium" || route.effort === "high") && wholeNumber(ms, AGENT_CHAT_BOUNDS.timingMs) ? { by: "jev", effort: route.effort, ms } : null;
  const effort = route.effort === null || (TASK_EFFORTS as readonly string[]).includes(route.effort as string) ? route.effort as TaskEffort | null : undefined;
  const phased = route.phase === undefined || (route.reason === "timeout" && (AGENT_CHAT_ROUTE_PHASES as readonly string[]).includes(route.phase as string));
  if (route.by !== "owner" || effort === undefined || !(AGENT_CHAT_ROUTE_REASONS as readonly string[]).includes(route.reason as string) || !timed || !phased) return null;
  return { by: "owner", effort, reason: route.reason as AgentChatRouteReason, ...(typeof ms === "number" ? { ms } : {}), ...(route.phase !== undefined ? { phase: route.phase as AgentChatRoutePhase } : {}) };
}

/** How long a turn took, how large its prompt was, and how long its preparation took: whole numbers inside their bounds, or nothing. A timing outside the contract is not drawn, and a preparation outside it is left out; the message keeps its text. */
export function parseTiming(value: unknown): AgentChatTiming | null {
  const timing = record(value);
  const prompt = record(timing?.prompt);
  const max = AGENT_CHAT_BOUNDS.timingMs;
  if (!timing || !prompt || !wholeNumber(timing.doneMs, max) || !(timing.eventMs === null || wholeNumber(timing.eventMs, max)) || !(timing.textMs === null || wholeNumber(timing.textMs, max))
    || !PROMPT_PARTS.every((part) => wholeNumber(prompt[part], 1_000_000))) return null;
  const prepare = parsePrepare(timing.prepare);
  const route = parseRoute(timing.route);
  return {
    eventMs: timing.eventMs as number | null, textMs: timing.textMs as number | null, doneMs: timing.doneMs,
    prompt: Object.fromEntries(PROMPT_PARTS.map((part) => [part, prompt[part]])) as AgentChatTiming["prompt"],
    ...(prepare ? { prepare } : {}),
    // Only `true` means a warm run answered; anything else reads as a run that started cold.
    ...(timing.warm === true ? { warm: true as const } : {}),
    ...(route ? { route } : {}),
  };
}

function parseMessage(value: unknown): AgentChatMessage | null {
  const message = record(value);
  if (!message || !text(message.id) || !text(message.text) || !text(message.at)) return null;
  if (message.role === "user") {
    // An image outside the contract is not drawn; the message keeps its text.
    const images = (Array.isArray(message.images) ? message.images : []).map(parseAgentChatImage).filter((image): image is AgentChatImage => image !== null);
    return { id: message.id, role: "user", text: message.text, at: message.at, ...(images.length > 0 ? { images } : {}) };
  }
  if (message.role !== "agent" || (message.provider !== "claude" && message.provider !== "codex") || !(AGENT_CHAT_TURN_STATUSES as readonly string[]).includes(message.status as string)) return null;
  const parsed: AgentChatAgentMessage = {
    id: message.id, role: "agent", text: message.text, at: message.at, provider: message.provider,
    model: text(message.model) ? message.model : null, ...effortOf(message.effort), status: message.status as AgentChatAgentMessage["status"],
  };
  const proposal = message.proposal === undefined ? null : parseProposal(message.proposal);
  if (proposal) parsed.proposal = proposal;
  if (message.proposalUnreadable === true || (message.proposal !== undefined && !proposal)) parsed.proposalUnreadable = true;
  // Choices belong to an answer with no proposal, and a grant follow-up line never carries any.
  const choices = parseChoices(message.choices);
  if (choices && !parsed.proposal && message.grantFollowUp !== true) parsed.choices = choices;
  if (text(message.followUp) && AGENT_CHAT_PROPOSAL_ID_PATTERN.test(message.followUp)) parsed.followUp = message.followUp;
  const timing = parseTiming(message.timing);
  if (timing) parsed.timing = timing;
  // A grant follow-up never offers a proposal: one that names one is not drawn as a follow-up.
  if (message.grantFollowUp === true && !parsed.proposal && !parsed.proposalUnreadable && parsed.followUp === undefined) parsed.grantFollowUp = true;
  return parsed;
}

function parseConversation(value: unknown): AgentChatConversation | null {
  const conversation = record(value);
  if (!conversation || !text(conversation.id) || !AGENT_CHAT_CONVERSATION_ID_PATTERN.test(conversation.id) || !text(conversation.title)
    || (conversation.provider !== "claude" && conversation.provider !== "codex") || !text(conversation.createdAt) || !text(conversation.updatedAt) || !Array.isArray(conversation.messages)) return null;
  const messages = conversation.messages.map(parseMessage);
  if (messages.some((message) => message === null)) return null;
  return {
    id: conversation.id, title: conversation.title, provider: conversation.provider, model: text(conversation.model) ? conversation.model : null, ...effortOf(conversation.effort),
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, messages: messages as AgentChatMessage[],
  };
}

function parseTurn(value: unknown): AgentChatTurn | null {
  const turn = record(value);
  if (!turn || !text(turn.conversationId) || !text(turn.startedAt) || !text(turn.text) || (turn.provider !== "claude" && turn.provider !== "codex")) return null;
  const activity = (AGENT_CHAT_ACTIVITIES as readonly string[]).includes(turn.activity as string) ? turn.activity as AgentChatActivity : "thinking";
  return { conversationId: turn.conversationId, startedAt: turn.startedAt, provider: turn.provider, model: text(turn.model) ? turn.model : null, ...effortOf(turn.effort), activity, text: turn.text };
}

export async function listAgentChats(repositoryId: string): Promise<AgentChatListResult> {
  const answer = await request("list", { repositoryId });
  if (answer?.ok !== true || !Array.isArray(answer.conversations)) return answer ? failure(answer) : UNAVAILABLE;
  const conversations: AgentChatConversationSummary[] = [];
  for (const entry of answer.conversations) {
    const row = record(entry);
    if (row && text(row.id) && AGENT_CHAT_CONVERSATION_ID_PATTERN.test(row.id) && text(row.title) && text(row.updatedAt) && typeof row.messages === "number") {
      conversations.push({ id: row.id, title: row.title, updatedAt: row.updatedAt, messages: row.messages });
    }
  }
  return { ok: true, conversations, running: text(answer.running) ? answer.running : null, ...(text(answer.summarizedAt) ? { summarizedAt: answer.summarizedAt } : {}) };
}

export async function readAgentChat(repositoryId: string, conversationId: string): Promise<AgentChatReadResult> {
  const answer = await request("read", { repositoryId, conversationId });
  const conversation = answer?.ok === true ? parseConversation(answer.conversation) : null;
  if (!conversation) return answer?.ok === false ? failure(answer) : UNAVAILABLE;
  return { ok: true, conversation, turn: answer!.turn === null || answer!.turn === undefined ? null : parseTurn(answer!.turn) };
}

function parseRun(value: unknown): AgentChatThreadRun | null {
  const run = record(value);
  return run && (run.provider === "claude" || run.provider === "codex") ? { provider: run.provider, model: text(run.model) ? run.model : null, ...effortOf(run.effort) } : null;
}

/** Where the thread was summarized for Aril: a position and a time, never text. Anything else reads as no summary. */
function parseSummarized(value: unknown): AgentChatThreadSummary | null {
  const summary = record(value);
  const through = record(summary?.through);
  return summary && through && text(through.conversationId) && AGENT_CHAT_CONVERSATION_ID_PATTERN.test(through.conversationId) && text(through.messageId)
    && AGENT_CHAT_MESSAGE_ID_PATTERN.test(through.messageId) && text(through.at) && text(summary.at)
    ? { through: { conversationId: through.conversationId, messageId: through.messageId, at: through.at }, at: summary.at } : null;
}

/** A message of the thread: a stored message with the conversation it is in. One outside the contract is not drawn. */
function parseThreadMessage(value: unknown): AgentChatThreadMessage | null {
  const stored = record(value);
  const message = parseMessage(value);
  return stored && message && text(stored.conversationId) && AGENT_CHAT_CONVERSATION_ID_PATTERN.test(stored.conversationId) ? { ...message, conversationId: stored.conversationId } : null;
}

/** The newest page of a repository's thread, or the page before a cursor. */
export async function threadAgentChat(repositoryId: string, before: string | null = null): Promise<AgentChatThreadResult> {
  const answer = await request("thread", { repositoryId, ...(before === null ? {} : { before }) });
  if (answer?.ok !== true || !Array.isArray(answer.messages)) return answer ? failure(answer) : UNAVAILABLE;
  return {
    ok: true,
    messages: answer.messages.map(parseThreadMessage).filter((message): message is AgentChatThreadMessage => message !== null),
    before: text(answer.before) && answer.before.length <= AGENT_CHAT_BOUNDS.cursorLength ? answer.before : null,
    turn: answer.turn === null || answer.turn === undefined ? null : parseTurn(answer.turn),
    sendTo: text(answer.sendTo) && AGENT_CHAT_CONVERSATION_ID_PATTERN.test(answer.sendTo) ? answer.sendTo : null,
    run: answer.run === null || answer.run === undefined ? null : parseRun(answer.run),
    updatedAt: text(answer.updatedAt) ? answer.updatedAt : null,
    summarized: parseSummarized(answer.summarized),
  };
}

/** The newest messages of the thread whose text holds the query, as plain excerpts. */
export async function searchAgentChat(repositoryId: string, query: string): Promise<AgentChatSearchResult> {
  const answer = await request("search", { repositoryId, query });
  if (answer?.ok !== true || !Array.isArray(answer.matches)) return answer ? failure(answer) : UNAVAILABLE;
  const matches: AgentChatSearchMatch[] = [];
  for (const entry of answer.matches) {
    const match = record(entry);
    if (match && text(match.conversationId) && AGENT_CHAT_CONVERSATION_ID_PATTERN.test(match.conversationId) && text(match.messageId) && AGENT_CHAT_MESSAGE_ID_PATTERN.test(match.messageId)
      && text(match.at) && (match.role === "user" || match.role === "agent") && text(match.snippet)) {
      matches.push({ conversationId: match.conversationId, messageId: match.messageId, at: match.at, role: match.role, snippet: match.snippet });
    }
  }
  return { ok: true, matches };
}

export async function sendAgentChat(repositoryId: string, conversationId: string | null, message: string, provider: AgentChatProvider, model: string | null, effort: TaskEffort | null, images: readonly string[] = []): Promise<AgentChatSendResult> {
  const answer = await request("send", { repositoryId, conversationId, text: message, provider, model, effort, ...(images.length > 0 ? { images: [...images] } : {}) });
  return answer?.ok === true && text(answer.conversationId) && AGENT_CHAT_CONVERSATION_ID_PATTERN.test(answer.conversationId) ? { ok: true, conversationId: answer.conversationId } : failure(answer);
}

async function done(operation: AgentChatOperationName, payload: Json): Promise<AgentChatDoneResult> {
  const answer = await request(operation, payload);
  return answer?.ok === true ? { ok: true } : failure(answer);
}

export const stopAgentChat = (repositoryId: string, conversationId: string) => done("stop", { repositoryId, conversationId });
/** Asks the desktop to keep a provider run ready for the thread's next message, with the run the composer shows. No model is called, and the answer is not read. */
export const warmAgentChat = (repositoryId: string, provider: AgentChatProvider, model: string | null, effort: TaskEffort | null) => done("warm", { repositoryId, provider, model, effort });
export const applyAgentChatProposal = (repositoryId: string, conversationId: string, proposalId: string) => done("apply", { repositoryId, conversationId, proposalId });
export const dismissAgentChatProposal = (repositoryId: string, conversationId: string, proposalId: string) => done("dismiss", { repositoryId, conversationId, proposalId });

/** The thread as far as it is loaded: the messages in time order, and the cursor of the page before the first one. */
export type LoadedThread = { messages: readonly AgentChatThreadMessage[]; before: string | null };
const EMPTY_THREAD: LoadedThread = { messages: [], before: null };

/** Messages of different conversations share their IDs (`m-1`), so a message is known by both. */
export const threadMessageKey = (message: { conversationId: string; id: string }) => `${message.conversationId}/${message.id}`;

/**
 * The newest page laid over what is loaded: everything before the first loaded message that the page holds stays, and the page
 * replaces the rest. A page that touches nothing loaded (the first read, or a thread that moved on by more than a page) replaces it.
 */
export function mergeNewest(loaded: LoadedThread, page: LoadedThread): LoadedThread {
  const keys = new Set(page.messages.map(threadMessageKey));
  const at = loaded.messages.findIndex((message) => keys.has(threadMessageKey(message)));
  return at < 0 ? { messages: page.messages, before: page.before } : { messages: [...loaded.messages.slice(0, at), ...page.messages], before: loaded.before };
}

/** A conversation read again after a proposal was answered: its loaded messages are replaced where they stand. */
function replaceConversation(loaded: LoadedThread, conversation: AgentChatConversation): LoadedThread {
  const latest = new Map(conversation.messages.map((message) => [message.id, message]));
  return { ...loaded, messages: loaded.messages.map((message) => { const next = message.conversationId === conversation.id ? latest.get(message.id) : undefined; return next ? { ...next, conversationId: conversation.id } : message; }) };
}

export type AgentChatView = {
  /** False until the first read of this repository's thread has answered. */
  ready: boolean;
  /** The loaded part of the thread, oldest first. */
  messages: readonly AgentChatThreadMessage[];
  /** More messages exist before the first one loaded. */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** The answer being written, in whichever conversation it runs. */
  turn: AgentChatTurn | null;
  /** What the thread last ran with, for the composer to start from. */
  run: AgentChatThreadRun | null;
  /** Where the thread was summarized for Aril, or null: the panel draws one quiet line there. */
  summarized: AgentChatThreadSummary | null;
  /** The owner's message that was sent and is not in the stored thread yet. */
  pendingMessage: string | null;
  /** The images of that message. */
  pendingImages: readonly AgentChatImage[];
  /** The proposal whose Apply or Dismiss is in flight. */
  resolving: string | null;
  /** Why the last operation was refused; cleared by the next one. */
  error: AgentChatError | null;
  send(message: string, provider: AgentChatProvider, model: string | null, effort: TaskEffort | null, images?: readonly AgentChatImage[]): Promise<boolean>;
  stop(): void;
  /** Asks the desktop to keep a provider run ready for the next message, with the run the composer shows. No model is called; the answer is not read. */
  warm(provider: AgentChatProvider, model: string | null, effort: TaskEffort | null): void;
  /** Answers true when the proposal ran, whole or in part, so the caller can read the board again. */
  apply(conversationId: string, proposalId: string): Promise<boolean>;
  dismiss(conversationId: string, proposalId: string): Promise<void>;
  /** Loads the page before the first loaded message. Answers true when messages were added. */
  loadOlder(): Promise<boolean>;
  /** Loads older pages, a bounded number, until the message is loaded. Answers whether it is. */
  reveal(conversationId: string, messageId: string): Promise<boolean>;
};

/**
 * The chat of one repository while its panel is open: one thread, whatever conversations it is saved in. `active` false stops every
 * request, so a closed or minimized panel asks nothing. While an answer is being written the newest page is read every poll interval;
 * otherwise the conversation list is asked at the idle pace, and the thread is read again only when something changed, so a turn
 * started from another device is followed as this panel's own. The caller mounts one instance per repository (a `key`), so no
 * message of one repository is ever shown under another.
 */
export function useAgentChat(repositoryId: string | null, active: boolean, availability: AgentChatAvailability): AgentChatView {
  const [ready, setReady] = useState(false);
  const [thread, setThread] = useState<LoadedThread>(EMPTY_THREAD);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [turn, setTurn] = useState<AgentChatTurn | null>(null);
  const [run, setRun] = useState<AgentChatThreadRun | null>(null);
  const [summarized, setSummarized] = useState<AgentChatThreadSummary | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<readonly AgentChatImage[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<AgentChatError | null>(null);
  const loaded = useRef<LoadedThread>(EMPTY_THREAD);
  // The time of the last update the loaded thread was read at, so the idle list can tell that something changed.
  const revision = useRef<string | null>(null);
  // The time the summary was written at when the thread was read, so the idle list can tell that a compaction finished.
  const summaryRevision = useRef<string | null>(null);
  const generation = useRef(0);
  const requests = useRef(0);
  // Once a message is accepted, the first read that starts after it holds the stored message and replaces the pending one.
  const accepted = useRef(Number.POSITIVE_INFINITY);
  const paging = useRef<Promise<boolean> | null>(null);
  const usable = active && repositoryId !== null && (availability === "desktop" || availability === "paired");
  const pollMs = availability === "paired" ? PAIRED_POLL_MS : DESKTOP_POLL_MS;
  const fast = turn !== null || pendingMessage !== null;

  // An answer that arrives after the panel left is dropped.
  useEffect(() => () => { generation.current += 1; }, []);

  const commit = useCallback((next: LoadedThread) => { loaded.current = next; setThread(next); }, []);

  // Reads the newest page. A read that a newer one overtook is dropped, so an old answer never replaces a newer one.
  const refresh = useCallback(async () => {
    if (repositoryId === null) return;
    const at = generation.current;
    const sequence = (requests.current += 1);
    const answer = await threadAgentChat(repositoryId);
    if (at !== generation.current || sequence !== requests.current) return;
    setReady(true);
    if (!answer.ok) { setError(answer.error); return; }
    commit(mergeNewest(loaded.current, answer));
    revision.current = answer.updatedAt;
    summaryRevision.current = answer.summarized?.at ?? null;
    setTurn(answer.turn);
    setRun(answer.run);
    setSummarized(answer.summarized);
    if (sequence > accepted.current) { accepted.current = Number.POSITIVE_INFINITY; setPendingMessage(null); }
  }, [repositoryId, commit]);

  // Reads the thread when the panel opens, and keeps reading it while an answer is being written.
  useEffect(() => {
    if (!usable) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      await refresh();
      if (fast && !cancelled) timer = window.setTimeout(() => { timer = null; void tick(); }, pollMs);
    };
    void tick();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [usable, fast, pollMs, refresh]);

  // While no answer is being written, asks the list at the idle pace. A turn that another device started, or a newer stored
  // change, reads the thread again.
  const idle = usable && !fast;
  useEffect(() => {
    if (!idle || repositoryId === null) return;
    const at = generation.current;
    let cancelled = false;
    let timer: number | null = null;
    const schedule = () => { timer = window.setTimeout(() => { timer = null; void poll(); }, IDLE_POLL_MS); };
    const poll = async () => {
      const answer = await listAgentChats(repositoryId);
      if (cancelled || at !== generation.current) return;
      if (!answer.ok) setError(answer.error);
      else if (answer.running !== null || (answer.conversations[0]?.updatedAt ?? null) !== revision.current || (answer.summarizedAt ?? null) !== summaryRevision.current) await refresh();
      if (!cancelled) schedule();
    };
    schedule();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [idle, repositoryId, refresh]);

  const loadOlder = useCallback((): Promise<boolean> => {
    const cursor = loaded.current.before;
    if (repositoryId === null || cursor === null) return Promise.resolve(false);
    if (paging.current) return paging.current;
    const at = generation.current;
    setLoadingOlder(true);
    const page = (async () => {
      const answer = await threadAgentChat(repositoryId, cursor);
      if (at !== generation.current) return false;
      setLoadingOlder(false);
      if (!answer.ok) { setError(answer.error); return false; }
      // The thread was read again from its newest page meanwhile: this cursor is not the first loaded message's any more.
      if (loaded.current.before !== cursor) return false;
      const known = new Set(loaded.current.messages.map(threadMessageKey));
      commit({ messages: [...answer.messages.filter((message) => !known.has(threadMessageKey(message))), ...loaded.current.messages], before: answer.before });
      return true;
    })().finally(() => { paging.current = null; });
    paging.current = page;
    return page;
  }, [repositoryId, commit]);

  const reveal = useCallback(async (conversationId: string, messageId: string) => {
    const present = () => loaded.current.messages.some((message) => message.conversationId === conversationId && message.id === messageId);
    for (let pages = 0; !present() && pages < REVEAL_PAGES; pages += 1) if (!await loadOlder()) break;
    return present();
  }, [loadOlder]);

  const send = useCallback(async (message: string, provider: AgentChatProvider, model: string | null, effort: TaskEffort | null, images: readonly AgentChatImage[] = []) => {
    if (repositoryId === null) return false;
    const at = generation.current;
    setError(null);
    setPendingMessage(message);
    setPendingImages(images);
    accepted.current = Number.POSITIVE_INFINITY;
    // The desktop chooses the conversation: the thread's current one, or a new one when it is full.
    const answer = await sendAgentChat(repositoryId, null, message, provider, model, effort, images.map((image) => image.id));
    if (at !== generation.current) return false;
    if (!answer.ok) { setPendingMessage(null); setError(answer.error); return false; }
    accepted.current = requests.current;
    void refresh();
    return true;
  }, [repositoryId, refresh]);

  const stop = useCallback(() => {
    if (repositoryId !== null && turn !== null) void stopAgentChat(repositoryId, turn.conversationId);
  }, [repositoryId, turn]);

  const warm = useCallback((provider: AgentChatProvider, model: string | null, effort: TaskEffort | null) => {
    if (repositoryId !== null && usable) void warmAgentChat(repositoryId, provider, model, effort);
  }, [repositoryId, usable]);

  const resolve = useCallback(async (conversationId: string, proposalId: string, approve: boolean) => {
    if (repositoryId === null) return false;
    const at = generation.current;
    setError(null);
    setResolving(proposalId);
    const answer = await (approve ? applyAgentChatProposal : dismissAgentChatProposal)(repositoryId, conversationId, proposalId);
    const latest = await readAgentChat(repositoryId, conversationId);
    if (at !== generation.current) return false;
    // The proposal may sit above the newest page, so its conversation is replaced where it stands. The desktop asks Aril for a
    // follow-up once the outcome is stored; it is a turn like any other, so the newest page is read, and then read until it ends.
    if (latest.ok) commit(replaceConversation(loaded.current, latest.conversation));
    await refresh();
    if (at !== generation.current) return false;
    if (!answer.ok) setError(answer.error);
    setResolving(null);
    return answer.ok;
  }, [repositoryId, commit, refresh]);

  const apply = useCallback((conversationId: string, proposalId: string) => resolve(conversationId, proposalId, true), [resolve]);
  const dismiss = useCallback(async (conversationId: string, proposalId: string) => { await resolve(conversationId, proposalId, false); }, [resolve]);

  return {
    ready, messages: thread.messages, hasOlder: thread.before !== null, loadingOlder, turn, run, summarized,
    pendingMessage, pendingImages: pendingMessage === null ? NO_IMAGES : pendingImages, resolving, error, send, stop, warm, apply, dismiss, loadOlder, reveal,
  };
}
