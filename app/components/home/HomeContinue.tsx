"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState, type Ref } from "react";
import { useTaskBoards } from "../../tasks-store";
import type { SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { useSessionCatalog } from "../../hooks/SessionCatalogContext";
import { HOME_PIN_LIMIT, normalizeHomePin, type HomePin, type HomePreferences } from "../../hooks/useHomePreferences";
import { CommandIcon, type CommandIconName } from "../command-center/CommandIcon";
import { CommandSelect, type CommandSelectOption } from "../command-center/CommandPage";
import { useMinuteClock } from "../tasks/task-panel-hooks";
import { HOME_RUNNING_SHOWN, runningCandidates, runningSessions, type RunningSession } from "./home-model";
import styles from "./HomeContinue.module.css";

type Destination = HomePin & { title: string; detail: string; href: string; icon: CommandIconName };
const VIEWS: Destination[] = [
  { kind: "view", id: "sessions", title: "Sessions", detail: "Live and historical sessions", href: "/sessions", icon: "sessions" },
  { kind: "view", id: "agents", title: "Models & delegation", detail: "Model, role, and work analysis", href: "/agents", icon: "agents" },
  { kind: "view", id: "usage-limits", title: "Usage limits", detail: "Provider account windows", href: "/usage-limits", icon: "limits" },
  { kind: "view", id: "repositories", title: "Repositories", detail: "Observed projects", href: "/repositories", icon: "repositories" },
];
const DESTINATION_KINDS: CommandSelectOption<HomePin["kind"]>[] = [{ value: "session", label: "Sessions" }, { value: "project", label: "Projects" }, { value: "view", label: "Views" }];
const samePin = (left: HomePin, right: HomePin) => left.kind === right.kind && left.id === right.id;

function sessionDestination(session: SessionSummary): Destination | null {
  try {
    return { kind: "session", id: session.id, title: session.title, detail: `${session.project} · ${session.source}`, href: `/sessions/${encodeSessionRoute(session.id)}`, icon: "session" };
  } catch { return null; }
}

function destinationsFor(sessions: SessionSummary[]): Destination[] {
  const projects = [...new Set(sessions.map((session) => session.project))]
    .filter((project) => normalizeHomePin({ kind: "project", id: project }) !== null)
    .sort((left, right) => left.localeCompare(right));
  return [
    ...VIEWS,
    ...projects.map((project): Destination => ({ kind: "project", id: project, title: project, detail: "Project sessions", href: `/sessions?project=${encodeURIComponent(project)}`, icon: "repositories" })),
    ...sessions.flatMap((session) => { const destination = sessionDestination(session); return destination ? [destination] : []; }),
  ];
}

function PinPicker({ destinations, pins, onToggle, catalogLoading }: {
  destinations: Destination[];
  pins: HomePin[];
  onToggle: (pin: HomePin) => void;
  catalogLoading: boolean;
}) {
  const [kind, setKind] = useState<HomePin["kind"]>("session");
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const matches = destinations.filter((destination) => destination.kind === kind && `${destination.title} ${destination.detail}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className={styles.picker}>
    <div className={styles.pickerFilters}>
      <label>Destination type<CommandSelect value={kind} onChange={(value) => { setKind(value); setQuery(""); }} options={DESTINATION_KINDS} /></label>
      <label>Find a destination<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names" /></label>
    </div>
    <ul className={styles.pickerResults} aria-label="Destinations to pin">
      {matches.slice(0, 20).map((destination) => {
        const pinned = pins.some((pin) => samePin(pin, destination));
        return <li key={`${destination.kind}:${destination.id}`}><button type="button" aria-pressed={pinned} aria-label={`Pin ${destination.title}`} disabled={!pinned && pins.length >= HOME_PIN_LIMIT} onClick={() => { onToggle(destination); setAnnouncement(pinned ? "Destination removed from Home." : "Destination pinned to Home."); }}>
          <span><strong>{destination.title}</strong><small>{destination.detail}</small></span><span>{pinned ? "Pinned" : "Pin"}<CommandIcon name="pin" size="small" /></span>
        </button></li>;
      })}
    </ul>
    {!matches.length && <p className={styles.hint}>{catalogLoading && kind !== "view" ? "Loading destinations from the local monitor…" : "No matching destinations."}</p>}
    {matches.length > 20 && <p className={styles.hint}>Showing the first 20 matches. Search to narrow the list.</p>}
    <p className={styles.hint}>{pins.length >= HOME_PIN_LIMIT ? "All six pins are in use. Remove one to add another." : "Choose up to six destinations. Your pins stay in this browser."}</p>
    <span className="srOnly" role="status">{announcement}</span>
  </div>;
}

/** The running sessions: a state dot, the title, the state (Working, or Waiting for you in amber), its repository, and when it last changed. */
export function HomeRunningList({ sessions }: { sessions: readonly RunningSession[] }) {
  return <ul className={styles.sessions} aria-label="Running sessions">
    {sessions.map((session) => <li key={session.key}>
      <Link className={styles.sessionRow} href={session.href}>
        <span className={`${styles.dot} ${session.waiting ? styles.dotWaiting : styles.dotWorking}`} aria-hidden="true" />
        <span className={styles.sessionTitle}>{session.title}</span>
        <span className={session.waiting ? styles.waiting : styles.state}>{session.waiting ? "Waiting for you" : "Working"}</span>
        <span className={styles.meta}>{session.meta}</span>
      </Link>
    </li>)}
  </ul>;
}

/**
 * The running sessions (at most four: working, or waiting for the owner), the last viewed session while none runs, and the pinned destinations in one
 * small line. The session catalog, the boards that name a task's title, and the preferences are the only things it reads.
 */
export function HomeContinue({ preferences, names, browseRef }: { preferences: HomePreferences; names: ReadonlyMap<string, string>; browseRef?: Ref<HTMLAnchorElement> }) {
  const { sessions, loading, connected, readiness } = useSessionCatalog();
  const { pins, lastViewedSessionId, ready, persistent, togglePin } = preferences;
  const headingId = useId();
  const destinations = useMemo(() => destinationsFor(sessions), [sessions]);
  const lastViewed = destinations.find((destination) => destination.kind === "session" && destination.id === lastViewedSessionId);
  const pickerRef = useRef<HTMLDetailsElement>(null);
  const pickerSummaryRef = useRef<HTMLElement>(null);
  const catalogLoading = loading || readiness.catalog === "loading";
  const catalogUnavailable = !connected || readiness.catalog === "unavailable";
  const [pinAnnouncement, setPinAnnouncement] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  // A session started for a task shows the task's title, so the boards of the shown sessions are read (the Tasks page's own store) before any row is drawn.
  const repositoryIds = useMemo(() => runningCandidates(sessions).slice(0, HOME_RUNNING_SHOWN).flatMap((session) => (session.repositoryId ? [session.repositoryId] : [])), [sessions]);
  const boards = useTaskBoards(repositoryIds);
  const now = useMinuteClock();
  const running = useMemo(() => runningSessions(sessions, names, boards, now), [sessions, names, boards, now]);
  const showRunning = running.total > 0 && running.settled;

  return <section className={styles.continue} aria-labelledby={headingId} aria-busy={!ready || undefined}>
    <header className={styles.heading}>
      <h2 id={headingId}>Continue{showRunning && <span className={styles.count}> · {running.total} running</span>}</h2>
      <Link ref={browseRef} className="commandQuietAction" href="/sessions">Browse sessions<CommandIcon name="arrow" size="small" /></Link>
    </header>
    {!ready ? <p className={styles.quiet} role="status">Loading your shortcuts…</p> : <>
      {showRunning ? <HomeRunningList sessions={running.shown} /> : running.total === 0 && <div className={styles.last}>
        {lastViewed ? <Link className={styles.returnLink} href={lastViewed.href} aria-label={`Open last viewed session: ${lastViewed.title}`}><CommandIcon name="session" /><span><small>Last viewed session</small><strong>{lastViewed.title}</strong><span>{lastViewed.detail}</span></span><CommandIcon name="arrow" size="small" /></Link>
          : <p>{lastViewedSessionId ? (catalogLoading ? "Finding your last viewed session…" : "Your last viewed session is not in the current catalog. Browse sessions to find another.") : "Open a session to inspect its agents and recorded evidence. A shortcut back to it will appear here."}</p>}
      </div>}

      <div className={styles.pinned}>
        {pins.length > 0 && <>
          <span id="home-pins-heading" className={styles.pinnedLabel}>Pinned</span>
          <ul className={styles.pinList} aria-labelledby="home-pins-heading">
            {pins.map((pin, index) => {
              const destination = destinations.find((item) => samePin(item, pin));
              const missingTitle = pin.kind === "project" ? pin.id : "Pinned session";
              return <li key={`${pin.kind}:${pin.id}`}>
                {destination ? <Link href={destination.href} aria-label={`${destination.title} · ${destination.detail}`} className={styles.pinLink}>{destination.title}</Link>
                  : <span className={styles.pinUnavailable} title={catalogLoading ? "Loading destination…" : "Not in the current catalog"}>{missingTitle}</span>}
                <button className={styles.removePin} type="button" aria-label={`Unpin ${destination?.title || `${missingTitle} ${index + 1}`}`} onClick={() => { togglePin(pin); setPinAnnouncement("Destination removed from Home."); pickerSummaryRef.current?.focus(); }}><CommandIcon name="close" size="small" /></button>
              </li>;
            })}
          </ul>
        </>}
        <details ref={pickerRef} className={styles.pinDisclosure} onToggle={(event) => setPickerOpen(event.currentTarget.open)}>
          <summary ref={pickerSummaryRef}>Add pins<CommandIcon name="pin" size="small" /></summary>
          {pickerOpen && <PinPicker destinations={destinations} pins={pins} onToggle={togglePin} catalogLoading={catalogLoading} />}
          <button type="button" className="commandSecondaryAction" onClick={() => { if (pickerRef.current) pickerRef.current.open = false; pickerSummaryRef.current?.focus(); }}>Done</button>
        </details>
      </div>
      {!persistent && <p className={styles.quiet} role="status">Browser storage is unavailable. Your Home preferences will last until this page is closed.</p>}
      {catalogUnavailable && <p className={styles.quiet}>The local monitor is reconnecting. Saved pins are kept; some destinations may be unavailable.</p>}
    </>}
    <span className="srOnly" role="status">{pinAnnouncement}</span>
  </section>;
}
