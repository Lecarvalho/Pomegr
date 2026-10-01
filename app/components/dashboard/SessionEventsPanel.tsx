"use client";

import { useId, useState, type ReactNode } from "react";
import type { ResourceField, SessionEvent, SessionEventFeed, SessionEventKind } from "../../../shared/session-domain-contract";
import { formatDuration } from "../../dashboard-utils";
import { usePhoneLayout } from "../../hooks/usePhoneLayout";
import { PanelHeadingLink } from "../PanelHeadingLink";
import { RESOURCE_FIELD_LABEL } from "./ResourceSparklineCard";
import type { SessionRouteQuery } from "./session-route";
import { Unavailable } from "./SessionOverviewUnavailable";

const DESKTOP_VISIBLE_EVENTS = 9;
const PHONE_VISIBLE_EVENTS = 5;

// Disk fields read as bare "Read" and "Write" elsewhere; an event row has no column to say what they measure.
const RESOURCE_EVENT_LABEL: Record<ResourceField, string> = { ...RESOURCE_FIELD_LABEL, read_bps: "Disk read", write_bps: "Disk write" };

// 16px stroke glyphs, one per kind. They stay neutral: the kind is named by the label, never by color.
const GLYPH_SHAPES: Record<SessionEventKind, ReactNode> = {
  agent_started: <><circle cx="8" cy="8" r="6" /><path d="M7 5.5l3.5 2.5L7 10.5z" /></>,
  agent_finished: <><circle cx="8" cy="8" r="6" /><path d="M5 8l2 2 4-4" /></>,
  agent_stopped: <><circle cx="8" cy="8" r="6" /><path d="M6.5 6.5h3v3h-3z" /></>,
  signal_reported: <path d="M4 14V2.5M4 3h8l-2 3 2 3H4" />,
  estimate_updated: <><path d="M2.5 11a5.5 5.5 0 0 1 11 0" /><path d="M8 11l3-4" /></>,
  user_message: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  resource_peak: <path d="M2 13l4-9 3 6 2-3 3 6" />,
  commit_observed: <><circle cx="8" cy="8" r="2.5" /><path d="M2 8h3.5M10.5 8H14" /></>,
  pull_request_opened: <><circle cx="4" cy="4" r="1.6" /><circle cx="4" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><path d="M4 5.6v4.8M12 10.4V7a2 2 0 0 0-2-2H8" /></>,
};

type EventPresentation = { label: string; detail: (event: SessionEvent) => string | null; destination: (event: SessionEvent) => Partial<SessionRouteQuery> };

const joinDetail = (...parts: Array<string | null>) => parts.filter(Boolean).join(" · ") || null;
// A newer monitor may send a field in a shape this browser does not know; each detail prints nothing for it rather than "undefined" or a guess.
const plainText = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
const agentDestination = (event: SessionEvent): Partial<SessionRouteQuery> => { const agent = plainText(event.agentId); return agent ? { tab: "agents", agent } : { tab: "agents" }; };
const wallTime = (event: SessionEvent) => typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs) || event.durationMs < 0 ? null : `${event.durationMs < 60_000 ? "<1m" : formatDuration(event.durationMs)} wall`;
const agentEnded = (event: SessionEvent) => joinDetail(plainText(event.agentLabel), wallTime(event));
const signalDetail = (event: SessionEvent) => { const label = plainText(event.signal?.label); return label ? joinDetail(label, "agent-reported") : null; };
const estimateDetail = (event: SessionEvent) => {
  const phase = plainText(event.progress?.phase);
  const percent = event.progress?.percent;
  return phase && typeof percent === "number" && Number.isFinite(percent) ? `${percent}% · ${phase.replaceAll("_", " ")}` : null;
};
const resourceDetail = (event: SessionEvent) => typeof event.resource === "string" && Object.hasOwn(RESOURCE_EVENT_LABEL, event.resource) ? `${RESOURCE_EVENT_LABEL[event.resource]} · session high` : null;
const pullRequestDetail = (event: SessionEvent) => typeof event.pullRequestNumber === "number" && Number.isSafeInteger(event.pullRequestNumber) && event.pullRequestNumber > 0 ? `#${event.pullRequestNumber}` : null;

