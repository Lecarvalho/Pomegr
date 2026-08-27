"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { SessionSummary } from "../../../shared/monitor-contract";
import pomegrPluginManifest from "../../../plugins/pomegr/.codex-plugin/plugin.json";
import { groupSessionsByProject, sessionListTime } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { CloseButton } from "../CloseButton";
import { DesktopUpdateOffer } from "../DesktopUpdateOffer";
import type { DesktopState } from "../DesktopControls";
import { SessionRelativeTimeText } from "../LiveTime";
import { ProviderBadge } from "../ProviderBadge";

function sessionActivityLabel(session: SessionSummary) {
  if (session.needsInput || session.activityStatus === "needs_input") return { label: "Needs input", className: "needsInput" };
  if (session.activityStatus === "working") return { label: "Working now", className: "working" };
  if (session.activityStatus === "idle") return { label: "Idle", className: "idle" };
  return { label: "Open", className: "unknown" };
}

export function SessionSidebar({ open, sessions, selectedSessionId, currentSessionId, viewingHistory, homeSelected = false, aboutSelected = false, update = null, onInstallUpdate = () => {}, onClose, onSelect }: {
  open: boolean;
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  currentSessionId: string | null;
  viewingHistory: boolean;
  homeSelected?: boolean;
  aboutSelected?: boolean;
  update?: DesktopState["update"] | null;
  onInstallUpdate?: () => void;
  onClose: () => void;
  onSelect: (session: SessionSummary) => void;
}) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const sidebarRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useDismissibleLayer(open, sidebarRef, close, false);
  const liveSessions = sessions.filter((session) => session.isLive);
  const historySessions = sessions.filter((session) => !session.isLive);
  const historyGroups = groupSessionsByProject(historySessions);
  const liveProjectCount = new Set(liveSessions.map((session) => session.project)).size;

  return (
    <>
      {open && <button className="sidebarBackdrop" type="button" onClick={onClose} aria-label="Close session navigation" />}
      <aside className={`sessionSidebar ${open ? "open" : ""}`} id="session-navigation" aria-label="Session navigation" ref={sidebarRef}>
        <div className="sidebarHeader">
          <div><span className="label">POMEGR</span><strong>Sessions</strong></div>
          <CloseButton label="Close session navigation" onClick={onClose} />
        </div>
        <nav className="sessionNav">
          <div className="liveHeading"><span>HOME</span><small>{liveProjectCount}</small></div>
          <Link className={`liveSessionLink ${homeSelected ? "selected" : ""}`} href="/" onClick={onClose} aria-label="Home — open sessions" aria-current={homeSelected ? "page" : undefined}>
            <i />
            <span><strong>Open sessions</strong><small>{liveSessions.length} open across projects</small></span>
          </Link>
          <div className="historyHeading"><span>OPEN SESSIONS</span><small>{liveSessions.length}</small></div>
          <div className="liveSessionList">
            {liveSessions.map((session) => {
              const selected = selectedSessionId ? selectedSessionId === session.id : currentSessionId === session.id && !viewingHistory;
              const activity = sessionActivityLabel(session);
              return (
                <button type="button" className={`liveSessionLink ${selected ? "selected" : ""}`} data-needs-input={session.needsInput || undefined} data-activity-status={activity.className} key={session.id} onClick={() => onSelect(session)} aria-current={selected ? "page" : undefined}>
                  <i />
                  <span><strong>{session.title}</strong><small><ProviderBadge source={session.source} compact /> · {session.project} · <em className={activity.className}>{activity.label}</em> · <SessionRelativeTimeText value={session.updatedAt} /></small></span>
                </button>
              );
            })}
            {liveSessions.length === 0 && <div className="liveSessionEmpty"><i /><span><strong>No open sessions</strong><small>New sessions appear automatically</small></span></div>}
          </div>
          <div className="historyHeading"><span>HISTORY</span><small>{historySessions.length}</small></div>
          <div className="historyList">
            {historySessions.length === 0 && <p>No recorded sessions yet.</p>}
            {historyGroups.map((group) => {
              const collapsed = !expandedProjects.has(group.project);
              const groupId = `history-project-${encodeURIComponent(group.project)}`;
              return (
                <section className={`historyProject ${collapsed ? "collapsed" : ""}`} key={group.project}>
                  <button className="historyProjectHeader" type="button" onClick={() => setExpandedProjects((current) => {
                    const next = new Set(current);
                    if (next.has(group.project)) next.delete(group.project); else next.add(group.project);
                    return next;
                  })} aria-expanded={!collapsed} aria-controls={groupId}>
                    <span><i aria-hidden="true">▾</i><strong title={group.project}>{group.project}</strong></span><small>{group.sessions.length}</small>
                  </button>
                  {!collapsed && <div className="historyProjectSessions" id={groupId}>
                    {group.sessions.map((session) => (
                      <button type="button" className={selectedSessionId === session.id ? "selected" : ""} key={session.id} onClick={() => onSelect(session)} aria-current={selectedSessionId === session.id ? "page" : undefined}>
                        <strong>{session.title}</strong><span className="historySessionMeta"><ProviderBadge source={session.source} compact /><time>{sessionListTime(session.updatedAt)}</time></span>
                      </button>
                    ))}
                  </div>}
                </section>
              );
            })}
            <Link className={`sidebarAboutLink ${aboutSelected ? "selected" : ""}`} href="/about" onClick={onClose} aria-current={aboutSelected ? "page" : undefined}><span>About Pomegr</span><i aria-hidden="true">→</i></Link>
          </div>
        </nav>
        <footer className="sidebarFooter">
          {update?.version && (update.status === "ready" || update.status === "installing") && (
            <DesktopUpdateOffer version={update.version} installing={update.status === "installing"} onInstall={onInstallUpdate} />
          )}
          <p className="sidebarMcpVersion" title="Latest Pomegr MCP version bundled with this app">
            <span>MCP version</span>
            <strong>v{pomegrPluginManifest.version}</strong>
          </p>
        </footer>
      </aside>
    </>
  );
}
