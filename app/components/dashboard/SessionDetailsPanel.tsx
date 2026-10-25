"use client";

import type { MonitorState, PomegrPluginMetadata } from "../../../shared/monitor-contract";
import { createEmptyProviderCapabilities } from "../../../shared/monitor-state.mjs";
import { sessionListTime } from "../../dashboard-utils";
import { RelativeTimeText } from "../LiveTime";
import { CopyTranscriptButton } from "../CopyTranscriptButton";
import { MachineryPanel } from "./MachineryPanel";

type SessionCost = NonNullable<NonNullable<MonitorState["session"]>["cost"]>;

function pluginVersionLabel(version: string | null) {
  return version ? `v${version.replace(/^v/i, "")}` : "Version unavailable";
}

function policyStatusLabel(status: PomegrPluginMetadata["policyStatus"]) {
  if (status === "valid") return "Valid";
  if (status === "invalid") return "Invalid — needs attention";
  if (status === "missing") return "Not configured";
  return "Unavailable";
}

function estimatedCostLabel(cost: SessionCost) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cost.currency,
    minimumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
    maximumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
  }).format(cost.amount);
}

export function SessionDetailsPanel({
  historical,
  showEstimatedCost = true,
  state,
}: {
  historical: boolean;
  showEstimatedCost?: boolean;
  state: MonitorState;
}) {
  if (!state.session) return null;
  const session = state.session;
  const capabilities = state.capabilities || createEmptyProviderCapabilities();
  const plugin = session.pomegrPlugin;
  const primaryAgent = state.agents.find((agent) => agent.id === "primary");

  return (
    <section className="sessionDetails" aria-label="Session details">
      <div className="sessionDetailsFacts">
        <section className="panel sessionFactsPanel" aria-label="Session">
          <header className="sessionDetailsHeader">
            <h2>Session</h2>
            {primaryAgent?.transcriptAvailable && <CopyTranscriptButton key={session.id} sessionId={session.id} agentId={primaryAgent.id} agentLabel={session.title || "this session"} showLabel />}
          </header>
          <dl className="sessionFacts">
            <div><dt>Provider</dt><dd>{state.source}</dd></div>
            <div><dt>Session ID</dt><dd className="sessionFactId">{session.id}</dd></div>
            <div><dt>Project</dt><dd>{session.project}</dd></div>
            <div><dt>Started</dt><dd>{session.startedAt ? sessionListTime(session.startedAt) : "Unavailable"}</dd></div>
            <div><dt>Approval mode</dt><dd>{capabilities.approvalMode ? session.approvalMode?.label || "Unavailable" : "Not supported"}</dd></div>
            {plugin && <div className="sessionPluginFact">
              <dt>Pomegr plugin</dt>
              <dd>
                <span>{pluginVersionLabel(plugin.version)}</span>
                <span>Policy: <strong className={`sessionPolicy-${plugin.policyStatus || "unknown"}`}>{policyStatusLabel(plugin.policyStatus)}{plugin.policyVersion === null ? "" : ` · v${plugin.policyVersion}`}</strong></span>
                <small>{historical ? "Recorded for this session" : "Observed at session start"}</small>
              </dd>
            </div>}
          </dl>
        </section>
        {showEstimatedCost && capabilities.estimatedCost && session.cost && (
          <section className="panel sessionCostDetail" aria-label="Cost estimate">
            <header className="sessionDetailsHeader"><h2>Cost estimate</h2><strong>{estimatedCostLabel(session.cost)}</strong></header>
            <p><span>{state.source} API list-rate estimate</span><br />
              Reference only — not a bill or subscription spend. {historical
                ? `Recorded ${sessionListTime(session.cost.observedAt)}`
                : <>Observed <RelativeTimeText value={session.cost.observedAt} /></>}
            </p>
          </section>
        )}
      </div>
      <MachineryPanel machinery={session.contextMachinery} supported={capabilities.contextMachinery} historical={historical} inventoryRef={session.contextInventoryRef} />
    </section>
  );
}
