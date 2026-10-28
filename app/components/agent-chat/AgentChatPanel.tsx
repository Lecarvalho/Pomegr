"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useAgentChat, type AgentChatAvailability } from "../../agent-chat-client";
import { useTasks } from "../../tasks-store";
import { AGENT_CHAT_BOUNDS, type AgentChatImage, type AgentChatProvider } from "../../../shared/agent-chat-contract";
import type { TaskEffort } from "../../../shared/task-contract";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { DEFAULT_RUN, NO_MODELS } from "../tasks/task-fields";
import { heldStartLine } from "../tasks/task-gates-model";
import { useTaskModelOptions } from "../tasks/task-panel-hooks";
import { AgentChatComposer, type AgentChatComposerHandle } from "./AgentChatComposer";
import { AgentChatPanelFrame, AgentChatHeader } from "./AgentChatFrame";
import { AgentChatHistory } from "./AgentChatHistory";
import { AgentChatMessages, type AgentChatLogState } from "./AgentChatMessages";
import { IMAGE_ADD_FAILURE_MESSAGE, IMAGE_TYPE_MESSAGE, acceptChatImageFiles, addAgentChatImage, conversationImageIds, useAgentChatImageUrls } from "./agent-chat-images";
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

// What the owner chose for the conversation in view, over the run it would start on. `key` is the conversation, or "new".
type ChosenRun = { key: string; pick?: { provider: AgentChatProvider; model: string | null }; effort?: TaskEffort };
// A follow-up to open: its conversation and message. `nonce` changes for each opening, so the same link opens it again.
type ChatFocus = { conversationId: string | null; messageId: string | null; nonce: number };

