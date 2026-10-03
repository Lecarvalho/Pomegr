"use client";

import type { SessionEvent, SessionEventFeed } from "../../../shared/session-domain-contract";
import { SessionEventsPanel } from "../dashboard/SessionEventsPanel";
import { Sample, Section } from "./DesignSystemKit";

function event(id: string, kind: SessionEvent["kind"], at: string, fields: Partial<SessionEvent> = {}): SessionEvent {
  return { id, kind, at, agentId: null, agentLabel: null, durationMs: null, signal: null, progress: null, resource: null, pullRequestNumber: null, refill: null, compaction: null, ...fields };
}

// Newest first, one row per kind plus a few repeats, so the 9-row desktop cap leaves an expander.
const ITEMS: SessionEvent[] = [
  event("e11", "estimate_updated", "2026-08-09T11:29:00.000Z", { progress: { percent: 45, phase: "implementing" } }),
  event("e10", "commit_observed", "2026-08-09T11:26:00.000Z"),
  event("e10-repeat", "commit_observed", "2026-08-09T11:25:00.000Z"),
  event("e09", "agent_finished", "2026-08-09T11:21:00.000Z", { agentId: "explore-summary", agentLabel: "Explore: summary domain", durationMs: 240_000 }),
  event("e08", "agent_started", "2026-08-09T11:17:00.000Z", { agentId: "explore-feed", agentLabel: "Explore: activity feed" }),
  event("e07", "agent_started", "2026-08-09T11:17:00.000Z", { agentId: "explore-summary", agentLabel: "Explore: summary domain" }),
  event("e06", "signal_reported", "2026-08-09T11:12:00.000Z", { signal: { label: "Privacy verified", tone: "positive" } }),
  event("e05", "resource_peak", "2026-08-09T11:05:00.000Z", { resource: "memory_bytes" }),
  event("e04b", "cache_refill", "2026-08-09T11:01:00.000Z", { agentId: "primary", agentLabel: "Primary agent", refill: "possible_full" }),
  event("e04a", "context_compacted", "2026-08-09T11:00:00.000Z", { agentId: "primary", agentLabel: "Primary agent", compaction: "automatic" }),
  event("e04", "user_message", "2026-08-09T10:58:00.000Z"),
  event("e03", "pull_request_opened", "2026-08-09T10:41:00.000Z", { pullRequestNumber: 43 }),
  event("e02", "agent_stopped", "2026-08-09T10:30:00.000Z", { agentId: "explore-tests", agentLabel: "Explore: tests", durationMs: 1_500_000 }),
  event("e01", "resource_peak", "2026-08-09T10:12:00.000Z", { resource: "read_bps" }),
];

const FULL: SessionEventFeed = { readiness: "ready", items: ITEMS, total: ITEMS.length };
const EMPTY: SessionEventFeed = { readiness: "ready", items: [], total: 0 };
const LOADING: SessionEventFeed = { readiness: "loading", items: [], total: 0 };
const UNAVAILABLE: SessionEventFeed = { readiness: "unavailable", items: [], total: 0 };

const ignore = () => undefined;

export function EventsRailSection() {
  return <Section id="events-rail" title="Events rail" lede="The Overview Events panel lists high-level session transitions newest first under a plain eyebrow heading. Each row is one quiet-role button: local clock time, a neutral 16px stroke glyph, a label with a muted detail, and a trailing chevron that opens the tab continuing that evidence.">
    <div className="designSystemGrid">
      <Sample label="Every kind · expander" note="Desktop shows 9 rows and phone 5; the footer expander is the panel's one text link. On desktop the expanded list scrolls inside the nine-row height instead of growing the panel, and the muted total counts the events derivable from retained evidence.">
        <div className="designSystemEventsFrame"><SessionEventsPanel headingId="design-system-events-full" events={FULL} onNavigate={ignore} /></div>
      </Sample>
      <Sample label="Empty" note="A ready feed with no events keeps the panel, so the layout stays stable.">
        <div className="designSystemEventsFrame"><SessionEventsPanel headingId="design-system-events-empty" events={EMPTY} onNavigate={ignore} /></div>
      </Sample>
      <Sample label="Loading and unavailable" note="Any readiness other than ready uses the shared unavailable line instead of rows.">
        <div className="designSystemEventsFrame"><SessionEventsPanel headingId="design-system-events-loading" events={LOADING} onNavigate={ignore} /></div>
        <div className="designSystemEventsFrame"><SessionEventsPanel headingId="design-system-events-unavailable" events={UNAVAILABLE} onNavigate={ignore} /></div>
      </Sample>
    </div>
    <p className="designSystemNote">Glyphs stay muted for every kind; the label names the transition, so no row carries a tone color. Rows read only the normalized fields their kind owns and never print prompt, command, or file content. Timestamps are the evidence time, and a commit row says Git-observed in its detail. A cache-refill row names its recorded kind and marks the elapsed-lifetime partial refill as an inference.</p>
  </Section>;
}
