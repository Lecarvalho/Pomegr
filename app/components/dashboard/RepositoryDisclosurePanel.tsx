"use client";

import type { MonitorState } from "../../../shared/monitor-contract";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";
import { RepositoryPanel } from "./RepositoryPanel";

export function RepositoryDisclosurePanel({ session, historical }: {
  session: NonNullable<MonitorState["session"]>;
  historical: boolean;
}) {
  const repository = session.repository;
  return (
    <DashboardDisclosurePanel
      className="sessionRepository sessionEvidenceDisclosure"
      defaultOpen={false}
      icon="chevron"
      storageKey="pomegr-disclosure-repository"
      title="Repository"
      summary={
        <span className="sessionEvidenceSummary">
          {repository.available ? <>
            <span className="sessionRepositoryBranch">{repository.branch}</span>{" · "}
            <span className="sessionSummaryData">{repository.commits.length}</span> commits · {" "}
            <span className="sessionSummaryData">{repository.files.length}</span> files
            <span className="sessionDesktopLabel"> changed · {historical ? "recorded state" : "working tree"}</span>
          </> : "No repository detected"}
        </span>
      }
    >
      {!repository.available && <p className="sessionRepositoryEmpty">No repository detected</p>}
      <RepositoryPanel session={session} />
    </DashboardDisclosurePanel>
  );
}
