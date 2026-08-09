"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useLiveClock } from "./useLiveClock";

const LiveClockContext = createContext<number | null>(null);

export function LiveClockProvider({ running, children }: { running: boolean; children: ReactNode }) {
  const now = useLiveClock(running);
  return <LiveClockContext.Provider value={now}>{children}</LiveClockContext.Provider>;
}

export function useLiveNow() {
  const now = useContext(LiveClockContext);
  if (now === null) throw new Error("useLiveNow must be used within LiveClockProvider");
  return now;
}
