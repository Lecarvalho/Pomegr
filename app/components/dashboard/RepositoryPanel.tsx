import type { MonitorState } from "../../../shared/monitor-contract";
import { gitPathParts, gitStatusLabel } from "../../dashboard-utils";

export function RepositoryPanel({ session }: { session: NonNullable<MonitorState["session"]> }) {
  const repository = session.repository;
  if (!repository.available) return null;
  return (
    <section className="panel gitPanel" aria-label={repository.historical ? "Recorded Git branch" : "Git working tree"}>
      <div className="gitSummary">
        <div><span className="label">{repository.historical ? "RECORDED BRANCH" : "GIT BRANCH"}</span><h2>{repository.branch}</h2><p title={session.cwd}>{session.project}</p></div>
        <span className={`changeCount ${repository.files.length ? "dirty" : "clean"}`}>{repository.historical ? "File state not recorded" : repository.files.length ? `${repository.files.length} uncommitted` : "Working tree clean"}</span>
      </div>
      {!repository.historical && repository.files.length > 0 && (
        <div className="gitFiles">{repository.files.map((file) => {
          const pathParts = gitPathParts(file.path);
          return <div className="gitFile" key={`${file.status}-${file.path}`}><span className={`gitStatus ${gitStatusLabel(file.status).toLowerCase()}`}>{gitStatusLabel(file.status)}</span><code title={file.path}><span className="gitPathDirectory">{pathParts.directory}</span><strong className="gitPathName">{pathParts.filename}</strong></code></div>;
        })}</div>
      )}
    </section>
  );
}
