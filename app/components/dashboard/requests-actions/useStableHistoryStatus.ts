import { useState } from "react";

export type HistoryStatus = "loading" | "ready" | "unavailable";

/** Once unavailable, stays so until a page arrives, so the live region does not re-announce on each retry. */
export function useStableHistoryStatus(status: string): HistoryStatus {
  const reported: HistoryStatus = status === "ready" ? "ready" : status === "unavailable" ? "unavailable" : "loading";
  const [retrying, setRetrying] = useState(false);
  if (reported === "unavailable" && !retrying) setRetrying(true);
  if (reported === "ready" && retrying) setRetrying(false);
  return retrying && reported !== "ready" ? "unavailable" : reported;
}
