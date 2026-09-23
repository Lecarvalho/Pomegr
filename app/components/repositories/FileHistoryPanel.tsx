import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import type { FileChangeKind, FileHistoryProvider, FileHistoryResponse, FileHistorySession } from "../../../shared/repository-files-contract";
import { gitPathParts } from "../../dashboard-utils";
import { DottedInfoPopover } from "../DottedInfoPopover";
import { ProviderBadge } from "../ProviderBadge";
import { CommandIcon } from "../command-center/CommandPage";
import { providerSourceLabel, sessionTimeLabel } from "./file-history-format";
import { fileStatusChip } from "./file-tree-model";

export type FileHistoryPanelProps = {
  side: "session" | "repository";
  repositoryId: string;
  repositoryLabel: string; // breadcrumb root
  /** Selected repository-relative path; null renders the "no file selected" state. */
  path: string | null;
  /** Git porcelain status of the path in the working tree, when currently modified. */
  workingTreeStatus: string | null;
  /** null while loading the selected file's history. */
  history: FileHistoryResponse | null;
  /** Session side: the session whose entry is highlighted as "this session". */
  currentSessionId?: string;
  className?: string;
};

const KIND_LABELS: Record<FileChangeKind, { label: string; tone: "positive" | "info" | "warning" | null }> = {
  edited: { label: "Edited", tone: "positive" },
  created: { label: "Created", tone: "info" },
  deleted: { label: "Deleted", tone: "warning" },
  moved: { label: "Moved", tone: null },
};

function FileGlyphIcon() {
  return <svg className="fileHistoryFileIcon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" />
  </svg>;
}

function LoadingRows() {
  return <div className="fileHistorySkeleton" aria-busy="true">
    <span className="visuallyHidden">Loading file history…</span>
    {[0, 1, 2].map((row) => <div key={row} className="fileHistorySkeletonRow" aria-hidden="true">
      <span className="uiSkeleton" style={{ width: 56 }} />
      <span className="uiSkeleton" style={{ width: 180 }} />
      <span className="uiSkeleton" style={{ width: 64 }} />
    </div>)}
  </div>;
}

function agentsSummary(session: FileHistorySession): string | null {
  if (session.agents.length === 0) return null;
  const knownCount = session.agents.filter((agent) => agent.label).length;
  if (knownCount === session.agents.length) return session.agents.map((agent) => agent.label).join(" · ");
  return `${session.agents.length} agent${session.agents.length === 1 ? "" : "s"}`;
}

function sessionHrefFor(sessionId: string, linkPath: string): string | null {
  try {
    return `/sessions/${encodeSessionRoute(sessionId)}?tab=repository&path=${encodeURIComponent(linkPath)}`;
  } catch {
    return null;
  }
}

function FileHistoryEntry({ session, linkPath, currentSessionId }: {
  session: FileHistorySession;
  linkPath: string;
  currentSessionId?: string;
}) {
  const isCurrent = currentSessionId !== undefined && session.sessionId === currentSessionId;
  const kind = KIND_LABELS[session.kind];
  const providerSource = providerSourceLabel(session.provider);
  const agentsText = agentsSummary(session);
  const href = sessionHrefFor(session.sessionId, linkPath);
  const title = session.title ?? "Untitled session";

  return <article className={`fileHistoryEntry${isCurrent ? " isCurrentSession" : ""}`}>
    <div className="fileHistoryEntryBody">
      <div className="fileHistoryEntryMeta">
        <span className={`commandChip${kind.tone ? ` ${kind.tone}` : ""}`}>{kind.label}</span>
        {session.editCount > 0 && <span className="fileHistoryEntryEdits">{session.editCount} edit{session.editCount === 1 ? "" : "s"}</span>}
        {isCurrent ? <span className="commandChip">this session</span> : session.live ? <span className="commandChip positive">live</span> : null}
      </div>
      {href ? <Link className="fileHistoryEntryTitle" href={href}>{title}</Link> : <span className="fileHistoryEntryTitle">{title}</span>}
      <div className="fileHistoryEntryAgents">
        {providerSource && <ProviderBadge source={providerSource} />}
        {agentsText && <span className="fileHistoryEntryAgentsText">{agentsText}</span>}
      </div>
      {session.pathAtTime && <p className="fileHistoryEntryOldPath">as {session.pathAtTime}</p>}
    </div>
    <time className="fileHistoryEntryTime" dateTime={session.newestAt}>{sessionTimeLabel(session.newestAt)}</time>
  </article>;
}

