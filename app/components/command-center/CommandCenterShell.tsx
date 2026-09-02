"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import type { SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import pomegrPluginManifest from "../../../plugins/pomegr/.codex-plugin/plugin.json";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { DesktopUpdateOffer } from "../DesktopUpdateOffer";
import { ExternalLink } from "../ExternalLink";
import type { DesktopState } from "../DesktopControls";
import { PomegrBrand, type PomegrMarkVariant } from "../PomegrBrand";
import { ThemeToggle } from "../ThemeToggle";
import { CommandIcon, type CommandIconName } from "./CommandIcon";

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
  { href: "/dashboards", label: "Dashboards", icon: "grid" },
  { href: "/sessions", label: "Sessions", icon: "session", match: (pathname) => pathname === "/sessions" || pathname.startsWith("/sessions/") },
  { href: "/agents", label: "Agents", icon: "agents" },
];

const systemNavigation: NavigationItem[] = [
  { href: "/usage-limits", label: "Usage limits", icon: "chart" },
  { href: "/repositories", label: "Repositories", icon: "git" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

const destinationTerms: Array<[RegExp, string]> = [
  [/dashboard|overview|workspace/i, "/dashboards"],
  [/session|history/i, "/sessions"],
  [/agent|topology/i, "/agents"],
  [/usage|limit|quota/i, "/usage-limits"],
  [/repo|git|branch/i, "/repositories"],
  [/setting|preference|notification|appearance/i, "/settings"],
  [/home/i, "/"],
];

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

function NotificationCenter({ sessions, connected, loading, onClose }: {
  sessions: SessionSummary[];
  connected: boolean;
  loading: boolean;
  onClose: (returnFocus?: boolean) => void;
}) {
  const needsInput = sessions.filter((session) => session.isLive && (session.needsInput || session.activityStatus === "needs_input"));
  const [read, setRead] = useState(false);
  const unreadCount = read ? 0 : needsInput.length + 1;
  return (
    <aside className="commandNotificationTray" id="command-notification-tray" aria-label="Notifications">
      <header>
        <div><h2>Notifications</h2><p>Local events that may need your attention</p></div>
        <div className="commandNotificationActions">
          <button type="button" onClick={() => setRead(true)} disabled={read}>{read ? "All read" : "Mark all read"}</button>
          <button className="commandIconButton" type="button" onClick={() => onClose()} aria-label="Close notifications"><CommandIcon name="close" /></button>
        </div>
      </header>
      {needsInput.length > 0 ? <>
        <div className="commandNotificationGroup"><span>Needs attention</span><b>{read ? 0 : needsInput.length}</b></div>
        {needsInput.slice(0, 4).map((session) => <article className={`commandNotificationEntry${read ? " isRead" : ""}`} key={session.id}>
          <i className="commandStatusDot attention" />
          <div><strong>{session.title}</strong><p>This live session is waiting for input. Session-reported state may be stale.</p><Link href={`/sessions/${encodeSessionRoute(session.id)}`} onClick={() => onClose(false)}>Open session</Link></div>
          <time>Now</time>
        </article>)}
      </> : <div className="commandNotificationEmpty"><CommandIcon name="bell" /><strong>No session needs attention</strong><p>Pomegr will keep observing local session state.</p></div>}
      <div className="commandNotificationGroup"><span>System</span><b>{read ? 0 : 1}</b></div>
      <article className={`commandNotificationEntry${read ? " isRead" : ""}`}>
        <i className={`commandStatusDot ${connected ? "online" : "offline"}`} />
        <div><strong>{loading ? "Connecting to monitor" : connected ? "Local monitor connected" : "Monitor unavailable"}</strong><p>{connected ? "The latest committed normalized state is available. No conversation content is exposed." : "Pomegr will retry automatically while preserving the last known-good state."}</p><Link href="/" onClick={() => onClose(false)}>View workspace</Link></div>
        <time>Now</time>
      </article>
      <footer aria-live="polite">{unreadCount ? `${unreadCount} unread ${unreadCount === 1 ? "notification" : "notifications"}` : "You are all caught up"}</footer>
    </aside>
  );
}

export function CommandCenterShell({ children, pathname, sessions, connected, loading, update = null, onInstallUpdate = () => {} }: CommandCenterShellProps) {
  const router = useRouter();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [markVariant, setMarkVariant] = useState<PomegrMarkVariant>("divided");
  const [query, setQuery] = useState("");
  const shortcutHint = useSyncExternalStore(subscribeToPlatformHint, getClientShortcutHint, getServerShortcutHint);
  const notificationWrapRef = useRef<HTMLDivElement | null>(null);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const profileWrapRef = useRef<HTMLDivElement | null>(null);
  const mobileNavigationRef = useRef<HTMLElement | null>(null);
  const mobileNavigationButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileSearchButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const liveSessionCount = sessions.filter((session) => session.isLive).length;
  const navigation = useMemo(() => primaryNavigation.map((item) => item.href === "/sessions" ? { ...item, count: liveSessionCount } : item), [liveSessionCount]);
  const hasNeedsInput = sessions.some((session) => session.isLive && (session.needsInput || session.activityStatus === "needs_input"));

  const closeNotifications = useCallback((returnFocus = true) => {
    setNotificationsOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => notificationButtonRef.current?.focus());
  }, []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  const closeMobileNavigation = useCallback((returnFocus = true) => {
    setMobileNavigationOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => mobileNavigationButtonRef.current?.focus());
  }, []);
  const closeMobileSearch = useCallback((returnFocus = true) => {
    setMobileSearchOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => mobileSearchButtonRef.current?.focus());
  }, []);
  useDismissibleLayer(notificationsOpen, notificationWrapRef, () => closeNotifications(), true);
  useDismissibleLayer(profileOpen, profileWrapRef, closeProfile, true);
  useDismissibleLayer(mobileNavigationOpen, mobileNavigationRef, () => closeMobileNavigation(), false);

  useEffect(() => {
    if (mobileSearchOpen) searchRef.current?.focus();
  }, [mobileSearchOpen]);

  useEffect(() => {
    const readVariant = () => setMarkVariant(pomegrMarkVariantForSearch(window.location.search));
    readVariant();
    window.addEventListener("popstate", readVariant);
    return () => window.removeEventListener("popstate", readVariant);
  }, []);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileSearchOpen(true);
        window.requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
      } else if (event.key === "Escape" && mobileSearchOpen) {
        event.preventDefault();
        closeMobileSearch();
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [closeMobileSearch, mobileSearchOpen]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const destination = destinationTerms.find(([pattern]) => pattern.test(query))?.[1];
    if (destination) {
      router.push(destination);
      setQuery("");
      setMobileSearchOpen(false);
    }
  };

  return (
    <div className="commandShell">
      <header className={`commandHeader${mobileSearchOpen ? " isSearchOpen" : ""}`}>
        <button ref={mobileNavigationButtonRef} className="commandIconButton commandMenuButton" type="button" aria-label={mobileNavigationOpen ? "Close primary menu" : "Open primary menu"} aria-controls="command-primary-navigation" aria-expanded={mobileNavigationOpen} onClick={() => {
          setNotificationsOpen(false);
          setProfileOpen(false);
          setMobileSearchOpen(false);
          setMobileNavigationOpen((open) => !open);
        }}><CommandIcon name={mobileNavigationOpen ? "close" : "menu"} /></button>
        <PomegrBrand href="/" label="Pomegr home" markVariant={markVariant} />
        <button className="commandIconButton commandMobileSearchClose" type="button" aria-label="Close search" onClick={() => closeMobileSearch()}><CommandIcon name="close" /></button>
        <form className="commandSearch" id="command-global-search" role="search" onSubmit={search}>
          <CommandIcon name="search" />
          <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} aria-label="Search Pomegr destinations" placeholder="Search dashboards, sessions, and agents" />
          <kbd>{shortcutHint}</kbd>
        </form>
        <span className={`commandEnvironment ${loading ? "loading" : connected ? "online" : "offline"}`}><i />{loading ? "Connecting" : connected ? "Local monitor" : "Monitor offline"}</span>
        <div className="commandHeaderTools">
          <button ref={mobileSearchButtonRef} className="commandIconButton commandMobileSearchButton" type="button" aria-label="Open search" aria-controls="command-global-search" aria-expanded={mobileSearchOpen} onClick={() => {
            setNotificationsOpen(false);
            setProfileOpen(false);
            setMobileNavigationOpen(false);
            setMobileSearchOpen(true);
          }}><CommandIcon name="search" /></button>
          <div className="commandNotificationWrap" ref={notificationWrapRef}>
            <button ref={notificationButtonRef} className="commandIconButton commandBell" type="button" aria-label={`Notifications${hasNeedsInput ? ", attention available" : ""}`} aria-controls="command-notification-tray" aria-expanded={notificationsOpen} onClick={() => { setProfileOpen(false); setNotificationsOpen((open) => !open); }}>
              <CommandIcon name="bell" />
              {hasNeedsInput && <i aria-hidden="true" />}
            </button>
            {notificationsOpen && <NotificationCenter sessions={sessions} connected={connected} loading={loading} onClose={closeNotifications} />}
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
              <Link href="/about" onClick={closeProfile}>About Pomegr</Link>
              <div className="commandProfileTheme"><span>Appearance</span><ThemeToggle /></div>
            </div>}
          </div>
        </div>
      </header>

      {mobileNavigationOpen && <button className="commandNavScrim" type="button" aria-label="Close primary menu" onClick={() => closeMobileNavigation()} />}
      <aside ref={mobileNavigationRef} className={`commandSidebar${mobileNavigationOpen ? " isOpen" : ""}`} id="command-primary-navigation" aria-label="Primary navigation">
        <nav>{navigation.map((item) => <NavigationLink key={item.href} item={item} pathname={pathname} onNavigate={() => closeMobileNavigation(false)} />)}</nav>
        <div className="commandNavDivider" />
        <nav>{systemNavigation.map((item) => <NavigationLink key={item.href} item={item} pathname={pathname} onNavigate={() => closeMobileNavigation(false)} />)}</nav>
        <div className="commandSidebarFoot">
          <div className="commandNavDivider" aria-hidden="true" />
          {update?.version && (update.status === "ready" || update.status === "installing") ? <DesktopUpdateOffer version={update.version} installing={update.status === "installing"} onInstall={onInstallUpdate} /> : null}
          <span>{loading ? "Connecting to the local observer." : connected ? "Session data remains on this machine." : "Local observer unavailable. Showing last known-good state."}</span>
          <strong>Pomegr v0.2.0</strong>
          <small>MCP v{pomegrPluginManifest.version}</small>
        </div>
      </aside>

      <main className="commandMain" id="main-content">{children}</main>
    </div>
  );
}
