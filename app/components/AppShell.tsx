"use client";

import { usePathname, useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionCatalogSnapshot, SessionSummary } from "../../shared/monitor-contract";
import { decodeSessionRoute, encodeSessionRoute } from "../../shared/session-route.mjs";
import { preserveSessionOrder } from "../dashboard-utils";
import { LiveClockProvider } from "../hooks/LiveClockContext";
import { SessionCatalogProvider } from "../hooks/SessionCatalogContext";
import type { DesktopState } from "./DesktopControls";
import { publishNavigationState, subscribeToOpenNavigation } from "./app-navigation";
import { SessionSidebar } from "./dashboard/SessionSidebar";

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
  const [navigationPath, setNavigationPath] = useState<string | null>(null);
  const [desktopState, setDesktopState] = useState<DesktopState | null>(null);
  const navigationOpen = navigationPath === pathname;
  const selectedSessionId = useMemo(() => selectedSessionFromPath(pathname), [pathname]);
  const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null;

  useEffect(() => {
    document.documentElement.dataset.pomegrHydrated = "true";
    return () => { delete document.documentElement.dataset.pomegrHydrated; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    if (desktopState?.paused) return () => controller.abort();

    const poll = async () => {
      try {
        const response = await fetch("/api/sessions", { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          if (!controller.signal.aborted) {
            setConnected(false);
            setLoading(false);
          }
          return;
        }
        const catalog = await response.json() as Partial<SessionCatalogSnapshot>;
        const nextSessions = Array.isArray(catalog.sessions) ? catalog.sessions : null;
        const nextLiveSessions = Array.isArray(catalog.liveSessions) ? catalog.liveSessions : null;
        if (!controller.signal.aborted && nextSessions && nextLiveSessions) {
          startTransition(() => {
            setSessions((current) => preserveSessionOrder(current, nextSessions));
            setLiveSessions((current) => preserveSessionOrder(current, nextLiveSessions));
            setConnected(true);
            setLoading(false);
          });
        } else if (!controller.signal.aborted) {
          setConnected(false);
          setLoading(false);
        }
      } catch {
        // Keep the most recent safe catalog visible while the monitor reconnects.
        if (!controller.signal.aborted) {
          setConnected(false);
          setLoading(false);
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 5_000);
      }
    };

    void poll();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
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
          />
          <div className="appContent">{children}</div>
        </div>
      </SessionCatalogProvider>
    </LiveClockProvider>
  );
}
