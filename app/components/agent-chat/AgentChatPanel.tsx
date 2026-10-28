"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useAgentChat, type AgentChatAvailability } from "../../agent-chat-client";
import { useAgentChatSearch } from "../../agent-chat-search";
import { useTasks } from "../../tasks-store";
import { AGENT_CHAT_BOUNDS, type AgentChatImage, type AgentChatProvider } from "../../../shared/agent-chat-contract";
import type { TaskEffort } from "../../../shared/task-contract";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { DEFAULT_RUN, NO_MODELS } from "../tasks/task-fields";
import { heldStartLine } from "../tasks/task-gates-model";
import { useTaskModelOptions } from "../tasks/task-panel-hooks";
import { AgentChatComposer, type AgentChatComposerHandle } from "./AgentChatComposer";
import { AgentChatPanelFrame, AgentChatHeader } from "./AgentChatFrame";
import { AgentChatMessages, type AgentChatLogState, type MessageTarget } from "./AgentChatMessages";
import { AgentChatSearch } from "./AgentChatSearch";
import { IMAGE_ADD_FAILURE_MESSAGE, IMAGE_TYPE_MESSAGE, acceptChatImageFiles, addAgentChatImage, threadImageSources, useAgentChatImageUrls } from "./agent-chat-images";
import { errorCopy } from "./agent-chat-presentation";
import { CHAT_DEFAULT_EFFORT, chatModelFromValue, chatModelOptions, chatModelValue, initialChatRun, resolveChatRun } from "./agent-chat-run";

type Shared = {
  open: boolean;
  repositories: ReadonlyArray<CommandSelectOption>;
  onRepositoryChange(repositoryId: string): void;
  expanded: boolean;
  onToggleExpanded(): void;
  onClose(): void;
};

// What the owner chose over the run the thread would start on.
type ChosenRun = { pick?: { provider: AgentChatProvider; model: string | null }; effort?: TaskEffort };
// A message to open: a follow-up's. `nonce` changes for each opening, so the same link opens it again.
type ChatFocus = { conversationId: string | null; messageId: string | null; nonce: number };

