import { useState } from "react";

export type HistoryStatus = "loading" | "ready" | "unavailable";

/**
 * The paged history retry runs every five seconds and reports `loading` for the length of each
 * attempt, so a status line rendered straight from it alternates twice per cycle and a live region
 * announces the same state again and again. Once history has been unavailable it stays unavailable
 * here until a page actually arrives; only `ready` clears it, so a later first load still reads as
 * loading. Adjusted during render rather than in an effect, so no frame shows the swing.
 *
 * The selection hook reports its status as a widened string, so anything that is neither `ready`
 * nor `unavailable` is read as still loading rather than trusted as a fourth state.
 */
export function useStableHistoryStatus(status: string): HistoryStatus {
  const reported: HistoryStatus = status === "ready" ? "ready" : status === "unavailable" ? "unavailable" : "loading";
  const [retrying, setRetrying] = useState(false);
  if (reported === "unavailable" && !retrying) setRetrying(true);
  if (reported === "ready" && retrying) setRetrying(false);
  return retrying && reported !== "ready" ? "unavailable" : reported;
}
