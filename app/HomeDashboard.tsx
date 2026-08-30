"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../shared/monitor-contract";
import { encodeSessionRoute } from "../shared/session-route.mjs";
import { CommandIcon, type CommandIconName } from "./components/command-center/CommandIcon";
import { useSessionCatalog } from "./hooks/SessionCatalogContext";
import { HOME_PIN_LIMIT, normalizeHomePin, useHomePreferences, type HomePin } from "./hooks/useHomePreferences";
import styles from "./HomeDashboard.module.css";

/* Approved Home direction: personal navigation within the existing Command Center.
   First viewport: grouped session navigation at left; concrete session guides at right.
   A prominent dismissible update precedes session navigation; the roadmap follows.
   Pins are local identities, never live metric cards; no Home or usage polling. */

type Destination = HomePin & { title: string; detail: string; href: string; icon: CommandIconName };
const VIEWS: Destination[] = [
  { kind: "view", id: "sessions", title: "Sessions", detail: "Live and historical sessions", href: "/sessions", icon: "sessions" },
  { kind: "view", id: "dashboards", title: "Dashboards", detail: "Built-in views", href: "/dashboards", icon: "dashboard" },
  { kind: "view", id: "agents", title: "Agent operations", detail: "Session-level agent evidence", href: "/agents", icon: "agents" },
  { kind: "view", id: "usage-limits", title: "Usage limits", detail: "Provider account windows", href: "/usage-limits", icon: "limits" },
  { kind: "view", id: "repositories", title: "Repositories", detail: "Observed projects", href: "/repositories", icon: "repositories" },
];
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
      <label>Destination type<select value={kind} onChange={(event) => { setKind(event.target.value as HomePin["kind"]); setQuery(""); }}>
        <option value="session">Sessions</option><option value="project">Projects</option><option value="view">Views</option>
      </select></label>
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
    {!matches.length && <p className={styles.pickerHint}>{catalogLoading && kind !== "view" ? "Loading destinations from the local monitor…" : "No matching destinations."}</p>}
    {matches.length > 20 && <p className={styles.pickerHint}>Showing the first 20 matches. Search to narrow the list.</p>}
    <p className={styles.pickerHint}>{pins.length >= HOME_PIN_LIMIT ? "All six pins are in use. Remove one to add another." : "Choose up to six destinations. Your pins stay in this browser."}</p>
    <span className="srOnly" role="status">{announcement}</span>
  </div>;
}

