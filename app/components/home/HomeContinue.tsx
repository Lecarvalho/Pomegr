"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState, type Ref } from "react";
import type { SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { useSessionCatalog } from "../../hooks/SessionCatalogContext";
import { HOME_PIN_LIMIT, normalizeHomePin, type HomePin, type HomePreferences } from "../../hooks/useHomePreferences";
import { CommandIcon, type CommandIconName } from "../command-center/CommandIcon";
import { CommandSelect, type CommandSelectOption } from "../command-center/CommandPage";
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

/** The last viewed session, the pinned destinations, and the picker that pins more. The session catalog and the preferences are the only things it reads. */
export function HomeContinue({ preferences, browseRef }: { preferences: HomePreferences; browseRef?: Ref<HTMLAnchorElement> }) {
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

  return <section className={styles.continue} aria-labelledby={headingId} aria-busy={!ready || undefined}>
    <header className={styles.heading}>
      <h2 id={headingId}>Continue</h2>
      <Link ref={browseRef} className="commandQuietAction" href="/sessions">Browse sessions<CommandIcon name="arrow" size="small" /></Link>
    </header>
    {!ready ? <p className={styles.quiet} role="status">Loading your shortcuts…</p> : <>
      <div className={styles.last}>
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
  </section>;
}
