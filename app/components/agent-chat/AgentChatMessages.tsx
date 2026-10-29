"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentChatAgentMessage, AgentChatImage, AgentChatThreadMessage, AgentChatThreadSummary, AgentChatTiming, AgentChatTurn } from "../../../shared/agent-chat-contract";
import type { Task } from "../../../shared/task-contract";
import { threadMessageKey } from "../../agent-chat-client";
import { CommandIcon } from "../command-center/CommandIcon";
import { AgentChatImageStrip } from "./AgentChatImages";
import type { AgentChatImageUrls } from "./agent-chat-images";
import { SafeMarkdown } from "../markdown/SafeMarkdown";
import { AgentChatProposalCard } from "./AgentChatProposalCard";
import { ACTIVITY_LABELS, STATUS_NOTES, SUGGESTIONS, SUMMARIZED_LINE, UNREADABLE_PROPOSAL, agentCaption, answerTimeTitle, formatMessageTime, pendingIsStored } from "./agent-chat-presentation";

type BoardTask = Pick<Task, "id" | "text">;

const PINNED_WITHIN = 24;
// Scrolling to within this many pixels of the first loaded message loads the page before it.
const LOAD_OLDER_WITHIN = 80;
// A message that was brought into view stays marked for this long.
const MARKED_MS = 2_000;
const NO_URLS: AgentChatImageUrls = new Map();
const NO_IMAGES: readonly AgentChatImage[] = [];

/** A message to bring into view: one a notification opened, or one the owner chose in the search. `nonce` changes for each request, so the same message can be asked for again. */
export type MessageTarget = { conversationId: string; messageId: string; nonce: number };

/**
 * The time of a message in the owner's local time, with the whole date and time as its tooltip, and under it the timing of an answer
 * that was measured. Nothing is drawn for a message with no time.
 */
function MessageTime({ at, timing }: { at: string | null | undefined; timing?: AgentChatTiming }) {
  const short = at ? formatMessageTime(at) : null;
  if (!at || short === null) return null;
  return <time className="agentChatMessageTime" dateTime={at} title={answerTimeTitle(at, timing) ?? undefined}>{short}</time>;
}

/** The quiet line where the thread was summarized for Aril: an icon, fixed words, and the time. It is no message and holds no summary text. */
function SummaryLine({ summarized }: { summarized: AgentChatThreadSummary }) {
  return <div className="agentChatQuietLine isSummary">
    <CommandIcon name="history" size="small" />
    <span className="agentChatQuietText">{SUMMARIZED_LINE}</span>
    <MessageTime at={summarized.at} />
  </div>;
}

/**
 * The message the summary line follows: the newest message the summary covers, or when that one is gone, the last message before its
 * time. Null when no loaded message precedes the summary's end, as when the older pages that hold it are not loaded yet.
 */
function summaryAnchor(messages: readonly AgentChatThreadMessage[], summarized: AgentChatThreadSummary | null): string | null {
  if (!summarized) return null;
  const covered = threadMessageKey({ conversationId: summarized.through.conversationId, id: summarized.through.messageId });
  if (messages.some((message) => threadMessageKey(message) === covered)) return covered;
  const end = Date.parse(summarized.through.at);
  const before = messages.filter((message) => Date.parse(message.at) < end).at(-1);
  return before ? threadMessageKey(before) : null;
}

function OwnerMessage({ message, text, at, images, urls, marked = false }: { message?: AgentChatThreadMessage; text: string; at: string | null; images: readonly AgentChatImage[]; urls: AgentChatImageUrls; marked?: boolean }) {
  return <article className={`agentChatMessage isOwner${marked ? " isMarked" : ""}`} aria-label="You" data-conversation-id={message?.conversationId} data-message-id={message?.id}>
    <div className="agentChatBubble">
      <p>{text}</p>
      <AgentChatImageStrip imageIds={images.map((image) => image.id)} urls={urls} label="Images you sent" />
    </div>
    <MessageTime at={at} />
  </article>;
}

export type AgentChatLogState = "loading" | "empty" | "ready";

function AgentHead({ at, caption, timing }: { at: string | null | undefined; caption: string | null; timing?: AgentChatTiming }) {
  return <p className="agentChatMessageHead"><span className="agentChatMessageName">Aril</span><MessageTime at={at} timing={timing} />{caption && <span className="agentChatMessageCaption">{caption}</span>}</p>;
}

