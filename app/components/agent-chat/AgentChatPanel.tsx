"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useAgentChat, type AgentChatAvailability } from "../../agent-chat-client";
import { useTasks } from "../../tasks-store";
import { AGENT_CHAT_BOUNDS, type AgentChatImage, type AgentChatProvider } from "../../../shared/agent-chat-contract";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { DEFAULT_RUN, NO_MODELS, runFromSelectValue, runSelectOptions, runSelectValue } from "../tasks/task-fields";
import { heldStartLine } from "../tasks/task-gates-model";
import { useTaskModelOptions } from "../tasks/task-panel-hooks";
import { AgentChatComposer, type AgentChatComposerHandle } from "./AgentChatComposer";
import { AgentChatPanelFrame, AgentChatHeader, AgentChatRepositoryRow } from "./AgentChatFrame";
import { AgentChatHistory } from "./AgentChatHistory";
import { AgentChatMessages, type AgentChatLogState } from "./AgentChatMessages";
import { IMAGE_ADD_FAILURE_MESSAGE, IMAGE_TYPE_MESSAGE, acceptChatImageFiles, addAgentChatImage, conversationImageIds, useAgentChatImageUrls } from "./agent-chat-images";
import { errorCopy } from "./agent-chat-presentation";

type Shared = {
  open: boolean;
  repositories: ReadonlyArray<CommandSelectOption>;
  onRepositoryChange(repositoryId: string): void;
  onMinimize(): void;
};

type ChosenRun = { key: string; provider: AgentChatProvider; model: string | null };

