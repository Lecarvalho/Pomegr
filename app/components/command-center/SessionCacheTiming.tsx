"use client";

import type { SessionSummary } from "../../../shared/monitor-contract";
import { coarseRelativeTime } from "../../dashboard-utils";
import { useLiveNowOrFrozen } from "../../hooks/LiveClockContext";
import { CACHE_TIMING_DOCUMENTATION_URL, cacheTimingLifetimeLabel, deriveCacheLifetimeTiming } from "../dashboard/AgentTurnCacheTiming";
import { DottedInfoPopover } from "../DottedInfoPopover";
import { CommandIcon } from "./CommandIcon";

function remainingLabel(remainingMs: number) {
  return `Cache ~${Math.max(1, Math.ceil(remainingMs / 60_000))}m left`;
}

/**
 * Quiet 12px timer glyph after a session's Updated time: amber while the
 * primary agent's cache lifetime is nearing its threshold, faint once it has
 * elapsed, nothing while it is neither. The glyph carries no text; its
 * accessible name and the hover/tap popover hold the reading. Historical rows
 * keep their recorded evidence. See docs/CACHE_TIMING.md.
 */
export function SessionCacheTiming({ session }: { session: SessionSummary }) {
  const now = useLiveNowOrFrozen();
  const timing = session.cacheTiming;
  if (!timing) return null;
  const { state, remainingMs } = deriveCacheLifetimeTiming(timing.lastCacheTouchAt, timing.cacheLifetime, now);
  if (state !== "near" && state !== "elapsed") return null;
  const label = state === "near" && remainingMs !== null ? remainingLabel(remainingMs) : "Cache lifetime elapsed";
  const content = <span className="cacheTimingPopoverContent">
    <span className="cacheTimingRow"><span>Last cache touch</span><time dateTime={timing.lastCacheTouchAt}>{coarseRelativeTime(timing.lastCacheTouchAt, now)}</time></span>
    <span className="cacheTimingRow"><span>Observed lifetime</span><strong>{cacheTimingLifetimeLabel(timing.cacheLifetime)}</strong></span>
    <strong className={`cacheTimingState ${state}`}>{state === "near" ? "Primary agent cache lifetime nearing threshold" : "Primary agent cache lifetime elapsed. Not proof the entry was dropped."}</strong>
  </span>;
  return <DottedInfoPopover
    ariaLabel={`${label} for the primary agent; show cache timing`}
    className={`commandSessionCacheTiming ${state === "near" ? "cacheTimingNear" : "cacheTimingElapsed"}`}
    content={content}
    link={{ href: CACHE_TIMING_DOCUMENTATION_URL, label: "How cache timing works", ariaLabel: "How cache timing works" }}
  ><CommandIcon name="timer" /></DottedInfoPopover>;
}
