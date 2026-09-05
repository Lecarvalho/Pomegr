"use client";

import type { MonitorState, PomegrPluginMetadata } from "../../../shared/monitor-contract";
import { createEmptyProviderCapabilities } from "../../../shared/monitor-state.mjs";
import { sessionListTime } from "../../dashboard-utils";
import { RelativeTimeText } from "../LiveTime";
import { ActivityPanel } from "./ActivityPanel";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";
import { MachineryPanel } from "./MachineryPanel";
import { UsageLimitsPanel } from "./UsageLimitsPanel";

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

function SessionDetailsSummary({ state, showEstimatedCost }: { state: MonitorState; showEstimatedCost: boolean }) {
  if (!state.session) return null;
  const capabilities = state.capabilities || createEmptyProviderCapabilities();
  const cost = showEstimatedCost && capabilities.estimatedCost ? state.session.cost : null;
  const plugin = state.session.pomegrPlugin;
  const pluginVersion = plugin?.version ? pluginVersionLabel(plugin.version) : null;
  const policyVersion = plugin?.policyVersion ?? null;
  const fallback = "Approval mode, usage limits, machinery, activity";

  return (
    <span className="sessionEvidenceSummary sessionDetailsSummary">
      <span className="sessionDesktopLabel">
        {cost && <>Estimated cost <span className="sessionSummaryData">{estimatedCostLabel(cost)}</span> (Claude Code estimate)</>}
        {pluginVersion && <>{cost ? " · " : ""}plugin <span className="sessionSummaryData">{pluginVersion}</span></>}
        {policyVersion !== null && <>{cost || pluginVersion ? " · " : ""}policy <span className="sessionSummaryData">v{policyVersion}</span></>}
        {!cost && !pluginVersion && policyVersion === null && fallback}
      </span>
      <span className="sessionPhoneLabel">
        {cost && <>Est. cost <span className="sessionSummaryData">{estimatedCostLabel(cost)}</span></>}
        {pluginVersion && <>{cost ? " · " : ""}plugin <span className="sessionSummaryData">{pluginVersion}</span></>}
        {!cost && !pluginVersion && fallback}
      </span>
    </span>
  );
}

export function SessionDetailsPanel({
  historical,
  loading,
  onRefresh,
  showEstimatedCost = true,
  state,
}: {
  historical: boolean;
  loading: boolean;
  onRefresh: () => void;
  showEstimatedCost?: boolean;
  state: MonitorState;
}) {
  if (!state.session) return null;
  const session = state.session;
  const capabilities = state.capabilities || createEmptyProviderCapabilities();
  const plugin = session.pomegrPlugin;

  return (
    <DashboardDisclosurePanel
      bodyClassName="sessionDetailsBody"
      className="sessionDetails sessionEvidenceDisclosure"
      defaultOpen={false}
      icon="chevron"
      storageKey="pomegr-session-details-open"
      summary={<SessionDetailsSummary state={state} showEstimatedCost={showEstimatedCost} />}
      title="Session details"
    >
      <div className="sessionFlowScore">
        <span>Flow score</span><strong>{state.readiness?.activityEvidence && state.readiness.activityEvidence !== "ready" ? "—" : `${state.score}/100`}</strong>
        <small>Deterministic attention heuristic based on repeated tool calls and overlapping edit targets; not a quality assessment.</small>
      </div>
      {plugin && (
        <section className="sessionPomegrIntegration" aria-label="Pomegr integration">
          <div className="sessionPomegrIntegrationHeader">
            <span>Pomegr integration</span>
            <small>{historical ? "Recorded for this session" : "Observed at session start"}</small>
          </div>
          <div className="sessionPomegrIntegrationGrid">
            <div>
              <span>Plugin</span>
              <strong title={plugin.version || undefined}>{pluginVersionLabel(plugin.version)}</strong>
            </div>
            <div className={`sessionPomegrPolicy sessionPomegrPolicy-${plugin.policyStatus || "unknown"}`}>
              <span>Policy</span>
              <strong>{policyStatusLabel(plugin.policyStatus)}{plugin.policyVersion === null ? "" : ` · v${plugin.policyVersion}`}</strong>
            </div>
          </div>
        </section>
      )}
      {showEstimatedCost && capabilities.estimatedCost && session.cost && (
        <div className="sessionCostDetail">
          <div>
            <span>{state.source} API list-rate estimate</span>
            <small>
              Reference only — not a bill or subscription spend. {historical
                ? `Recorded ${sessionListTime(session.cost.observedAt)}`
                : <>Observed <RelativeTimeText value={session.cost.observedAt} /></>}
            </small>
          </div>
          <strong>{estimatedCostLabel(session.cost)}</strong>
        </div>
      )}
      {!historical && capabilities.usageLimits && <UsageLimitsPanel source={state.source} usageLimits={state.usageLimits} />}
      <MachineryPanel machinery={session.contextMachinery} supported={capabilities.contextMachinery} historical={historical} inventoryRef={session.contextInventoryRef} />
      <ActivityPanel activity={state.activity} historical={historical} loading={loading} onRefresh={onRefresh} />
    </DashboardDisclosurePanel>
  );
}
