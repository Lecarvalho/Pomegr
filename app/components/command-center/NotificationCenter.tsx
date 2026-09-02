"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ProviderServiceStatus, SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { ExternalLink } from "../ExternalLink";
import { providerHasServiceIssue, providerIncidentRank } from "../ProviderStatus";
import { CommandIcon } from "./CommandIcon";

type Notification = {
  id: string;
  rank: number;
  group: "Needs attention" | "Provider service" | "System";
  title: string;
  description: string;
  href: string;
  linkLabel: string;
  external?: boolean;
  checkedAt?: string | null;
  tone: "attention" | "online" | "offline";
};

export function useNotifications(sessions: SessionSummary[], providers: ProviderServiceStatus[], connected: boolean, loading: boolean) {
  const entries = useMemo<Notification[]>(() => [
    ...sessions.filter((session) => session.isLive && (session.needsInput || session.activityStatus === "needs_input")).map((session): Notification => ({
      id: `session:${session.id}`, rank: 0, group: "Needs attention", title: session.title,
      description: "This live session is waiting for input. Session-reported state may be stale.",
      href: `/sessions/${encodeSessionRoute(session.id)}`, linkLabel: "Open session", tone: "attention",
    })),
    ...providers.filter(providerHasServiceIssue).map((provider): Notification => ({
      id: `provider:${provider.provider}:${provider.incidentKey || provider.status}`, rank: providerIncidentRank(provider), group: "Provider service",
      title: `${provider.source} reports service issues`,
      description: `${provider.incidents[0] ? `${provider.incidents[0].label.replace(/[.!?]+$/u, "")}. ` : ""}Requests may be delayed or fail.${provider.readiness === "unavailable" ? " Status refresh is delayed; this is the last confirmed report." : ""}`,
      href: provider.incidents[0]?.url || provider.statusPageUrl, linkLabel: provider.incidents.length ? "View incident" : "View status page",
      external: true, checkedAt: provider.checkedAt, tone: "attention",
    })),
    {
      id: `monitor:${loading ? "loading" : connected ? "connected" : "unavailable"}`, rank: 0, group: "System",
      title: loading ? "Connecting to monitor" : connected ? "Local monitor connected" : "Monitor unavailable",
      description: connected ? "The latest committed normalized state is available. No conversation content is exposed." : "Pomegr will retry automatically while preserving the last known-good state.",
      href: "/", linkLabel: "View workspace", tone: connected ? "online" : "offline",
    },
  ], [sessions, providers, connected, loading]);
  const [read, setRead] = useState<Map<string, number>>(() => new Map());
  // Keep only current identities, so recovery followed by recurrence needs attention again.
  const active = new Set(entries.map((entry) => entry.id));
  const retainedRead = new Map([...read].filter(([id]) => active.has(id)));
  if (retainedRead.size !== read.size) setRead(retainedRead);
  const isUnread = (entry: Notification) => !read.has(entry.id) || entry.rank > read.get(entry.id)!;
  return {
    entries,
    isUnread,
    unreadCount: entries.filter(isUnread).length,
    hasUnreadAttention: entries.some((entry) => entry.group !== "System" && isUnread(entry)),
    markAllRead: () => setRead((previous) => new Map(entries.map((entry) => [entry.id, Math.max(entry.rank, previous.get(entry.id) ?? 0)]))),
  };
}

export function NotificationCenter({ entries, isUnread, unreadCount, markAllRead, onClose }: ReturnType<typeof useNotifications> & { onClose: (returnFocus?: boolean) => void }) {
  const groups = ["Needs attention", "Provider service", "System"] as const;
  return <aside className="commandNotificationTray" id="command-notification-tray" aria-label="Notifications">
    <header>
      <div><h2>Notifications</h2><p>Events that may need your attention</p></div>
      <div className="commandNotificationActions">
        <button type="button" onClick={markAllRead} disabled={!unreadCount}>{unreadCount ? "Mark all read" : "All read"}</button>
        <button className="commandIconButton" type="button" onClick={() => onClose()} aria-label="Close notifications"><CommandIcon name="close" /></button>
      </div>
    </header>
    {!entries.some((entry) => entry.group !== "System") && <div className="commandNotificationEmpty"><CommandIcon name="bell" /><strong>No session needs attention</strong><p>Pomegr will keep observing local session state.</p></div>}
    {groups.map((group) => {
      const groupEntries = entries.filter((entry) => entry.group === group);
      if (!groupEntries.length) return null;
      return <section key={group} aria-label={group}>
        <div className="commandNotificationGroup"><span>{group}</span><b>{groupEntries.filter(isUnread).length}</b></div>
        {groupEntries.slice(0, group === "Needs attention" ? 4 : groupEntries.length).map((entry) => <article className={`commandNotificationEntry${isUnread(entry) ? "" : " isRead"}`} key={entry.id}>
          <i className={`commandStatusDot ${entry.tone}`} aria-hidden="true" />
          <div><strong>{entry.title}</strong><p>{entry.description}</p>
            {entry.checkedAt && <p>Last checked <time dateTime={entry.checkedAt}>{new Date(entry.checkedAt).toLocaleString()}</time></p>}
            {entry.external ? <ExternalLink href={entry.href}>{entry.linkLabel}</ExternalLink> : <Link href={entry.href} onClick={() => onClose(false)}>{entry.linkLabel}</Link>}
          </div>
          {!entry.external && <time>Now</time>}
        </article>)}
      </section>;
    })}
    <footer aria-live="polite">{unreadCount ? `${unreadCount} unread ${unreadCount === 1 ? "notification" : "notifications"}` : "You are all caught up"}</footer>
  </aside>;
}
