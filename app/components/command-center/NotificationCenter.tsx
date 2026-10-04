"use client";

import Link from "next/link";
import { useState } from "react";
import type { NotificationAction, NotificationRecord } from "../../../shared/notification-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { useNotificationSnapshot } from "../../notifications-client";
import { useNotificationReadState } from "../../notification-read-state";
import { CommandIcon } from "./CommandIcon";

export type NotificationView = {
  id: string;
  kind: string;
  group: "Needs attention" | "Provider service" | "System";
  title: string;
  description: string;
  href: string;
  linkLabel: string;
  tone: "attention" | "online" | "offline";
  occurredAt: string;
  priority: number;
};

export type NotificationPresentationRule = {
  kind: string;
  present: (record: NotificationRecord) => Pick<NotificationView, "group" | "title" | "description" | "tone"> | null;
};

const PROVIDER_LABEL = { claude: "Claude Code", codex: "Codex" } as const;
const GROUP_ORDER: NotificationView["group"][] = ["Needs attention", "Provider service", "System"];

/** Fixed destinations. A malformed session identity falls back to the Sessions page. */
export function notificationDestination(action: NotificationAction, record: NotificationRecord): { href: string; label: string } {
  switch (action) {
    case "open_session": {
      if (record.kind === "needs_input" && record.data.sessionId.startsWith(`${record.provider}:`)) {
        try { return { href: `/sessions/${encodeSessionRoute(record.data.sessionId)}`, label: "Open session" }; }
        catch { /* malformed identity must never become a route */ }
      }
      return { href: "/sessions", label: "View sessions" };
    }
    case "open_sessions": return { href: "/sessions", label: "View sessions" };
    case "open_providers": return { href: "/usage-limits", label: "View providers" };
    case "open_workspace": return { href: "/", label: "View workspace" };
  }
}

export const NOTIFICATION_PRESENTATION: readonly NotificationPresentationRule[] = [
  { kind: "needs_input", present: (record) => record.kind === "needs_input" && record.lifecycle === "active" ? {
    group: "Needs attention", title: record.data.sessionTitle,
    description: "Needs input. This live session is waiting for your action; recorded state may be stale.", tone: "attention",
  } : null },
  { kind: "provider_incident", present: (record) => record.kind === "provider_incident" && record.lifecycle === "active" ? {
    group: "Provider service", title: `${PROVIDER_LABEL[record.provider]} reports service issues`,
    description: record.data.status === "outage" ? "The provider reports an outage. Requests may be delayed or fail."
      : record.data.status === "maintenance" ? "The provider reports maintenance. Requests may be delayed."
        : "The provider reports degraded service. Requests may be delayed or fail.", tone: "attention",
  } : null },
  { kind: "provider_recovery", present: (record) => record.kind === "provider_recovery" ? {
    group: "Provider service", title: `${PROVIDER_LABEL[record.provider]} reports service restored`,
    description: "The provider's public status is operational again. This does not confirm that a session succeeded.", tone: "online",
  } : null },
  { kind: "monitor_unreachable", present: (record) => record.kind === "monitor_unreachable" ? {
    group: "System", title: "Monitor unavailable",
    description: "Pomegr will retry automatically while preserving the last known-good state.", tone: "offline",
  } : null },
];

/** Presentation registration is separate from tray rendering. Tests can add a producer here. */
export function adaptNotificationRecords(records: readonly NotificationRecord[], rules: readonly NotificationPresentationRule[] = NOTIFICATION_PRESENTATION): NotificationView[] {
  const byKind = new Map(rules.map((rule) => [rule.kind, rule]));
  return records.flatMap((record) => {
    const presentation = byKind.get(record.kind)?.present(record);
    if (!presentation) return [];
    const destination = notificationDestination(record.action, record);
    return [{ id: record.id, kind: record.kind, occurredAt: record.occurredAt, priority: record.priority,
      ...presentation, href: destination.href, linkLabel: destination.label }];
  }).sort((left, right) => right.priority - left.priority || right.occurredAt.localeCompare(left.occurredAt));
}

