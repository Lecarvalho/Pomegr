"use client";

import { useEffect, useRef, useState } from "react";
import { AGENT_CHAT_BOUNDS, type AgentChatSearchMatch } from "../shared/agent-chat-contract";
import { searchAgentChat } from "./agent-chat-client";

// Search in the thread of one repository. The desktop app searches its own saved messages: this only asks it, once the owner
// has stopped typing for a moment, and keeps the answer in memory.

export const SEARCH_DELAY_MS = 250;

export type AgentChatSearchView = {
  /** The text in the field, as typed. */
  query: string;
  setQuery(value: string): void;
  /** The matches of the query that was last answered, newest first. Null while the field holds nothing to ask, or the ask failed. */
  matches: readonly AgentChatSearchMatch[] | null;
  /** The last ask was not answered. */
  failed: boolean;
};

type Answer = { matches: readonly AgentChatSearchMatch[]; failed: boolean };

/** Searches the thread while `enabled`. A closed search asks nothing and shows nothing. */
export function useAgentChatSearch(repositoryId: string | null, enabled: boolean): AgentChatSearchView {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const asked = useRef(0);
  const text = query.trim().slice(0, AGENT_CHAT_BOUNDS.searchQueryLength);
  const live = enabled && repositoryId !== null && text !== "";

  useEffect(() => {
    if (!live || repositoryId === null) return;
    const sequence = asked.current;
    const timer = window.setTimeout(() => {
      void searchAgentChat(repositoryId, text).then((result) => {
        // An answer to a query the owner has since changed is dropped: a change of the query bumps the count.
        if (sequence !== asked.current) return;
        setAnswer(result.ok ? { matches: result.matches, failed: false } : { matches: [], failed: true });
      });
    }, SEARCH_DELAY_MS);
    return () => { asked.current += 1; window.clearTimeout(timer); };
  }, [live, repositoryId, text]);

  return { query, setQuery, matches: live && answer !== null && !answer.failed ? answer.matches : null, failed: live && answer?.failed === true };
}
