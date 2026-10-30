"use client";

import { useMemo, useRef, useSyncExternalStore } from "react";
import { useAgentChatAvailability } from "./agent-chat-client";
import { CommandPageHeader } from "./components/command-center/CommandPage";
import { ProviderStatusArea } from "./components/ProviderStatus";
import { homeSuggestions } from "./components/agent-chat/agent-chat-presentation";
import { HomeAril } from "./components/home/HomeAril";
import { HomeArilLine } from "./components/home/HomeArilLine";
import { HomeContinue } from "./components/home/HomeContinue";
import { HomeNeedsYou } from "./components/home/HomeNeedsYou";
import { HomeUpdateCard } from "./components/home/HomeUpdateCard";
import { HomeUpdateIllustration } from "./components/home/HomeUpdateIllustration";
import { arilLine, greetingFor, needsYou, suggestionFacts } from "./components/home/home-model";
import { useHomeLogs } from "./components/home/useHomeLogs";
import { useHomePreferences } from "./hooks/useHomePreferences";
import { useProviderStatus } from "./provider-status-client";
import { useRepositoryInventory } from "./repository-inventory-client";
import { useTaskHome } from "./tasks-home-store";
import styles from "./HomeDashboard.module.css";

/** Approved Home direction (docs/internal/design/home.md). */

const subscribeNever = () => () => {};
// The owner's local hour is known only on the client. Until then the title is empty, so it is never drawn with another word first.
const useGreeting = () => useSyncExternalStore(subscribeNever, () => greetingFor(new Date().getHours()), () => "");

export function HomeDashboard() {
  const providerStatus = useProviderStatus();
  const preferences = useHomePreferences();
  const { ready, updateDismissed, dismissUpdate, updateSeen, markUpdateSeen } = preferences;
  const greeting = useGreeting();
  const home = useTaskHome();
  const { snapshot: inventory } = useRepositoryInventory();
  // Where the chat can be reached is decided before anything of Aril is drawn: the task log and the composer need it.
  const availability = useAgentChatAvailability();
  const aril = availability === "desktop" || availability === "paired";
  const logs = useHomeLogs(home, aril);
  const browseRef = useRef<HTMLAnchorElement>(null);

  const names = useMemo(() => new Map(inventory.repositories.map((repository) => [repository.id, repository.displayName])), [inventory.repositories]);
  // Nothing is drawn from the boards until the client, the inventory, and the logs it reads have answered, so no row appears after another is shown.
  const settling = availability === "pending" || inventory.readiness === "loading" || logs.reading;
  const needs = useMemo(() => (home.readiness === "ready" && !settling ? needsYou(home, names, logs.reads) : null), [home, names, logs.reads, settling]);
  const line = useMemo(() => (aril && home.readiness === "ready" && !logs.reading ? arilLine(logs.reads, logs.at) : null), [aril, home.readiness, logs.reading, logs.reads, logs.at]);
  const reading = aril && (home.readiness === "loading" || logs.reading);
  const suggestions = useMemo(() => homeSuggestions(suggestionFacts(home, needs?.total ?? 0)), [home, needs?.total]);

  const meta = line !== null ? <HomeArilLine>{line}</HomeArilLine> : reading ? <HomeArilLine status>Reading the task logs…</HomeArilLine> : undefined;

  return <section className={`commandView commandHome ${styles.home}`} aria-labelledby="home-heading">
    <div className={styles.column}>
      <CommandPageHeader title={greeting} headingId="home-heading" meta={meta} />

      {needs !== null && needs.total > 0 && <HomeNeedsYou items={needs.items} total={needs.total} />}
      {home.readiness === "unavailable" && availability !== "pending" && <p className={styles.note} role="status">Task boards are unavailable. Pomegr will retry.</p>}

      <HomeContinue preferences={preferences} browseRef={browseRef} />

      <div className={styles.status}>
        <ProviderStatusArea providers={providerStatus.providers} className={styles.providerStatus} />
        {ready && !updateDismissed && <HomeUpdateCard
          title="Let Aril run your backlog"
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

      {aril && <div className={styles.composer}><HomeAril suggestions={suggestions} /></div>}
    </div>
  </section>;
}
