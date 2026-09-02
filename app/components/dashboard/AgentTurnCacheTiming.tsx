"use client";

import { useMemo } from "react";
import type { Agent, CacheLifetime, RequestSnapshot, RequestSnapshotFeed } from "../../../shared/monitor-contract";
import { coarseRelativeTime } from "../../dashboard-utils";
import { useLiveNow } from "../../hooks/LiveClockContext";
import { DottedInfoPopover } from "../DottedInfoPopover";

export const CACHE_TIMING_DOCUMENTATION_URL = "https://github.com/Lecarvalho/pomegr/blob/main/docs/CACHE_TIMING.md";

type CacheTimingState = "neutral" | "near" | "elapsed" | "unavailable";

type AgentTurnCacheEvidence = {
  lastCacheTouch: RequestSnapshot | null;
  lastRequest: RequestSnapshot | null;
  state: CacheTimingState;
};

const CACHE_LIFETIME_MS: Partial<Record<CacheLifetime, number>> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};

const CACHE_NEAR_WINDOW_MS: Partial<Record<CacheLifetime, number>> = {
  "5m": 60_000,
  "1h": 5 * 60_000,
};

function newestSnapshot(items: RequestSnapshot[]) {
  let newest: RequestSnapshot | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const observedAt = Date.parse(item.observedAt);
    if (!Number.isFinite(observedAt) || observedAt < newestAt) continue;
    newest = item;
    newestAt = observedAt;
  }
  return newest;
}

export function deriveAgentTurnCacheEvidence(requestSnapshots: RequestSnapshotFeed, agentId: string, now: number, historical: boolean, status: Agent["status"]): AgentTurnCacheEvidence {
  if (requestSnapshots.status !== "ready") return { lastRequest: null, lastCacheTouch: null, state: "unavailable" };
  const agentRequests = requestSnapshots.items.filter((item) => item.agentId === agentId);
  const lastRequest = newestSnapshot(agentRequests);
  const lastCacheTouch = newestSnapshot(agentRequests.filter((item) => item.cacheReadTokens > 0 || item.cacheWriteTokens > 0));
  if (!lastCacheTouch || historical || status === "finished" || status === "stopped") {
    return { lastRequest, lastCacheTouch, state: lastCacheTouch ? "neutral" : "unavailable" };
  }

  const lifetimeMs = CACHE_LIFETIME_MS[lastCacheTouch.cacheLifetime || "mixed"];
  const nearWindowMs = CACHE_NEAR_WINDOW_MS[lastCacheTouch.cacheLifetime || "mixed"];
  const touchedAt = Date.parse(lastCacheTouch.observedAt);
  if (!lifetimeMs || !nearWindowMs || !Number.isFinite(touchedAt)) return { lastRequest, lastCacheTouch, state: "unavailable" };
  const remainingMs = touchedAt + lifetimeMs - now;
  const state = remainingMs <= 0 ? "elapsed" : remainingMs <= nearWindowMs ? "near" : "neutral";
  return { lastRequest, lastCacheTouch, state };
}

function relativeTimestamp(value: string | null, now: number) {
  return value ? coarseRelativeTime(value, now) : "unavailable";
}

function lifetimeLabel(value: CacheLifetime | null | undefined) {
  if (value === "mixed") return "Mixed";
  return value || "Unavailable";
}

export function AgentTurnCacheTiming({ agentId, className = "", historical, requestSnapshots, status }: {
  agentId: string;
  className?: string;
  historical: boolean;
  requestSnapshots: RequestSnapshotFeed;
  status: Agent["status"];
}) {
  const now = useLiveNow();
  const evidence = useMemo(
    () => deriveAgentTurnCacheEvidence(requestSnapshots, agentId, now, historical, status),
    [agentId, historical, now, requestSnapshots, status],
  );
  const lastRequestAt = evidence.lastRequest?.observedAt || null;
  const lastCacheTouchAt = evidence.lastCacheTouch?.observedAt || null;
  const triggerTime = relativeTimestamp(lastRequestAt, now);
  const toneClass = evidence.state === "near" ? "cacheTimingNear" : evidence.state === "elapsed" ? "cacheTimingElapsed" : "";
  const stateLabel = evidence.state === "near"
    ? "Cache lifetime nearing threshold"
    : evidence.state === "elapsed"
      ? "Cache lifetime threshold elapsed"
      : null;

  if (!stateLabel) return <time
    className={`agentTurnCacheTiming agentTurnCacheTimingPlain ${className}`.trim()}
    dateTime={lastRequestAt || undefined}
  >last turn {triggerTime}</time>;

  const content = <span className="cacheTimingPopoverContent">
    <span className="cacheTimingRow"><span>Last model turn</span><time dateTime={lastRequestAt || undefined}>{triggerTime}</time></span>
    <span className="cacheTimingRow"><span>Last cache touch</span><time dateTime={lastCacheTouchAt || undefined}>{relativeTimestamp(lastCacheTouchAt, now)}</time></span>
    <span className="cacheTimingRow"><span>Observed lifetime</span><strong>{lifetimeLabel(evidence.lastCacheTouch?.cacheLifetime)}</strong></span>
    <strong className={`cacheTimingState ${evidence.state}`}>{stateLabel}</strong>
  </span>;

  return <DottedInfoPopover
    ariaLabel={`Last model turn ${triggerTime}; show turn and cache timing`}
    className={`agentTurnCacheTiming ${toneClass} ${className}`.trim()}
    content={content}
    link={{
      href: CACHE_TIMING_DOCUMENTATION_URL,
      label: "How cache timing works",
      ariaLabel: "How cache timing works",
    }}
  >
    <time dateTime={lastRequestAt || undefined}>last turn {triggerTime}</time>
  </DottedInfoPopover>;
}
