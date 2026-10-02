import Link from "next/link";
import type { RepositoryDomain } from "../../../shared/session-domain-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { FileHistoryLoadingRows, FilePanelHeader, KIND_LABELS } from "../repositories/FileHistoryPanel";
import { sessionTimeLabel } from "../repositories/file-history-format";

type RecordedFile = RepositoryDomain["fileHistory"]["files"][number];
type GitObservedFile = NonNullable<RepositoryDomain["gitObservedFiles"]>["files"][number];

const COMMITTED_CHANGE_TEXT = {
  added: "Added in the commit",
  modified: "Modified in the commit",
  deleted: "Deleted in the commit",
} as const;

function gitObservedText(file: GitObservedFile): string {
  return file.change ? COMMITTED_CHANGE_TEXT[file.change] : "Net change not recorded";
}

/** Recorded agents for the file, one line each: the name (a visible agent opens in the Agents
 * inspector), its latest reported model, a per-agent count when several agents changed the
 * file, and its recorded assignment. */
function RecordedAgents({ agents, onOpenAgent }: { agents: RecordedFile["agents"]; onOpenAgent?: (agentId: string) => void }) {
  if (agents.length === 0) return null;
  const showCounts = agents.length > 1;
  return <ul className="fileHistoryEntryAgents" aria-label="Agents that changed this file">
    {agents.map((agent) => {
      const name = agent.label ?? "Unlisted agent";
      return <li key={agent.id} className="fileHistoryEntryAgent">
        <div className="fileHistoryEntryMeta">
          {agent.label && onOpenAgent
            ? <button type="button" className="commandTextLink" aria-label={`Open ${name} in the Agents inspector`} onClick={() => onOpenAgent(agent.id)}>{name}</button>
            : <span className="fileHistoryEntryMetaText">{name}</span>}
          {agent.model && <span className="fileHistoryEntryMetaText fileHistoryEntryModel" title="Latest model this agent reported">{agent.model}</span>}
          {showCounts && <span className="fileHistoryEntryMetaText">{agent.changeCount} change{agent.changeCount === 1 ? "" : "s"}</span>}
        </div>
        {agent.assignment && <p className="fileHistoryEntryNote">{agent.assignment}</p>}
      </li>;
    })}
  </ul>;
}

/** The session Repository tab's right panel: what this session did to the selected file, built
 * only from the repository domain the tab already holds, so selecting a file never waits on a
 * fetch. The file's history across sessions lives on the repository page, one link away. */
export function SessionFilePanel({ repositoryId, repositoryLabel, path, workingTreeStatus, statusRecorded = false, recorded, recordedReadiness, gitObserved, onOpenAgent, className = "" }: {
  repositoryId: string;
  repositoryLabel: string;
  /** Selected repository-relative path; null renders the "no file selected" state. */
  path: string | null;
  workingTreeStatus: string | null;
  /** The status was recorded at the session's last live check (historical session), not read now. */
  statusRecorded?: boolean;
  /** This session's recorded change summary for the path, when one exists. */
  recorded: RecordedFile | null;
  recordedReadiness: RepositoryDomain["fileHistory"]["readiness"];
  /** How Git saw the path change in the session window, when no tool recorded it. */
  gitObserved: GitObservedFile | null;
  /** Opens a recorded agent in the session's Agents tab. */
  onOpenAgent?: (agentId: string) => void;
  className?: string;
}) {
  if (path === null) {
    return <section className={`panel fileHistoryPanel ${className}`.trim()} aria-label="File in this session">
      <p className="fileHistoryEmptyState">Select a file to see what this session changed.</p>
    </section>;
  }

  const kind = recorded ? KIND_LABELS[recorded.kind] : null;
  const body = recorded && kind
    ? <article className="fileHistoryEntry">
        <div className="fileHistoryEntryBody">
          <span className="fileHistoryEntryTitle">Recorded in this session</span>
          <div className="fileHistoryEntryMeta">
            <span className={`commandChip${kind.tone ? ` ${kind.tone}` : ""}`}>{kind.label}</span>
            <span className="fileHistoryEntryMetaText">{recorded.changeCount} change{recorded.changeCount === 1 ? "" : "s"}</span>
          </div>
          <RecordedAgents agents={recorded.agents ?? []} onOpenAgent={onOpenAgent} />
        </div>
        {recorded.lastObservedAt && <time className="fileHistoryEntryTime" dateTime={recorded.lastObservedAt}>{sessionTimeLabel(recorded.lastObservedAt)}</time>}
      </article>
    : gitObserved
      ? <article className="fileHistoryEntry">
          <div className="fileHistoryEntryBody">
            <span className="fileHistoryEntryTitle">Committed by this session · no recorded agent edit</span>
            <div className="fileHistoryEntryMeta">
              <span className="fileHistoryEntryMetaText">{gitObservedText(gitObserved)}</span>
            </div>
            <p className="fileHistoryEntryNote">Matched by time to a Git command this session ran. Pomegr can&apos;t tell which agent changed the file.</p>
          </div>
        </article>
      : recordedReadiness === "loading"
        ? <FileHistoryLoadingRows />
        : <p className="fileHistoryEmptyState">{recordedReadiness === "ready" ? "No recorded change in this session." : "Recorded changes are unavailable."}</p>;

  return <section className={`panel fileHistoryPanel ${className}`.trim()} aria-label="File in this session">
    <FilePanelHeader repositoryLabel={repositoryLabel} path={path} workingTreeStatus={workingTreeStatus} statusRecorded={statusRecorded}
      action={<Link className="commandQuietAction fileHistoryHeaderAction" href={`/repositories/${repositoryId}?tab=files&path=${encodeURIComponent(path)}`}>
        All history on repository page<CommandIcon name="chevron" size="small" />
      </Link>} />
    <div className="fileHistoryEntries">{body}</div>
    <div className="fileHistoryFooter">
      <span>Agent edits come from Write and Edit tools only. Shell-written files appear once this session commits them.</span>
    </div>
  </section>;
}