/** One repository's chat. Mounted once for each repository (a `key`), so no conversation of one repository is shown under another. */
function AgentChatBody({ repositoryId, availability, open, repositories, onRepositoryChange, onMinimize, onAnswering, onAnswered }: Shared & {
  repositoryId: string;
  availability: Exclude<AgentChatAvailability, "pending" | "absent">;
  onAnswering(answering: boolean): void;
  onAnswered(): void;
}) {
  // A minimized panel keeps following an answer that is being written, and asks nothing otherwise.
  const [following, setFollowing] = useState(false);
  const view = useAgentChat(repositoryId, open || following, availability);
  const answering = view.turn !== null || view.pendingMessage !== null;
  if (following !== answering) setFollowing(answering);

  const { board, refresh } = useTasks(repositoryId);
  const models = useTaskModelOptions(board.runModels);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState("");
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

  useEffect(() => {
    onAnswering(answering);
    if (wasAnswering.current && !answering && !open) onAnswered();
    wasAnswering.current = answering;
  }, [answering, open, onAnswering, onAnswered]);
  useEffect(() => () => onAnswering(false), [onAnswering]);

  // Run on starts from the open conversation's provider and model, else Claude Code's default model.
  const key = view.conversation?.id ?? "new";
  const base: ChosenRun = view.conversation
    ? { key, provider: view.conversation.provider, model: view.conversation.model }
    : { key, provider: DEFAULT_RUN.provider ?? "claude", model: null };
  const run = chosen !== null && chosen.key === key ? chosen : base;
  const runOptions = useMemo(() => runSelectOptions(models, { provider: run.provider, model: run.model, effort: null }), [models, run.provider, run.model]);

  const send = async () => {
    const text = draft.trim();
    if (text === "") return;
    setHistoryOpen(false);
    setSentProvider(run.provider);
    setPin((current) => current + 1);
    setDraft("");
    const images = attached;
    setAttached([]);
    setImageError(null);
    // A refused message stays in the field with its images, so a failed send loses nothing the owner put in.
    if (!await view.send(text, run.provider, run.model, images)) {
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
    <AgentChatHeader historyOpen={historyOpen} onToggleHistory={() => setHistoryOpen((current) => !current)} onNew={startNew} onMinimize={onMinimize} />
    {repositories.length > 1 && <AgentChatRepositoryRow options={repositories} value={repositoryId} onChange={onRepositoryChange} />}
    <div className="agentChatBody">
      {historyOpen
        ? <AgentChatHistory conversations={view.conversations} openId={view.openId} runningId={view.runningId}
          onOpen={(conversationId) => { view.open(conversationId); setHistoryOpen(false); }} onDelete={(conversationId) => { void view.remove(conversationId); }} />
        : <AgentChatMessages state={logState} conversation={view.conversation} turn={view.turn} pendingMessage={view.pendingMessage} pendingImages={view.pendingImages} imageUrls={imageUrls} tasks={board.tasks}
          resolving={view.resolving} pinSignal={pin} startHere={availability === "desktop"} heldStart={heldStart} onSuggest={suggest} onApply={(proposalId) => { void apply(proposalId); }} onDismiss={(proposalId) => { void view.dismiss(proposalId); }} />}
    </div>
    <AgentChatComposer ref={composer} value={draft} onChange={setDraft} onSend={() => { void send(); }} onStop={view.stop}
      runOptions={runOptions} runValue={runSelectValue({ provider: run.provider, model: run.model, effort: null })}
      onRunChange={(value) => { const next = runFromSelectValue(value, null); setChosen({ key, provider: next.provider ?? run.provider, model: next.model }); }}
      running={view.turn !== null} busy={view.pendingMessage !== null} runningElsewhere={view.runningElsewhere}
      images={attached.map((image) => image.id)} imageUrls={imageUrls} uploading={uploading > 0} imageError={imageError}
      onAttach={(files) => { void attach(files); }} onRemoveImage={(imageId) => { setImageError(null); setAttached((current) => current.filter((image) => image.id !== imageId)); }}
      error={view.error ? errorCopy(view.error, { provider: sentProvider, conversationOpen: view.openId !== null }) : null} />
  </>;
}

/** The panel while no repository can be chosen: the inventory is loading, or Pomegr has observed none. */
function AgentChatWithoutRepository({ loading, onMinimize }: { loading: boolean; onMinimize(): void }) {
  const options = useMemo(() => runSelectOptions(NO_MODELS, DEFAULT_RUN), []);
  return <>
    <AgentChatHeader historyOpen={false} onToggleHistory={() => undefined} onNew={() => undefined} onMinimize={onMinimize} disabled />
    <div className="agentChatBody">
      <div className="agentChatLogFrame"><div className="agentChatLog">
        <p className="agentChatLoading">{loading ? "Loading…" : "No repositories observed yet."}</p>
      </div></div>
    </div>
    <AgentChatComposer value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined} runOptions={options} runValue={runSelectValue(DEFAULT_RUN)}
      onRunChange={() => undefined} disabled running={false} busy={false} runningElsewhere={false} error={null} />
  </>;
}

export function AgentChatPanel({ id, panelRef, mounted, availability, repositoryId, repositoriesLoading, repositories, open, onRepositoryChange, onMinimize, onAnswering, onAnswered }: Shared & {
  id: string;
  panelRef: Ref<HTMLElement>;
  /** The body is built on the first opening and kept, so a minimized panel keeps its draft and follows an answer. */
  mounted: boolean;
  availability: Exclude<AgentChatAvailability, "pending" | "absent">;
  repositoryId: string | null;
  repositoriesLoading: boolean;
  onAnswering(answering: boolean): void;
  onAnswered(): void;
}) {
  // Escape minimizes unless a layer inside the panel (an open list, a delete question) took the key first.
  const keyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onMinimize();
  }, [onMinimize]);
  return <AgentChatPanelFrame id={id} panelRef={panelRef} open={open} onKeyDown={keyDown}>
    {mounted && (repositoryId !== null
      ? <AgentChatBody key={repositoryId} repositoryId={repositoryId} availability={availability} open={open} repositories={repositories}
        onRepositoryChange={onRepositoryChange} onMinimize={onMinimize} onAnswering={onAnswering} onAnswered={onAnswered} />
      : <AgentChatWithoutRepository loading={repositoriesLoading} onMinimize={onMinimize} />)}
  </AgentChatPanelFrame>;
}
