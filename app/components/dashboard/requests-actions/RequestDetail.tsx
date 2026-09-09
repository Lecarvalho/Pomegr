import type { Agent } from "../../../../shared/monitor-contract";
import { agentDisplayName, cacheLifetimeLabel, shortTime } from "../../../dashboard-utils";
import { AgentChip } from "../../AgentChip";
import { WORK_LABELS } from "../../agents/agent-presentation";
import { requestNumber, type RequestRow } from "./model";
import { RequestCacheDetail } from "./RequestCacheDetail";

export function RequestNavigation({ ordinal, count, onStep, canPrev = ordinal > 1, canNext = ordinal < count }: { ordinal: number; count: number; onStep: (delta: number) => void; canPrev?: boolean; canNext?: boolean }) {
  return <div className="requestsActionsNavigation"><button type="button" className="commandSecondaryAction" disabled={!canPrev} onClick={() => onStep(-1)}>Prev</button><button type="button" className="commandSecondaryAction" disabled={!canNext} onClick={() => onStep(1)}>Next</button></div>;
}

export function RequestDetail({ row, agent, count, phone, cacheWriteAvailable, onStep, canPrev, canNext }: {
  row: RequestRow; agent?: Agent; count: number; phone: boolean; cacheWriteAvailable: boolean; onStep: (delta: number) => void; canPrev?: boolean; canNext?: boolean;
}) {
  const stats = [
    { label: "Uncached input", kind: "uncached", value: row.uncachedInputTokens },
    ...(cacheWriteAvailable ? [{ label: "Cache write", kind: "write", value: row.cacheWriteTokens }] : []),
    { label: "Cache read", kind: "read", value: row.cacheReadTokens },
    { label: "Output", kind: "output", value: row.outputTokens },
  ];
  return <section className="requestsActionsDetail" aria-label="Selected request">
    <header><div><h3>Request <span className="requestsActionsNumber">#{requestNumber(row)}</span></h3><p>{agent ? agentDisplayName(agent) : "Unknown agent"} · {shortTime(row.observedAt)} · {cacheLifetimeLabel(row.cacheLifetime).replace("cache TTL", "cache lifetime")}</p></div>
      {!phone && <RequestNavigation ordinal={row.ordinal} count={count} onStep={onStep} canPrev={canPrev} canNext={canNext} />}</header>
    <p className="requestsActionsPrompt"><span>Full prompt</span><strong>{row.promptTokens.toLocaleString()} tokens</strong></p>
    <div className={`requestsActionsStats${cacheWriteAvailable ? "" : " withoutWrite"}`}>
      {stats.map(({ label, kind, value }) => <div className={`requestsActionsStat ${kind}`} key={kind}><span className="sessionEyebrow"><i className={`requestsActionsSwatch ${kind}`} aria-hidden="true" />{label}</span><strong>{value.toLocaleString()}</strong></div>)}
    </div>
    <RequestCacheDetail row={row} />
    <div className="requestsActionsWork">
      {[{ title: "Before", work: row.precedingWork }, { title: "Issued", work: row.issuedWork }].map(({ title, work }) => <div key={title}>
        <h4 className="sessionEyebrow">{title}</h4>
        <div className="requestsActionsChips">{work.length ? work.map(({ kind, count }) => <AgentChip key={kind}>{WORK_LABELS[kind]}{count > 1 ? ` ×${count}` : ""}</AgentChip>) : <span className="requestsActionsNone">None recorded</span>}</div>
      </div>)}
    </div>
  </section>;
}
