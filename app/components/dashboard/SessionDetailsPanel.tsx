"use client";

import type { MonitorState } from "../../../shared/monitor-contract";
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

  return (
    <DashboardDisclosurePanel
      bodyClassName="sessionDetailsBody"
      className="sessionDetails"
      defaultOpen={false}
      storageKey="pomegr-session-details-open"
      summary={<SessionDetailsSummary state={state} historical={historical} />}
      title="Session details"
    >
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
