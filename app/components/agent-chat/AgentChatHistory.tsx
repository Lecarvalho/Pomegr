"use client";

import { useState, type KeyboardEvent } from "react";
import type { AgentChatConversationSummary } from "../../../shared/agent-chat-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { conversationMeta } from "./agent-chat-presentation";

/** The saved conversations of one repository. Deleting asks inline: a native dialog would take focus from the panel. */
export function AgentChatHistory({ conversations, openId, runningId, onOpen, onDelete }: {
  conversations: readonly AgentChatConversationSummary[];
  openId: string | null;
  runningId: string | null;
  onOpen(conversationId: string): void;
  onDelete(conversationId: string): void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // The inline question is an inner layer: Escape answers it before it can close the panel.
    event.preventDefault();
    setConfirming(null);
  };
  return <div className="agentChatHistory">
    <h3 className="agentChatEyebrow">Conversations</h3>
    {conversations.length === 0
      ? <p className="agentChatHistoryEmpty">No conversations yet.</p>
      : <ul className="agentChatHistoryList">
        {conversations.map((conversation) => {
          const current = conversation.id === openId;
          const asking = confirming === conversation.id;
          return <li key={conversation.id} className={`agentChatHistoryItem${current ? " isCurrent" : ""}`} onKeyDown={asking ? cancelOnEscape : undefined}>
            <button type="button" className="agentChatHistoryOpen" aria-current={current ? "true" : undefined} onClick={() => onOpen(conversation.id)}>
              <span className="agentChatHistoryTitle">{conversation.title}</span>{" "}
              <span className="agentChatHistoryMeta">{conversationMeta(conversation)}</span>
            </button>
            {asking
              ? <div className="agentChatHistoryConfirm" role="group" aria-label={`Delete ${conversation.title}?`}>
                <button type="button" className="commandSecondaryAction" onClick={() => { setConfirming(null); onDelete(conversation.id); }}>Delete</button>
                <button type="button" className="commandQuietAction" autoFocus onClick={() => setConfirming(null)}>Keep</button>
              </div>
              : <button type="button" className="commandIconAction agentChatHistoryDelete" aria-label={`Delete conversation: ${conversation.title}`} title={runningId === conversation.id ? "Aril is answering in this conversation" : "Delete conversation"}
                disabled={runningId === conversation.id} onClick={() => setConfirming(conversation.id)}><CommandIcon name="trash" /></button>}
          </li>;
        })}
      </ul>}
    <p className="agentChatHistoryNote">Conversations are kept on this computer until you delete them.</p>
  </div>;
}
