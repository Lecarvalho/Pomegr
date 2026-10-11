"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAgentChatAvailability } from "../../agent-chat-client";
import { useRepositoryInventory } from "../../repository-inventory-client";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { AgentChatLauncher } from "./AgentChatFrame";
import { AgentChatPanel } from "./AgentChatPanel";
import { chooseRepository, readStoredRepository, repositoryFromRoute, storeRepository } from "./agent-chat-presentation";

/**
 * Aril, the Pomegr task-board agent: a launcher at the bottom right of the window and the chat panel it opens. It is
 * drawn only where the chat can be reached (the desktop app, or a paired phone), and that is decided before anything
 * is drawn, so the launcher is never shown and then taken away.
 */
export function AgentChatDock() {
  const availability = useAgentChatAvailability();
  if (availability !== "desktop" && availability !== "paired") return null;
  return <AgentChatDockLive availability={availability} />;
}

function AgentChatDockLive({ availability }: { availability: "desktop" | "paired" }) {
  const pathname = usePathname() || "/";
  const { snapshot, loading } = useRepositoryInventory();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const refocusRepository = useRef(false);

  const ids = useMemo(() => snapshot.repositories.map((repository) => repository.id), [snapshot.repositories]);
  const options = useMemo<CommandSelectOption[]>(() => snapshot.repositories.map((repository) => ({ value: repository.id, label: repository.displayName })), [snapshot.repositories]);
  const repositoryId = selected !== null && ids.includes(selected) ? selected : null;

  // The route's repository, else the last one used, else the first listed.
  const initialChoice = () => chooseRepository(ids, repositoryFromRoute(pathname, window.location.search, ids), readStoredRepository());
  // The inventory may arrive after the panel opened, or drop the chosen repository: choose again, once, as soon as there is one to choose.
  if (everOpened && repositoryId === null && ids.length > 0) setSelected(initialChoice());

  const openPanel = () => {
    // An answer being written keeps its repository; otherwise each opening starts from the board in view.
    if (!(answering && repositoryId !== null)) setSelected(initialChoice());
    setFresh(false);
    setEverOpened(true);
    setOpen(true);
  };
  const minimize = useCallback(() => { returnFocus.current = true; setOpen(false); }, []);
  const chooseRepositoryByOwner = useCallback((id: string) => { refocusRepository.current = true; storeRepository(id); setSelected(id); }, []);
  const onAnswered = useCallback(() => setFresh(true), []);

  useEffect(() => { if (open && repositoryId !== null) storeRepository(repositoryId); }, [open, repositoryId]);

  // Opening moves focus to the message field, and minimizing returns it to the launcher. Nothing else moves focus, so an
  // answer that is being written never takes it.
  const hasRepository = repositoryId !== null;
  useEffect(() => {
    if (!open) return;
    const field = panel.current?.querySelector<HTMLTextAreaElement>("textarea");
    if (field && !field.disabled) field.focus({ preventScroll: true });
    else panel.current?.querySelector<HTMLButtonElement>("[data-minimize]")?.focus({ preventScroll: true });
  }, [open, hasRepository]);
  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    launcher.current?.focus({ preventScroll: true });
  }, [open]);
  // Choosing a repository remounts the panel's body; the switcher keeps focus, as the Tasks page does.
  useEffect(() => {
    if (!refocusRepository.current) return;
    refocusRepository.current = false;
    panel.current?.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Repository"]')?.focus({ preventScroll: true });
  }, [repositoryId]);

  return <div className="agentChatDock">
    {!open && <AgentChatLauncher buttonRef={launcher} answering={answering} fresh={fresh} expanded={false} controls={panelId} onClick={openPanel} />}
    <AgentChatPanel id={panelId} panelRef={panel} open={open} mounted={everOpened} availability={availability} repositoryId={repositoryId}
      repositoriesLoading={loading && ids.length === 0} repositories={options} onRepositoryChange={chooseRepositoryByOwner} onMinimize={minimize}
      onAnswering={setAnswering} onAnswered={onAnswered} />
  </div>;
}
