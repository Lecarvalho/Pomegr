"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { PullRequest } from "../../../shared/monitor-contract";
import type { RepositoryDomain } from "../../../shared/session-domain-contract";
import { timelineTime } from "../../dashboard-utils";
import { useSessionCatalog } from "../../hooks/SessionCatalogContext";
import { useSessionDomain } from "../../session-domain-store";
import { FileTree } from "../repositories/FileTree";
import { SessionFilePanel } from "./SessionFilePanel";
import { repositoryFilePath } from "../repositories/repository-route";
import { CommandIcon } from "../command-center/CommandIcon";
import { RelativeTimeText } from "../LiveTime";
import {
  bestRepositoryTabFilesSegment,
  buildRepositoryTabFilesSegments,
  ELSEWHERE_SEGMENT_EMPTY_TEXT,
  filterFilesByPath,
  REPOSITORY_TAB_FILES_SEGMENTS,
  segmentCount,
  touchedSegmentEmptyText,
  uncommittedSegmentEmptyText,
  type RepositoryTabFilesSegment,
} from "./repository-files-view";

export type RepositoryTabProps = {
  sessionId: string;
  historical: boolean;
  paused?: boolean;
  /** Deep-linked or previously selected repository-relative path (F21); null selects nothing. */
  selectedPath?: string | null;
  onSelectPath?: (path: string | null) => void;
  /** Opens a recorded agent in the session's Agents tab. */
  onOpenAgent?: (agentId: string) => void;
};

type Repository = NonNullable<RepositoryDomain["repository"]>;
type Comparison = Repository["comparison"];
// Local shape for the Fixed interface's `gitTasks` field (shared/session-domain-contract.ts),
// kept independent of RepositoryDomain so this file typechecks whether or not the parallel
// monitor change has landed that field yet.
type GitTasks = { total: number; failed: number } | null;

// Compact chip text for the top bar (G3). Distinct from the longer sentence `comparisonLabel`
// (app/dashboard-utils.ts) used by the Overview repository row.
function comparisonChipText(comparison: Comparison): string | null {
  if (!comparison) return null;
  if (comparison.integrated) return `Integrated into ${comparison.branch}`;
  if (comparison.ahead === 0 && comparison.behind === 0) return `Up to date with ${comparison.branch}`;
  if (comparison.behind === 0) return `${comparison.ahead} ahead of ${comparison.branch}`;
  if (comparison.ahead === 0) return `${comparison.behind} behind ${comparison.branch}`;
  return `${comparison.ahead} ahead, ${comparison.behind} behind ${comparison.branch}`;
}

function comparisonChipTone(comparison: Comparison): "positive" | "warning" | undefined {
  if (!comparison || comparison.integrated) return undefined;
  if (comparison.behind > 0) return "warning";
  if (comparison.ahead > 0) return "positive";
  return undefined;
}

function pullRequestChipText(pullRequests: PullRequest[]): string | null {
  if (pullRequests.length === 0) return null;
  if (pullRequests.length > 1) return `${pullRequests.length} pull requests`;
  const pullRequest = pullRequests[0]!;
  const state = pullRequest.draft ? "Draft" : pullRequest.state.charAt(0).toUpperCase() + pullRequest.state.slice(1);
  return `${state} PR #${pullRequest.number}`;
}

function pullRequestSizeText(pullRequests: PullRequest[]): string | null {
  if (pullRequests.length !== 1) return null;
  const pullRequest = pullRequests[0]!;
  if (pullRequest.additions === null || pullRequest.deletions === null) return null;
  return `PR +${pullRequest.additions.toLocaleString()} −${pullRequest.deletions.toLocaleString()}`;
}

function commitsInSessionText(commitsInSession: number | null, ahead: number | null): string | null {
  if (commitsInSession === null) return null;
  if (commitsInSession === 0) return "No commits in this session";
  if (commitsInSession === ahead) {
    if (commitsInSession === 2) return "Both commits in this session";
    if (commitsInSession > 2) return `All ${commitsInSession} commits in this session`;
  }
  if (commitsInSession === 1) return "1 commit in this session";
  return `${commitsInSession} commits in this session`;
}

function gitTasksText(gitTasks: GitTasks): string | null {
  if (!gitTasks || gitTasks.total === 0) return null;
  return `${gitTasks.total} git shell task${gitTasks.total === 1 ? "" : "s"}, ${gitTasks.failed} failed`;
}

function joinLineParts(parts: Array<{ key: string; node: ReactNode }>) {
  return parts.map((part, index) => <span key={part.key}>{index > 0 ? " · " : ""}{part.node}</span>);
}

function RepositoryTabBarSkeleton() {
  return <div className="panel repositoryTabBar repositoryTabBarSkeleton" role="status" aria-label="Loading repository evidence" aria-busy="true">
    <span className="repositoryTabBarSkeletonLine" />
    <span className="repositoryTabBarSkeletonLine" />
  </div>;
}

