"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SessionSummaryDomain } from "../../../shared/session-domain-contract";
import type { SessionTab } from "./session-route";

const PRIMARY_PHONE_TABS: SessionTab[] = ["overview", "agents", "activities", "repository"];
const SECONDARY_TABS: SessionTab[] = ["signals", "resources", "details"];
const ALL_TABS: SessionTab[] = ["overview", "agents", "activities", "repository", "signals", "resources", "details"];
const LABELS: Record<SessionTab, string> = {
  overview: "Overview",
  agents: "Agents",
  activities: "Activities",
  signals: "Signals",
  repository: "Repository",
  resources: "Resources",
  details: "Details",
};

// Session panel content lives in app/Dashboard.tsx, which owns the single
// rendered tabpanel. That panel must carry id="session-tab-panel" and
// aria-labelledby={`session-tab-${activeTab}`} to match the ids below.
const PANEL_ID = "session-tab-panel";

export function SessionTabs({ active, summary, onSelect }: {
  active: SessionTab;
  summary: SessionSummaryDomain;
  onSelect: (tab: SessionTab) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const phoneButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const moreMenu = useRef<HTMLDivElement | null>(null);
  const menuItems = useRef<Array<HTMLButtonElement | null>>([]);
  // Historical sessions report resourceAvailability.hasData as null (readiness
  // never reaches "ready" because resource metrics are live-only), so only
  // show the Resources tab when there is confirmed data to show. A live
  // session's resource readiness can still be "loading": that is not yet
  // known to be hidden, so it must not be treated the same as a resolved
  // "no data" or "unavailable" outcome.
  const resourcesReadiness = summary.resourceAvailability.readiness;
  const resourcesHasData = summary.resourceAvailability.hasData;
  const showResources = resourcesHasData === true;
  const resourcesDefinitivelyHidden = !showResources && resourcesReadiness !== "loading";
  const available = ALL_TABS.filter((tab) => tab !== "resources" || showResources);
  const menuTabs = SECONDARY_TABS.filter((tab) => available.includes(tab));

  // If the active tab (e.g. from ?tab=resources) is hidden, such as on a
  // historical session with no resource data, fall back to Overview. Redirect
  // only once readiness has resolved (ready-with-no-data or unavailable);
  // while a live session's resource readiness is still loading, stay put so
  // a `?tab=resources` deep link is not rewritten out from under it.
  useEffect(() => {
    if (active !== "resources") return;
    if (resourcesDefinitivelyHidden) onSelect("overview");
  }, [active, resourcesDefinitivelyHidden, onSelect]);

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
    buttons.current[next]?.focus();
  };
  const phoneKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const count = PRIMARY_PHONE_TABS.length;
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
    phoneButtons.current[next]?.focus();
  };
  const menuKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? menuTabs.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + menuTabs.length) % menuTabs.length;
      menuItems.current[next]?.focus();
    }
  };
  const chooseFromMenu = (tab: SessionTab) => {
    setMoreOpen(false);
    onSelect(tab);
    moreButton.current?.focus();
  };
  useEffect(() => {
    if (!moreOpen) return;
    menuItems.current[0]?.focus();
    const pointer = (event: PointerEvent) => { if (!moreMenu.current?.contains(event.target as Node) && !moreButton.current?.contains(event.target as Node)) setMoreOpen(false); };
    const keyboard = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setMoreOpen(false); moreButton.current?.focus(); } };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", keyboard); };
  }, [moreOpen]);
  const count = (tab: SessionTab) => {
    if (tab === "agents" && summary.sectionReadiness.agentEvidence === "ready") return summary.metrics.agents;
    if (tab === "activities" && summary.sectionReadiness.activityEvidence === "ready") return summary.activity.total;
    // Repository counts the files this session affected (its Touched here list) and omits the
    // chip for a zero or unknown value rather than showing "0".
    if (tab === "repository" && summary.repository.touchedFiles) return summary.repository.touchedFiles;
    return null;
  };

  return <div className="sessionTabsShell">
    <nav className="sessionTabs sessionDesktopTabs" aria-label="Session sections" role="tablist">
      {available.map((tab, index) => <button key={tab} id={`session-tab-${tab}`} ref={(node) => { buttons.current[index] = node; }} type="button" role="tab"
        aria-selected={active === tab} aria-controls={PANEL_ID} tabIndex={active === tab ? 0 : -1} onKeyDown={(event) => keyDown(event, index)} onClick={() => onSelect(tab)}>
        {LABELS[tab]}{count(tab) === null ? null : <span>{count(tab)?.toLocaleString()}</span>}
      </button>)}
    </nav>
    <nav className="sessionTabs sessionPhoneTabs" aria-label="Session navigation">
      <div className="sessionPhoneTablist" role="tablist" aria-label="Session sections">
        {PRIMARY_PHONE_TABS.map((tab, index) => <button key={tab} id={`session-tab-phone-${tab}`} ref={(node) => { phoneButtons.current[index] = node; }} type="button" role="tab"
          aria-selected={active === tab} aria-controls={PANEL_ID} tabIndex={active === tab || (!PRIMARY_PHONE_TABS.includes(active) && index === 0) ? 0 : -1}
          onKeyDown={(event) => phoneKeyDown(event, index)} onClick={() => onSelect(tab)}>{tab === "repository" ? "Repo" : LABELS[tab]}{tab === "agents" && count(tab) !== null && <span>{count(tab)?.toLocaleString()}</span>}</button>)}
      </div>
      {menuTabs.length > 0 && <button ref={moreButton} id="session-tab-more" type="button" className={SECONDARY_TABS.includes(active) ? "active" : undefined}
        aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}>More<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 6l5 5 5-5" /></svg></button>}
    </nav>
    {moreOpen && <div ref={moreMenu} className="sessionMoreMenu" role="menu" aria-label="More session sections">
      {menuTabs.map((tab, index) => <button className="commandQuietAction" role="menuitem" type="button" key={tab}
        ref={(node) => { menuItems.current[index] = node; }} aria-current={active === tab ? "true" : undefined}
        onKeyDown={(event) => menuKeyDown(event, index)} onClick={() => chooseFromMenu(tab)}>{LABELS[tab]}</button>)}
    </div>}
  </div>;
}
