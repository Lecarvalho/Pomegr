"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AGENT_CHAT_ACTIVITIES, AGENT_CHAT_BOARD_OPERATIONS, AGENT_CHAT_CONVERSATION_ID_PATTERN, AGENT_CHAT_ERRORS, AGENT_CHAT_PROPOSAL_ID_PATTERN,
  AGENT_CHAT_PROPOSAL_STATES, AGENT_CHAT_TURN_STATUSES,
  type AgentChatActivity, type AgentChatAgentMessage, type AgentChatBoardOperation, type AgentChatConversation, type AgentChatConversationSummary,
  type AgentChatDoneResult, type AgentChatError, type AgentChatListResult, type AgentChatMessage, type AgentChatOperationName, type AgentChatOperationResult,
  type AgentChatProposal, type AgentChatProvider, type AgentChatReadResult, type AgentChatSendResult, type AgentChatTurn,
} from "../shared/agent-chat-contract";
import { useClientAccess } from "./hooks/ClientAccessContext";

// Client of the Pomegr agent chat. The desktop app owns the chat: this module only asks it, through the desktop
// bridge in the app window or through the paired-device route on a phone. Nothing is kept in browser storage.

const DESKTOP_POLL_MS = 500;
const PAIRED_POLL_MS = 1_000;
const PAIRED_PATH = "/api/agent-chat";

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
  const taskId = text(result.taskId) ? { taskId: result.taskId } : {};
  if (result.ok) return { ok: true, ...taskId };
  return text(result.error) ? { ok: false, error: result.error as Extract<AgentChatOperationResult, { ok: false }>["error"], ...taskId } : null;
}

function parseProposal(value: unknown): AgentChatProposal | null {
  const proposal = record(value);
  if (!proposal || !text(proposal.id) || !AGENT_CHAT_PROPOSAL_ID_PATTERN.test(proposal.id) || !text(proposal.summary) || !Array.isArray(proposal.operations)
    || !(AGENT_CHAT_PROPOSAL_STATES as readonly string[]).includes(proposal.state as string)) return null;
  const operations = proposal.operations.filter((entry): entry is AgentChatBoardOperation => {
    const operation = record(entry);
    return Boolean(operation) && (AGENT_CHAT_BOARD_OPERATIONS as readonly string[]).includes(operation!.op as string);
  });
  if (operations.length !== proposal.operations.length) return null;
  const parsed: AgentChatProposal = { id: proposal.id, summary: proposal.summary, operations, state: proposal.state as AgentChatProposal["state"] };
  if (Array.isArray(proposal.results)) {
    const results = proposal.results.map(parseResult);
    if (results.length === operations.length && results.every((result) => result !== null)) parsed.results = results as AgentChatOperationResult[];
  }
  return parsed;
}

function parseMessage(value: unknown): AgentChatMessage | null {
  const message = record(value);
  if (!message || !text(message.id) || !text(message.text) || !text(message.at)) return null;
  if (message.role === "user") return { id: message.id, role: "user", text: message.text, at: message.at };
  if (message.role !== "agent" || (message.provider !== "claude" && message.provider !== "codex") || !(AGENT_CHAT_TURN_STATUSES as readonly string[]).includes(message.status as string)) return null;
  const parsed: AgentChatAgentMessage = {
    id: message.id, role: "agent", text: message.text, at: message.at, provider: message.provider,
    model: text(message.model) ? message.model : null, status: message.status as AgentChatAgentMessage["status"],
  };
  const proposal = message.proposal === undefined ? null : parseProposal(message.proposal);
  if (proposal) parsed.proposal = proposal;
  if (message.proposalUnreadable === true || (message.proposal !== undefined && !proposal)) parsed.proposalUnreadable = true;
  return parsed;
}

function parseConversation(value: unknown): AgentChatConversation | null {
  const conversation = record(value);
  if (!conversation || !text(conversation.id) || !AGENT_CHAT_CONVERSATION_ID_PATTERN.test(conversation.id) || !text(conversation.title)
    || (conversation.provider !== "claude" && conversation.provider !== "codex") || !text(conversation.createdAt) || !text(conversation.updatedAt) || !Array.isArray(conversation.messages)) return null;
  const messages = conversation.messages.map(parseMessage);
  if (messages.some((message) => message === null)) return null;
  return {
    id: conversation.id, title: conversation.title, provider: conversation.provider, model: text(conversation.model) ? conversation.model : null,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, messages: messages as AgentChatMessage[],
  };
}

