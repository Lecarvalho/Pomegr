"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAgentChatAvailability } from "../../agent-chat-client";
import { useRepositoryInventory } from "../../repository-inventory-client";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { AgentChatLauncher, AgentChatScrim } from "./AgentChatFrame";
import { AgentChatPanel } from "./AgentChatPanel";
import {
  AGENT_CHAT_OPEN_EVENT, AGENT_CHAT_SEND_EVENT, HOME_COMPOSER_FIELD_ID, agentChatLink, chooseRepository, readStoredRepository, repositoryFromRoute, storeRepository,
  type AgentChatHandoff, type AgentChatLink, type AgentChatSend,
} from "./agent-chat-presentation";

/**
 * Aril, the Pomegr task-board agent: a launcher at the bottom right of the window and the chat panel it opens, docked to
 * the right edge below the shell header. The panel lays over the page, which a light scrim dims; a click on the scrim closes
 * the panel as Close does. The chat is drawn only where it can be reached (the desktop app, or a paired phone), and that is
 * decided before anything is drawn, so the launcher is never shown and then taken away. Home draws no launcher: its composer is the way
 * in, and a message written there reaches this dock as an event; the dock opens the panel on that repository and the panel sends it.
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
  const [expanded, setExpanded] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // A follow-up's link waits here until its repository is listed, then opens the chat at it.
  const [link, setLink] = useState<AgentChatLink | null>(() => (typeof window === "undefined" ? null : agentChatLink(window.location.pathname, window.location.search)));
  const [focus, setFocus] = useState<(AgentChatLink & { nonce: number }) | null>(null);
  // A message written on Home waits here until its repository is listed, then the panel opens at it and sends it once.
  const [pendingSend, setPendingSend] = useState<AgentChatHandoff | null>(null);
  const [outbox, setOutbox] = useState<AgentChatHandoff | null>(null);
  const sends = useRef(0);
  const onHome = pathname === "/";
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
  const close = useCallback(() => { returnFocus.current = true; setOpen(false); }, []);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const chooseRepositoryByOwner = useCallback((id: string) => { refocusRepository.current = true; storeRepository(id); setSelected(id); }, []);
  const onAnswered = useCallback(() => setFresh(true), []);

  useEffect(() => { if (open && repositoryId !== null) storeRepository(repositoryId); }, [open, repositoryId]);

  // A notification opens the chat at its follow-up: the link of the page that loaded, or one clicked inside the app.
  useEffect(() => {
    const onOpen = (event: Event) => { const detail = (event as CustomEvent<AgentChatLink>).detail; if (detail) setLink(detail); };
    window.addEventListener(AGENT_CHAT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(AGENT_CHAT_OPEN_EVENT, onOpen);
  }, []);
  useEffect(() => {
    const onSend = (event: Event) => {
      const detail = (event as CustomEvent<AgentChatSend>).detail;
      if (!detail) return;
      sends.current += 1;
      setPendingSend({ ...detail, nonce: sends.current });
    };
    window.addEventListener(AGENT_CHAT_SEND_EVENT, onSend);
    return () => window.removeEventListener(AGENT_CHAT_SEND_EVENT, onSend);
  }, []);
  if (pendingSend !== null && ids.includes(pendingSend.repositoryId)) {
    setPendingSend(null);
    setOutbox(pendingSend);
    setSelected(pendingSend.repositoryId);
    setEverOpened(true);
    setOpen(true);
    setFresh(false);
  } else if (pendingSend !== null && !loading) {
    // A repository the inventory does not list cannot be written to.
    setPendingSend(null);
  }
  if (link !== null && ids.includes(link.repositoryId)) {
    setLink(null);
    setSelected(link.repositoryId);
    setEverOpened(true);
    setOpen(true);
    setFresh(false);
    setFocus({ ...link, nonce: (focus?.nonce ?? 0) + 1 });
  }

  // Opening moves focus to the message field, and closing returns it to the launcher. Nothing else moves focus, so an
  // answer that is being written never takes it.
  const hasRepository = repositoryId !== null;
  useEffect(() => {
    if (!open) return;
    const field = panel.current?.querySelector<HTMLTextAreaElement>("textarea");
    if (field && !field.disabled) field.focus({ preventScroll: true });
    else panel.current?.querySelector<HTMLButtonElement>("[data-close]")?.focus({ preventScroll: true });
  }, [open, hasRepository]);
  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    // Home has no launcher: its message field is where the panel was opened from.
    (onHome ? document.getElementById(HOME_COMPOSER_FIELD_ID) : launcher.current)?.focus({ preventScroll: true });
  }, [open, onHome]);
  // Choosing a repository remounts the panel's body; the composer's repository choice keeps focus, as the Tasks page's switcher does.
  useEffect(() => {
    if (!refocusRepository.current) return;
    refocusRepository.current = false;
    panel.current?.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Repository"]')?.focus({ preventScroll: true });
  }, [repositoryId]);

  const outgoingTaken = useCallback((nonce: number) => setOutbox((current) => (current !== null && current.nonce === nonce ? null : current)), []);

  return <div className="agentChatDock">
    {!open && !onHome && <AgentChatLauncher buttonRef={launcher} answering={answering} fresh={fresh} expanded={false} controls={panelId} onClick={openPanel} />}
    {open && <AgentChatScrim onClick={close} />}
    <AgentChatPanel id={panelId} panelRef={panel} open={open} mounted={everOpened} availability={availability} repositoryId={repositoryId}
      repositoriesLoading={loading && ids.length === 0} repositories={options} onRepositoryChange={chooseRepositoryByOwner} expanded={expanded} onToggleExpanded={toggleExpanded} onClose={close}
      focus={focus !== null && focus.repositoryId === repositoryId ? focus : null}
      onAnswering={setAnswering} onAnswered={onAnswered} outgoing={outbox} onOutgoingTaken={outgoingTaken} />
  </div>;
}
