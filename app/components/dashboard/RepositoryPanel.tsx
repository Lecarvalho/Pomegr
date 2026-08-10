import type { MonitorState } from "../../../shared/monitor-contract";
import { gitPathParts, gitStatusLabel } from "../../dashboard-utils";
import { RelativeTimeText } from "../LiveTime";

function comparisonLabel(repository: NonNullable<MonitorState["session"]>["repository"]) {
  const comparison = repository.comparison;
  if (!comparison) return null;
  if (comparison.integrated) return `Changes integrated into ${comparison.branch}`;
  if (comparison.ahead === 0 && comparison.behind === 0) return `Up to date with ${comparison.branch}`;
  const parts = [];
  if (comparison.ahead) parts.push(`${comparison.ahead} ahead`);
  if (comparison.behind) parts.push(`${comparison.behind} behind`);
  return `${parts.join(" · ")} ${comparison.kind === "base" ? "relative to" : "vs"} ${comparison.branch}`;
}

export function RepositoryPanel({ session }: { session: NonNullable<MonitorState["session"]> }) {
  const repository = session.repository;
  if (!repository.available) return null;
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
  return (
    <section className="panel gitPanel" aria-label={repository.historical ? "Recorded Git branch" : "Git branch overview"}>
      <div className="gitSummary">
        <div><span className="label">{repository.historical ? "RECORDED BRANCH" : "GIT BRANCH"}</span><h2>{repository.branch}</h2><p title={session.cwd}>{session.project}</p></div>
        <div className="gitBadges">
          {!repository.historical && comparison && <span className="branchComparison" title="Compared with a remote snapshot fetched into Threadlight's isolated cache.">{comparison}</span>}
          {!repository.historical && remote.status === "checking" && <span className="branchComparison pending">Checking remote…</span>}
          {!repository.historical && remote.status === "unavailable" && <span className="branchComparison unavailable">Remote unavailable</span>}
          <span className={`changeCount ${repository.files.length ? "dirty" : "clean"}`}>{repository.historical ? "Repository state not recorded" : repository.files.length ? `${repository.files.length} uncommitted` : "Working tree clean"}</span>
        </div>
      </div>
      {repository.historical ? (
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
      )}
    </section>
  );
}
