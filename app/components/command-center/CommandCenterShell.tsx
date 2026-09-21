"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import pomegrPackageManifest from "../../../package.json";
import pomegrPluginManifest from "../../../plugins/pomegr/.codex-plugin/plugin.json";
import { useProviderStatus } from "../../provider-status-client";
import { NotificationCenter, useNotifications } from "./NotificationCenter";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { DesktopUpdateOffer } from "../DesktopUpdateOffer";
import { ExternalLink } from "../ExternalLink";
import type { DesktopState } from "../DesktopControls";
import { PomegrBrand, type PomegrMarkVariant } from "../PomegrBrand";
import { ThemeToggle } from "../ThemeToggle";
import { CommandIcon, type CommandIconName } from "./CommandIcon";
import { useRepositoryInventory } from "../../repository-inventory-client";
import { useUsageLimits } from "../../usage-limits-client";

export function shortcutHintForPlatform(platform?: string) {
  const value = platform ?? (typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`);
  return /mac|iphone|ipad|ipod|ios/i.test(value) ? "⌘ K" : "Ctrl K";
}

function subscribeToPlatformHint() { return () => {}; }
function getClientShortcutHint() { return shortcutHintForPlatform(); }
function getServerShortcutHint() { return "⌘ K"; }

type CommandCenterShellProps = {
  children: ReactNode;
  pathname: string;
  sessions: SessionSummary[];
  connected: boolean;
  loading: boolean;
  update?: DesktopState["update"] | null;
  onInstallUpdate?: () => void;
};

type NavigationItem = {
  href: string;
  label: string;
  icon: CommandIconName;
  count?: number;
  match?: (pathname: string) => boolean;
};

const primaryNavigation: NavigationItem[] = [
  { href: "/", label: "Home", icon: "home", match: (pathname) => pathname === "/" },
  { href: "/sessions", label: "Sessions", icon: "session", match: (pathname) => pathname === "/sessions" || pathname.startsWith("/sessions/") },
  { href: "/repositories", label: "Repositories", icon: "git", match: (pathname) => pathname === "/repositories" || pathname.startsWith("/repositories/") },
  { href: "/agents", label: "Models & delegation", icon: "agents" },
];

const systemNavigation: NavigationItem[] = [
  { href: "/usage-limits", label: "Usage limits", icon: "chart" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

const destinationTerms: Array<[RegExp, string]> = [
  [/session|history/i, "/sessions"],
  [/agent|topology|model|delegat/i, "/agents"],
  [/usage|limit|quota/i, "/usage-limits"],
  [/repo|git|branch/i, "/repositories"],
  [/setting|preference|notification|appearance/i, "/settings"],
  [/home/i, "/"],
];

type PaletteResult = { id: string; href: string; label: string; detail: string; icon: CommandIconName };

function Palette({ open, onClose, query, onQueryChange, results, onSelect, inputRef }: {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  results: PaletteResult[];
  onSelect: (result: PaletteResult) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedIndex = Math.min(activeIndex, Math.max(0, results.length - 1));
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key === "Tab") { event.preventDefault(); inputRef.current?.focus(); return; }
      if (!results.length) return;
      if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => (current + 1) % results.length); }
      if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => (current - 1 + results.length) % results.length); }
      if (event.key === "Enter") { event.preventDefault(); const selected = results[selectedIndex]; if (selected) onSelect(selected); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [inputRef, onClose, onSelect, open, results, selectedIndex]);
  useEffect(() => { if (open) document.getElementById("command-palette-input")?.focus(); }, [open]);
  if (!open) return null;
  return <div className="commandPaletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="commandPalette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
      <header><CommandIcon name="search" /><label id="command-palette-title" className="commandVisuallyHidden" htmlFor="command-palette-input">Search Pomegr</label><input ref={inputRef} id="command-palette-input" role="combobox" aria-expanded="true" aria-controls="command-palette-results" aria-activedescendant={results[selectedIndex] ? `command-palette-${results[selectedIndex].id}` : undefined} value={query} onChange={(event) => onQueryChange(event.currentTarget.value)} placeholder="Search destinations, sessions, and repositories" autoComplete="off" /><kbd>Esc</kbd></header>
      <div className="commandPaletteResults" id="command-palette-results" role="listbox" aria-label="Search results">
        {results.map((result, index) => <button type="button" id={`command-palette-${result.id}`} key={result.id} role="option" tabIndex={-1} aria-selected={index === selectedIndex} className={`commandQuietAction commandPaletteOption${index === selectedIndex ? " active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => { event.preventDefault(); onSelect(result); }}><CommandIcon name={result.icon} /><span><strong>{result.label}</strong><small>{result.detail}</small></span><CommandIcon name="arrow" size="small" /></button>)}
        {!results.length && <p>No destinations match that search.</p>}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span></footer>
    </section>
  </div>;
}

function isCurrent(item: NavigationItem, pathname: string) {
  return item.match ? item.match(pathname) : pathname === item.href;
}

export function pomegrMarkVariantForSearch(search = ""): PomegrMarkVariant {
  return new URLSearchParams(search).get("logo") === "outline" ? "outline" : "divided";
}

function NavigationLink({ item, pathname, onNavigate }: { item: NavigationItem; pathname: string; onNavigate?: () => void }) {
  const current = isCurrent(item, pathname);
  return (
    <Link className={`commandNavItem${current ? " active" : ""}`} href={item.href} aria-current={current ? "page" : undefined} aria-label={item.count === undefined ? item.label : `${item.label}, ${item.count} live`} onClick={onNavigate}>
      <CommandIcon name={item.icon} />
      <span>{item.label}</span>
      {item.count !== undefined && <em>{item.count}</em>}
    </Link>
  );
}

export type SidebarLimit = { provider: string; percent: number; label: string };

export function sidebarLimitsForCatalog(sessions: SessionSummary[], providers: ReturnType<typeof useUsageLimits>["providers"], referenceTime: number): SidebarLimit[] {
  const after = referenceTime - 7 * 24 * 60 * 60 * 1000;
  const recentProviders = new Set(sessions.filter((session) => {
    const createdAt = session.createdAt ? Date.parse(session.createdAt) : NaN;
    return Number.isFinite(createdAt) && createdAt >= after;
  }).map((session) => session.provider));
  return providers.flatMap((entry) => {
    if (!recentProviders.has(entry.provider)) return [];
    const tightest = [...(entry.usageLimits?.limits || [])].sort((left, right) => right.percent - left.percent)[0];
    return tightest ? [{ provider: entry.source, percent: Math.max(0, Math.min(100, tightest.percent)), label: tightest.window || tightest.label }] : [];
  });
}

export function CommandCenterShell({ children, pathname, sessions, connected, loading, update = null, onInstallUpdate = () => {} }: CommandCenterShellProps) {
  const router = useRouter();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [markVariant, setMarkVariant] = useState<PomegrMarkVariant>("divided");
  const [query, setQuery] = useState("");
  const [sidebarReferenceTime] = useState(() => Date.now());
  const shortcutHint = useSyncExternalStore(subscribeToPlatformHint, getClientShortcutHint, getServerShortcutHint);
  const notificationWrapRef = useRef<HTMLDivElement | null>(null);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const profileWrapRef = useRef<HTMLDivElement | null>(null);
  const mobileNavigationRef = useRef<HTMLElement | null>(null);
  const mobileNavigationButtonRef = useRef<HTMLButtonElement | null>(null);
  const paletteButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const liveSessionCount = sessions.filter((session) => session.isLive).length;
  const navigation = useMemo(() => primaryNavigation.map((item) => item.href === "/sessions" ? { ...item, count: liveSessionCount } : item), [liveSessionCount]);
  const { providers } = useProviderStatus();
  const usageLimits = useUsageLimits();
  const { snapshot: repositorySnapshot } = useRepositoryInventory();
  const notifications = useNotifications(sessions, providers, connected, loading);
  const hasAttention = notifications.hasUnreadAttention;

  const paletteResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const destinations: PaletteResult[] = [
      { id: "home", href: "/", label: "Home", detail: "Your pinned workspace", icon: "home" },
      { id: "sessions", href: "/sessions", label: "Sessions", detail: "Live and recorded work", icon: "sessions" },
      { id: "repositories", href: "/repositories", label: "Repositories", detail: "Observed projects", icon: "repositories" },
      { id: "agents", href: "/agents", label: "Models & delegation", detail: "Model, role, and work analysis", icon: "agents" },
      { id: "usage-limits", href: "/usage-limits", label: "Usage limits", detail: "Provider account windows", icon: "chart" },
      { id: "settings", href: "/settings", label: "Settings", detail: "Local preferences", icon: "settings" },
    ];
    const recentSessions = sessions.slice(0, 5).map((session) => ({ id: `session-${session.id}`, href: `/sessions/${encodeSessionRoute(session.id)}`, label: session.title, detail: `Session · ${session.project}`, icon: "session" as const }));
    const recentRepositories = repositorySnapshot.repositories.slice(0, 5).map((repository) => ({ id: `repository-${repository.id}`, href: `/repositories/${repository.id}`, label: repository.displayName, detail: "Repository", icon: "repositories" as const }));
    const routedDestination = destinationTerms.find(([pattern]) => pattern.test(normalized))?.[1];
    const routed = routedDestination ? destinations.filter((result) => result.href === routedDestination) : [];
    const candidates = [...routed, ...destinations.filter((result) => result.href !== routedDestination), ...recentSessions, ...recentRepositories];
    return normalized ? candidates.filter((result) => `${result.label} ${result.detail}`.toLowerCase().includes(normalized)) : candidates;
  }, [query, repositorySnapshot.repositories, sessions]);

  const sidebarLimits = useMemo(() => sidebarLimitsForCatalog(sessions, usageLimits.providers, sidebarReferenceTime), [sessions, sidebarReferenceTime, usageLimits.providers]);

  const closeNotifications = useCallback((returnFocus = true) => {
    setNotificationsOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => notificationButtonRef.current?.focus());
  }, []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  const closeMobileNavigation = useCallback((returnFocus = true) => {
    setMobileNavigationOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => mobileNavigationButtonRef.current?.focus());
  }, []);
  const closePalette = useCallback((returnFocus = true) => {
    setPaletteOpen(false);
    setQuery("");
    if (returnFocus) paletteButtonRef.current?.focus();
  }, []);
  useDismissibleLayer(notificationsOpen, notificationWrapRef, () => closeNotifications(), true);
  useDismissibleLayer(profileOpen, profileWrapRef, closeProfile, true);
  useDismissibleLayer(mobileNavigationOpen, mobileNavigationRef, () => closeMobileNavigation(), false);

  useEffect(() => {
    const readVariant = () => setMarkVariant(pomegrMarkVariantForSearch(window.location.search));
    readVariant();
    window.addEventListener("popstate", readVariant);
    return () => window.removeEventListener("popstate", readVariant);
  }, []);

  const openPalette = useCallback(() => {
    setNotificationsOpen(false);
    setProfileOpen(false);
    setMobileNavigationOpen(false);
    setPaletteOpen(true);
  }, []);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
        window.requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
      } else if (event.key === "Escape" && paletteOpen) {
        event.preventDefault();
        closePalette();
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [closePalette, openPalette, paletteOpen]);
  const selectPaletteResult = useCallback((result: PaletteResult) => {
    router.push(result.href);
    closePalette(false);
  }, [closePalette, router]);

  return (
    <div className="commandShell">
      <header className="commandHeader">
        <button ref={mobileNavigationButtonRef} className="commandIconButton commandMenuButton" type="button" aria-label={mobileNavigationOpen ? "Close primary menu" : "Open primary menu"} aria-controls="command-primary-navigation" aria-expanded={mobileNavigationOpen} onClick={() => {
          setNotificationsOpen(false);
          setProfileOpen(false);
          setPaletteOpen(false);
          setMobileNavigationOpen((open) => !open);
        }}><CommandIcon name={mobileNavigationOpen ? "close" : "menu"} /></button>
        <PomegrBrand href="/" label="Pomegr home" markVariant={markVariant} />
        <button ref={paletteButtonRef} className="commandQuietAction commandPaletteTrigger" type="button" aria-label="Search Pomegr" aria-haspopup="dialog" aria-expanded={paletteOpen} onClick={openPalette}><CommandIcon name="search" /><span>Search</span><kbd>{shortcutHint}</kbd></button>
        <span className={`commandEnvironment ${loading ? "loading" : connected ? "online" : "offline"}`}><i />{loading ? "Connecting" : connected ? "Local monitor" : "Monitor offline"}</span>
        <div className="commandHeaderTools">
          <div className="commandNotificationWrap" ref={notificationWrapRef}>
            <button ref={notificationButtonRef} className="commandIconButton commandBell" type="button" aria-label={`Notifications${hasAttention ? ", attention available" : ""}`} aria-controls="command-notification-tray" aria-expanded={notificationsOpen} onClick={() => { setProfileOpen(false); setNotificationsOpen((open) => !open); }}>
              <CommandIcon name="bell" />
              {hasAttention && <i aria-hidden="true" />}
            </button>
            {notificationsOpen && <NotificationCenter {...notifications} onClose={closeNotifications} />}
          </div>
          <div className="commandProfileWrap" ref={profileWrapRef}>
            <button className="commandProfileButton" type="button" aria-label="Local profile, coming soon" aria-expanded={profileOpen} aria-controls="command-profile-menu" onClick={() => { setNotificationsOpen(false); setProfileOpen((open) => !open); }}>
              <span className="commandAvatar" aria-hidden="true">LP</span>
              <span><strong>Local profile</strong><small>Coming soon</small></span>
            </button>
            {profileOpen && <div className="commandProfileMenu" id="command-profile-menu">
              <header><strong>Local profile</strong><span>Workspace identity and preferences are coming soon.</span></header>
              <Link href="/settings" onClick={closeProfile}>Open settings</Link>
              <ExternalLink href="https://github.com/Lecarvalho/pomegr/blob/main/docs/user-guide/README.md" onClick={closeProfile}>Documentation</ExternalLink>
              <Link href="/settings?section=about" onClick={closeProfile}>About Pomegr</Link>
              <div className="commandProfileTheme"><span>Appearance</span><ThemeToggle /></div>
            </div>}
          </div>
        </div>
      </header>

      <Palette key={paletteOpen ? "open" : "closed"} open={paletteOpen} onClose={closePalette} query={query} onQueryChange={setQuery} results={paletteResults} onSelect={selectPaletteResult} inputRef={searchRef} />

      {mobileNavigationOpen && <button className="commandNavScrim" type="button" aria-label="Close primary menu" onClick={() => closeMobileNavigation()} />}
      <aside ref={mobileNavigationRef} className={`commandSidebar${mobileNavigationOpen ? " isOpen" : ""}`} id="command-primary-navigation" aria-label="Primary navigation">
        <nav>{navigation.map((item) => <NavigationLink key={item.href} item={item} pathname={pathname} onNavigate={() => closeMobileNavigation(false)} />)}</nav>
        <div className="commandNavDivider" />
        <nav>{systemNavigation.map((item) => <NavigationLink key={item.href} item={item} pathname={pathname} onNavigate={() => closeMobileNavigation(false)} />)}</nav>
        <div className="commandSidebarFoot">
          <div className="commandNavDivider" aria-hidden="true" />
          {update?.version && (update.status === "ready" || update.status === "installing") ? <DesktopUpdateOffer version={update.version} installing={update.status === "installing"} onInstall={onInstallUpdate} /> : null}
          {sidebarLimits.length > 0 && <section className="commandSidebarLimits" aria-label="Usage limits"><header><span>Usage limits</span><Link href="/usage-limits">View</Link></header>{sidebarLimits.map((limit) => <div key={limit.provider} className={`commandSidebarLimit ${limit.percent >= 85 ? "critical" : limit.percent >= 75 ? "warning" : "normal"}`}><span>{limit.provider}</span><strong>{Math.round(limit.percent)}% · {limit.label}</strong><i aria-hidden="true"><b style={{ width: `${limit.percent}%` }} /></i></div>)}</section>}
          <span>{loading ? "Connecting to the local observer." : connected ? "Session data remains on this machine." : "Local observer unavailable. Showing last known-good state."}</span>
          <strong>Pomegr v{pomegrPackageManifest.version}</strong>
          <small>MCP v{pomegrPluginManifest.version}</small>
        </div>
      </aside>

      <main className="commandMain" id="main-content">{children}</main>
    </div>
  );
}