function FilesTreeSkeleton() {
  return <div className="panel repositoryTabFilesTree repositoryTabFilesSkeleton" role="status" aria-label="Loading file history" aria-busy="true">
    <span className="repositoryTabFilesSkeletonLine" />
    <span className="repositoryTabFilesSkeletonLine" />
    <span className="repositoryTabFilesSkeletonLine" />
  </div>;
}

/** The session Repository tab's body (F17/F18): a search field, a Touched here / Uncommitted /
 * Changed elsewhere segment, and the shared FileTree plus the fetch-free SessionFilePanel. */
function RepositoryTabFiles({ domain, workingTreeFiles, repositoryId, historical, workingTreeKnown, sessionId, selectedPath, onSelectPath, onOpenAgent }: {
  domain: RepositoryDomain;
  workingTreeFiles: Repository["files"];
  repositoryId: string;
  historical: boolean;
  /** False without Git state (no saved snapshot, or no live repository): only recorded changes can be listed. */
  workingTreeKnown: boolean;
  sessionId: string;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [manualSegment, setManualSegment] = useState<RepositoryTabFilesSegment | null>(null);
  const { sessions } = useSessionCatalog();
  const rootLabel = sessions.find((session) => session.id === sessionId)?.project ?? "Repository";
  const segments = buildRepositoryTabFilesSegments(domain.fileHistory.files, workingTreeFiles, domain.gitObservedFiles);
  // Without a snapshot the Uncommitted and Changed elsewhere segments would read as "none", so
  // only Touched here (the recorded file-change index) is offered.
  const segment = workingTreeKnown ? manualSegment ?? bestRepositoryTabFilesSegment(selectedPath, segments) : "touched";
  const query = search.trim();
  const treeLoading = segment === "touched" && domain.fileHistory.readiness === "loading";
  const listedFiles = filterFilesByPath(segments[segment], query);
  const listedElsewhere = segment === "touched" ? filterFilesByPath(segments.touchedElsewhere, query) : undefined;
  // The panel describes only a file the tree currently lists: after a segment switch or a search
  // that drops the selected row, its history would read as a file that is not there.
  const shownPath = selectedPath && (treeLoading || [...listedFiles, ...listedElsewhere ?? []].some((file) => file.path === selectedPath)) ? selectedPath : null;
  const recorded = shownPath ? domain.fileHistory.files.find((file) => file.path === shownPath) ?? null : null;
  const gitObserved = shownPath ? domain.gitObservedFiles?.files.find((file) => file.path === shownPath) ?? null : null;
  const workingTreeStatus = shownPath ? workingTreeFiles.find((file) => file.path === shownPath)?.status ?? null : null;

  const selectSegment = (next: RepositoryTabFilesSegment) => setManualSegment(next);
  const selectFile = (path: string) => onSelectPath(path);

  const treeArea = treeLoading
    ? <FilesTreeSkeleton />
    : <FileTree
        scope="session"
        rootLabel={rootLabel}
        files={listedFiles}
        elsewhere={listedElsewhere}
        selectedPath={shownPath}
        onSelect={(file) => selectFile(file.path)}
        expandAll={query.length > 0}
        emptyText={segment === "touched"
          ? touchedSegmentEmptyText(domain.fileHistory.readiness) ?? "No files touched in this session yet."
          : segment === "uncommitted" ? uncommittedSegmentEmptyText(historical) : ELSEWHERE_SEGMENT_EMPTY_TEXT}
        className="repositoryTabFilesTree"
      />;

  return <div className="repositoryTabFiles">
    <div className="repositoryTabFilesToolbar">
      <input
        type="search"
        className="repositoryTabFilesSearch"
        aria-label="Find a file touched in this session"
        placeholder="Find a file touched in this session"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {workingTreeKnown && <div className="commandSegmented" role="group" aria-label="File segment">
        {REPOSITORY_TAB_FILES_SEGMENTS.map(({ id, label }) => <button key={id} type="button" aria-pressed={segment === id} onClick={() => selectSegment(id)}>{label} {segmentCount(segments, id)}</button>)}
      </div>}
      <span className="commandChip repositoryTabFilesBeta" title="File coverage is still being expanded.">Beta</span>
    </div>
    <div className="panel repositoryTabFilesBody">
      {treeArea}
      <SessionFilePanel
        repositoryId={repositoryId}
        repositoryLabel={rootLabel}
        path={shownPath}
        workingTreeStatus={workingTreeStatus}
        statusRecorded={historical}
        recorded={recorded}
        recordedReadiness={domain.fileHistory.readiness}
        gitObserved={gitObserved}
        onOpenAgent={onOpenAgent}
        className="repositoryTabFilesPanel"
      />
    </div>
  </div>;
}

/** The session Repository tab: a top bar (branch, comparison, PR, git-task summary) plus the
 * file tree / file history body (F17/F18). The commit list moved to the repository page Git tab
 * (RepositoryGitTab.tsx); see docs/internal/plans/ia-redesign for the design contract. */
export function RepositoryTab({ sessionId, historical, paused = false, selectedPath: selectedPathInput = null, onSelectPath = () => {}, onOpenAgent }: RepositoryTabProps) {
  const result = useSessionDomain({ sessionId, domain: "repository" }, { historical, enabled: !paused });
  const domain = result.data;
  const selectedPath = repositoryFilePath(selectedPathInput) ?? null;

  if (!domain) return <div className="sessionTabState" role="status">{result.unavailable ? "Repository evidence is unavailable for this session." : result.error ? "Repository evidence is temporarily unavailable." : "Loading repository evidence…"}</div>;
  if (domain.readiness === "loading") return <RepositoryTabBarSkeleton />;

  const repository = domain.repository;
  if (!repository || !repository.available) {
    // Recorded file changes are session evidence, not Git state: they list for a linked
    // repository even when no live Git state can be shown for it.
    if (!domain.repositoryId) {
      return <section className="panel repositoryTabBar repositoryTabBarEmpty">
        <p className="repositoryTabBarEmptyText">No Git repository detected for this session.</p>
      </section>;
    }
    return <div className="repositoryTab">
      <section className="panel repositoryTabBar repositoryTabBarEmpty" aria-label="Repository">
        <p className="repositoryTabBarEmptyText">{domain.unavailableReason === "branch_changed"
          ? "The working tree is no longer on this session's branch. Branch comparison, pull requests, and uncommitted files are unavailable."
          : "Git state is unavailable for this session. Branch comparison, pull requests, and uncommitted files are unavailable."}</p>
      </section>
      <RepositoryTabFiles domain={domain} workingTreeFiles={[]} repositoryId={domain.repositoryId} historical={historical} workingTreeKnown={false} sessionId={sessionId} selectedPath={selectedPath} onSelectPath={onSelectPath} onOpenAgent={onOpenAgent} />
    </div>;
  }

  // G10: a historical session with no saved live-check snapshot has no Git state to show. Its
  // recorded file changes come from the file-change index, not the snapshot, and still render.
  const snapshotMissing = repository.historical && domain.recordedAt === null;

  const pullRequests = domain.pullRequests?.items || [];
  const comparisonKnown = repository.remote.status === "ready";
  const comparisonText = comparisonKnown ? comparisonChipText(repository.comparison) : null;
  const comparisonTone = comparisonKnown ? comparisonChipTone(repository.comparison) : undefined;
  const remoteStateText = repository.remote.status === "checking" ? "Checking remote…" : repository.remote.status === "unavailable" ? "Remote comparison unavailable" : null;
  const prChipText = pullRequestChipText(pullRequests);

  const lineParts: Array<{ key: string; node: ReactNode }> = [];
  const commitsText = commitsInSessionText(domain.commitsInSession, repository.comparison?.ahead ?? null);
  if (commitsText) lineParts.push({ key: "commits", node: commitsText });
  const prSizeText = pullRequestSizeText(pullRequests);
  if (prSizeText) lineParts.push({ key: "prsize", node: prSizeText });
  if (repository.remote.checkedAt) {
    lineParts.push({
      key: "remote",
      node: <>remote checked {historical ? timelineTime(repository.remote.checkedAt, true) : <RelativeTimeText value={repository.remote.checkedAt} />}</>,
    });
  }
  const gitTasksTextValue = gitTasksText(domain.gitTasks);
  if (gitTasksTextValue) lineParts.push({ key: "gittasks", node: gitTasksTextValue });

  return <div className="repositoryTab">
    <section className="panel repositoryTabBar" aria-label="Repository">
      <div className="repositoryTabBarLeft">
        <div className="repositoryTabBarLine1">
          <CommandIcon name="git" />
          <span className="repositoryTabBarBranch">{repository.branch || "Branch unavailable"}</span>
          {comparisonText && <span className={`commandChip${comparisonTone ? ` ${comparisonTone}` : ""}`}>{comparisonText}</span>}
          {!comparisonText && remoteStateText && !snapshotMissing && <span className="repositoryTabBarRemoteState">{remoteStateText}</span>}
          {prChipText && <span className="commandChip">{prChipText}</span>}
        </div>
        {lineParts.length > 0 && <p className="repositoryTabBarLine2">{joinLineParts(lineParts)}</p>}
        {snapshotMissing && <p className="repositoryTabBarUnrecorded">No saved Git snapshot for this session. Branch comparison, pull requests, and uncommitted files are unavailable.</p>}
        {domain.recordedAt !== null && <p className="repositoryTabBarRecordedCaption">Recorded at the session&apos;s last live check</p>}
      </div>
      {domain.repositoryId && <Link className="commandQuietAction repositoryTabBarAction" href={`/repositories/${domain.repositoryId}?tab=git`}>
        Git tab on repository page<CommandIcon name="arrow" size="small" />
      </Link>}
    </section>
    {domain.repositoryId
      ? <RepositoryTabFiles domain={domain} workingTreeFiles={repository.files} repositoryId={domain.repositoryId} historical={historical} workingTreeKnown={!snapshotMissing} sessionId={sessionId} selectedPath={selectedPath} onSelectPath={onSelectPath} onOpenAgent={onOpenAgent} />
      : <p className="repositoryTabFilesUnavailable">File history requires a linked repository.</p>}
  </div>;
}
