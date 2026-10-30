"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WARM_DEBOUNCE_MS, threadAgentChat, warmAgentChat } from "../../agent-chat-client";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { AgentChatComposer, type AgentChatComposerHandle } from "../agent-chat/AgentChatComposer";
import {
  HOME_COMPOSER_FIELD_ID, chooseRepository, openAgentChat, readStoredRepository, sendAgentChatFromHome, storeRepository,
} from "../agent-chat/agent-chat-presentation";
import { CHAT_DEFAULT_EFFORT, chatModelOptions, chatModelValue, initialChatRun, type ChatRunSource } from "../agent-chat/agent-chat-run";
import { useAgentChatComposer } from "../agent-chat/useAgentChatComposer";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { NO_MODELS } from "../tasks/task-fields";
import styles from "./HomeAril.module.css";

/** The run the repository's thread last used, read once for each repository the composer shows. It is only the composer's first model and effort. */
function useThreadRun(repositoryId: string): { run: ChatRunSource | null; ready: boolean } {
  const [read, setRead] = useState<{ repositoryId: string; run: ChatRunSource | null } | null>(null);
  useEffect(() => {
    let live = true;
    void threadAgentChat(repositoryId).then((answer) => { if (live) setRead({ repositoryId, run: answer.ok ? answer.run : null }); });
    return () => { live = false; };
  }, [repositoryId]);
  const current = read !== null && read.repositoryId === repositoryId;
  return { run: current ? read.run : null, ready: current };
}

/** The suggestion chips above the composer, and the quiet action that opens the conversation without sending anything. */
export function HomeChips({ suggestions, onPick, onOpen }: { suggestions: readonly string[]; onPick(text: string): void; onOpen(): void }) {
  return <div className={styles.chips}>
    {suggestions.length > 0 && <ul className={styles.chipList} aria-label="Suggestions">
      {suggestions.map((text) => <li key={text}>
        <button type="button" className="commandQuietAction agentChatSuggestionChip" onClick={() => onPick(text)}>{text}</button>
      </li>)}
    </ul>}
    <button type="button" className={`commandQuietAction ${styles.open}`} onClick={onOpen}>Open conversation</button>
  </div>;
}

/** The chat composer for one repository, drawn on Home. Send hands the message to the dock, which opens the panel and sends it there. */
function HomeComposer({ repositoryId, repositories, onRepositoryChange, suggestions }: {
  repositoryId: string;
  repositories: ReadonlyArray<CommandSelectOption>;
  onRepositoryChange(repositoryId: string): void;
  suggestions: readonly string[];
}) {
  const thread = useThreadRun(repositoryId);
  const state = useAgentChatComposer(repositoryId, thread.run);
  const { run, draft, setDraft, attached, setAttached, setImageError } = state;
  const composer = useRef<AgentChatComposerHandle>(null);

  // A field that keeps its focus asks the desktop to keep a provider run ready for the next message, as the panel's does: once for a
  // burst of focus events, with the run the composer shows, and only after the thread was read so that the run is the thread's.
  const [focused, setFocused] = useState(false);
  const { ready } = thread;
  useEffect(() => {
    if (!focused || !ready) return;
    const timer = window.setTimeout(() => { void warmAgentChat(repositoryId, run.provider, run.model, run.effort); }, WARM_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [focused, ready, repositoryId, run.provider, run.model, run.effort]);

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    sendAgentChatFromHome({ repositoryId, text, provider: run.provider, model: run.model, effort: run.effort, images: attached });
    setDraft("");
    setAttached([]);
    setImageError(null);
  };

  return <>
    <HomeChips suggestions={suggestions} onPick={(text) => { setDraft(text); composer.current?.focus(); }} onOpen={() => openAgentChat(repositoryId)} />
    <AgentChatComposer ref={composer} fieldId={HOME_COMPOSER_FIELD_ID} value={draft} onChange={setDraft} onSend={send} onStop={() => undefined} onFieldFocusChange={setFocused}
      modelOptions={state.modelOptions} modelValue={state.modelValue} onModelChange={state.chooseModel} effort={run.effort} onEffortChange={state.chooseEffort}
      repositories={repositories} repositoryId={repositoryId} onRepositoryChange={onRepositoryChange}
      running={false} busy={false} error={null}
      images={attached.map((image) => image.id)} imageUrls={state.imageUrls} uploading={state.uploading} imageError={state.imageError}
      onAttach={(files) => { void state.attach(files); }} onRemoveImage={state.removeImage} />
  </>;
}

/** The composer is disabled while no repository can be chosen: the inventory is loading, or Pomegr has observed none. */
function HomeComposerWithoutRepository({ loading }: { loading: boolean }) {
  const options = useMemo(() => chatModelOptions(NO_MODELS, initialChatRun(NO_MODELS, null)), []);
  return <>
    <p className={styles.note} role="status">{loading ? "Loading repositories…" : "No repositories observed yet."}</p>
    <AgentChatComposer fieldId={HOME_COMPOSER_FIELD_ID} value="" onChange={() => undefined} onSend={() => undefined} onStop={() => undefined}
      modelOptions={options} modelValue={chatModelValue(initialChatRun(NO_MODELS, null))} onModelChange={() => undefined}
      effort={CHAT_DEFAULT_EFFORT} onEffortChange={() => undefined} disabled running={false} busy={false} error={null} />
  </>;
}

/** The suggestions and the composer at the foot of Home. Drawn only where the chat can be reached. */
export function HomeAril({ suggestions }: { suggestions: readonly string[] }) {
  const { snapshot, loading } = useRepositoryInventory();
  const ids = useMemo(() => snapshot.repositories.map((repository) => repository.id), [snapshot.repositories]);
  const options = useMemo<CommandSelectOption[]>(() => snapshot.repositories.map((repository) => ({ value: repository.id, label: repository.displayName })), [snapshot.repositories]);
  const [selected, setSelected] = useState<string | null>(null);
  // The last repository used, else the first listed, until the owner chooses one here.
  const fallback = useMemo(() => chooseRepository(ids, null, readStoredRepository()), [ids]);
  const repositoryId = selected !== null && ids.includes(selected) ? selected : fallback;
  const choose = (id: string) => { storeRepository(id); setSelected(id); };

  return <section className={`agentChatHome ${styles.aril}`} aria-label="Ask Aril">
    {repositoryId === null
      ? <HomeComposerWithoutRepository loading={loading && ids.length === 0} />
      : <HomeComposer repositoryId={repositoryId} repositories={options} onRepositoryChange={choose} suggestions={suggestions} />}
  </section>;
}