// Label, detail, and destination read only fields each kind owns, so an event never prints anything it was not defined to carry.
const PRESENTATION: Record<SessionEventKind, EventPresentation> = {
  agent_started: { label: "Agent started", detail: (event) => plainText(event.agentLabel), destination: agentDestination },
  agent_finished: { label: "Agent finished", detail: agentEnded, destination: agentDestination },
  agent_stopped: { label: "Agent stopped", detail: agentEnded, destination: agentDestination },
  signal_reported: { label: "Signal reported", detail: signalDetail, destination: () => ({ tab: "signals" }) },
  estimate_updated: { label: "Agent estimate updated", detail: estimateDetail, destination: () => ({ tab: "details" }) },
  user_message: { label: "User message", detail: () => null, destination: () => ({ tab: "activities" }) },
  resource_peak: { label: "Resource peak", detail: resourceDetail, destination: () => ({ tab: "resources" }) },
  commit_observed: { label: "Commit observed", detail: () => "Git-observed", destination: () => ({ tab: "repository" }) },
  pull_request_opened: { label: "Pull request opened", detail: pullRequestDetail, destination: () => ({ tab: "repository" }) },
};

/** Local 24-hour HH:mm, the same on every locale; null when the recorded timestamp does not parse. */
function clockTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// A newer monitor may record a kind this browser does not know; omit it rather than invent a label.
const isKnownEvent = (event: SessionEvent) => Object.hasOwn(PRESENTATION, event.kind);

function SessionEventRow({ event, onNavigate }: { event: SessionEvent; onNavigate: (changes: Partial<SessionRouteQuery>) => void }) {
  const presentation = PRESENTATION[event.kind];
  const detail = presentation.detail(event);
  const time = clockTime(event.at);
  const text = detail ? `${presentation.label} · ${detail}` : presentation.label;
  return <button type="button" className="commandQuietAction sessionEventRow" aria-label={[presentation.label, detail, time].filter(Boolean).join(", ")} onClick={() => onNavigate(presentation.destination(event))}>
    <time className="sessionEventTime" dateTime={event.at} suppressHydrationWarning>{time ?? "—"}</time>
    <svg className="sessionEventGlyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-event-kind={event.kind}>{GLYPH_SHAPES[event.kind]}</svg>
    <span className="sessionEventText" title={text}><strong className="sessionEventLabel">{presentation.label}</strong>{detail && <span className="sessionEventDetail">{detail}</span>}</span>
    <svg className="sessionEventChevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>
  </button>;
}

/** Overview rail of high-level session transitions. Renders only the feed it is given; the monitor decides what an event is. */
export function SessionEventsPanel({ events, onNavigate, headingId = "session-events" }: {
  events: SessionEventFeed;
  onNavigate: (changes: Partial<SessionRouteQuery>) => void;
  headingId?: string;
}) {
  const phone = usePhoneLayout();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const items = events.readiness === "ready" ? events.items.filter(isKnownEvent) : [];
  const limit = phone ? PHONE_VISIBLE_EVENTS : DESKTOP_VISIBLE_EVENTS;
  const earlier = items.length - limit;
  const visible = expanded ? items : items.slice(0, limit);
  return <section className="sessionOverviewPanel sessionEventsPanel" aria-labelledby={headingId}>
    <div className="sessionOverviewHeading"><div className="sessionRequestHeadingMain"><PanelHeadingLink id={headingId} onOpen={() => onNavigate({ tab: "activities" })}>Events</PanelHeadingLink><span className="sessionRequestSummary">newest first</span></div></div>
    {events.readiness !== "ready" ? <Unavailable readiness={events.readiness} label="Event evidence" /> : items.length === 0
      ? <p className="sessionOverviewEmpty">No events recorded.</p>
      : <>
        {/* data-expanded lets the stylesheet scroll the list inside the collapsed height on desktop instead of growing the panel. */}
        <ul id={listId} className="sessionEventList" data-expanded={expanded ? "true" : undefined}>{visible.map((event) => <li key={event.id}><SessionEventRow event={event} onNavigate={onNavigate} /></li>)}</ul>
        <div className="sessionEventsFooter">
          {earlier > 0 && <button type="button" className="commandTextLink" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((open) => !open)}>{expanded ? "Show fewer" : `Show ${earlier} earlier`}</button>}
          {/* The total counts events derivable from retained evidence, so it claims no complete session history. */}
          <span className="sessionEventsTotal">{`${events.total.toLocaleString("en-US")} ${events.total === 1 ? "event" : "events"}`}</span>
        </div>
      </>}
  </section>;
}
