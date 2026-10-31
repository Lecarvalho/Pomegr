"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useAgentChatAvailability } from "./agent-chat-client";
import { useArilSwitch } from "./aril-control-client";
import { CommandPageHeader } from "./components/command-center/CommandPage";
import { AGENT_CHAT_CLOSED_EVENT, HOME_SECTION_ID, homeSuggestions } from "./components/agent-chat/agent-chat-presentation";
import { HomeAril, type HomeMode } from "./components/home/HomeAril";
import { HomeArilLine } from "./components/home/HomeArilLine";
import { HomeContinue } from "./components/home/HomeContinue";
import { HomeNeedsYou } from "./components/home/HomeNeedsYou";
import { HomeUpdateCard } from "./components/home/HomeUpdateCard";
import { HomeUpdateIllustration } from "./components/home/HomeUpdateIllustration";
import { arilLine, greetingFor, needsYou, suggestionFacts } from "./components/home/home-model";
import { useHomeLogs } from "./components/home/useHomeLogs";
import { useSessionCatalog } from "./hooks/SessionCatalogContext";
import { useHomePreferences } from "./hooks/useHomePreferences";
import { useRepositoryInventory } from "./repository-inventory-client";
import { useTaskHome } from "./tasks-home-store";
import { createEmptyTaskHome } from "../shared/task-contract";
import styles from "./HomeDashboard.module.css";

/** Approved Home direction (docs/internal/design/home.md). */

const subscribeNever = () => () => {};
// The owner's local hour is known only on the client. Until then the title is empty, so it is never drawn with another word first.
const useGreeting = () => useSyncExternalStore(subscribeNever, () => greetingFor(new Date().getHours()), () => "");
const NO_TASKS = createEmptyTaskHome("ready");

export function HomeDashboard() {
  const preferences = useHomePreferences();
  const { ready, updateDismissed, dismissUpdate, updateSeen, markUpdateSeen } = preferences;
  const greeting = useGreeting();
  const home = useTaskHome();
  const { snapshot: inventory } = useRepositoryInventory();
  const catalog = useSessionCatalog();
  // Where the chat can be reached is decided before anything of Aril is drawn: the task log and the composer need it.
  const availability = useAgentChatAvailability();
  const aril = availability === "desktop" || availability === "paired";
  // The composer and its chips are drawn only once the switch is known and Aril is On; while it is Off, or not yet known, Home has neither and the
  // rest of Home lays out as it is. A composer is never drawn and then taken away.
  const chat = useArilSwitch(aril).state?.on === true;
  const logs = useHomeLogs(home, aril);
  const browseRef = useRef<HTMLAnchorElement>(null);
  const page = useRef<HTMLElement>(null);

  // Home has three modes. Focusing the composer (or picking a chip) lifts it to the middle and fades the rest out; Send hands the page to the
  // maximized panel; the panel's close brings Home back. Escape, or a click outside while the field is empty, leaves focus mode.
  const [mode, setMode] = useState<HomeMode>("home");
  const [emptyDraft, setEmptyDraft] = useState(true);
  // Aril turned Off while the composer was lifted or the thread was open: Home comes back, since nothing else would give it back.
  if (!chat && mode !== "home") setMode("home");
  const leave =useCallback(() => { setMode("home"); page.current?.focus({ preventScroll: true }); }, []);
  const enterFocus = useCallback(() => setMode((current) => (current === "home" ? "focus" : current)), []);
  const sent = useCallback(() => setMode("thread"), []);
  useEffect(() => {
    const closed = () => setMode((current) => (current === "thread" ? "home" : current));
    window.addEventListener(AGENT_CHAT_CLOSED_EVENT, closed);
    return () => window.removeEventListener(AGENT_CHAT_CLOSED_EVENT, closed);
  }, []);
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || mode !== "focus" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    leave();
  };

  const names = useMemo(() => new Map(inventory.repositories.map((repository) => [repository.id, repository.displayName])), [inventory.repositories]);
  // Nothing is drawn from the boards, the logs, or the sessions until each has answered, so no line appears after another is shown.
  const catalogLoading = catalog.loading || catalog.readiness.catalog === "loading";
  const settling = availability === "pending" || inventory.readiness === "loading" || home.readiness === "loading" || logs.reading || catalogLoading;
  const needs = useMemo(
    () => (settling ? null : needsYou({ home: home.readiness === "ready" ? home : NO_TASKS, names, logs: logs.reads, sessions: catalog.sessions })),
    [home, names, logs.reads, catalog.sessions, settling],
  );
  const line = useMemo(() => (aril && home.readiness === "ready" && !logs.reading ? arilLine(logs.reads, logs.at) : null), [aril, home.readiness, logs.reading, logs.reads, logs.at]);
  const reading = aril && (home.readiness === "loading" || logs.reading);
  const suggestions = useMemo(() => homeSuggestions(suggestionFacts(home, needs?.total ?? 0)), [home, needs?.total]);

  const meta = line !== null ? <HomeArilLine>{line}</HomeArilLine> : reading ? <HomeArilLine status>Reading the task logs…</HomeArilLine> : undefined;

  return <section ref={page} id={HOME_SECTION_ID} tabIndex={-1} className={`commandView commandHome ${styles.home}`} aria-labelledby="home-heading" onKeyDown={keyDown}>
    {mode === "focus" && <div className={styles.dim} aria-hidden="true" onClick={() => { if (emptyDraft) leave(); }} />}
    <div className={styles.column}>
      <div className={`${styles.content}${mode === "home" ? "" : ` ${styles.isHidden}`}`} inert={mode === "home" ? undefined : true}>
        <CommandPageHeader title={greeting} headingId="home-heading" meta={meta} />

        {needs !== null && needs.total > 0 && <HomeNeedsYou lines={needs.lines} total={needs.total} />}
        {home.readiness === "unavailable" && availability !== "pending" && <p className={styles.note} role="status">Task boards are unavailable. Pomegr will retry.</p>}

        <HomeContinue preferences={preferences} names={names} browseRef={browseRef} />

        {ready && !updateDismissed && <HomeUpdateCard
          title="Let Aril run your backlog"
          summary="Under a grant, Aril starts, reviews, and merges tasks within limits you set."
          description="A grant lets Aril start the Ready tasks your work rules select and their reviews, send failed work back, merge on green CI after a passing review, and write tasks from plans you name. It stays within the hours, tasks, and usage limit you set."
          highlights={[
            "Set the limits in Aril settings, add a work rule, and select Start grant.",
            "Only you start a grant, in the desktop app or on a paired phone you allow. Stop grant ends it at once and ends no running session.",
            "The Log lists each grant action, each usage pause, and each refused merge. Starting sessions works on Windows only.",
          ]}
          illustration={<HomeUpdateIllustration />}
          autoOpen={!updateSeen}
          onAutoOpen={markUpdateSeen}
          onDismiss={() => { dismissUpdate(); browseRef.current?.focus(); }}
        />}
      </div>

      {chat && <div className={styles.composer}><HomeAril suggestions={suggestions} mode={mode} onFocus={enterFocus} onSent={sent} onLeave={leave} onEmptyChange={setEmptyDraft} /></div>}
    </div>
  </section>;
}
