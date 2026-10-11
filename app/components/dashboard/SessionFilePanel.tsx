import Link from "next/link";
import type { SessionTouchedFile, SessionTouchedFiles } from "../../../shared/session-domain-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { FileHistoryLoadingRows, FilePanelHeader, KIND_LABELS } from "../repositories/FileHistoryPanel";
import { sessionTimeLabel } from "../repositories/file-history-format";

type RecordedFile = Extract<SessionTouchedFile, { source: "recorded" }>;
type CommittedFile = Extract<SessionTouchedFile, { source: "committed" }>;

const COMMITTED_CHANGE_TEXT = {
  added: "Added in the commit",
  modified: "Modified in the commit",
  deleted: "Deleted in the commit",
} as const;

function committedText(file: CommittedFile): string {
  return file.change ? COMMITTED_CHANGE_TEXT[file.change] : "Net change not recorded";
}

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

export function SessionFilePanel({ repositoryId, repositoryLabel, path, workingTreeStatus, statusRecorded = false, file, readiness, onOpenAgent, className = "" }: {
  repositoryId: string;
  repositoryLabel: string;
  path: string | null;
  workingTreeStatus: string | null;
  statusRecorded?: boolean;
  file: SessionTouchedFile | null;
  readiness: SessionTouchedFiles["readiness"];
  onOpenAgent?: (agentId: string) => void;
  className?: string;
}) {
  if (path === null) {
    return <section className={`panel fileHistoryPanel ${className}`.trim()} aria-label="File in this session">
      <p className="fileHistoryEmptyState">Select a file to see what this session changed.</p>
    </section>;
  }

  const kind = file?.source === "recorded" ? KIND_LABELS[file.kind] : null;
  const body = file?.source === "recorded" && kind
    ? <article className="fileHistoryEntry">
        <div className="fileHistoryEntryBody">
          <span className="fileHistoryEntryTitle">Recorded in this session</span>
          <div className="fileHistoryEntryMeta">
            <span className={`commandChip${kind.tone ? ` ${kind.tone}` : ""}`}>{kind.label}</span>
            <span className="fileHistoryEntryMetaText">{file.changeCount} change{file.changeCount === 1 ? "" : "s"}</span>
          </div>
          <RecordedAgents agents={file.agents ?? []} onOpenAgent={onOpenAgent} />
        </div>
        {file.lastObservedAt && <time className="fileHistoryEntryTime" dateTime={file.lastObservedAt}>{sessionTimeLabel(file.lastObservedAt)}</time>}
      </article>
    : file?.source === "committed"
      ? <article className="fileHistoryEntry">
          <div className="fileHistoryEntryBody">
            <span className="fileHistoryEntryTitle">Committed by this session · no recorded agent edit</span>
            <div className="fileHistoryEntryMeta">
              <span className="fileHistoryEntryMetaText">{committedText(file)}</span>
            </div>
            <p className="fileHistoryEntryNote">Matched by time to a Git command this session ran. Pomegr can&apos;t tell which agent changed the file.</p>
          </div>
        </article>
      : readiness === "loading"
        ? <FileHistoryLoadingRows />
        : <p className="fileHistoryEmptyState">{readiness === "ready" ? "No recorded change in this session." : "Recorded changes are unavailable."}</p>;

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