export function useNotifications(connected: boolean, loading: boolean) {
  const { snapshot, status } = useNotificationSnapshot();
  const { read, markRead } = useNotificationReadState();
  const [localRead, setLocalRead] = useState<Set<string>>(() => new Set());
  const [offline, setOffline] = useState<{ active: boolean; occurredAt: string | null }>({ active: false, occurredAt: null });
  const offlineNow = !connected && !loading;
  if (offline.active !== offlineNow) setOffline({ active: offlineNow, occurredAt: offlineNow ? new Date().toISOString() : null });
  const local: NotificationRecord[] = offlineNow ? [{
    id: "client:monitor_unreachable", kind: "monitor_unreachable", provider: null, data: {},
    category: "system", severity: "warning", lifecycle: "active", priority: 90,
    occurredAt: offline.occurredAt || new Date().toISOString(), timeBasis: "observed",
    deliveryEligible: false, action: "open_workspace",
  }] : [];
  const entries = adaptNotificationRecords([...snapshot.occurrences, ...local]);
  const visibleIds = new Set(entries.map((entry) => entry.id));
  if ([...localRead].some((id) => !visibleIds.has(id))) setLocalRead(new Set([...localRead].filter((id) => visibleIds.has(id))));
  const isUnread = (entry: NotificationView) => !read.has(entry.id) && !localRead.has(entry.id);
  const unreadCount = entries.filter(isUnread).length;
  return {
    entries, isUnread, unreadCount,
    hasUnreadAttention: entries.some((entry) => entry.group !== "System" && isUnread(entry)),
    markAllRead: () => {
      markRead(entries.map((entry) => entry.id));
      setLocalRead(new Set(entries.filter((entry) => entry.id.startsWith("client:")).map((entry) => entry.id)));
    },
    sourceStatus: status, activeSessionOverflow: snapshot.activeSessionOverflow,
  };
}

export function NotificationCenter({ entries, isUnread, unreadCount, markAllRead, sourceStatus, activeSessionOverflow, onClose }: ReturnType<typeof useNotifications> & { onClose: (returnFocus?: boolean) => void }) {
  return <aside className="commandNotificationTray" id="command-notification-tray" data-testid="notification-center" aria-label="Notifications">
    <header>
      <div><h2>Notifications</h2><p>Events that may need your attention</p></div>
      <div className="commandNotificationActions">
        <button className="commandQuietAction" type="button" onClick={markAllRead} disabled={!unreadCount}>{unreadCount ? "Mark all read" : "All read"}</button>
        <button className="commandIconButton" type="button" onClick={() => onClose()} aria-label="Close notifications"><CommandIcon name="close" /></button>
      </div>
    </header>
    {sourceStatus !== "ready" && <div className="commandNotificationGroup" role="status">{sourceStatus === "loading" ? "Loading notifications…" : "Notification updates are delayed. Showing last known state."}</div>}
    {!entries.some((entry) => entry.group !== "System") && sourceStatus === "ready" && <div className="commandNotificationEmpty"><CommandIcon name="bell" /><strong>No session needs attention</strong><p>Pomegr will keep observing local session state.</p></div>}
    {GROUP_ORDER.map((group) => {
      const groupEntries = entries.filter((entry) => entry.group === group);
      if (!groupEntries.length) return null;
      return <section key={group} aria-label={group}>
        <div className="commandNotificationGroup"><span>{group}</span><b>{groupEntries.filter(isUnread).length}</b></div>
        {groupEntries.map((entry) => <article className={`commandNotificationEntry${isUnread(entry) ? "" : " isRead"}`} key={entry.id} data-testid={`notification-${entry.kind}`} aria-label={`${entry.title}, ${entry.kind.replaceAll("_", " ")}`}>
          <i className={`commandStatusDot ${entry.tone}`} aria-hidden="true" />
          <div><strong>{entry.title}</strong><p>{entry.description}</p>
            <Link href={entry.href} onClick={() => onClose(false)}>{entry.linkLabel}</Link>
          </div>
          <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</time>
        </article>)}
      </section>;
    })}
    {activeSessionOverflow > 0 && <div className="commandNotificationGroup"><span>{activeSessionOverflow} more sessions need input</span><Link href="/sessions" onClick={() => onClose(false)}>View sessions</Link></div>}
    <footer aria-live="polite">{unreadCount ? `${unreadCount} unread ${unreadCount === 1 ? "notification" : "notifications"}` : "You are all caught up"}</footer>
  </aside>;
}
