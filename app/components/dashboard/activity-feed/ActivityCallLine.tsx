"use client";

import type { Agent } from "../../../../shared/monitor-contract";
import type { HistoryActivity } from "../../../../shared/session-history-contract";
import { agentDisplayName, shortTime } from "../../../dashboard-utils";
import { WorkKindIcon } from "../../WorkKindIcon";
import { WORK_LABELS } from "../../agents/agent-presentation";
import { activityDuration } from "./duration";
import { targetBasename } from "./feed-model";

/**
 * Bounded lifecycle label and tone from the call's own recorded evidence. Execution-task lifecycle
 * (exit code, background flag, running) is not reachable here: history call ids are re-keyed
 * monitor-side and provider tool-use ids stay monitor-private, so no honest association exists yet.
 */
function callStatus(call: HistoryActivity) {
  if (call.status === "failed") return { label: "Failed", tone: "negative" };
  // A recorded call-to-result duration is the evidence that a result arrived at all.
  if (call.durationMs !== null) return { label: "Completed", tone: "positive" };
  return { label: "Status unavailable", tone: "" };
}

/** Result time: the recorded call time plus its own call-to-result wall duration. */
function resultTime(call: HistoryActivity) {
  if (call.durationMs === null) return "—";
  return shortTime(new Date(Date.parse(call.timestamp) + call.durationMs).toISOString());
}

/**
 * One phone call line: kind icon, ellipsized target and wall duration, with the detail block it
 * discloses in place beneath it. Only bounded activity metadata renders here; commands, output,
 * per-call tokens and cost never do.
 */
export function ActivityCallLine({ call, agent, open, busy, onToggle }: {
  call: HistoryActivity; agent: Agent | undefined; open: boolean; busy: boolean; onToggle: () => void;
}) {
  const status = callStatus(call);
  const kindLabel = WORK_LABELS[call.workKind];
  // A call recorded without a detail (an assistant reply, a tool that reports no argument) would
  // leave the line blank, so it falls back to the tool name desktop rows already print.
  const target = call.detail ? targetBasename(call.detail) : call.tool || "—";
  const duration = activityDuration(call.durationMs);
  const detailId = `call-detail-${call.id}`;
  return <li className="activityCallItem">
    <button type="button" className={`commandQuietAction activityCallLine${open ? " isOpen" : ""}`}
      aria-expanded={open} aria-controls={detailId} aria-disabled={busy || undefined}
      aria-label={`${kindLabel}, ${target}, ${duration}`}
      onClick={() => { if (busy) return; onToggle(); }}>
      <WorkKindIcon kind={call.workKind} />
      <span className="activityCallTarget">{target}</span>
      {/* A failed call tints its duration text alone; the line keeps the neutral feed tone. */}
      <span className={`activityCallDuration${call.status === "failed" ? " attention" : ""}${call.durationMs === null ? " unavailable" : ""}`}>{duration}</span>
      <svg className="activityCallChevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>
    </button>
    {open && <div className="activityCallDetail" id={detailId}>
      <div className="activityCallChips">
        <span className="commandChip">{kindLabel}</span>
        <span className={`commandChip${status.tone ? ` ${status.tone}` : ""}`}>{status.label}</span>
      </div>
      <div className="activityCallRow"><span>Kind</span><span>{kindLabel} · {call.tool}</span></div>
      <div className="activityCallRow"><span>Wall duration</span><span>{duration}</span></div>
      <div className="activityCallRow"><span>Called</span><span>{shortTime(call.timestamp)}</span></div>
      <div className="activityCallRow"><span>Result</span><span>{resultTime(call)}</span></div>
      <div className="activityCallRow"><span>Agent</span><span>{agent ? agentDisplayName(agent) : "Unknown agent"}</span></div>
    </div>}
  </li>;
}
