"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { HomeReadiness, SessionSummary } from "../../shared/monitor-contract";

type SessionCatalogContextValue = {
  sessions: SessionSummary[];
  loading: boolean;
  connected: boolean;
  readiness: Pick<HomeReadiness, "catalog">;
};

const emptySessionCatalog: SessionCatalogContextValue = { sessions: [], loading: true, connected: true, readiness: { catalog: "loading" } };
const SessionCatalogContext = createContext<SessionCatalogContextValue>(emptySessionCatalog);

export function SessionCatalogProvider({ sessions, loading = false, connected = true, readiness, children }: {
  sessions: SessionSummary[];
  loading?: boolean;
  connected?: boolean;
  readiness?: Pick<HomeReadiness, "catalog">;
  children: ReactNode;
}) {
  return <SessionCatalogContext.Provider value={{ sessions, loading, connected, readiness: readiness || { catalog: loading ? "loading" : "ready" } }}>{children}</SessionCatalogContext.Provider>;
}

export function useSessionCatalog() {
  return useContext(SessionCatalogContext);
}
