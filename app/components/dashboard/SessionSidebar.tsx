"use client";

import { useCallback, useRef, useState } from "react";
import type { SessionSummary } from "../../../shared/monitor-contract";
import { groupSessionsByProject, relativeTime, sessionListTime } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { CloseButton } from "../CloseButton";

export function SessionSidebar({ open, sessions, selectedSessionId, currentSessionId, viewingHistory, onClose, onSelect }: {
  open: boolean;
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  currentSessionId: string | null;
  viewingHistory: boolean;
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

  return (
    <>
      {open && <button className="sidebarBackdrop" type="button" onClick={onClose} aria-label="Close session navigation" />}
      <aside className={`sessionSidebar ${open ? "open" : ""}`} aria-label="Session navigation" ref={sidebarRef}>
        <div className="sidebarHeader">
          <div><span className="label">THREADLIGHT</span><strong>Sessions</strong></div>
          <CloseButton label="Close session navigation" onClick={onClose} />
        </div>
        <nav className="sessionNav">
          <div className="liveHeading"><span>LIVE SESSIONS</span><small>{liveSessions.length}</small></div>
          <div className="liveSessionList">
            {liveSessions.map((session) => {
              const selected = selectedSessionId ? selectedSessionId === session.id : currentSessionId === session.id && !viewingHistory;
              return (
                <button type="button" className={`liveSessionLink ${selected ? "selected" : ""}`} data-needs-input={session.needsInput || undefined} key={session.id} onClick={() => onSelect(session)} aria-current={selected ? "page" : undefined}>
                  <i />
                  <span><strong>{session.title}</strong><small>{session.project} · {session.needsInput ? <em>Needs input</em> : relativeTime(session.updatedAt)}</small></span>
                </button>
              );
            })}
            {liveSessions.length === 0 && <div className="liveSessionEmpty"><i /><span><strong>Waiting for a session</strong><small>Auto-discovery enabled</small></span></div>}
          </div>
          <div className="historyHeading"><span>HISTORY</span><small>{historySessions.length}</small></div>
          <div className="historyList">
            {historySessions.length === 0 && <p>No previous sessions found.</p>}
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
                        <strong>{session.title}</strong><time>{sessionListTime(session.updatedAt)}</time>
                      </button>
                    ))}
                  </div>}
                </section>
              );
            })}
            <a className="sidebarAboutLink" href="/about"><span>About Threadlight</span><i aria-hidden="true">→</i></a>
          </div>
        </nav>
      </aside>
    </>
  );
}