/** A grant follow-up: one fixed line Pomegr wrote from the task log, drawn as a quiet line (an icon, its text, and its time) and not as a message. */
function QuietLine({ message, marked }: { message: AgentChatAgentMessage & { conversationId: string }; marked: boolean }) {
  return <article className={`agentChatQuietLine${marked ? " isMarked" : ""}`} aria-label="Aril" data-conversation-id={message.conversationId} data-message-id={message.id}>
    <CommandIcon name="spark" size="small" />
    <span className="agentChatQuietText">{message.text}</span>
    <MessageTime at={message.at} />
  </article>;
}

function AgentMessage({ message, marked, tasks, imageUrls, resolving, startHere, heldStart, onApply, onDismiss }: {
  message: AgentChatAgentMessage & { conversationId: string };
  marked: boolean;
  tasks: readonly BoardTask[];
  imageUrls: AgentChatImageUrls;
  resolving: string | null;
  startHere: boolean;
  heldStart?(taskId: string): string | null;
  onApply(conversationId: string, proposalId: string): void;
  onDismiss(conversationId: string, proposalId: string): void;
}) {
  if (message.grantFollowUp) return <QuietLine message={message} marked={marked} />;
  return <article className={`agentChatMessage isAgent${marked ? " isMarked" : ""}`} aria-label="Aril" data-conversation-id={message.conversationId} data-message-id={message.id}>
    <AgentHead at={message.at} caption={agentCaption(message)} timing={message.timing} />
    {message.text !== "" && <SafeMarkdown text={message.text} />}
    {message.status !== "complete" && <p className="agentChatMessageNote">{STATUS_NOTES[message.status]}</p>}
    {message.proposal && <AgentChatProposalCard proposal={message.proposal} tasks={tasks} imageUrls={imageUrls} busy={resolving === message.proposal.id} startHere={startHere} heldStart={heldStart}
      onApply={(proposalId) => onApply(message.conversationId, proposalId)} onDismiss={(proposalId) => onDismiss(message.conversationId, proposalId)} />}
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
 * The thread with Aril. It follows the newest line only while the owner is at the bottom; once they scroll up it stays where
 * they are and offers Jump to latest. Scrolling to the top loads the page before the first message, and the log stays where the
 * owner was reading. The partial answer is not a live region of its own: the log announces each stored message, and the
 * activity line is a status.
 */
export function AgentChatMessages({ state, messages, summarized = null, turn, pendingMessage, pendingAt = null, pendingImages = NO_IMAGES, imageUrls = NO_URLS, tasks, resolving, pinSignal = 0, target = null, hasOlder = false, loadingOlder = false, startHere = false, heldStart, onLoadOlder, onSuggest, onApply, onDismiss }: {
  state: AgentChatLogState;
  messages: readonly AgentChatThreadMessage[];
  /** Where the thread was summarized for Aril: one quiet line follows the newest message the summary covers. */
  summarized?: AgentChatThreadSummary | null;
  turn: AgentChatTurn | null;
  pendingMessage: string | null;
  /** When the message that is not stored yet was sent. */
  pendingAt?: string | null;
  /** The images of the message that was sent and is not stored yet. */
  pendingImages?: readonly AgentChatImage[];
  /** The object URL of each image that has arrived. */
  imageUrls?: AgentChatImageUrls;
  tasks: readonly BoardTask[];
  resolving: string | null;
  /** Changing it brings the newest line back into view, as when the owner sends a message. */
  pinSignal?: number;
  /** A message to bring into view once it is drawn: a follow-up that a notification opened, or a match the owner chose. */
  target?: MessageTarget | null;
  /** Messages exist before the first one drawn. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  /** True in the desktop window, where a proposed session start can be applied. */
  startHere?: boolean;
  /** The gates that hold a task's start now, as one line from the board's readings. */
  heldStart?(taskId: string): string | null;
  onLoadOlder?(): void;
  onSuggest(text: string): void;
  onApply(conversationId: string, proposalId: string): void;
  onDismiss(conversationId: string, proposalId: string): void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const showPending = pendingMessage !== null && !pendingIsStored(messages, pendingMessage);
  const running = turn !== null || pendingMessage !== null;
  const [marked, setMarked] = useState<{ key: string; nonce: number } | null>(null);
  const summaryKey = summaryAnchor(messages, summarized);

  const toBottom = useCallback(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
    pinned.current = true;
  }, []);

  // Older messages that were added above keep what the owner was reading where it was: the first message drawn changed, and the
  // one that was first is still there. The height of the log before is the one recorded after the last draw.
  const first = messages.length > 0 ? threadMessageKey(messages[0]) : null;
  const drawn = useRef<{ first: string | null; height: number }>({ first: null, height: 0 });
  useLayoutEffect(() => {
    const element = log.current;
    if (!element || drawn.current.first === null || first === drawn.current.first || !messages.some((message) => threadMessageKey(message) === drawn.current.first)) return;
    element.scrollTop += element.scrollHeight - drawn.current.height;
  });

  // A message the owner just sent starts at the newest line; the scroll event clears Jump to latest.
  useLayoutEffect(() => { toBottom(); }, [pinSignal, toBottom]);
  useLayoutEffect(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  });

  // A message that was asked for comes into view once, when it is drawn, and stays marked for a moment.
  const brought = useRef<string | null>(null);
  const targetShown = target !== null && messages.some((message) => message.conversationId === target.conversationId && message.id === target.messageId);
  useLayoutEffect(() => {
    if (target === null) { brought.current = null; return; }
    const element = log.current;
    const key = `${target.conversationId}/${target.messageId}`;
    if (!targetShown || !element || brought.current === `${key}/${target.nonce}`) return;
    brought.current = `${key}/${target.nonce}`;
    element.querySelector<HTMLElement>(`[data-conversation-id="${target.conversationId}"][data-message-id="${target.messageId}"]`)?.scrollIntoView?.({ block: "center" });
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_WITHIN;
    setMarked({ key, nonce: target.nonce });
  }, [target, targetShown]);
  useEffect(() => {
    if (marked === null) return;
    const timer = window.setTimeout(() => setMarked(null), MARKED_MS);
    return () => window.clearTimeout(timer);
  }, [marked]);

  // Records the log as drawn, for the next time older messages are added above, and asks for older messages when what is drawn
  // does not fill the log. A log with no height yet asks nothing, and a first message is asked about once, so a page the desktop
  // refused is not asked for again by every draw; the owner's next scroll to the top asks again.
  const asked = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = log.current;
    if (!element) return;
    drawn.current = { first, height: element.scrollHeight };
    if (hasOlder && !loadingOlder && element.clientHeight > 0 && element.scrollHeight <= element.clientHeight && asked.current !== first) {
      asked.current = first;
      onLoadOlder?.();
    }
  });

  const onScroll = () => {
    const element = log.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_WITHIN;
    // The height as the owner leaves it, so the place is kept against it when a page arrives above.
    drawn.current = { first: drawn.current.first, height: element.scrollHeight };
    pinned.current = atBottom;
    setAway((current) => (current === !atBottom ? current : !atBottom));
    if (hasOlder && !loadingOlder && element.scrollTop <= LOAD_OLDER_WITHIN) onLoadOlder?.();
  };

  return <div className="agentChatLogFrame">
    <div ref={log} className="agentChatLog" role="log" aria-label="Conversation with Aril" tabIndex={0} onScroll={onScroll}>
      {state === "loading" && <p className="agentChatLoading">Loading…</p>}
      {state === "empty" && <Empty onSuggest={onSuggest} />}
      {state === "ready" && <>
        {messages.map((message) => {
          const isMarked = marked !== null && marked.key === `${message.conversationId}/${message.id}`;
          return <Fragment key={threadMessageKey(message)}>
            {message.role === "user"
              ? <OwnerMessage message={message} text={message.text} at={message.at} images={message.images ?? NO_IMAGES} urls={imageUrls} marked={isMarked} />
              : <AgentMessage message={message} marked={isMarked} tasks={tasks} imageUrls={imageUrls} resolving={resolving} startHere={startHere} heldStart={heldStart} onApply={onApply} onDismiss={onDismiss} />}
            {summarized && summaryKey === threadMessageKey(message) && <SummaryLine summarized={summarized} />}
          </Fragment>;
        })}
        {showPending && <OwnerMessage text={pendingMessage} at={pendingAt} images={pendingImages} urls={imageUrls} />}
        {running && <article className="agentChatMessage isAgent isWriting" aria-label="Aril">
          <AgentHead at={turn?.startedAt ?? pendingAt} caption={turn ? agentCaption(turn) : null} />
          {turn && turn.text !== "" && <div aria-live="off"><SafeMarkdown text={turn.text} /></div>}
          <p className="agentChatActivity" role="status">{ACTIVITY_LABELS[turn?.activity ?? "starting"]}</p>
        </article>}
      </>}
    </div>
    {loadingOlder && <p className="agentChatEarlier" role="status">Loading earlier messages…</p>}
    {away && <button type="button" className="commandQuietAction agentChatJump" onClick={() => { toBottom(); setAway(false); }}>Jump to latest</button>}
  </div>;
}
