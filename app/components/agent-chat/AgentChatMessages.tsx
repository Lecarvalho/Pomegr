"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AgentChatAgentMessage, AgentChatConversation, AgentChatImage, AgentChatTurn } from "../../../shared/agent-chat-contract";
import type { Task } from "../../../shared/task-contract";
import { AgentChatImageStrip } from "./AgentChatImages";
import type { AgentChatImageUrls } from "./agent-chat-images";
import { SafeMarkdown } from "../markdown/SafeMarkdown";
import { AgentChatProposalCard } from "./AgentChatProposalCard";
import { ACTIVITY_LABELS, STATUS_NOTES, SUGGESTIONS, UNREADABLE_PROPOSAL, agentCaption, pendingIsStored } from "./agent-chat-presentation";

type BoardTask = Pick<Task, "id" | "text">;

const PINNED_WITHIN = 24;
const NO_URLS: AgentChatImageUrls = new Map();
const NO_IMAGES: readonly AgentChatImage[] = [];

function OwnerMessage({ text, images, urls }: { text: string; images: readonly AgentChatImage[]; urls: AgentChatImageUrls }) {
  return <article className="agentChatMessage isOwner" aria-label="You">
    <p>{text}</p>
    <AgentChatImageStrip imageIds={images.map((image) => image.id)} urls={urls} label="Images you sent" />
  </article>;
}

export type AgentChatLogState = "loading" | "empty" | "ready";

function AgentHead({ caption }: { caption: string | null }) {
  return <p className="agentChatMessageHead"><span className="agentChatMessageName">Aril</span>{caption && <span className="agentChatMessageCaption">{caption}</span>}</p>;
}

function AgentMessage({ message, tasks, imageUrls, resolving, startHere, heldStart, onApply, onDismiss }: {
  message: AgentChatAgentMessage;
  tasks: readonly BoardTask[];
  imageUrls: AgentChatImageUrls;
  resolving: string | null;
  startHere: boolean;
  heldStart?(taskId: string): string | null;
  onApply(proposalId: string): void;
  onDismiss(proposalId: string): void;
}) {
  return <article className="agentChatMessage isAgent" aria-label="Aril" data-message-id={message.id}>
    <AgentHead caption={agentCaption(message)} />
    {message.text !== "" && <SafeMarkdown text={message.text} />}
    {message.status !== "complete" && <p className="agentChatMessageNote">{STATUS_NOTES[message.status]}</p>}
    {message.proposal && <AgentChatProposalCard proposal={message.proposal} tasks={tasks} imageUrls={imageUrls} busy={resolving === message.proposal.id} startHere={startHere} heldStart={heldStart} onApply={onApply} onDismiss={onDismiss} />}
    {message.proposalUnreadable && <p className="taskNotice warning agentChatNotice">{UNREADABLE_PROPOSAL}</p>}
  </article>;
}

