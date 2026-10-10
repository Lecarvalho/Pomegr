"use client";

import Link from "next/link";
import { useId } from "react";
import { IssueBody, IssueCharacterCount, IssueNotices, IssueStatusChip } from "./IssuePreview";
import { GITHUB_SETTINGS_HREF, TRUNCATED_LINE, canPromote, issueDateLabel, tasksHref, type IssuesNotice } from "./promote-issues-model";
import type { TaskIssue } from "./task-issues-desktop";

// The list and detail panes of the Promote issues page (design contract G72-G107). They draw what they are given and
// read nothing, so `/design-system` renders them from static issues without the desktop bridge.

/** A state drawn in place of the list: fixed copy and no issue text. A sign-in problem links to Settings. */
export function IssuesState({ notice }: { notice: IssuesNotice }) {
  return <div className="promoteIssuesState" role="status">
    {notice.title && <p className="promoteIssuesStateTitle">{notice.title}</p>}
    <p className="promoteIssuesStateDetail">
      {notice.detail}{notice.settings && <>{" "}<Link className="commandTextLink" href={GITHUB_SETTINGS_HREF}>{notice.settings}</Link></>}
    </p>
  </div>;
}

function IssueRow({ issue, selected, onSelect }: { issue: TaskIssue; selected: boolean; onSelect(number: number): void }) {
  const date = issueDateLabel(issue.updatedAt);
  return <li>
    <button type="button" className="promoteIssueRow" aria-pressed={selected} onClick={() => onSelect(issue.number)}>
      <span className="promoteIssueRowHead">
        <span className="promoteIssueNumber">#{issue.number}</span>
        <span className="promoteIssueRowTitle">{issue.title}</span>
      </span>
      <span className="promoteIssueMeta">
        <IssueStatusChip issue={issue} />
        {date && <span className="promoteIssueDate">{date}</span>}
      </span>
    </button>
  </li>;
}

function IssueDetail({ repositoryId, issue, onPromote }: { repositoryId: string; issue: TaskIssue; onPromote(issue: TaskIssue): void }) {
  const titleId = useId();
  const date = issueDateLabel(issue.updatedAt);
  return <article className="promoteIssueDetail" aria-labelledby={titleId}>
    <div className="promoteIssueHead">
      <span className="promoteIssueNumber">#{issue.number}</span>
      <h2 id={titleId}>{issue.title}</h2>
      <span className="promoteIssueMeta">
        <IssueStatusChip issue={issue} />
        {date && <span className="promoteIssueDate">{date}</span>}
      </span>
    </div>
    <IssueNotices issue={issue}>
      {issue.taskId && <div className="taskNotice positive">
        <span>Already on the board as {issue.taskId}.</span>
        <Link className="commandTextLink" href={tasksHref(repositoryId)}>Open task</Link>
      </div>}
    </IssueNotices>
    <IssueBody body={issue.body} ranges={issue.hiddenComments.ranges} truncated={issue.bodyTruncated} />
    <div className="promoteIssueFooter">
      <IssueCharacterCount issue={issue} />
      <button type="button" className="commandPrimaryAction" aria-haspopup="dialog" disabled={!canPromote(issue)} onClick={() => onPromote(issue)}>Promote</button>
    </div>
  </article>;
}

/**
 * The split body: the open issues on the left, the chosen issue's notices, raw body and Promote on the right. `Promote`
 * only reports the chosen issue; opening the task modal for it belongs to the caller.
 */
export function PromoteIssuesSplit({ repositoryId, issues, truncated, selected, onSelect, onPromote }: {
  repositoryId: string;
  issues: readonly TaskIssue[];
  truncated: boolean;
  selected: TaskIssue | null;
  onSelect(number: number): void;
  onPromote(issue: TaskIssue): void;
}) {
  return <div className="promoteIssuesSplit">
    <div className="promoteIssuesListPane">
      <ul className="promoteIssuesList" aria-label="Open issues">
        {issues.map((issue) => <IssueRow key={issue.number} issue={issue} selected={issue.number === selected?.number} onSelect={onSelect} />)}
      </ul>
      {truncated && <p className="promoteIssuesTruncated">{TRUNCATED_LINE}</p>}
    </div>
    {selected && <IssueDetail key={selected.number} repositoryId={repositoryId} issue={selected} onPromote={onPromote} />}
  </div>;
}
