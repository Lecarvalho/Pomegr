"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useAgentChat, WARM_DEBOUNCE_MS, type AgentChatAvailability } from "../../agent-chat-client";
import { useAgentChatSearch } from "../../agent-chat-search";
import type { AgentChatImage, AgentChatProvider } from "../../../shared/agent-chat-contract";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { DEFAULT_RUN, NO_MODELS } from "../tasks/task-fields";
import { heldStartLine } from "../tasks/task-gates-model";
import { AgentChatComposer, type AgentChatComposerHandle } from "./AgentChatComposer";
import { AgentChatPanelFrame, AgentChatHeader } from "./AgentChatFrame";
import { AgentChatMessages, type AgentChatLogState, type MessageTarget } from "./AgentChatMessages";
import { AgentChatSearch } from "./AgentChatSearch";
import { threadImageSources } from "./agent-chat-images";
import { errorCopy, type AgentChatHandoff } from "./agent-chat-presentation";
import { CHAT_DEFAULT_EFFORT, chatModelOptions, chatModelValue, initialChatRun, type ChatRun } from "./agent-chat-run";
import { useAgentChatComposer } from "./useAgentChatComposer";

type Shared = {
  open: boolean;
  repositories: ReadonlyArray<CommandSelectOption>;
  onRepositoryChange(repositoryId: string): void;
  expanded: boolean;
  onToggleExpanded(): void;
  onClose(): void;
};

// A message to open: a follow-up's. `nonce` changes for each opening, so the same link opens it again.
type ChatFocus = { conversationId: string | null; messageId: string | null; nonce: number };

