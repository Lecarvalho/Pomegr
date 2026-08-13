"use client";

import { useCallback, useRef, useState } from "react";
import type { MonitorState } from "../../../shared/monitor-contract";
import { compactNumber, gitPathParts, gitStatusLabel } from "../../dashboard-utils";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { RelativeTimeText } from "../LiveTime";
import { PopoverFrame } from "../PopoverFrame";

function comparisonLabel(repository: NonNullable<MonitorState["session"]>["repository"]) {
  const comparison = repository.comparison;
  if (!comparison) return null;
  if (comparison.integrated) return `Changes integrated into ${comparison.branch}`;
  if (comparison.ahead === 0 && comparison.behind === 0) return `Up to date with ${comparison.branch}`;
  const parts = [];
  if (comparison.ahead) parts.push(`${comparison.ahead} ${comparison.ahead === 1 ? "commit" : "commits"} ahead`);
  if (comparison.behind) parts.push(`${comparison.behind} ${comparison.behind === 1 ? "commit" : "commits"} behind`);
  return `${parts.join(" · ")} ${comparison.kind === "base" ? "relative to" : "compared with"} ${comparison.branch}`;
}

export function RepositoryPanel({ session }: { session: NonNullable<MonitorState["session"]> }) {
  const repository = session.repository;
  const pullRequests = session.pullRequests?.items || [];
  const [pullRequestsOpen, setPullRequestsOpen] = useState(false);
  const pullRequestAnchorRef = useRef<HTMLDivElement | null>(null);
  const closePullRequests = useCallback(() => setPullRequestsOpen(false), []);
  useDismissibleLayer(pullRequestsOpen, pullRequestAnchorRef, closePullRequests);
  if (!repository.available && pullRequests.length === 0) return null;
  const commits = repository.commits || [];
  const isMain = repository.isMain ?? true;
  const remote = repository.remote || { status: "unavailable", checkedAt: null };
  const comparison = remote.status === "ready" ? comparisonLabel(repository) : null;
  const commitsLabel = isMain
    ? "RECENT COMMITS"
    : repository.comparison?.integrated
      ? "UNMERGED BRANCH COMMITS"
    : repository.comparison
      ? `COMMITS SINCE ${repository.comparison.branch.toUpperCase()}`
      : "REMOTE BRANCH COMMITS";
  const emptyCommitText = isMain
    ? "No commits yet."
    : repository.comparison?.integrated
      ? `Branch changes are already integrated into ${repository.comparison.branch}.`
    : remote.status === "checking"
      ? "Checking the remote default branch…"
      : remote.status === "unavailable"
        ? "Remote comparison unavailable."
        : `No commits beyond ${repository.comparison?.branch || "the remote default branch"}.`;
  const pullRequestBadge = pullRequests.length === 1
    ? `${pullRequests[0].draft ? "Draft" : pullRequests[0].state} PR #${pullRequests[0].number}`
    : `${pullRequests.length} pull requests`;
  const sessionPullRequests = pullRequests.filter((pullRequest) => pullRequest.association === "session").length;
  const mergedPullRequestCoversComparison = Boolean(repository.comparison?.integrated && pullRequests.some((pullRequest) => (
    pullRequest.state === "merged"
    && pullRequest.headBranch === repository.branch
    && (repository.comparison?.branch === pullRequest.baseBranch || repository.comparison?.branch.endsWith(`/${pullRequest.baseBranch}`))
  )));
  return (
    <section className="panel gitPanel" aria-label={!repository.available ? "Pull request overview" : repository.historical ? "Recorded Git branch" : "Git branch overview"}>
      <div className="gitSummary">
        <div><h2>{repository.available ? repository.branch : session.project}</h2><p title={session.cwd}>{repository.historical ? `Recorded branch · ${session.project}` : session.project}</p></div>
        <div className="gitBadges">
          {pullRequests.length > 0 && (
            <div className="pullRequestAnchor" ref={pullRequestAnchorRef}>
              <button className={`pullRequestBadge ${pullRequests.some((pullRequest) => pullRequest.state === "open") ? "open" : "settled"}`} type="button" onClick={() => setPullRequestsOpen((open) => !open)} aria-expanded={pullRequestsOpen} aria-controls="session-pull-requests">
                <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3" r="2"/><circle cx="12" cy="12.5" r="2"/><path d="M4 5v8M6 4h3a3 3 0 0 1 3 3v3.5"/></svg>
                {pullRequestBadge}
              </button>
              {pullRequestsOpen && (
                <PopoverFrame
                  id="session-pull-requests"
                  ariaLabel="Pull requests linked to this session"
                  eyebrow="SESSION LINKS"
                  title="Pull requests"
                  closeLabel="Close pull requests"
                  onClose={closePullRequests}
                  summary={<>{sessionPullRequests ? `${sessionPullRequests} recorded in this session` : "Matched to the current branch"}{session.pullRequests?.checkedAt ? <> · checked <RelativeTimeText value={session.pullRequests.checkedAt} /></> : session.pullRequests?.status === "unavailable" ? " · GitHub status unavailable" : null}</>}
                  className="pullRequestPopover"
                >
                  <div className="pullRequestList">
                    {pullRequests.map((pullRequest) => (
                      <a className="pullRequestRow" href={pullRequest.url} target="_blank" rel="noreferrer" key={pullRequest.url}>
                        <span className={`pullRequestIcon ${pullRequest.state}`} aria-hidden="true"><i/><i/><i/></span>
                        <span className="pullRequestBody">
                          <span className="pullRequestTitle"><strong>{pullRequest.title}</strong><em className={pullRequest.draft ? "draft" : pullRequest.state}>{pullRequest.draft ? "Draft" : pullRequest.state}</em></span>
                          <small>{pullRequest.repository} · #{pullRequest.number} · {pullRequest.association === "session" ? "recorded in session" : "current branch"}</small>
                          {pullRequest.headBranch && pullRequest.baseBranch && <code>{pullRequest.headBranch} → {pullRequest.baseBranch}</code>}
                        </span>
                        <span className="pullRequestStats">
                          {pullRequest.additions !== null && <b>+{compactNumber(pullRequest.additions)}</b>}
                          {pullRequest.deletions !== null && <b>−{compactNumber(pullRequest.deletions)}</b>}
                          <i aria-hidden="true">↗</i>
                        </span>
                      </a>
                    ))}
                  </div>
                </PopoverFrame>
              )}
            </div>
          )}
          {repository.available && !repository.historical && comparison && !mergedPullRequestCoversComparison && <span className="branchComparison" title="Compared with a remote snapshot fetched into Pomegr's isolated cache.">{comparison}</span>}
          {repository.available && !repository.historical && remote.status === "checking" && <span className="branchComparison pending">Checking remote…</span>}
          {repository.available && !repository.historical && remote.status === "unavailable" && <span className="branchComparison unavailable">Remote comparison unavailable</span>}
        </div>
      </div>
      {repository.available && (repository.historical ? (
        <div className="gitHistorical"><span className="label">RECORDED STATE</span><p>Commit history and working-tree changes were not recorded for this session.</p></div>
      ) : (
        <div className="gitDetails">
          <div className="gitCommits">
            <div className="gitListHeader"><span className="label">{commitsLabel}</span><span>{commits.length ? `${commits.length} shown` : "None"}</span></div>
            <div className="gitList">
              {commits.length ? commits.map((commit) => (
                <div className="gitCommit" key={commit.hash}>
                  <code>{commit.hash}</code>
                  <strong title={commit.subject}>{commit.subject}</strong>
                  <time dateTime={commit.committedAt || undefined}><RelativeTimeText value={commit.committedAt} /></time>
                </div>
              )) : <p className="gitEmpty">{emptyCommitText}</p>}
            </div>
          </div>
          <div className="gitChanges">
            <div className="gitListHeader"><span className="label">UNCOMMITTED CHANGES</span><span>{repository.files.length || "None"}</span></div>
            <div className="gitFiles">
              {repository.files.length ? repository.files.map((file) => {
                const pathParts = gitPathParts(file.path);
                return <div className="gitFile" key={`${file.status}-${file.path}`}><span className={`gitStatus ${gitStatusLabel(file.status).toLowerCase()}`}>{gitStatusLabel(file.status)}</span><code title={file.path}><span className="gitPathDirectory">{pathParts.directory}</span><strong className="gitPathName">{pathParts.filename}</strong></code></div>;
              }) : <p className="gitEmpty">No local changes.</p>}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
