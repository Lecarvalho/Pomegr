"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgentChatAvailability } from "../../agent-chat-client";
import { useRepositoryInventory } from "../../repository-inventory-client";
import type { CommandSelectOption } from "../command-center/CommandSelect";
import { AgentChatLauncher, AgentChatScrim } from "./AgentChatFrame";
import { AgentChatPanel } from "./AgentChatPanel";
import {
  AGENT_CHAT_CLOSED_EVENT, AGENT_CHAT_OPEN_EVENT, AGENT_CHAT_SEND_EVENT, HOME_ENTRY_MS, HOME_SECTION_ID, HOME_SETTLE_CURVE, HOME_SETTLE_MS, agentChatLink, chooseRepository,
  prefersReducedMotion, readStoredRepository, repositoryFromRoute, storeRepository, type AgentChatHandoff, type AgentChatLink, type AgentChatSend,
} from "./agent-chat-presentation";

/**
 * Aril, the Pomegr task-board agent: a launcher at the bottom right of the window and the chat panel it opens, docked to
 * the right edge below the shell header. The panel lays over the page, which a light scrim dims; a click on the scrim closes
 * the panel as Close does. The chat is drawn only where it can be reached (the desktop app, or a paired phone), and that is
 * decided before anything is drawn, so the launcher is never shown and then taken away. Home draws no launcher: its composer is the way
 * in, and a message written there reaches this dock as an event. The dock opens the maximized panel on that repository, the panel sends the
 * message, and closing the panel gives the page back to Home; the panel's mode before that is restored.
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
  // The mode the owner keeps for the panel, and the mode a panel opened from Home has instead (maximized) while it is open: the close drops it, so the owner's mode returns.
  const [keptExpanded, setKeptExpanded] = useState(false);
  const [homeMode, setHomeMode] = useState<boolean | null>(null);
  const expanded = homeMode ?? keptExpanded;
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
  // While the panel was opened from Home: the thread's messages fade in, and the panel's mode before it was maximized is kept to restore.
  const [entering, setEntering] = useState(false);
  const sends = useRef(0);
  const flipped = useRef(0);
  const wasOpen = useRef(false);
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
  const close = useCallback(() => { returnFocus.current = true; setOpen(false); setHomeMode(null); setEntering(false); }, []);
  const toggleExpanded = useCallback(() => (homeMode === null ? setKeptExpanded((current) => !current) : setHomeMode(!homeMode)), [homeMode]);
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
    // Home hands the page to the maximized panel, and the panel gives it back when it closes.
    setHomeMode(true);
    setEntering(true);
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
    // Home has no launcher: focus returns to the Home page itself, not to its composer, which would lift it again.
    (onHome ? document.getElementById(HOME_SECTION_ID) : launcher.current)?.focus({ preventScroll: true });
  }, [open, onHome]);
  // The panel closed: Home is told, so it leaves the thread it handed its message to.
  useEffect(() => {
    if (open) { wasOpen.current = true; return; }
    if (wasOpen.current) { wasOpen.current = false; window.dispatchEvent(new Event(AGENT_CHAT_CLOSED_EVENT)); }
  }, [open]);
  useEffect(() => {
    if (!entering) return;
    const timer = window.setTimeout(() => setEntering(false), HOME_ENTRY_MS);
    return () => window.clearTimeout(timer);
  }, [entering]);
  // The composer of the panel starts where the composer of Home was on the screen and settles to the bottom; no motion under reduced motion.
  useLayoutEffect(() => {
    if (outbox === null || !open || outbox.fromTop === undefined || flipped.current === outbox.nonce) return;
    flipped.current = outbox.nonce;
    const form = panel.current?.querySelector<HTMLElement>(".agentChatComposer");
    if (!form || prefersReducedMotion()) return;
    const delta = outbox.fromTop - form.getBoundingClientRect().top;
    if (!Number.isFinite(delta) || Math.abs(delta) < 1) return;
    form.style.transition = "none";
    form.style.transform = `translateY(${delta}px)`;
    void form.offsetHeight;
    form.style.transition = `transform ${HOME_SETTLE_MS}ms ${HOME_SETTLE_CURVE}`;
    form.style.transform = "";
    const done = () => { form.style.transition = ""; };
    form.addEventListener("transitionend", done, { once: true });
  }, [outbox, open]);
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
      onAnswering={setAnswering} onAnswered={onAnswered} outgoing={outbox} onOutgoingTaken={outgoingTaken} entering={entering} />
  </div>;
}
