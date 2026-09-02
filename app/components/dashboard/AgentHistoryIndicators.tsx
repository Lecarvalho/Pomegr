"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { CacheLifetimeInference, CacheReadDropCount, CacheRefillCount, CacheRefillReason, CacheToolChangeAttributionCount, ContextHistoryBoundary } from "../../../shared/monitor-contract";
import { cacheReadReuseDroppedSignalDefinition, cacheRefillSignalDefinition } from "../../../shared/signal-dictionary";
import { formatDuration, timelineTime } from "../../dashboard-utils";
import { AgentChip } from "../AgentChip";
import { ExternalLink } from "../ExternalLink";
import { CacheEvidencePopover } from "./CacheEvidencePopover";

export type CompactionSummary = {
  automatic: number;
  manual: number;
  total: number;
};

export function summarizeCompactions(boundaries: ContextHistoryBoundary[], agentIds: string[]): CompactionSummary {
  const observedAgents = new Set(agentIds);
  let automatic = 0;
  let manual = 0;
  for (const boundary of boundaries) {
    if (!observedAgents.has(boundary.agentId)) continue;
    if (boundary.kind === "automatic_compaction") automatic += 1;
    if (boundary.kind === "manual_compaction") manual += 1;
  }
  return { automatic, manual, total: automatic + manual };
}

export function compactionDescription(summary: CompactionSummary, representedAgents = 1) {
  const count = `${summary.total} ${summary.total === 1 ? "compaction" : "compactions"}`;
  const scope = representedAgents > 1 ? ` across ${representedAgents} agents` : "";
  const kinds = [
    summary.automatic > 0 ? `${summary.automatic} automatic` : "",
    summary.manual > 0 ? `${summary.manual} manual` : "",
  ].filter(Boolean).join(" · ");
  return `${count}${scope}${kinds ? ` · ${kinds}` : ""}.`;
}

export function summarizeCacheRefills(cacheRefills: CacheRefillCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  return cacheRefills.reduce((count, refill) => observedAgents.has(refill.agentId) ? count + refill.count : count, 0);
}

export function summarizeCacheReadDrops(cacheReadDrops: CacheReadDropCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  return cacheReadDrops.reduce((count, drop) => observedAgents.has(drop.agentId) ? count + drop.count : count, 0);
}

