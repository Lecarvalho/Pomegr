"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { AGENT_CHAT_BOUNDS, type AgentChatSearchMatch } from "../../../shared/agent-chat-contract";
import { SEARCH_FAILED, SEARCH_HINT, SEARCH_LABEL, SEARCH_NONE, SEARCH_PLACEHOLDER, SEARCH_ROLE_LABELS, formatMessageTime, fullMessageTime, splitMatch } from "./agent-chat-presentation";

/** The excerpt of a match, with the searched text emphasized where it occurs in the excerpt. */
function Snippet({ snippet, query }: { snippet: string; query: string }) {
  const parts = splitMatch(snippet, query);
  return <span className="agentChatSearchSnippet">{parts ? <>{parts.before}<mark className="agentChatSearchMark">{parts.match}</mark>{parts.after}</> : snippet}</span>;
}

/**
 * The search under the header: a field and the messages that hold its text, newest first. Choosing one jumps to it in the thread.
 * Escape belongs to this layer first, so it closes the search and not the panel.
 */
export function AgentChatSearch({ id, query, onQueryChange, matches, failed, onChoose, onClose }: {
  id?: string;
  query: string;
  onQueryChange(value: string): void;
  /** Null while the field holds nothing to ask. */
  matches: readonly AgentChatSearchMatch[] | null;
  failed: boolean;
  onChoose(match: AgentChatSearchMatch): void;
  onClose(): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus({ preventScroll: true }); }, []);

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    // The native search field would clear itself on Escape; here the key closes the search.
    event.preventDefault();
    onClose();
  };

  return <div id={id} className="agentChatSearch" role="search" aria-label="Search the conversation" onKeyDown={keyDown}>
    <input ref={field} className="agentChatSearchField" type="search" aria-label={SEARCH_LABEL} placeholder={SEARCH_PLACEHOLDER} maxLength={AGENT_CHAT_BOUNDS.searchQueryLength}
      autoComplete="off" spellCheck={false} value={query} onChange={(event) => onQueryChange(event.currentTarget.value)} />
    {failed ? <p className="agentChatSearchNote" role="status">{SEARCH_FAILED}</p>
      : matches === null ? <p className="agentChatSearchNote">{SEARCH_HINT}</p>
        : matches.length === 0 ? <p className="agentChatSearchNote" role="status">{SEARCH_NONE}</p>
          : <ul className="agentChatSearchList" aria-label="Matching messages">
            {matches.map((match) => {
              const time = formatMessageTime(match.at);
              return <li key={`${match.conversationId}/${match.messageId}`}>
                <button type="button" className="agentChatSearchResult" onClick={() => onChoose(match)}>
                  <span className="agentChatSearchMeta">
                    <span className="agentChatSearchWho">{SEARCH_ROLE_LABELS[match.role]}</span>
                    {time !== null && <time className="agentChatMessageTime" dateTime={match.at} title={fullMessageTime(match.at) ?? undefined}>{time}</time>}
                  </span>
                  <Snippet snippet={match.snippet} query={query} />
                </button>
              </li>;
            })}
          </ul>}
  </div>;
}
