"use client";

import type { MonitorState, PomegrPluginMetadata } from "../../../shared/monitor-contract";
import { createEmptyProviderCapabilities } from "../../../shared/monitor-state.mjs";
import { compactNumber, sessionListTime } from "../../dashboard-utils";
import { RelativeTimeText } from "../LiveTime";
import { ActivityPanel } from "./ActivityPanel";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";
import { MachineryPanel } from "./MachineryPanel";
import { RepositoryPanel } from "./RepositoryPanel";
import { UsageLimitsPanel } from "./UsageLimitsPanel";

function changeLabel(count: number) {
  if (count === 0) return "Clean";
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

function usageSummaryLimit(state: MonitorState) {
  return state.usageLimits.limits.find((candidate) => candidate.active) || state.usageLimits.limits[0] || null;
}

function compactUsageWindow(window: string) {
  return window
    .replace(/\s+minutes?\b/gi, "m")
    .replace(/\s+hours?\b/gi, "h")
    .replace(/\s+days?\b/gi, "d")
    .replace(/\s+weeks?\b/gi, "w")
    .replace(/\s+months?\b/gi, "mo");
}

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

function policySummaryLabel(plugin: PomegrPluginMetadata) {
  if (plugin.policyStatus === "valid") return plugin.policyVersion === null ? "Policy valid" : `Policy v${plugin.policyVersion}`;
  if (plugin.policyStatus === "invalid") return "Policy needs attention";
  return "Policy not configured";
}

function estimatedCostLabel(cost: SessionCost) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cost.currency,
    minimumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
    maximumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
  }).format(cost.amount);
}

function SessionDetailsSummary({ state, historical }: { state: MonitorState; historical: boolean }) {
  if (!state.session) return null;
  const capabilities = state.capabilities || createEmptyProviderCapabilities();
  const repository = state.session.repository;
  const usageLimit = usageSummaryLimit(state);
  const usagePercent = typeof usageLimit?.percent === "number" && Number.isFinite(usageLimit.percent)
    ? usageLimit.percent
    : null;
  const machinery = state.session.contextMachinery;
  const plugin = state.session.pomegrPlugin;

  return (
    <span className="disclosureSummaryMetrics sessionDetailsSummary">
      {repository.available ? (
        <span className="sessionGitSummary">
          <b>Git</b>
          <span className="sessionSummaryBranch" title={repository.branch}>{repository.branch}</span>
          <span aria-hidden="true">{"\u00b7"}</span>
          <span>{changeLabel(repository.files.length)}</span>
        </span>
      ) : <span><b>Git</b> Unavailable</span>}
      {!historical && capabilities.usageLimits && (
        <span><b>Usage {usageLimit ? compactUsageWindow(usageLimit.window) : "5h"}</b> {state.usageLimits.available && usagePercent !== null ? `${Math.round(usagePercent)}%` : "unavailable"}</span>
      )}
      {plugin && (
        <span className="sessionPomegrSummary">
          <b>Pomegr</b> {pluginVersionLabel(plugin.version)} <span aria-hidden="true">{"\u00b7"}</span> {policySummaryLabel(plugin)}
        </span>
      )}
      {capabilities.contextMachinery && machinery && (
        <span><b>Loaded inventory</b> {"\u2248"}{compactNumber(machinery.machineryTokens)}</span>
      )}
    </span>
  );
}

export function SessionDetailsPanel({
  historical,
  loading,
  onRefresh,
  state,
}: {
  historical: boolean;
  loading: boolean;
  onRefresh: () => void;
  state: MonitorState;
}) {
  if (!state.session) return null;
  const session = state.session;
  const capabilities = state.capabilities || createEmptyProviderCapabilities();
  const plugin = session.pomegrPlugin;

  return (
    <DashboardDisclosurePanel
      bodyClassName="sessionDetailsBody"
      className="sessionDetails"
      defaultOpen={false}
      storageKey="pomegr-session-details-open"
      summary={<SessionDetailsSummary state={state} historical={historical} />}
      title="Session details"
    >
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
      {capabilities.estimatedCost && session.cost && (
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
      <RepositoryPanel session={session} />
      {!historical && capabilities.usageLimits && <UsageLimitsPanel source={state.source} usageLimits={state.usageLimits} />}
      <MachineryPanel machinery={session.contextMachinery} supported={capabilities.contextMachinery} historical={historical} />
      <ActivityPanel activity={state.activity} historical={historical} loading={loading} onRefresh={onRefresh} />
    </DashboardDisclosurePanel>
  );
}