export function HomeDashboard() {
  const { sessions, loading, connected, readiness } = useSessionCatalog();
  const { pins, lastViewedSessionId, ready, persistent, togglePin, updateDismissed, dismissUpdate } = useHomePreferences();
  const destinations = useMemo(() => destinationsFor(sessions), [sessions]);
  const lastViewed = destinations.find((destination) => destination.kind === "session" && destination.id === lastViewedSessionId);
  const browseRef = useRef<HTMLAnchorElement>(null);
  const pickerRef = useRef<HTMLDetailsElement>(null);
  const pickerSummaryRef = useRef<HTMLElement>(null);
  const catalogLoading = loading || readiness.catalog === "loading";
  const catalogUnavailable = !connected || readiness.catalog === "unavailable";
  const [pinAnnouncement, setPinAnnouncement] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  return <section className={`commandView commandHome ${styles.home}`} aria-labelledby="home-heading">
    <header className={styles.intro}>
      <h1 id="home-heading">Welcome to Pomegr</h1>
      <p>Understand your coding sessions. Build on what you learn.</p>
    </header>

    {ready && !updateDismissed && <aside className={styles.news} aria-labelledby="home-news-heading">
      <h2 id="home-news-heading">What’s new</h2>
      <div><h3>Personal shortcuts on Home</h3><p>Pin sessions, projects, and views in this browser, and reopen your last viewed session.</p></div>
      <details><summary>About this update<CommandIcon name="arrow" size="small" /></summary><p>Home keeps your shortcuts in this browser. Session activity lives in Sessions, and account windows live in Usage limits.</p></details>
      <button type="button" className={styles.dismissNews} aria-label="Dismiss this update" onClick={() => { dismissUpdate(); browseRef.current?.focus(); }}><CommandIcon name="close" /></button>
    </aside>}

    <div className={styles.workspace}>
      <section className={styles.sessions} aria-labelledby="home-sessions-heading" aria-busy={!ready || undefined}>
        <header className={styles.sectionHeading}>
          <div><h2 id="home-sessions-heading">Sessions</h2><p>Open recorded work or return to a saved destination.</p></div>
          <Link ref={browseRef} className={`commandSecondaryAction ${styles.browse}`} href="/sessions">Browse sessions<CommandIcon name="arrow" size="small" /></Link>
        </header>
        {!ready ? <p className={styles.quiet} role="status">Loading your shortcuts…</p> : <>
          <div className={styles.lastSession}>
            {lastViewed ? <Link className={styles.returnLink} href={lastViewed.href} aria-label={`Open last viewed session: ${lastViewed.title}`}><CommandIcon name="session" /><span><small>Last viewed session</small><strong>{lastViewed.title}</strong><span>{lastViewed.detail}</span></span><CommandIcon name="arrow" size="small" /></Link>
              : <p>{lastViewedSessionId ? (catalogLoading ? "Finding your last viewed session…" : "Your last viewed session is not in the current catalog. Browse sessions to find another.") : "Open a session to inspect its agents and recorded evidence. A shortcut back to it will appear here."}</p>}
          </div>

          <div className={styles.pins}>
            <h3 id="home-pins-heading">Pinned destinations</h3>
            {pins.length ? <ul className={styles.pinList} aria-labelledby="home-pins-heading">
              {pins.map((pin, index) => {
                const destination = destinations.find((item) => samePin(item, pin));
                const missingTitle = pin.kind === "project" ? pin.id : "Pinned session";
                return <li key={`${pin.kind}:${pin.id}`}>
                  {destination ? <Link href={destination.href} aria-label={`${destination.title} · ${destination.detail}`} className={styles.pinLink}><CommandIcon name={destination.icon} /><span><strong>{destination.title}</strong><small>{destination.detail}</small></span></Link> : <div className={styles.pinUnavailable}><CommandIcon name={pin.kind === "project" ? "repositories" : "session"} /><span><strong>{missingTitle}</strong><small>{catalogLoading ? "Loading destination…" : "Not in the current catalog"}</small></span></div>}
                  <button className={styles.removePin} type="button" aria-label={`Unpin ${destination?.title || `${missingTitle} ${index + 1}`}`} onClick={() => { togglePin(pin); setPinAnnouncement("Destination removed from Home."); pickerSummaryRef.current?.focus(); }}><CommandIcon name="close" size="small" /></button>
                </li>;
              })}
            </ul> : <p className={styles.emptyPins}>Keep frequently used sessions, projects, and views one click away.</p>}
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
      </section>

      <section className={styles.guides} aria-labelledby="home-guides-heading">
        <h2 id="home-guides-heading">Understand your sessions</h2>
        <article>
          <h3>Inspect context changes</h3>
          <p>Open a session’s Context history to see recorded snapshots and compaction boundaries, when available. Select an agent to focus the timeline.</p>
          <Link className={styles.textLink} href={lastViewed?.href || "/sessions"}>Inspect a session<CommandIcon name="arrow" size="small" /></Link>
        </article>
        <article>
          <h3>Download a session report</h3>
          <p>Keep a retrospective of recorded session metadata. Open a session, then choose “Download report”.</p>
          <Link className={styles.textLink} href="/sessions">Choose a session<CommandIcon name="arrow" size="small" /></Link>
        </article>
      </section>
    </div>

    <div className={styles.roadmap}>
      <section className={styles.coach} aria-labelledby="home-coach-heading">
        <div className={styles.coachIntro}><div className={styles.coachHeading}><h2 id="home-coach-heading">Session coach</h2><span className={styles.soon}>Coming soon</span></div><h3>A fresh perspective<br />on how you work.</h3><p>An integrated agent to help you understand your coding sessions and find practical ways to improve your next one.</p></div>
        <div className={styles.coachQuestions}><p>Questions you’ll be able to explore</p><ul><li>What contributed to this context increase?</li><li>Where did this session repeat work?</li><li>What could I try differently next time?</li></ul></div>
        <p className={styles.coachBoundary}>Planned: read-only guidance grounded in a session you choose, with links to recorded evidence. Suggestions will distinguish facts from interpretations. Sending metadata to a model will require your opt-in.</p>
      </section>

      <section className={styles.next} aria-label="More coming soon">
        <article><div><h2>Saved views</h2><span className={styles.soon}>Coming soon</span></div><p>Keep a preferred combination of projects, providers, and session filters ready to reopen.</p></article>
        <article><div><h2>Session comparison</h2><span className={styles.soon}>Coming soon</span></div><p>Inspect two sessions side by side, from context snapshots and wall time to recorded events.</p></article>
      </section>
    </div>
  </section>;
}
