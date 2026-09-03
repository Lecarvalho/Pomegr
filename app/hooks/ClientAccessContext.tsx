"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

export type ClientAccessMode = "unknown" | "local" | "lan";

type ClientAccessSnapshot = {
  mode: ClientAccessMode;
  canCopyTranscriptPath: boolean;
  accessExpired: boolean;
};

type ClientAccessContextValue = ClientAccessSnapshot & {
  markAccessExpired: () => void;
  refreshAccess: () => Promise<void>;
};

const unknownAccess: ClientAccessSnapshot = Object.freeze({ mode: "unknown", canCopyTranscriptPath: false, accessExpired: false });
let accessSnapshot: ClientAccessSnapshot = unknownAccess;
let refreshStarted = false;
const accessListeners = new Set<() => void>();

function publishAccess(next: ClientAccessSnapshot) {
  accessSnapshot = Object.freeze(next);
  for (const listener of accessListeners) listener();
}

function normalizeAccess(value: unknown): Omit<ClientAccessSnapshot, "accessExpired"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mode: "unknown", canCopyTranscriptPath: false };
  const source = value as { mode?: unknown; canCopyTranscriptPath?: unknown };
  if (source.mode === "local" && source.canCopyTranscriptPath === true) return { mode: "local", canCopyTranscriptPath: true };
  if (source.mode === "lan" && source.canCopyTranscriptPath === false) return { mode: "lan", canCopyTranscriptPath: false };
  return { mode: "unknown", canCopyTranscriptPath: false };
}

async function refreshClientAccess() {
  try {
    const response = await fetch("/api/client-access", { cache: "no-store" });
    if (!response.ok) throw new Error("Client access unavailable");
    const next = normalizeAccess(await response.json());
    publishAccess({ ...next, accessExpired: false });
  } catch {
    // Network failures do not prove a paired browser's access expired.
    if (accessSnapshot.mode === "lan") publishAccess({ ...accessSnapshot, canCopyTranscriptPath: false });
    else publishAccess(unknownAccess);
  }
}

function subscribeClientAccess(listener: () => void) {
  accessListeners.add(listener);
  if (!refreshStarted) {
    refreshStarted = true;
    queueMicrotask(() => { void refreshClientAccess(); });
  }
  return () => accessListeners.delete(listener);
}

const defaultAccess: ClientAccessContextValue = {
  ...unknownAccess,
  markAccessExpired() {},
  async refreshAccess() {},
};
const ClientAccessContext = createContext<ClientAccessContextValue>(defaultAccess);

export function ClientAccessProvider({ children }: { children: ReactNode }) {
  const access = useSyncExternalStore(subscribeClientAccess, () => accessSnapshot, () => unknownAccess);
  const markAccessExpired = useCallback(() => {
    if (accessSnapshot.mode === "lan") publishAccess({ ...accessSnapshot, canCopyTranscriptPath: false, accessExpired: true });
  }, []);
  const refreshAccess = useCallback(() => refreshClientAccess(), []);
  const value = useMemo(() => ({ ...access, markAccessExpired, refreshAccess }), [access, markAccessExpired, refreshAccess]);
  return <ClientAccessContext.Provider value={value}>{children}</ClientAccessContext.Provider>;
}

export function useClientAccess() {
  return useContext(ClientAccessContext);
}

export function PhoneAccessExpiredNotice() {
  const { accessExpired } = useClientAccess();
  if (!accessExpired) return null;
  return <section className="phoneAccessExpired" role="alert" aria-live="assertive">
    <div><strong>Phone access expired</strong><p>This phone needs a new pairing code before it can view Pomegr again.</p></div>
    <a href="/__pomegr/pair">Scan a new code on your computer</a>
  </section>;
}
