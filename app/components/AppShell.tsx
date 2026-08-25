"use client";

import { usePathname, useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionSummary } from "../../shared/monitor-contract";
import { decodeSessionRoute, encodeSessionRoute } from "../../shared/session-route.mjs";
import { preserveSessionOrder } from "../dashboard-utils";
import { LiveClockProvider } from "../hooks/LiveClockContext";
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
  const [navigationPath, setNavigationPath] = useState<string | null>(null);
  const [desktopState, setDesktopState] = useState<DesktopState | null>(null);
  const navigationOpen = navigationPath === pathname;
  const selectedSessionId = useMemo(() => selectedSessionFromPath(pathname), [pathname]);
  const selectedSession = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null;

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    if (desktopState?.paused) return () => controller.abort();

    const poll = async () => {
      try {
        const response = await fetch("/api/sessions", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const catalog = await response.json() as { sessions?: SessionSummary[] };
        if (!controller.signal.aborted) {
          startTransition(() => setSessions((current) => preserveSessionOrder(current, catalog.sessions || [])));
        }
      } catch {
        // Keep the most recent safe catalog visible while the monitor reconnects.
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
    </LiveClockProvider>
  );
}