export function summarizeCacheReadDropOccurrences(cacheReadDrops: CacheReadDropCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  return cacheReadDrops.flatMap((drop) => observedAgents.has(drop.agentId)
    ? drop.occurrences.map((occurrence) => ({ ...occurrence, agentId: drop.agentId }))
    : [])
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

function cacheReadDropSummary(count: number, representedAgents = 1) {
  const occurrences = count === 1 ? "1 time" : `${count} times`;
  const scope = representedAgents > 1 ? ` across ${representedAgents} agents` : "";
  return `Possible cache refill inferred ${occurrences}${scope}.`;
}

function CacheRefillTrigger({ count, label, expanded, controls, onClick }: {
  count: number;
  label: string;
  expanded: boolean;
  controls: string;
  onClick: () => void;
}) {
  return <AgentChip as="button" className="agentHistoryIndicator agentCacheRefillIndicator" ariaLabel={label} expanded={expanded} controls={controls} onClick={onClick}>
    <svg aria-hidden="true" className="agentHistoryIcon agentCacheRefillIcon" viewBox="0 0 24 24">
      <path d="M12 2.5v8M8.5 7l3.5 3.5L15.5 7M4 14h16M6.5 18h11M9 22h6" />
    </svg>
    <span aria-hidden="true" className="agentHistoryCount">{count > 99 ? "99+" : count}</span>
  </AgentChip>;
}

const CACHE_REFILL_REASON_LABELS: Record<CacheRefillReason, string> = {
  model_changed: "model configuration changed",
  system_changed: "system instructions changed",
  tools_changed: "tool definitions changed",
  messages_changed: "message history changed",
};

const CACHE_TOOL_CHANGE_CAUSE_LABELS: Record<CacheToolChangeAttributionCount["cause"], string> = {
  remote_control_connected: "Remote Control connected",
};
const CACHE_TOOL_NAMES = new Set(["RemoteTrigger", "PushNotification", "ListAgents"]);
const CACHE_TOOL_CHANGE_KIND_LABELS = {
  added: "added",
  definition_changed: "definition changed",
} as const;

export function summarizeCacheRefillReasons(cacheRefills: CacheRefillCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  const counts = new Map<CacheRefillReason, number>();
  for (const refill of cacheRefills) {
    if (!observedAgents.has(refill.agentId)) continue;
    for (const item of refill.reasons || []) {
      if (!Object.hasOwn(CACHE_REFILL_REASON_LABELS, item.reason) || !Number.isSafeInteger(item.count) || item.count <= 0) continue;
      counts.set(item.reason, (counts.get(item.reason) || 0) + item.count);
    }
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => ({ reason, count }));
}

export function summarizeCacheToolChangeAttributions(cacheRefills: CacheRefillCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  const attributions = new Map<CacheToolChangeAttributionCount["cause"], CacheToolChangeAttributionCount>();
  for (const refill of cacheRefills) {
    if (!observedAgents.has(refill.agentId)) continue;
    for (const attribution of refill.toolChangeAttributions || []) {
      if (!Object.hasOwn(CACHE_TOOL_CHANGE_CAUSE_LABELS, attribution.cause)
        || !Number.isSafeInteger(attribution.count)
        || attribution.count <= 0) continue;
      const changes = (attribution.changes || []).filter((change) => (
        CACHE_TOOL_NAMES.has(change.tool) && Object.hasOwn(CACHE_TOOL_CHANGE_KIND_LABELS, change.kind)
      ));
      const previous = attributions.get(attribution.cause);
      attributions.set(attribution.cause, {
        cause: attribution.cause,
        count: (previous?.count || 0) + attribution.count,
        changes: previous?.changes || changes,
      });
    }
  }
  return [...attributions.values()].sort((left, right) => left.cause.localeCompare(right.cause));
}

function cacheRefillSummary(count: number, representedAgents = 1) {
  const occurrences = count === 1 ? "1 time" : `${count} times`;
  const scope = representedAgents > 1 ? ` across ${representedAgents} agents` : "";
  return `Possible full cache refill observed ${occurrences}${scope}.`;
}

function cacheRefillInference(toolChangeAttributions: ReturnType<typeof summarizeCacheToolChangeAttributions>) {
  return toolChangeAttributions.map((attribution) => {
    const cause = CACHE_TOOL_CHANGE_CAUSE_LABELS[attribution.cause];
    const causeCount = attribution.count > 1 ? ` (${attribution.count} refills)` : "";
    const changes = attribution.changes.map((change) => `${change.tool} (${CACHE_TOOL_CHANGE_KIND_LABELS[change.kind]})`).join(", ");
    return `${cause}${causeCount}${changes ? `; likely changed ${changes}` : ""}`;
  }).join(" · ");
}

function cacheRefillOccurrenceInference(attribution: CacheToolChangeAttributionCount | Omit<CacheToolChangeAttributionCount, "count"> | null) {
  if (!attribution || !Object.hasOwn(CACHE_TOOL_CHANGE_CAUSE_LABELS, attribution.cause)) return "";
  const cause = CACHE_TOOL_CHANGE_CAUSE_LABELS[attribution.cause];
  const changes = (attribution.changes || []).filter((change) => (
    CACHE_TOOL_NAMES.has(change.tool) && Object.hasOwn(CACHE_TOOL_CHANGE_KIND_LABELS, change.kind)
  )).map((change) => `${change.tool} (${CACHE_TOOL_CHANGE_KIND_LABELS[change.kind]})`).join(", ");
  return `${cause}${changes ? `; likely changed ${changes}` : ""}`;
}

function cacheLifetimeInferenceLabel(inference: CacheLifetimeInference | null) {
  if (!inference || inference.cause !== "cache_lifetime_elapsed") return "";
  const lifetime = inference.cacheLifetime === "5m"
    ? "Five-minute cache"
    : inference.cacheLifetime === "1h"
      ? "One-hour cache"
      : "Mixed cache lifetimes";
  return `${lifetime} likely expired; ${formatDuration(inference.elapsedMs)} elapsed since the preceding request`;
}

export function cacheRefillOccurrenceDescriptions(
  count: number,
  reasons: ReturnType<typeof summarizeCacheRefillReasons> = [],
) {
  const occurrences: string[] = [];
  for (const { reason, count: reasonCount } of reasons) {
    for (let index = 0; index < reasonCount && occurrences.length < count; index += 1) {
      occurrences.push(CACHE_REFILL_REASON_LABELS[reason]);
    }
  }
  while (occurrences.length < count) occurrences.push("reason unavailable");
  return occurrences;
}

export function summarizeCacheRefillOccurrences(cacheRefills: CacheRefillCount[], agentIds: string[]) {
  const observedAgents = new Set(agentIds);
  const occurrences: Array<{ agentId: string; observedAt: string | null; reason: string; inference: string; lifetimeInference: string; signal: ReturnType<typeof cacheRefillSignalDefinition> }> = [];
  for (const refill of cacheRefills) {
    if (!observedAgents.has(refill.agentId)) continue;
    if (Array.isArray(refill.occurrences) && refill.occurrences.length > 0) {
      occurrences.push(...refill.occurrences.map((occurrence) => {
        const lifetimeInference = cacheLifetimeInferenceLabel(occurrence.cacheLifetimeInference);
        return {
          agentId: refill.agentId,
          observedAt: occurrence.observedAt,
          reason: occurrence.reason && Object.hasOwn(CACHE_REFILL_REASON_LABELS, occurrence.reason)
            ? CACHE_REFILL_REASON_LABELS[occurrence.reason]
            : occurrence.providerStatus === "previous_cache_entry_unavailable"
              ? "previous cache entry unavailable"
              : "reason unavailable",
          inference: [
            lifetimeInference,
            cacheRefillOccurrenceInference(occurrence.toolChangeAttribution),
          ].filter(Boolean).join(" · "),
          lifetimeInference,
          signal: cacheRefillSignalDefinition(occurrence),
        };
      }));
      continue;
    }
    occurrences.push(...cacheRefillOccurrenceDescriptions(refill.count, summarizeCacheRefillReasons([refill], [refill.agentId]))
      .map((reason) => ({ agentId: refill.agentId, observedAt: null, reason, inference: "", lifetimeInference: "", signal: null })));
  }
  return occurrences.sort((left, right) => {
    if (!left.observedAt) return 1;
    if (!right.observedAt) return -1;
    return Date.parse(left.observedAt) - Date.parse(right.observedAt);
  });
}

export function cacheRefillDescription(
  count: number,
  representedAgents = 1,
  reasons: ReturnType<typeof summarizeCacheRefillReasons> = [],
  toolChangeAttributions: ReturnType<typeof summarizeCacheToolChangeAttributions> = [],
  occurrences: ReturnType<typeof summarizeCacheRefillOccurrences> = [],
) {
  if (occurrences.length > 0) {
    const summarizeLabels = (labels: string[], limit: number, overflowLabel: string) => {
      const counts = new Map<string, number>();
      for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
      const entries = [...counts.entries()];
      const visible = entries.slice(0, limit).map(([label, labelCount]) => (
        `${label}${labelCount > 1 ? ` (${labelCount})` : ""}`
      ));
      const omitted = entries.length - visible.length;
      if (omitted > 0) visible.push(`${omitted} additional ${overflowLabel}`);
      return visible.join(" · ");
    };
    const evidence = summarizeLabels(occurrences.map(({ reason }) => reason), 5, "diagnostic categories");
    const inference = summarizeLabels(occurrences.map((occurrence) => occurrence.inference).filter(Boolean), 3, "inference categories");
    return `${cacheRefillSummary(count, representedAgents)} Provider diagnostic: ${evidence}.${inference ? ` Inference: ${inference}.` : ""}`;
  }
  const diagnosed = reasons.reduce((total, item) => total + item.count, 0);
  const reasonText = reasons.map(({ reason, count: reasonCount }) => (
    `${CACHE_REFILL_REASON_LABELS[reason]}${reasonCount > 1 ? ` (${reasonCount})` : ""}`
  )).join(" · ");
  const unavailable = Math.max(0, count - diagnosed);
  const evidence = [reasonText, unavailable > 0 ? `reason unavailable${unavailable > 1 ? ` (${unavailable})` : ""}` : ""].filter(Boolean).join(" · ");
  const inference = cacheRefillInference(toolChangeAttributions);
  return `${cacheRefillSummary(count, representedAgents)}${evidence ? ` Provider diagnostic: ${evidence}.` : " Reason unavailable."}${inference ? ` Inference: ${inference}.` : ""}`;
}

export function AgentHistoryIndicators({ agentIds, boundaries, cacheRefills = [], cacheReadDrops = [], className = "" }: {
  agentIds: string[];
  boundaries: ContextHistoryBoundary[];
  cacheRefills?: CacheRefillCount[];
  cacheReadDrops?: CacheReadDropCount[];
  className?: string;
}) {
  const [cachePopoverOpen, setCachePopoverOpen] = useState(false);
  const [cacheReadDropPopoverOpen, setCacheReadDropPopoverOpen] = useState(false);
  const cachePopoverId = useId();
  const cacheReadDropPopoverId = useId();
  const cachePopoverAnchorRef = useRef<HTMLSpanElement | null>(null);
  const cacheReadDropPopoverAnchorRef = useRef<HTMLSpanElement | null>(null);
  const closeCachePopover = useCallback(() => setCachePopoverOpen(false), []);
  const closeCacheReadDropPopover = useCallback(() => setCacheReadDropPopoverOpen(false), []);
  const summary = summarizeCompactions(boundaries, agentIds);
  const cacheRefillCount = summarizeCacheRefills(cacheRefills, agentIds);
  const cacheReadDropCount = summarizeCacheReadDrops(cacheReadDrops, agentIds);
  const cacheRefillReasons = summarizeCacheRefillReasons(cacheRefills, agentIds);
  const cacheToolChangeAttributions = summarizeCacheToolChangeAttributions(cacheRefills, agentIds);
  const cacheRefillOccurrences = summarizeCacheRefillOccurrences(cacheRefills, agentIds);
  const cacheRefillLabel = cacheRefillDescription(cacheRefillCount, agentIds.length, cacheRefillReasons, cacheToolChangeAttributions, cacheRefillOccurrences);
  const cacheReadDropOccurrences = summarizeCacheReadDropOccurrences(cacheReadDrops, agentIds);
  const cacheReadDropLabel = cacheReadDropSummary(cacheReadDropCount, agentIds.length);
  if (summary.total === 0 && cacheRefillCount === 0 && cacheReadDropCount === 0) return null;
  return <span className={`agentHistoryIndicators ${className}`.trim()}>
    {summary.total > 0 && <AgentChip className="agentHistoryIndicator agentCompactionIndicator" title={compactionDescription(summary, agentIds.length)} ariaLabel={compactionDescription(summary, agentIds.length)}>
      <svg aria-hidden="true" className="agentHistoryIcon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
      <span aria-hidden="true" className="agentHistoryCount">{summary.total > 99 ? "99+" : summary.total}</span>
    </AgentChip>}
    {cacheRefillCount > 0 && <span className="agentPopoverAnchor cacheRefillPopoverAnchor" ref={cachePopoverAnchorRef}>
      <CacheRefillTrigger count={cacheRefillCount} label={cacheRefillLabel} expanded={cachePopoverOpen} controls={cachePopoverId} onClick={() => setCachePopoverOpen((open) => !open)} />
      {cachePopoverOpen && <CacheEvidencePopover anchorRef={cachePopoverAnchorRef} id={cachePopoverId} ariaLabel="Cache refill evidence" eyebrow="Cache evidence" title="Possible full refill" closeLabel="Close cache refill evidence" onClose={closeCachePopover} summary={cacheRefillSummary(cacheRefillCount, agentIds.length)} className="cacheRefillPopover">
        <ol className="cacheRefillPopoverOccurrences" aria-label="Cache refill occurrences">
          {cacheRefillOccurrences.map((occurrence, index) => <li key={`${occurrence.agentId}-${occurrence.observedAt || "unknown"}-${index}`}>
            <div className="cacheRefillPopoverOccurrenceHeading">
              <span>{index + 1}</span>
              {occurrence.observedAt
                ? <time dateTime={occurrence.observedAt}>{timelineTime(occurrence.observedAt, true)}</time>
                : <span>Time unavailable</span>}
            </div>
            <dl className="cacheRefillEvidenceGrid">
              <div><dt>Provider</dt><dd>{occurrence.reason}</dd></div>
              <div><dt>Observed</dt><dd>{occurrence.signal?.observed || occurrence.inference || "No recognized lifecycle sequence."}</dd></div>
              {occurrence.signal && occurrence.lifetimeInference && <div><dt>Inference</dt><dd>{occurrence.lifetimeInference}.</dd></div>}
              <div><dt>Impact</dt><dd>{occurrence.signal?.impact || "Possible full-refill thresholds were met."}</dd></div>
            </dl>
            {occurrence.signal && <div className="cacheRefillDefinition">
              <code>{occurrence.signal.code}</code>
              <ExternalLink href={occurrence.signal.href}>Open signal definition</ExternalLink>
            </div>}
          </li>)}
        </ol>
      </CacheEvidencePopover>}
    </span>}
    {cacheReadDropCount > 0 && <span className="agentPopoverAnchor cacheRefillPopoverAnchor" ref={cacheReadDropPopoverAnchorRef}>
      <CacheRefillTrigger count={cacheReadDropCount} label={cacheReadDropLabel} expanded={cacheReadDropPopoverOpen} controls={cacheReadDropPopoverId} onClick={() => setCacheReadDropPopoverOpen((open) => !open)} />
      {cacheReadDropPopoverOpen && <CacheEvidencePopover anchorRef={cacheReadDropPopoverAnchorRef} id={cacheReadDropPopoverId} ariaLabel="Possible cache refill evidence" eyebrow="Cache evidence" title="Possible cache refill" closeLabel="Close possible cache refill evidence" onClose={closeCacheReadDropPopover} summary={cacheReadDropSummary(cacheReadDropCount, agentIds.length)} className="cacheRefillPopover">
        <ol className="cacheRefillPopoverOccurrences" aria-label="Possible cache refill occurrences">
          {cacheReadDropOccurrences.map((occurrence, index) => {
            const signal = cacheReadReuseDroppedSignalDefinition();
            return <li key={occurrence.id}>
              <div className="cacheRefillPopoverOccurrenceHeading">
                <span>{index + 1}</span>
                <time dateTime={occurrence.observedAt}>{timelineTime(occurrence.observedAt, true)}</time>
              </div>
              <dl className="cacheRefillEvidenceGrid cacheReadDropEvidenceGrid">
                <div><dt>Observed</dt><dd>{occurrence.previousCacheReadPercent}% → {occurrence.cacheReadPercent}% cache read</dd></div>
                <div><dt>Inference</dt><dd>Possible cache refill.</dd></div>
                <div><dt>Limitation</dt><dd>No positive cache-write evidence, so a refill and its cause cannot be confirmed.</dd></div>
              </dl>
              <div className="cacheRefillDefinition">
                <code>{signal.code}</code>
                <ExternalLink href={signal.href}>Open signal definition</ExternalLink>
              </div>
            </li>;
          })}
        </ol>
      </CacheEvidencePopover>}
    </span>}
  </span>;
}
