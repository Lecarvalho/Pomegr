import type { Agent } from "../../../../shared/monitor-contract";
import { agentDisplayName, cacheLifetimeLabel, shortTime } from "../../../dashboard-utils";
import { AgentChip } from "../../AgentChip";
import { WORK_LABELS } from "../../agents/agent-presentation";
import type { RequestRow } from "./model";

export function RequestNavigation({ ordinal, count, onStep }: { ordinal: number; count: number; onStep: (delta: number) => void }) {
  return <div className="requestsActionsNavigation"><button type="button" className="requestsActionsButton" disabled={ordinal <= 1} onClick={() => onStep(-1)}>Prev</button><button type="button" className="requestsActionsButton" disabled={ordinal >= count} onClick={() => onStep(1)}>Next</button></div>;
}

export function RequestDetail({ row, agent, count, phone, cacheWriteAvailable, onStep }: {
  row: RequestRow; agent?: Agent; count: number; phone: boolean; cacheWriteAvailable: boolean; onStep: (delta: number) => void;
}) {
  const stats = [
    { label: "Uncached input", kind: "uncached", value: row.uncachedInputTokens },
    ...(cacheWriteAvailable ? [{ label: "Cache write", kind: "write", value: row.cacheWriteTokens }] : []),
    { label: "Cache read", kind: "read", value: row.cacheReadTokens },
    { label: "Output", kind: "output", value: row.outputTokens },
  ];
  return <section className="requestsActionsDetail" aria-label="Selected request">
    <header><div><h3>Request <span className="requestsActionsNumber">#{row.ordinal}</span></h3><p>{agent ? agentDisplayName(agent) : "Unknown agent"} · {shortTime(row.observedAt)} · {cacheLifetimeLabel(row.cacheLifetime).replace("cache TTL", "cache lifetime")}</p></div>
      {!phone && <RequestNavigation ordinal={row.ordinal} count={count} onStep={onStep} />}</header>
    <div className={`requestsActionsStats${cacheWriteAvailable ? "" : " withoutWrite"}`}>
      {stats.map(({ label, kind, value }) => <div className={`requestsActionsStat ${kind}`} key={kind}><span className="sessionEyebrow"><i className={`requestsActionsSwatch ${kind}`} aria-hidden="true" />{label}</span><strong>{value.toLocaleString()}</strong></div>)}
    </div>
    <div className="requestsActionsWork">
      {[{ title: "Results available before", association: "transcript adjacency", work: row.precedingWork }, { title: "Actions issued by request", association: "recorded link", work: row.issuedWork }].map(({ title, association, work }) => <div key={title}>
        <h4 className="sessionEyebrow">{title} <span>· {association}</span></h4>
        <div className="requestsActionsChips">{work.length ? work.map(({ kind, count }) => <AgentChip key={kind}>{WORK_LABELS[kind]}{count > 1 ? ` ×${count}` : ""}</AgentChip>) : <span className="requestsActionsNone">None recorded</span>}</div>
      </div>)}
    </div>
    <p className="requestsActionsCaveat">Surrounding actions do not establish token cost per operation.{!phone && " Uncached input is the portion recorded without cache reuse or cache writes."}</p>
  </section>;
}
