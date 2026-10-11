"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AgentChatAgentMessage, AgentChatConversation, AgentChatTurn } from "../../../shared/agent-chat-contract";
import type { Task } from "../../../shared/task-contract";
import { AgentChatMarkdown } from "./AgentChatMarkdown";
import { AgentChatProposalCard } from "./AgentChatProposalCard";
import { ACTIVITY_LABELS, STATUS_NOTES, SUGGESTIONS, UNREADABLE_PROPOSAL, agentCaption, pendingIsStored } from "./agent-chat-presentation";

type BoardTask = Pick<Task, "id" | "text">;

const PINNED_WITHIN = 24;

export type AgentChatLogState = "loading" | "empty" | "ready";

function AgentHead({ caption }: { caption: string | null }) {
  return <p className="agentChatMessageHead"><span className="agentChatMessageName">Aril</span>{caption && <span className="agentChatMessageCaption">{caption}</span>}</p>;
}

function AgentMessage({ message, tasks, resolving, onApply, onDismiss }: {
  message: AgentChatAgentMessage;
  tasks: readonly BoardTask[];
  resolving: string | null;
  onApply(proposalId: string): void;
  onDismiss(proposalId: string): void;
}) {
  return <article className="agentChatMessage isAgent" aria-label="Aril">
    <AgentHead caption={agentCaption(message)} />
    {message.text !== "" && <AgentChatMarkdown text={message.text} />}
    {message.status !== "complete" && <p className="agentChatMessageNote">{STATUS_NOTES[message.status]}</p>}
    {message.proposal && <AgentChatProposalCard proposal={message.proposal} tasks={tasks} busy={resolving === message.proposal.id} onApply={onApply} onDismiss={onDismiss} />}
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
export function AgentChatMessages({ state, conversation, turn, pendingMessage, tasks, resolving, pinSignal = 0, onSuggest, onApply, onDismiss }: {
  state: AgentChatLogState;
  conversation: AgentChatConversation | null;
  turn: AgentChatTurn | null;
  pendingMessage: string | null;
  tasks: readonly BoardTask[];
  resolving: string | null;
  /** Changing it brings the newest line back into view, as when the owner sends a message. */
  pinSignal?: number;
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
          ? <article key={message.id} className="agentChatMessage isOwner" aria-label="You"><p>{message.text}</p></article>
          : <AgentMessage key={message.id} message={message} tasks={tasks} resolving={resolving} onApply={onApply} onDismiss={onDismiss} />))}
        {showPending && <article className="agentChatMessage isOwner" aria-label="You"><p>{pendingMessage}</p></article>}
        {running && <article className="agentChatMessage isAgent isWriting" aria-label="Aril">
          <AgentHead caption={turn ? agentCaption(turn) : null} />
          {turn && turn.text !== "" && <div aria-live="off"><AgentChatMarkdown text={turn.text} /></div>}
          <p className="agentChatActivity" role="status">{ACTIVITY_LABELS[turn?.activity ?? "starting"]}</p>
        </article>}
      </>}
    </div>
    {away && <button type="button" className="commandQuietAction agentChatJump" onClick={() => { toBottom(); setAway(false); }}>Jump to latest</button>}
  </div>;
}
