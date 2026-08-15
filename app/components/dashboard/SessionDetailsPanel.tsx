"use client";

import type { MonitorState } from "../../../shared/monitor-contract";
import { createEmptyProviderCapabilities } from "../../../shared/monitor-state.mjs";
import { compactNumber } from "../../dashboard-utils";
import { ActivityPanel } from "./ActivityPanel";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";
import { MachineryPanel } from "./MachineryPanel";
import { RepositoryPanel } from "./RepositoryPanel";
import { UsageLimitsPanel } from "./UsageLimitsPanel";

function changeLabel(count: number) {
  if (count === 0) return "Clean";
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

function maximumUsagePercent(state: MonitorState) {
  const percentages = state.usageLimits.limits
    .map((limit) => limit.percent)
    .filter((percent) => Number.isFinite(percent));
  return percentages.length > 0 ? Math.max(...percentages) : null;
}

function SessionDetailsSummary({ state, historical }: { state: MonitorState; historical: boolean }) {
  if (!state.session) return null;
  const capabilities = state.capabilities || createEmptyProviderCapabilities();
  const repository = state.session.repository;
  const maximumUsage = maximumUsagePercent(state);
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
        <span><b>Usage</b> {state.usageLimits.available && maximumUsage !== null ? `${Math.round(maximumUsage)}%` : "unavailable"}</span>
      )}
      {capabilities.contextMachinery && machinery && (
        <span><b>Loaded</b> {"\u2248"}{compactNumber(machinery.machineryTokens)}</span>
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
      <RepositoryPanel session={session} />
      {!historical && capabilities.usageLimits && <UsageLimitsPanel usageLimits={state.usageLimits} />}
      <MachineryPanel machinery={session.contextMachinery} supported={capabilities.contextMachinery} historical={historical} />
      <ActivityPanel activity={state.activity} historical={historical} loading={loading} onRefresh={onRefresh} />
    </DashboardDisclosurePanel>
  );
}
