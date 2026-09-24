import Link from "next/link";
import type { RepositoryDomain } from "../../../shared/session-domain-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { FileHistoryLoadingRows, FilePanelHeader, KIND_LABELS } from "../repositories/FileHistoryPanel";
import { sessionTimeLabel } from "../repositories/file-history-format";

type RecordedFile = RepositoryDomain["fileHistory"]["files"][number];
type GitObservedFile = NonNullable<RepositoryDomain["gitObservedFiles"]>["files"][number];

const COMMITTED_CHANGE_TEXT = {
  added: "Added in a commit on the session branch",
  modified: "Modified in a commit on the session branch",
  deleted: "Deleted in a commit on the session branch",
} as const;

function gitObservedText(file: GitObservedFile): string {
  if (file.source === "uncommitted") return "Became uncommitted during the session";
  return file.change ? COMMITTED_CHANGE_TEXT[file.change] : "Committed on the session branch";
}

/** The session Repository tab's right panel: what this session did to the selected file, built
 * only from the repository domain the tab already holds, so selecting a file never waits on a
 * fetch. The file's history across sessions lives on the repository page, one link away. */
export function SessionFilePanel({ repositoryId, repositoryLabel, path, workingTreeStatus, statusRecorded = false, recorded, recordedReadiness, gitObserved, className = "" }: {
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
        </div>
        {recorded.lastObservedAt && <time className="fileHistoryEntryTime" dateTime={recorded.lastObservedAt}>{sessionTimeLabel(recorded.lastObservedAt)}</time>}
      </article>
    : gitObserved
      ? <article className="fileHistoryEntry">
          <div className="fileHistoryEntryBody">
            <span className="fileHistoryEntryTitle">Seen in Git · no recorded agent edit</span>
            <div className="fileHistoryEntryMeta">
              <span className="fileHistoryEntryMetaText">{gitObservedText(gitObserved)}</span>
            </div>
            <p className="fileHistoryEntryNote">Could be the agent through a command Pomegr can't read, a build or generated file, or someone else.</p>
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
      <span>Agent edits come from Write and Edit tools only. Shell commands and builds show as seen in Git.</span>
    </div>
  </section>;
}