/** One repository's chat. Mounted once for each repository (a `key`), so no message of one repository is shown under another. */
function AgentChatBody({ repositoryId, availability, open, repositories, onRepositoryChange, expanded, onToggleExpanded, onClose, onAnswering, onAnswered, focus }: Shared & {
  repositoryId: string;
  focus: ChatFocus | null;
  availability: Exclude<AgentChatAvailability, "pending" | "absent">;
  onAnswering(answering: boolean): void;
  onAnswered(): void;
}) {
  // A closed panel keeps following an answer that is being written, and asks nothing otherwise.
  const [following, setFollowing] = useState(false);
  const view = useAgentChat(repositoryId, open || following, availability);
  const answering = view.turn !== null || view.pendingMessage !== null;
  if (following !== answering) setFollowing(answering);

  const { board, refresh } = useTasks(repositoryId);
  const models = useTaskModelOptions(board.runModels);
  const [searchOpen, setSearchOpen] = useState(false);
  const search = useAgentChatSearch(repositoryId, searchOpen);
  const searchId = useId();
  const searchToggle = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState("");
  // When the message on its way was sent, until it reaches the stored thread with its own time.
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ChosenRun>({});
  const [sentProvider, setSentProvider] = useState<AgentChatProvider>(DEFAULT_RUN.provider ?? "claude");
  const [pin, setPin] = useState(0);
  // The images of the message being written: the desktop app holds their bytes, this holds what it answered.
  const [attached, setAttached] = useState<readonly AgentChatImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageSources = useMemo(() => threadImageSources(view.messages), [view.messages]);
  const { urls: imageUrls, remember } = useAgentChatImageUrls(repositoryId, imageSources);
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

  // The run starts from what the thread last ran with, else the newest known model and Medium. It is never a default.
  const base = initialChatRun(models, view.run);
  const run = resolveChatRun(models, { ...base, ...chosen.pick, effort: chosen.effort ?? base.effort });
  const modelOptions = chatModelOptions(models, run);

  const closeSearch = () => { setSearchOpen(false); search.setQuery(""); searchToggle.current?.focus({ preventScroll: true }); };
  const send = async () => {
    const text = draft.trim();
    if (text === "") return;
    setSearchOpen(false);
    search.setQuery("");
    setSentProvider(run.provider);
    setSentAt(new Date().toISOString());
    setPin((current) => current + 1);
    setDraft("");
    const images = attached;
    setAttached([]);
    setImageError(null);
    // A refused message stays in the field with its images, so a failed send loses nothing the owner put in.
    if (!await view.send(text, run.provider, run.model, run.effort, images)) {
      setDraft((current) => (current === "" ? text : current));
      setAttached((current) => (current.length === 0 ? images : current));
    }
  };
  const attach = async (files: File[]) => {
    const { accepted, message } = acceptChatImageFiles(files, attached.length + uploading);
    setImageError(message);
    for (const file of accepted) {
      setUploading((current) => current + 1);
      const answer = await addAgentChatImage(repositoryId, new Uint8Array(await file.arrayBuffer()));
      setUploading((current) => current - 1);
      if (!answer.ok) { setImageError(answer.error === "invalid" ? IMAGE_TYPE_MESSAGE : IMAGE_ADD_FAILURE_MESSAGE); continue; }
      remember(answer.image.id, file);
      setAttached((current) => (current.length < AGENT_CHAT_BOUNDS.imagesPerMessage ? [...current, answer.image] : current));
    }
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
      <AgentChatMessages state={logState} messages={view.messages} turn={view.turn} pendingMessage={view.pendingMessage} pendingAt={sentAt} pendingImages={view.pendingImages} imageUrls={imageUrls} tasks={board.tasks}
        resolving={view.resolving} pinSignal={pin} target={target} hasOlder={view.hasOlder} loadingOlder={view.loadingOlder} startHere={availability === "desktop"} heldStart={heldStart}
        onLoadOlder={() => { void view.loadOlder(); }} onSuggest={suggest} onApply={(conversationId, proposalId) => { void apply(conversationId, proposalId); }} onDismiss={(conversationId, proposalId) => { void view.dismiss(conversationId, proposalId); }} />
    </div>
    <AgentChatComposer ref={composer} value={draft} onChange={setDraft} onSend={() => { void send(); }} onStop={view.stop}
      modelOptions={modelOptions} modelValue={chatModelValue(run)}
      repositories={repositories} repositoryId={repositoryId} onRepositoryChange={onRepositoryChange}
      onModelChange={(value) => { const pick = chatModelFromValue(value); if (pick) setChosen({ ...chosen, pick }); }}
      effort={run.effort} onEffortChange={(effort) => setChosen({ ...chosen, effort })}
      running={view.turn !== null} busy={view.pendingMessage !== null}
      images={attached.map((image) => image.id)} imageUrls={imageUrls} uploading={uploading > 0} imageError={imageError}
      onAttach={(files) => { void attach(files); }} onRemoveImage={(imageId) => { setImageError(null); setAttached((current) => current.filter((image) => image.id !== imageId)); }}
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

export function AgentChatPanel({ id, panelRef, mounted, availability, repositoryId, repositoriesLoading, repositories, open, onRepositoryChange, expanded, onToggleExpanded, onClose, onAnswering, onAnswered, focus = null }: Shared & {
  focus?: ChatFocus | null;
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
        onRepositoryChange={onRepositoryChange} expanded={expanded} onToggleExpanded={onToggleExpanded} onClose={onClose} onAnswering={onAnswering} onAnswered={onAnswered} focus={focus} />
      : <AgentChatWithoutRepository loading={repositoriesLoading} expanded={expanded} onToggleExpanded={onToggleExpanded} onClose={onClose} />)}
  </AgentChatPanelFrame>;
}
