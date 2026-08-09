import type { MonitorState } from "../../../shared/monitor-contract";
import { sessionListTime } from "../../dashboard-utils";
import { AgentChip } from "../AgentChip";
import { RelativeTimeText, SessionWallTimeText } from "../LiveTime";

export function SessionHero({ session, historical }: { session: MonitorState["session"]; historical: boolean }) {
  const sessionLabel = session?.title || "Waiting for a session";
  return (
    <section className="hero" id="top">
      <div>
        <div className="eyebrow"><span /> {historical ? "HISTORICAL SESSION" : "LIVE SESSION OBSERVER"} {session ? `· ${session.project}` : ""}</div>
        {session && <div className="sessionId"><span>SESSION ID</span><code>{session.id}</code></div>}
        <h1>{sessionLabel}</h1>
        <p title={session?.summary ? "Provider-generated session summary" : undefined}>{session?.summary?.text || (session
          ? historical ? "No provider-generated summary was recorded for this session." : "Waiting for a provider-generated session summary."
          : "Waiting for a session summary.")}</p>
        {session?.summary && <small className="heroSummarySource">Provider-generated session summary</small>}
      </div>
      <div className="sessionMeta">
        <div className="sessionMetaValues">
          <span>{historical ? "RECORDED WALL TIME" : "ELAPSED WALL TIME"}</span>
          <strong>{session ? <SessionWallTimeText session={session} historical={historical} /> : "—"}</strong>
          <small>{session ? historical ? `Ended ${sessionListTime(session.updatedAt || "")}` : <>Last event <RelativeTimeText value={session.updatedAt} /></> : "Auto-discovery enabled"}</small>
        </div>
        {session?.signal && <AgentChip className={`sessionSignal ${session.signal.tone}`} title="Reported for this session through the Threadlight MCP tool">{session.signal.label}</AgentChip>}
      </div>
    </section>
  );
}
