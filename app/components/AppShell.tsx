"use client";

import { usePathname } from "next/navigation";
import { decodeSessionRoute } from "../../shared/session-route.mjs";
import { useHomePreferences } from "../hooks/useHomePreferences";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { HomeReadiness, SessionCatalogSnapshot, SessionSummary } from "../../shared/monitor-contract";
import { newestSessionsFirst } from "../dashboard-utils";
import { LiveClockProvider } from "../hooks/LiveClockContext";
import { SessionCatalogProvider } from "../hooks/SessionCatalogContext";
import type { DesktopState } from "./DesktopControls";
import { useUsageLimitsPollingPause } from "../usage-limits-client";
import { useProviderStatusPollingPause } from "../provider-status-client";
import { DisplayPreferencesProvider } from "../hooks/DisplayPreferencesContext";
import { PhoneAccessExpiredNotice, useClientAccess } from "../hooks/ClientAccessContext";
import { CommandCenterShell } from "./command-center/CommandCenterShell";

type AppShellDesktopBridge = {
  getDesktopState(): Promise<DesktopState | null>;
  installUpdate(): Promise<DesktopState | null>;
  onDesktopStateChanged(callback: (state: DesktopState) => void): () => void;
};

function desktopBridge() {
  return (window as Window & { pomegrDesktop?: AppShellDesktopBridge }).pomegrDesktop;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const [catalogReadiness, setCatalogReadiness] = useState<Pick<HomeReadiness, "catalog">>({ catalog: "loading" });
  const catalogRevisionRef = useRef<number | string | null>(null);
  const catalogNotificationStartedAtRef = useRef<number | null>(null);
  const catalogReadinessRef = useRef(catalogReadiness);
  const sessionCountRef = useRef(0);
  const [desktopState, setDesktopState] = useState<DesktopState | null>(null);
  const { mode: clientAccessMode, markAccessExpired, refreshAccess } = useClientAccess();
  useUsageLimitsPollingPause(Boolean(desktopState?.paused));
  useProviderStatusPollingPause(Boolean(desktopState?.paused));
  const { ready: homePreferencesReady, rememberSession } = useHomePreferences();

  useEffect(() => {
    if (!homePreferencesReady || !pathname.startsWith("/sessions/")) return;
    const id = decodeSessionRoute(pathname.slice("/sessions/".length));
    if (id && sessions.some((session) => session.id === id)) rememberSession(id);
  }, [homePreferencesReady, pathname, rememberSession, sessions]);

  useEffect(() => {
    document.documentElement.dataset.pomegrHydrated = "true";
    return () => { delete document.documentElement.dataset.pomegrHydrated; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    let retryAttempt = 0;
    let requestInFlight = false;
    let refreshAfterFlight = false;
    let pendingEventRevision: number | null = null;
    let eventSource: EventSource | null = null;
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
          catalogNotificationStartedAtRef.current = null;
          succeeded = true;
          retryAttempt = 0;
          return;
        }
        if (!response.ok) {
          if (!controller.signal.aborted) {
            if (response.status === 401 && clientAccessMode === "lan") markAccessExpired();
            setConnected(false);
            setLoading(false);
            setCatalogReadiness((current) => current.catalog === "loading" && sessionCountRef.current === 0 ? { ...current, catalog: "unavailable" } : current);
          }
          return;
        }
        const catalog = await response.json() as Partial<SessionCatalogSnapshot>;
        const nextSessions = Array.isArray(catalog.sessions) ? catalog.sessions : null;
        if (!controller.signal.aborted && nextSessions) {
          const nextReadiness = catalog.readiness || { catalog: "ready" as const };
          setSessions(newestSessionsFirst(nextSessions));
          const headerRevision = response.headers.get("x-pomegr-revision");
          const revision = typeof catalog.revision === "number" || typeof catalog.revision === "string" ? catalog.revision : headerRevision || catalogRevisionRef.current;
          catalogRevisionRef.current = revision;
          catalogReadinessRef.current = nextReadiness;
          sessionCountRef.current = nextSessions.length;
          setCatalogReadiness(nextReadiness);
          setConnected(true);
          setLoading(false);
          const notificationStartedAt = catalogNotificationStartedAtRef.current;
          catalogNotificationStartedAtRef.current = null;
          if (notificationStartedAt !== null) {
            window.requestAnimationFrame(() => {
              try {
                performance.clearMeasures("pomegr.catalog-notification-to-render");
                performance.measure("pomegr.catalog-notification-to-render", {
                  start: notificationStartedAt,
                  end: performance.now(),
                });
              } catch { /* timing diagnostics must never affect presentation */ }
            });
          }
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
          if (refreshAfterFlight) {
            refreshAfterFlight = false;
            const currentRevision = catalogRevisionRef.current;
            if (pendingEventRevision !== null && String(pendingEventRevision) !== String(currentRevision ?? "")) {
              pendingEventRevision = null;
              schedule(0);
              return;
            }
            pendingEventRevision = null;
          }
          const delay = succeeded
          ? (document.hidden ? 30_000 : catalogReadinessRef.current.catalog === "loading" ? 1_000 : 5_000)
            : [2_000, 5_000, 10_000, 30_000][Math.min(retryAttempt++, 3)];
          if (succeeded) retryAttempt = 0;
          schedule(delay);
        }
      }
    };

    focusListener = () => { if (!document.hidden) { void refreshAccess(); void poll(); } };
    visibilityListener = () => { if (!document.hidden) { void refreshAccess(); void poll(); } };
    window.addEventListener("focus", focusListener);
    document.addEventListener("visibilitychange", visibilityListener);
    void poll();
    if (typeof EventSource === "function") {
      eventSource = new EventSource("/api/events");
      eventSource.addEventListener("catalog", (message) => {
        if (controller.signal.aborted || document.hidden) return;
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as { domain?: unknown; revision?: unknown };
          if (event.domain !== "sessions" || !Number.isSafeInteger(event.revision) || Number(event.revision) < 0
            || String(event.revision) === String(catalogRevisionRef.current ?? "")) return;
          pendingEventRevision = Number(event.revision);
          catalogNotificationStartedAtRef.current = performance.now();
          if (requestInFlight) refreshAfterFlight = true;
          else {
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
            void poll();
          }
        } catch {
          // Malformed or future event shapes cannot alter browser state.
        }
      });
    }
    return () => {
      controller.abort();
      eventSource?.close();
      if (timer !== null) window.clearTimeout(timer);
      if (focusListener) window.removeEventListener("focus", focusListener);
      if (visibilityListener) document.removeEventListener("visibilitychange", visibilityListener);
    };
  }, [clientAccessMode, desktopState?.paused, markAccessExpired, refreshAccess]);

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

  const installUpdate = useCallback(() => {
    void desktopBridge()?.installUpdate().then((state) => { if (state) setDesktopState(state); }, () => {});
  }, []);

  return (
    <DisplayPreferencesProvider>
      <LiveClockProvider running={!desktopState?.paused}>
        <SessionCatalogProvider sessions={sessions} loading={loading} connected={connected} readiness={catalogReadiness}>
          <CommandCenterShell
            pathname={pathname}
            sessions={sessions}
            connected={connected}
            loading={loading}
            update={desktopState?.update || null}
            onInstallUpdate={installUpdate}
          >
            <PhoneAccessExpiredNotice />
            {children}
          </CommandCenterShell>
        </SessionCatalogProvider>
      </LiveClockProvider>
    </DisplayPreferencesProvider>
  );
}