function parseTurn(value: unknown): AgentChatTurn | null {
  const turn = record(value);
  if (!turn || !text(turn.conversationId) || !text(turn.startedAt) || !text(turn.text) || (turn.provider !== "claude" && turn.provider !== "codex")) return null;
  const activity = (AGENT_CHAT_ACTIVITIES as readonly string[]).includes(turn.activity as string) ? turn.activity as AgentChatActivity : "thinking";
  return { conversationId: turn.conversationId, startedAt: turn.startedAt, provider: turn.provider, model: text(turn.model) ? turn.model : null, activity, text: turn.text };
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
  return { ok: true, conversations, running: text(answer.running) ? answer.running : null };
}

export async function readAgentChat(repositoryId: string, conversationId: string): Promise<AgentChatReadResult> {
  const answer = await request("read", { repositoryId, conversationId });
  const conversation = answer?.ok === true ? parseConversation(answer.conversation) : null;
  if (!conversation) return answer?.ok === false ? failure(answer) : UNAVAILABLE;
  return { ok: true, conversation, turn: answer!.turn === null || answer!.turn === undefined ? null : parseTurn(answer!.turn) };
}

export async function sendAgentChat(repositoryId: string, conversationId: string | null, message: string, provider: AgentChatProvider, model: string | null): Promise<AgentChatSendResult> {
  const answer = await request("send", { repositoryId, conversationId, text: message, provider, model });
  return answer?.ok === true && text(answer.conversationId) && AGENT_CHAT_CONVERSATION_ID_PATTERN.test(answer.conversationId) ? { ok: true, conversationId: answer.conversationId } : failure(answer);
}

async function done(operation: AgentChatOperationName, payload: Json): Promise<AgentChatDoneResult> {
  const answer = await request(operation, payload);
  return answer?.ok === true ? { ok: true } : failure(answer);
}

export const stopAgentChat = (repositoryId: string, conversationId: string) => done("stop", { repositoryId, conversationId });
export const deleteAgentChat = (repositoryId: string, conversationId: string) => done("delete", { repositoryId, conversationId });
export const applyAgentChatProposal = (repositoryId: string, conversationId: string, proposalId: string) => done("apply", { repositoryId, conversationId, proposalId });
export const dismissAgentChatProposal = (repositoryId: string, conversationId: string, proposalId: string) => done("dismiss", { repositoryId, conversationId, proposalId });

export type AgentChatView = {
  /** False until the first list of this repository has answered. */
  ready: boolean;
  conversations: AgentChatConversationSummary[];
  /** The open conversation, or null for a new one. */
  conversation: AgentChatConversation | null;
  /** The conversation being opened, or null for a new one. It is set before `conversation` has been read. */
  openId: string | null;
  /** The conversation of this repository whose answer is being written, or null. */
  runningId: string | null;
  /** The answer being written in the open conversation. */
  turn: AgentChatTurn | null;
  /** The owner's message that was sent and is not in the stored conversation yet. */
  pendingMessage: string | null;
  /** A turn runs in another conversation of this repository, so Send would answer busy. */
  runningElsewhere: boolean;
  /** The proposal whose Apply or Dismiss is in flight. */
  resolving: string | null;
  /** Why the last operation was refused; cleared by the next one. */
  error: AgentChatError | null;
  open(conversationId: string | null): void;
  send(message: string, provider: AgentChatProvider, model: string | null): Promise<boolean>;
  stop(): void;
  /** Answers true when the proposal ran, whole or in part, so the caller can read the board again. */
  apply(proposalId: string): Promise<boolean>;
  dismiss(proposalId: string): Promise<void>;
  remove(conversationId: string): Promise<void>;
};

/**
 * The chat of one repository while its panel is open. `active` false stops every request, so a closed or minimized
 * panel asks nothing. Polls only while an answer is being written. The caller mounts one instance per repository
 * (a `key`), so no conversation of one repository is ever shown under another.
 */
