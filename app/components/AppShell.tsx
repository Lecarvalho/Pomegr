"use client";

import { usePathname, useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HomeReadiness, SessionCatalogSnapshot, SessionSummary } from "../../shared/monitor-contract";
import { decodeSessionRoute, encodeSessionRoute } from "../../shared/session-route.mjs";
import { preserveSessionOrder } from "../dashboard-utils";
import { LiveClockProvider } from "../hooks/LiveClockContext";
import { SessionCatalogProvider } from "../hooks/SessionCatalogContext";
import type { DesktopState } from "./DesktopControls";
import { publishNavigationState, subscribeToOpenNavigation } from "./app-navigation";
import { SessionSidebar } from "./dashboard/SessionSidebar";
import { useUsageLimitsPollingPause } from "../usage-limits-client";

type AppShellDesktopBridge = {
  getDesktopState(): Promise<DesktopState | null>;
  installUpdate(): Promise<DesktopState | null>;
  onDesktopStateChanged(callback: (state: DesktopState) => void): () => void;
};

function desktopBridge() {
  return (window as Window & { pomegrDesktop?: AppShellDesktopBridge }).pomegrDesktop;
}

function selectedSessionFromPath(pathname: string) {
  const match = /^\/sessions\/([^/]+)$/.exec(pathname);
  return match ? decodeSessionRoute(match[1]) : null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [liveSessions, setLiveSessions] = useState<SessionCatalogSnapshot["liveSessions"]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const [catalogReadiness, setCatalogReadiness] = useState<Pick<HomeReadiness, "catalog" | "sessionSummaries">>({ catalog: "loading", sessionSummaries: {} });
  const catalogRevisionRef = useRef<number | string | null>(null);
  const catalogReadinessRef = useRef(catalogReadiness);
  const sessionCountRef = useRef(0);
  const [navigationPath, setNavigationPath] = useState<string | null>(null);
  const [desktopState, setDesktopState] = useState<DesktopState | null>(null);
  const navigationOpen = navigationPath === pathname;
  const selectedSessionId = useMemo(() => selectedSessionFromPath(pathname), [pathname]);
  const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null;
  useUsageLimitsPollingPause(Boolean(desktopState?.paused));

  useEffect(() => {
    document.documentElement.dataset.pomegrHydrated = "true";
    return () => { delete document.documentElement.dataset.pomegrHydrated; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    let retryAttempt = 0;
    let requestInFlight = false;
    let focusListener: (() => void) | null = null;
    let visibilityListener: (() => void) | null = null;
    if (desktopState?.paused) return () => controller.abort();

    const schedule = (delay: number) => {
      if (controller.signal.aborted) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void poll(); }, delay);
    };
    const poll = async () => {
      if (controller.signal.aborted || requestInFlight) return;
      requestInFlight = true;
      let succeeded = false;
      try {
        const query = catalogRevisionRef.current === null ? "" : `?revision=${encodeURIComponent(String(catalogRevisionRef.current))}`;
        const response = await fetch(`/api/sessions${query}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 204) {
          succeeded = true;
          retryAttempt = 0;
          return;
        }
        if (!response.ok) {
          if (!controller.signal.aborted) {
            setConnected(false);
            setLoading(false);
            setCatalogReadiness((current) => current.catalog === "loading" && sessionCountRef.current === 0 ? { ...current, catalog: "unavailable" } : current);
          }
          return;
        }
        const catalog = await response.json() as Partial<SessionCatalogSnapshot>;
        const nextSessions = Array.isArray(catalog.sessions) ? catalog.sessions : null;
        const nextLiveSessions = Array.isArray(catalog.liveSessions) ? catalog.liveSessions : null;
        if (!controller.signal.aborted && nextSessions && nextLiveSessions) {
          const nextReadiness = catalog.readiness || { catalog: "ready" as const, sessionSummaries: {} };
          startTransition(() => {
            setSessions((current) => preserveSessionOrder(current, nextSessions));
            setLiveSessions((current) => preserveSessionOrder(current, nextLiveSessions));
            const headerRevision = response.headers.get("x-pomegr-revision");
            const revision = typeof catalog.revision === "number" || typeof catalog.revision === "string" ? catalog.revision : headerRevision || catalogRevisionRef.current;
            catalogRevisionRef.current = revision;
            catalogReadinessRef.current = nextReadiness;
            sessionCountRef.current = nextSessions.length;
            setCatalogReadiness(nextReadiness);
            setConnected(true);
            setLoading(false);
          });
          succeeded = true;
        } else if (!controller.signal.aborted) {
          setConnected(false);
          setLoading(false);
        }
      } catch {
        // Keep the most recent safe catalog visible while the monitor reconnects.
        if (!controller.signal.aborted) {
          setConnected(false);
          setLoading(false);
          setCatalogReadiness((current) => current.catalog === "loading" && sessionCountRef.current === 0 ? { ...current, catalog: "unavailable" } : current);
        }
      } finally {
        requestInFlight = false;
        if (!controller.signal.aborted) {
          const delay = succeeded
          ? (document.hidden ? 30_000 : catalogReadinessRef.current.catalog === "loading" ? 1_000 : 5_000)
            : [2_000, 5_000, 10_000, 30_000][Math.min(retryAttempt++, 3)];
          if (succeeded) retryAttempt = 0;
          schedule(delay);
        }
      }
    };

    focusListener = () => { if (!document.hidden) void poll(); };
    visibilityListener = () => { if (!document.hidden) void poll(); };
    window.addEventListener("focus", focusListener);
    document.addEventListener("visibilitychange", visibilityListener);
    void poll();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
      if (focusListener) window.removeEventListener("focus", focusListener);
      if (visibilityListener) document.removeEventListener("visibilitychange", visibilityListener);
    };
  }, [desktopState?.paused]);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let active = true;
    const apply = (state: DesktopState | null) => {
      if (active && state) setDesktopState(state);
    };
    void bridge.getDesktopState().then(apply, () => {});
    const unsubscribe = bridge.onDesktopStateChanged(apply);
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    const open = () => setNavigationPath(pathname);
    return subscribeToOpenNavigation(open);
  }, [pathname]);

  useEffect(() => {
    publishNavigationState(navigationOpen);
    return () => publishNavigationState(false);
  }, [navigationOpen]);

  const installUpdate = useCallback(() => {
    void desktopBridge()?.installUpdate().then((state) => { if (state) setDesktopState(state); }, () => {});
  }, []);

  const selectSession = useCallback((session: SessionSummary) => {
    setNavigationPath(null);
    if (session.id === selectedSessionId) return;
    router.push(`/sessions/${encodeSessionRoute(session.id)}`);
  }, [router, selectedSessionId]);

  return (
    <LiveClockProvider running={!desktopState?.paused}>
      <SessionCatalogProvider sessions={sessions} liveSessions={liveSessions} loading={loading} connected={connected}>
        <div className="appFrame">
          <SessionSidebar
            open={navigationOpen}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            currentSessionId={selectedSessionId}
            viewingHistory={Boolean(selectedSession && !selectedSession.isLive)}
            homeSelected={pathname === "/"}
            aboutSelected={pathname === "/about"}
            update={desktopState?.update || null}
            onInstallUpdate={installUpdate}
            onClose={() => setNavigationPath(null)}
            onSelect={selectSession}
            readiness={catalogReadiness}
          />
          <div className="appContent">{children}</div>
        </div>
      </SessionCatalogProvider>
    </LiveClockProvider>
  );
}
