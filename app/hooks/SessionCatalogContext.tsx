"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { LiveSessionSummary, SessionSummary } from "../../shared/monitor-contract";

type SessionCatalogContextValue = {
  sessions: SessionSummary[];
  liveSessions: LiveSessionSummary[];
  loading: boolean;
  connected: boolean;
};

const emptySessionCatalog: SessionCatalogContextValue = { sessions: [], liveSessions: [], loading: true, connected: true };
const SessionCatalogContext = createContext<SessionCatalogContextValue>(emptySessionCatalog);

export function SessionCatalogProvider({ sessions, liveSessions, loading = false, connected = true, children }: {
  sessions: SessionSummary[];
  liveSessions: LiveSessionSummary[];
  loading?: boolean;
  connected?: boolean;
  children: ReactNode;
}) {
  return <SessionCatalogContext.Provider value={{ sessions, liveSessions, loading, connected }}>{children}</SessionCatalogContext.Provider>;
}

export function useSessionCatalog() {
  return useContext(SessionCatalogContext);
}