export function useAgentChat(repositoryId: string | null, active: boolean, availability: AgentChatAvailability): AgentChatView {
  const [ready, setReady] = useState(false);
  const [conversations, setConversations] = useState<AgentChatConversationSummary[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<AgentChatConversation | null>(null);
  const [turn, setTurn] = useState<AgentChatTurn | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<AgentChatError | null>(null);
  const generation = useRef(0);
  const chosen = useRef(false);
  const usable = active && repositoryId !== null && (availability === "desktop" || availability === "paired");
  const pollMs = availability === "paired" ? PAIRED_POLL_MS : DESKTOP_POLL_MS;

  // An answer that arrives after the panel left is dropped.
  useEffect(() => () => { generation.current += 1; }, []);

  const applyList = useCallback((answer: AgentChatListResult, at: number) => {
    if (at !== generation.current) return;
    if (answer.ok) {
      setConversations(answer.conversations);
      setRunning(answer.running);
      // The panel opens on the conversation being answered, else on the newest one.
      if (!chosen.current) { chosen.current = true; setOpenId(answer.running ?? answer.conversations[0]?.id ?? null); }
    } else setError(answer.error);
    setReady(true);
  }, []);

  const refreshList = useCallback(async () => {
    if (repositoryId === null) return;
    const at = generation.current;
    applyList(await listAgentChats(repositoryId), at);
  }, [repositoryId, applyList]);

  useEffect(() => {
    if (!usable || repositoryId === null) return;
    const at = generation.current;
    void listAgentChats(repositoryId).then((answer) => applyList(answer, at));
  }, [usable, repositoryId, applyList]);

  // Reads the open conversation, and keeps reading while its answer is being written.
  useEffect(() => {
    if (!usable || repositoryId === null || openId === null) return;
    const at = generation.current;
    let cancelled = false;
    let timer: number | null = null;
    const read = async () => {
      const answer = await readAgentChat(repositoryId, openId);
      if (cancelled || at !== generation.current) return;
      if (!answer.ok) {
        if (answer.error === "not_found") { setOpenId(null); setConversation(null); setTurn(null); void refreshList(); } else setError(answer.error);
        return;
      }
      setConversation(answer.conversation);
      setTurn(answer.turn);
      // The stored conversation now holds the message that was sent.
      setPendingMessage(null);
      if (answer.turn) timer = window.setTimeout(() => { timer = null; void read(); }, pollMs);
      else { setRunning((current) => (current === openId ? null : current)); void refreshList(); }
    };
    void read();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [usable, repositoryId, openId, pollMs, running, refreshList]);

  const open = useCallback((conversationId: string | null) => {
    chosen.current = true;
    setError(null); setPendingMessage(null); setTurn(null);
    setConversation((current) => (current?.id === conversationId ? current : null));
    setOpenId(conversationId);
  }, []);

  const send = useCallback(async (message: string, provider: AgentChatProvider, model: string | null) => {
    if (repositoryId === null) return false;
    const at = generation.current;
    setError(null);
    setPendingMessage(message);
    const answer = await sendAgentChat(repositoryId, openId, message, provider, model);
    if (at !== generation.current) return false;
    if (!answer.ok) { setPendingMessage(null); setError(answer.error); return false; }
    chosen.current = true;
    setOpenId(answer.conversationId);
    setRunning(answer.conversationId);
    return true;
  }, [repositoryId, openId]);

  const stop = useCallback(() => {
    if (repositoryId !== null && openId !== null) void stopAgentChat(repositoryId, openId);
  }, [repositoryId, openId]);

  const resolve = useCallback(async (proposalId: string, approve: boolean) => {
    if (repositoryId === null || openId === null) return false;
    const at = generation.current;
    setError(null);
    setResolving(proposalId);
    const answer = await (approve ? applyAgentChatProposal : dismissAgentChatProposal)(repositoryId, openId, proposalId);
    const latest = await readAgentChat(repositoryId, openId);
    if (at !== generation.current) return false;
    if (latest.ok) setConversation(latest.conversation);
    if (!answer.ok) setError(answer.error);
    setResolving(null);
    return answer.ok;
  }, [repositoryId, openId]);

  const apply = useCallback((proposalId: string) => resolve(proposalId, true), [resolve]);
  const dismiss = useCallback(async (proposalId: string) => { await resolve(proposalId, false); }, [resolve]);

  const remove = useCallback(async (conversationId: string) => {
    if (repositoryId === null) return;
    const at = generation.current;
    setError(null);
    const answer = await deleteAgentChat(repositoryId, conversationId);
    if (at !== generation.current) return;
    if (!answer.ok) { setError(answer.error); return; }
    if (conversationId === openId) { setOpenId(null); setConversation(null); setTurn(null); }
    await refreshList();
  }, [repositoryId, openId, refreshList]);

  return {
    ready, conversations, conversation: conversation?.id === openId ? conversation : null, openId, runningId: running,
    turn: turn?.conversationId === openId ? turn : null,
    pendingMessage, runningElsewhere: running !== null && running !== openId, resolving, error, open, send, stop, apply, dismiss, remove,
  };
}
