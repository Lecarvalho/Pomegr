"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { HomeReadiness, LiveSessionSummary, SessionSummary } from "../../shared/monitor-contract";

type SessionCatalogContextValue = {
  sessions: SessionSummary[];
  liveSessions: LiveSessionSummary[];
  loading: boolean;
  connected: boolean;
  readiness: Pick<HomeReadiness, "catalog" | "sessionSummaries">;
};

const emptySessionCatalog: SessionCatalogContextValue = { sessions: [], liveSessions: [], loading: true, connected: true, readiness: { catalog: "loading", sessionSummaries: {} } };
const SessionCatalogContext = createContext<SessionCatalogContextValue>(emptySessionCatalog);

export function SessionCatalogProvider({ sessions, liveSessions, loading = false, connected = true, readiness, children }: {
  sessions: SessionSummary[];
  liveSessions: LiveSessionSummary[];
  loading?: boolean;
  connected?: boolean;
  readiness?: Pick<HomeReadiness, "catalog" | "sessionSummaries">;
  children: ReactNode;
}) {
  return <SessionCatalogContext.Provider value={{ sessions, liveSessions, loading, connected, readiness: readiness || { catalog: loading ? "loading" : "ready", sessionSummaries: {} } }}>{children}</SessionCatalogContext.Provider>;
}

export function useSessionCatalog() {
  return useContext(SessionCatalogContext);
}