/** One repository's chat. Mounted once for each repository (a `key`), so no conversation of one repository is shown under another. */
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // When the message on its way was sent, until it reaches the stored conversation with its own time.
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ChosenRun | null>(null);
  const [sentProvider, setSentProvider] = useState<AgentChatProvider>(DEFAULT_RUN.provider ?? "claude");
  const [pin, setPin] = useState(0);
  // The images of the message being written: the desktop app holds their bytes, this holds what it answered.
  const [attached, setAttached] = useState<readonly AgentChatImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const shownImages = useMemo(() => [...conversationImageIds(view.conversation?.messages ?? []), ...view.pendingImages.map((image) => image.id)], [view.conversation, view.pendingImages]);
  const { urls: imageUrls, remember } = useAgentChatImageUrls(repositoryId, view.conversation?.id ?? null, shownImages);
  const composer = useRef<AgentChatComposerHandle>(null);
  const wasAnswering = useRef(false);
  const openConversation = view.open;

  // A follow-up's link opens its conversation; the log then brings the follow-up into view.
  const focusNonce = focus?.nonce ?? 0;
  const focusConversation = focus?.conversationId ?? null;
  const [shownNonce, setShownNonce] = useState(0);
  if (shownNonce !== focusNonce) { setShownNonce(focusNonce); setHistoryOpen(false); }
  useEffect(() => {
    if (focusNonce !== 0 && focusConversation !== null) openConversation(focusConversation);
  }, [focusNonce, focusConversation, openConversation]);

  useEffect(() => {
    onAnswering(answering);
    if (wasAnswering.current && !answering && !open) onAnswered();
    wasAnswering.current = answering;
  }, [answering, open, onAnswering, onAnswered]);
  useEffect(() => () => onAnswering(false), [onAnswering]);

  // The run starts from the open conversation's model and effort, else the newest known model and Medium. It is never a default.
  const key = view.conversation?.id ?? "new";
  const base = initialChatRun(models, view.conversation);
  const choice = chosen !== null && chosen.key === key ? chosen : null;
  const run = resolveChatRun(models, { ...base, ...choice?.pick, effort: choice?.effort ?? base.effort });
  const modelOptions = chatModelOptions(models, run);

  const send = async () => {
    const text = draft.trim();
    if (text === "") return;
    setHistoryOpen(false);
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
  const apply = async (proposalId: string) => { if (await view.apply(proposalId)) await refresh(); };
  const heldStart = (taskId: string) => {
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    return task ? heldStartLine(task, board.queue) : null;
  };
  const startNew = () => { view.open(null); setHistoryOpen(false); composer.current?.focus(); };
  const suggest = (text: string) => { setDraft(text); composer.current?.focus(); };

  const hasContent = view.conversation !== null || view.pendingMessage !== null || view.turn !== null;
  const logState: AgentChatLogState = hasContent ? "ready"
    : !view.ready ? "loading"
      : view.openId === null ? "empty"
        : view.error === null ? "loading" : "ready";

  return <>
    <AgentChatHeader historyOpen={historyOpen} onToggleHistory={() => setHistoryOpen((current) => !current)} onNew={startNew} expanded={expanded} onToggleExpanded={onToggleExpanded} onClose={onClose} />
    <div className="agentChatBody">
      {historyOpen
        ? <AgentChatHistory conversations={view.conversations} openId={view.openId} runningId={view.runningId}
          onOpen={(conversationId) => { view.open(conversationId); setHistoryOpen(false); }} onDelete={(conversationId) => { void view.remove(conversationId); }} />
        : <AgentChatMessages state={logState} conversation={view.conversation} turn={view.turn} pendingMessage={view.pendingMessage} pendingAt={sentAt} pendingImages={view.pendingImages} imageUrls={imageUrls} tasks={board.tasks}
          resolving={view.resolving} pinSignal={pin} focusMessageId={focus !== null && focus.conversationId === view.openId ? focus.messageId : null} startHere={availability === "desktop"} heldStart={heldStart} onSuggest={suggest} onApply={(proposalId) => { void apply(proposalId); }} onDismiss={(proposalId) => { void view.dismiss(proposalId); }} />}
    </div>
    <AgentChatComposer ref={composer} value={draft} onChange={setDraft} onSend={() => { void send(); }} onStop={view.stop}
      modelOptions={modelOptions} modelValue={chatModelValue(run)}
      repositories={repositories} repositoryId={repositoryId} onRepositoryChange={onRepositoryChange}
      onModelChange={(value) => { const pick = chatModelFromValue(value); if (pick) setChosen({ ...choice, key, pick }); }}
      effort={run.effort} onEffortChange={(effort) => setChosen({ ...choice, key, effort })}
      running={view.turn !== null} busy={view.pendingMessage !== null} runningElsewhere={view.runningElsewhere}
      images={attached.map((image) => image.id)} imageUrls={imageUrls} uploading={uploading > 0} imageError={imageError}
      onAttach={(files) => { void attach(files); }} onRemoveImage={(imageId) => { setImageError(null); setAttached((current) => current.filter((image) => image.id !== imageId)); }}
      error={view.error ? errorCopy(view.error, { provider: sentProvider, conversationOpen: view.openId !== null }) : null} />
  </>;
}

/** The panel while no repository can be chosen: the inventory is loading, or Pomegr has observed none. */
function AgentChatWithoutRepository({ loading, expanded, onToggleExpanded, onClose }: { loading: boolean; expanded: boolean; onToggleExpanded(): void; onClose(): void }) {
  const options = useMemo(() => chatModelOptions(NO_MODELS, initialChatRun(NO_MODELS, null)), []);
  return <>
    <AgentChatHeader historyOpen={false} onToggleHistory={() => undefined} onNew={() => undefined} expanded={expanded} onToggleExpanded={onToggleExpanded} onClose={onClose} disabled />
    <div className="agentChatBody">
      <div className="agentChatLogFrame"><div className="agentChatLog">
        <p className="agentChatLoading">{loading ? "Loading…" : "No repositories observed yet."}</p>
      </div></div>
    </div>
    <AgentChatComposer value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined} modelOptions={options} modelValue={chatModelValue(initialChatRun(NO_MODELS, null))}
      onModelChange={() => undefined} effort={CHAT_DEFAULT_EFFORT} onEffortChange={() => undefined} disabled running={false} busy={false} runningElsewhere={false} error={null} />
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