export function FileHistoryPanel({ side, repositoryId, repositoryLabel, path, workingTreeStatus, history, currentSessionId, className = "" }: FileHistoryPanelProps) {
  const [resetKey, setResetKey] = useState(path);
  const [providerFilter, setProviderFilter] = useState<"all" | FileHistoryProvider>("all");
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  // Reset local UI state when the selected path changes, per React's "adjust state on prop
  // change" pattern (no effect needed, so the reset lands before this render paints).
  if (path !== resetKey) {
    setResetKey(path);
    setProviderFilter("all");
    setCopied(false);
  }

  useEffect(() => () => {
    if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current);
  }, []);

  if (path === null) {
    return <section className={`panel fileHistoryPanel ${className}`.trim()} aria-label="File history">
      <p className="fileHistoryEmptyState">Select a file to see its recorded sessions.</p>
    </section>;
  }

  const { directory, filename } = gitPathParts(path);
  const ready = history !== null && history.readiness === "ready";
  const readiness = history?.readiness ?? "loading";
  const sessions = ready && history ? history.sessions : [];
  const unattributedChanges = ready && history ? history.unattributedChanges : 0;
  const linkPath = (history?.path ?? path);
  const providers = [...new Set(sessions.map((session) => session.provider).filter((provider): provider is FileHistoryProvider => provider !== null))];
  const filteredSessions = providerFilter === "all" ? sessions : sessions.filter((session) => session.provider === providerFilter);
  const statusChip = fileStatusChip(workingTreeStatus);

  const copyPath = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return <section className={`panel fileHistoryPanel ${className}`.trim()} aria-label="File history">
    <header className="fileHistoryHeader">
      <div className="fileHistoryBreadcrumb">
        <span>{repositoryLabel}</span>
        {directory && <><span aria-hidden="true">/</span><span>{directory}</span></>}
      </div>
      <div className="fileHistoryTitleRow">
        <div className="fileHistoryTitle">
          <FileGlyphIcon />
          <b className="fileHistoryFileName">{filename}</b>
          {statusChip && <span className={`commandChip${statusChip.tone ? ` ${statusChip.tone}` : ""}`}>{statusChip.label} in working tree</span>}
        </div>
        {side === "session"
          ? <Link className="commandQuietAction fileHistoryHeaderAction" href={`/repositories/${repositoryId}?tab=files&path=${encodeURIComponent(linkPath)}`}>
              All history on repository page<CommandIcon name="chevron" size="small" />
            </Link>
          : <button type="button" className="commandSecondaryAction fileHistoryHeaderAction" onClick={copyPath}>{copied ? "Copied" : "Copy path"}</button>}
      </div>
      {ready && <div className="fileHistoryMetaRow">
        <span className="fileHistorySessionCount">{sessions.length} recorded session{sessions.length === 1 ? "" : "s"} · newest first</span>
        {providers.length > 1 && <div className="commandSegmented" role="group" aria-label="Filter by provider">
          <button type="button" aria-pressed={providerFilter === "all"} onClick={() => setProviderFilter("all")}>All providers</button>
          {providers.map((provider) => <button key={provider} type="button" aria-pressed={providerFilter === provider} onClick={() => setProviderFilter(provider)}>{providerSourceLabel(provider)}</button>)}
        </div>}
      </div>}
    </header>
    <div className="fileHistoryEntries">
      {!ready
        ? (readiness === "rebuilding"
          ? <p className="fileHistoryEmptyState">File history is rebuilding.</p>
          : readiness === "unavailable"
            ? <p className="fileHistoryEmptyState">File history is unavailable.</p>
            : <LoadingRows />)
        : (filteredSessions.length === 0
          ? <p className="fileHistoryEmptyState">No recorded sessions changed this file.</p>
          : filteredSessions.map((session) => <FileHistoryEntry key={session.sessionId} session={session} linkPath={linkPath} currentSessionId={currentSessionId} />))}
      {ready && unattributedChanges > 0 && <p className="fileHistoryUnattributed">{unattributedChanges} change{unattributedChanges === 1 ? "" : "s"} without session attribution (moves seen in Git)</p>}
    </div>
    <div className="fileHistoryFooter">
      <span>File history covers recorded Write and Edit operations. Shell scripts and external edits may be missing.</span>
      <DottedInfoPopover ariaLabel="More about file history coverage" content="Git-observed moves keep identity but add no session attribution; files outside retained checkpoints are absent.">How to read this</DottedInfoPopover>
    </div>
  </section>;
}