/** One repository's chat. Mounted once for each repository (a `key`), so no message of one repository is shown under another. */
function AgentChatBody({ repositoryId, availability, open, repositories, onRepositoryChange, expanded, onToggleExpanded, onClose, onAnswering, onAnswered, focus, outgoing, onOutgoingTaken }: Shared & {
  repositoryId: string;
  focus: ChatFocus | null;
  availability: Exclude<AgentChatAvailability, "pending" | "absent">;
  onAnswering(answering: boolean): void;
  onAnswered(): void;
  /** A message the owner wrote on Home for this repository: sent once, as if typed here. */
  outgoing: AgentChatHandoff | null;
  onOutgoingTaken(nonce: number): void;
}) {
  // A closed panel keeps following an answer that is being written, and asks nothing otherwise.
  const [following, setFollowing] = useState(false);
  const view = useAgentChat(repositoryId, open || following, availability);
  const answering = view.turn !== null || view.pendingMessage !== null;
  if (following !== answering) setFollowing(answering);

  const imageSources = useMemo(() => threadImageSources(view.messages), [view.messages]);
  const { board, refresh, run, modelOptions, modelValue, chooseModel, chooseEffort, draft, setDraft, attached, setAttached, uploading, imageError, setImageError, imageUrls, attach, removeImage } = useAgentChatComposer(repositoryId, view.run, imageSources);
  const [searchOpen, setSearchOpen] = useState(false);
  const search = useAgentChatSearch(repositoryId, searchOpen);
  const searchId = useId();
  const searchToggle = useRef<HTMLButtonElement>(null);
  // When the message on its way was sent, until it reaches the stored thread with its own time.
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [sentProvider, setSentProvider] = useState<AgentChatProvider>(DEFAULT_RUN.provider ?? "claude");
  const [pin, setPin] = useState(0);
  const composer = useRef<AgentChatComposerHandle>(null);
  const wasAnswering = useRef(false);

  // A message to bring into view: it is loaded first, by loading older pages a bounded number of times, and then drawn in view.
  const [target, setTarget] = useState<MessageTarget | null>(null);
  const requested = useRef(0);
  const reveal = view.reveal;
  const bring = useCallback((conversationId: string, messageId: string) => {
    void reveal(conversationId, messageId).then((found) => {
      if (found) { requested.current += 1; setTarget({ conversationId, messageId, nonce: requested.current }); }
    });
  }, [reveal]);

  // A follow-up's link brings its message into view, once the thread is read.
  const focusNonce = focus?.nonce ?? 0;
  const focusConversation = focus?.conversationId ?? null;
  const focusMessage = focus?.messageId ?? null;
  const [shownNonce, setShownNonce] = useState(0);
  if (shownNonce !== focusNonce) { setShownNonce(focusNonce); setSearchOpen(false); }
  useEffect(() => {
    if (focusNonce !== 0 && view.ready && focusConversation !== null && focusMessage !== null) bring(focusConversation, focusMessage);
  }, [focusNonce, view.ready, focusConversation, focusMessage, bring]);

  useEffect(() => {
    onAnswering(answering);
    if (wasAnswering.current && !answering && !open) onAnswered();
    wasAnswering.current = answering;
  }, [answering, open, onAnswering, onAnswered]);
  useEffect(() => () => onAnswering(false), [onAnswering]);

  // A field that keeps its focus asks the desktop to keep a provider run ready for the next message, once for a burst of focus events and
  // with the run the composer shows by then. The thread is read first, so the run is the thread's and not the starting default.
  const [fieldFocused, setFieldFocused] = useState(false);
  const { ready, warm } = view;
  useEffect(() => {
    if (!fieldFocused || !ready) return;
    const timer = window.setTimeout(() => warm(run.provider, run.model, run.effort), WARM_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [fieldFocused, ready, warm, run.provider, run.model, run.effort]);

  const closeSearch = () => { setSearchOpen(false); search.setQuery(""); searchToggle.current?.focus({ preventScroll: true }); };
  // Sends a message with a run. A refused message stays in the field with its images, so a failed send loses nothing the owner put in.
  const submit = async (text: string, asked: ChatRun, images: readonly AgentChatImage[]) => {
    setSearchOpen(false);
    search.setQuery("");
    setSentProvider(asked.provider);
    setSentAt(new Date().toISOString());
    setPin((current) => current + 1);
    setImageError(null);
    if (!await view.send(text, asked.provider, asked.model, asked.effort, images)) {
      setDraft((current) => (current === "" ? text : current));
      setAttached((current) => (current.length === 0 ? images : current));
    }
  };
  const send = async () => {
    const text = draft.trim();
    if (text === "") return;
    const images = attached;
    setDraft("");
    setAttached([]);
    await submit(text, run, images);
  };
  // A message written on Home arrives once, from the dock, with the run Home showed. It is sent as if typed here, and a draft stays.
  const taken = useRef(0);
  useEffect(() => {
    if (outgoing === null || taken.current === outgoing.nonce) return;
    taken.current = outgoing.nonce;
    onOutgoingTaken(outgoing.nonce);
    void submit(outgoing.text, { provider: outgoing.provider, model: outgoing.model, effort: outgoing.effort }, outgoing.images);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one send for each handoff
  }, [outgoing]);
  // A tap on a quick reply or an option sends its label as the owner's own message, with the run the composer shows. The draft stays as it is.
  // Only a click the keyboard made keeps focus in the field: a tap on a phone should not open the keyboard.
  const choose = async (label: string, byKeyboard: boolean) => {
    if (view.turn !== null || view.pendingMessage !== null) return;
    setSearchOpen(false);
    search.setQuery("");
    setSentProvider(run.provider);
    setSentAt(new Date().toISOString());
    setPin((current) => current + 1);
    if (byKeyboard) composer.current?.focus();
    await view.send(label, run.provider, run.model, run.effort);
  };
  const apply = async (conversationId: string, proposalId: string) => { if (await view.apply(conversationId, proposalId)) await refresh(); };
  const heldStart = (taskId: string) => {
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    return task ? heldStartLine(task, board.queue) : null;
  };
  const suggest = (text: string) => { setDraft(text); composer.current?.focus(); };

  const hasContent = view.messages.length > 0 || view.pendingMessage !== null || view.turn !== null;
  const logState: AgentChatLogState = !view.ready ? "loading" : hasContent ? "ready" : "empty";

  return <>
    <AgentChatHeader searchOpen={searchOpen} onToggleSearch={() => (searchOpen ? closeSearch() : setSearchOpen(true))} searchRef={searchToggle} searchControls={searchId}
      expanded={expanded} onToggleExpanded={onToggleExpanded} onClose={onClose} />
    {searchOpen && <AgentChatSearch id={searchId} query={search.query} onQueryChange={search.setQuery} matches={search.matches} failed={search.failed}
      onChoose={(match) => { closeSearch(); bring(match.conversationId, match.messageId); }} onClose={closeSearch} />}
    <div className="agentChatBody">
      <AgentChatMessages state={logState} messages={view.messages} summarized={view.summarized} turn={view.turn} pendingMessage={view.pendingMessage} pendingAt={sentAt} pendingImages={view.pendingImages} imageUrls={imageUrls} tasks={board.tasks}
        resolving={view.resolving} pinSignal={pin} target={target} hasOlder={view.hasOlder} loadingOlder={view.loadingOlder} startHere={availability === "desktop"} heldStart={heldStart}
        onLoadOlder={() => { void view.loadOlder(); }} onSuggest={suggest} onChoose={(label, byKeyboard) => { void choose(label, byKeyboard); }} onApply={(conversationId, proposalId) => { void apply(conversationId, proposalId); }} onDismiss={(conversationId, proposalId) => { void view.dismiss(conversationId, proposalId); }} />
    </div>
    <AgentChatComposer ref={composer} value={draft} onChange={setDraft} onSend={() => { void send(); }} onStop={view.stop} onFieldFocusChange={setFieldFocused}
      modelOptions={modelOptions} modelValue={modelValue}
      repositories={repositories} repositoryId={repositoryId} onRepositoryChange={onRepositoryChange}
      onModelChange={chooseModel}
      effort={run.effort} onEffortChange={chooseEffort}
      running={view.turn !== null} busy={view.pendingMessage !== null}
      images={attached.map((image) => image.id)} imageUrls={imageUrls} uploading={uploading} imageError={imageError}
      onAttach={(files) => { void attach(files); }} onRemoveImage={removeImage}
      error={view.error ? errorCopy(view.error, { provider: sentProvider }) : null} />
  </>;
}

/** The panel while no repository can be chosen: the inventory is loading, or Pomegr has observed none. */
function AgentChatWithoutRepository({ loading, expanded, onToggleExpanded, onClose }: { loading: boolean; expanded: boolean; onToggleExpanded(): void; onClose(): void }) {
  const options = useMemo(() => chatModelOptions(NO_MODELS, initialChatRun(NO_MODELS, null)), []);
  return <>
    <AgentChatHeader searchOpen={false} onToggleSearch={() => undefined} expanded={expanded} onToggleExpanded={onToggleExpanded} onClose={onClose} disabled />
    <div className="agentChatBody">
      <div className="agentChatLogFrame"><div className="agentChatLog">
        <p className="agentChatLoading">{loading ? "Loading…" : "No repositories observed yet."}</p>
      </div></div>
    </div>
    <AgentChatComposer value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined} modelOptions={options} modelValue={chatModelValue(initialChatRun(NO_MODELS, null))}
      onModelChange={() => undefined} effort={CHAT_DEFAULT_EFFORT} onEffortChange={() => undefined} disabled running={false} busy={false} error={null} />
  </>;
}

export function AgentChatPanel({ id, panelRef, mounted, availability, repositoryId, repositoriesLoading, repositories, open, onRepositoryChange, expanded, onToggleExpanded, onClose, onAnswering, onAnswered, focus = null, outgoing = null, onOutgoingTaken }: Shared & {
  focus?: ChatFocus | null;
  /** A message written on Home, waiting for the body of its repository to send it. */
  outgoing?: AgentChatHandoff | null;
  onOutgoingTaken(nonce: number): void;
  id: string;
  panelRef: Ref<HTMLElement>;
  /** The body is built on the first opening and kept, so a closed panel keeps its draft and follows an answer. */
  mounted: boolean;
  availability: Exclude<AgentChatAvailability, "pending" | "absent">;
  repositoryId: string | null;
  repositoriesLoading: boolean;
  onAnswering(answering: boolean): void;
  onAnswered(): void;
}) {
  // Escape closes the panel unless a layer inside the panel (an open list, a delete question) took the key first.
  const keyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onClose();
  }, [onClose]);
  return <AgentChatPanelFrame id={id} panelRef={panelRef} open={open} expanded={expanded} onKeyDown={keyDown}>
    {mounted && (repositoryId !== null
      ? <AgentChatBody key={repositoryId} repositoryId={repositoryId} availability={availability} open={open} repositories={repositories}
        onRepositoryChange={onRepositoryChange} expanded={expanded} onToggleExpanded={onToggleExpanded} onClose={onClose} onAnswering={onAnswering} onAnswered={onAnswered} focus={focus}
        outgoing={outgoing !== null && outgoing.repositoryId === repositoryId ? outgoing : null} onOutgoingTaken={onOutgoingTaken} />
      : <AgentChatWithoutRepository loading={repositoriesLoading} expanded={expanded} onToggleExpanded={onToggleExpanded} onClose={onClose} />)}
  </AgentChatPanelFrame>;
}
