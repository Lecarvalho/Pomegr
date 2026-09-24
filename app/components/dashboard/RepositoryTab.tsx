"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { PullRequest } from "../../../shared/monitor-contract";
import type { RepositoryDomain } from "../../../shared/session-domain-contract";
import { timelineTime } from "../../dashboard-utils";
import { useFileHistory } from "../../repository-files-store";
import { useSessionCatalog } from "../../hooks/SessionCatalogContext";
import { useSessionDomain } from "../../session-domain-store";
import { FileHistoryPanel } from "../repositories/FileHistoryPanel";
import { FileTree } from "../repositories/FileTree";
import { repositoryFilePath } from "../repositories/repository-route";
import { CommandIcon } from "../command-center/CommandIcon";
import { RelativeTimeText } from "../LiveTime";
import {
  bestRepositoryTabFilesSegment,
  buildRepositoryTabFilesSegments,
  ELSEWHERE_SEGMENT_EMPTY_TEXT,
  filterFilesByPath,
  REPOSITORY_TAB_FILES_SEGMENTS,
  resolveRepositoryTabFileTarget,
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
 * Changed elsewhere segment, and the shared FileTree / FileHistoryPanel pair in session scope. */
function RepositoryTabFiles({ domain, repository, repositoryId, historical, sessionId, selectedPath, onSelectPath, paused }: {
  domain: RepositoryDomain;
  repository: Repository;
  repositoryId: string;
  historical: boolean;
  sessionId: string;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  paused: boolean;
}) {
  const [search, setSearch] = useState("");
  const [manualSegment, setManualSegment] = useState<RepositoryTabFilesSegment | null>(null);
  const { sessions } = useSessionCatalog();
  const rootLabel = sessions.find((session) => session.id === sessionId)?.project ?? "Repository";
  const segments = buildRepositoryTabFilesSegments(domain.fileHistory.files, repository.files, domain.gitObservedFiles);
  const segment = manualSegment ?? bestRepositoryTabFilesSegment(selectedPath, segments);
  const query = search.trim();
  const target = resolveRepositoryTabFileTarget(selectedPath, domain.fileHistory.files);
  const history = useFileHistory(repositoryId, target, { paused });
  const workingTreeStatus = selectedPath ? repository.files.find((file) => file.path === selectedPath)?.status ?? null : null;

  const selectSegment = (next: RepositoryTabFilesSegment) => setManualSegment(next);
  const selectFile = (path: string) => onSelectPath(path);

  const treeArea = segment === "touched" && domain.fileHistory.readiness === "loading"
    ? <FilesTreeSkeleton />
    : <FileTree
        scope="session"
        rootLabel={rootLabel}
        files={filterFilesByPath(segments[segment], query)}
        elsewhere={segment === "touched" ? filterFilesByPath(segments.touchedElsewhere, query) : undefined}
        selectedPath={selectedPath}
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
      <div className="commandSegmented" role="group" aria-label="File segment">
        {REPOSITORY_TAB_FILES_SEGMENTS.map(({ id, label }) => <button key={id} type="button" aria-pressed={segment === id} onClick={() => selectSegment(id)}>{label} {segmentCount(segments, id)}</button>)}
      </div>
      <span className="commandChip repositoryTabFilesBeta" title="File coverage is still being expanded.">Beta</span>
    </div>
    <div className="panel repositoryTabFilesBody">
      {treeArea}
      <FileHistoryPanel
        side="session"
        repositoryId={repositoryId}
        repositoryLabel={rootLabel}
        path={selectedPath}
        workingTreeStatus={workingTreeStatus}
        statusRecorded={historical}
        history={history}
        currentSessionId={sessionId}
        className="repositoryTabFilesPanel"
      />
    </div>
  </div>;
}

/** The session Repository tab: a top bar (branch, comparison, PR, git-task summary) plus the
 * file tree / file history body (F17/F18). The commit list moved to the repository page Git tab
 * (RepositoryGitTab.tsx); see docs/internal/plans/ia-redesign for the design contract. */
export function RepositoryTab({ sessionId, historical, paused = false, selectedPath: selectedPathInput = null, onSelectPath = () => {} }: RepositoryTabProps) {
  const result = useSessionDomain({ sessionId, domain: "repository" }, { historical, enabled: !paused });
  const domain = result.data;
  const selectedPath = repositoryFilePath(selectedPathInput) ?? null;

  if (!domain) return <div className="sessionTabState" role="status">{result.unavailable ? "Repository evidence is unavailable for this session." : result.error ? "Repository evidence is temporarily unavailable." : "Loading repository evidence…"}</div>;
  if (domain.readiness === "loading") return <RepositoryTabBarSkeleton />;

  const repository = domain.repository;
  if (!repository || !repository.available) {
    return <section className="panel repositoryTabBar repositoryTabBarEmpty">
      <p className="repositoryTabBarEmptyText">No Git repository detected for this session.</p>
    </section>;
  }

  if (repository.historical && domain.recordedAt === null) {
    // G10: historical session with no recorded live-check snapshot.
    return <section className="panel repositoryTabBar">
      <div className="repositoryTabBarLeft">
        <div className="repositoryTabBarLine1"><CommandIcon name="git" /><span className="repositoryTabBarBranch">{repository.branch || "Branch unavailable"}</span></div>
        <p className="repositoryTabBarUnrecorded">Repository state was not recorded for this session.</p>
      </div>
    </section>;
  }

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
          {!comparisonText && remoteStateText && <span className="repositoryTabBarRemoteState">{remoteStateText}</span>}
          {prChipText && <span className="commandChip">{prChipText}</span>}
        </div>
        {lineParts.length > 0 && <p className="repositoryTabBarLine2">{joinLineParts(lineParts)}</p>}
        {domain.recordedAt !== null && <p className="repositoryTabBarRecordedCaption">Recorded at the session&apos;s last live check</p>}
      </div>
      {domain.repositoryId && <Link className="commandQuietAction repositoryTabBarAction" href={`/repositories/${domain.repositoryId}?tab=git`}>
        Git tab on repository page<CommandIcon name="arrow" size="small" />
      </Link>}
    </section>
    {domain.repositoryId
      ? <RepositoryTabFiles domain={domain} repository={repository} repositoryId={domain.repositoryId} historical={historical} sessionId={sessionId} selectedPath={selectedPath} onSelectPath={onSelectPath} paused={paused} />
      : <p className="repositoryTabFilesUnavailable">File history requires a linked repository.</p>}
  </div>;
}