function Empty({ onSuggest }: { onSuggest(text: string): void }) {
  return <div className="agentChatEmpty">
    <h3 className="agentChatEmptyTitle">Ask Aril about this board</h3>
    <p className="agentChatEmptyText">Aril reads this repository&apos;s task board and Pomegr&apos;s session evidence, and proposes board changes that you apply.</p>
    <div className="agentChatSuggestions">
      {SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" className="commandSecondaryAction agentChatSuggestion" onClick={() => onSuggest(suggestion)}>{suggestion}</button>)}
    </div>
    <p className="agentChatEmptyNote">Aril can be wrong. Check a proposal before you apply it.</p>
  </div>;
}

/**
 * The conversation with Aril. It follows the newest line only while the owner is at the bottom; once they scroll up
 * it stays where they are and offers Jump to latest. The partial answer is not a live region of its own: the log
 * announces each stored message, and the activity line is a status.
 */
export function AgentChatMessages({ state, conversation, turn, pendingMessage, pendingImages = NO_IMAGES, imageUrls = NO_URLS, tasks, resolving, pinSignal = 0, focusMessageId = null, startHere = false, heldStart, onSuggest, onApply, onDismiss }: {
  state: AgentChatLogState;
  conversation: AgentChatConversation | null;
  turn: AgentChatTurn | null;
  pendingMessage: string | null;
  /** The images of the message that was sent and is not stored yet. */
  pendingImages?: readonly AgentChatImage[];
  /** The object URL of each image that has arrived. */
  imageUrls?: AgentChatImageUrls;
  tasks: readonly BoardTask[];
  resolving: string | null;
  /** Changing it brings the newest line back into view, as when the owner sends a message. */
  pinSignal?: number;
  /** A follow-up that a notification opened: brought into view once it is drawn. */
  focusMessageId?: string | null;
  /** True in the desktop window, where a proposed session start can be applied. */
  startHere?: boolean;
  /** The gates that hold a task's start now, as one line from the board's readings. */
  heldStart?(taskId: string): string | null;
  onSuggest(text: string): void;
  onApply(proposalId: string): void;
  onDismiss(proposalId: string): void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const messages = conversation?.messages ?? [];
  const showPending = pendingMessage !== null && !pendingIsStored(messages, pendingMessage);
  const running = turn !== null || pendingMessage !== null;
  const conversationId = conversation?.id ?? null;

  const toBottom = useCallback(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
    pinned.current = true;
  }, []);

  // A newly opened conversation, and a message the owner just sent, start at the newest line; the scroll event clears Jump to latest.
  useLayoutEffect(() => { toBottom(); }, [conversationId, pinSignal, toBottom]);
  useLayoutEffect(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  });

  // A follow-up that a notification opened comes into view once, after the conversation starts at its newest line.
  const focused = useRef<string | null>(null);
  const focusShown = messages.some((message) => message.id === focusMessageId);
  useLayoutEffect(() => {
    if (focusMessageId === null) { focused.current = null; return; }
    const element = log.current;
    if (!focusShown || !element || focused.current === `${conversationId}/${focusMessageId}`) return;
    focused.current = `${conversationId}/${focusMessageId}`;
    element.querySelector<HTMLElement>(`[data-message-id="${focusMessageId}"]`)?.scrollIntoView?.({ block: "nearest" });
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_WITHIN;
  }, [conversationId, focusMessageId, focusShown]);

  const onScroll = () => {
    const element = log.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_WITHIN;
    pinned.current = atBottom;
    setAway((current) => (current === !atBottom ? current : !atBottom));
  };

  return <div className="agentChatLogFrame">
    <div ref={log} className="agentChatLog" role="log" aria-label="Conversation with Aril" tabIndex={0} onScroll={onScroll}>
      {state === "loading" && <p className="agentChatLoading">Loading…</p>}
      {state === "empty" && <Empty onSuggest={onSuggest} />}
      {state === "ready" && <>
        {messages.map((message) => (message.role === "user"
          ? <OwnerMessage key={message.id} text={message.text} images={message.images ?? NO_IMAGES} urls={imageUrls} />
          : <AgentMessage key={message.id} message={message} tasks={tasks} imageUrls={imageUrls} resolving={resolving} startHere={startHere} heldStart={heldStart} onApply={onApply} onDismiss={onDismiss} />))}
        {showPending && <OwnerMessage text={pendingMessage} images={pendingImages} urls={imageUrls} />}
        {running && <article className="agentChatMessage isAgent isWriting" aria-label="Aril">
          <AgentHead caption={turn ? agentCaption(turn) : null} />
          {turn && turn.text !== "" && <div aria-live="off"><SafeMarkdown text={turn.text} /></div>}
          <p className="agentChatActivity" role="status">{ACTIVITY_LABELS[turn?.activity ?? "starting"]}</p>
        </article>}
      </>}
    </div>
    {away && <button type="button" className="commandQuietAction agentChatJump" onClick={() => { toBottom(); setAway(false); }}>Jump to latest</button>}
  </div>;
}
