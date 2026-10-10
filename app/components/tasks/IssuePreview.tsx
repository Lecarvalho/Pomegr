"use client";

import { useId, type ReactNode } from "react";
import { TASK_BOUNDS } from "../../../shared/task-contract";
import type { IssueAuthorAssociation, TaskIssue } from "./task-issues-desktop";

// The issue preview shared by the Promote issues page and the task modal (design contract G90-G92, G97-G104). Titles
// and bodies are third-party text: every one is rendered as a React text node, never as markup, a link or Markdown.

const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const LIMIT = COUNT_FORMAT.format(TASK_BOUNDS.textLength);

const ASSOCIATION_LABELS: Record<IssueAuthorAssociation, string> = {
  owner: "Owner", member: "Member", collaborator: "Collaborator", outsider: "Outside contributor",
};

export function issueAssociationLabel(association: IssueAuthorAssociation): string {
  return ASSOCIATION_LABELS[association];
}

/**
 * The notices of one issue, in the order of the design contract: outside contributor, hidden comments, too long. The
 * caller's `children` follow them (the promoted notice on the page, for example). Nothing is drawn when none applies.
 */
export function IssueNotices({ issue, children }: { issue: TaskIssue; children?: ReactNode }) {
  const hidden = issue.hiddenComments.count;
  return <>
    {issue.authorAssociation === "outsider" && <p className="taskNotice warning">Opened by someone outside the repository. Read the whole body before promoting.</p>}
    {hidden > 0 && <p className="taskNotice warning">
      {hidden === 1
        ? "1 hidden comment found. GitHub does not show it on the issue page. It is not copied into the task."
        : `${COUNT_FORMAT.format(hidden)} hidden comments found. GitHub does not show them on the issue page. They are not copied into the task.`}
    </p>}
    {/* The count judges the task text a promote would store (title and body without hidden comments), not the body alone. */}
    {issue.tooLong && <p className="taskNotice negative">
      The task text would be {COUNT_FORMAT.format(issue.characters)} characters and a task holds {LIMIT}. Shorten the issue, or write the task by hand.
    </p>}
    {children}
  </>;
}

type BodyPart = { text: string; hidden: boolean };

/** Splits the body at the monitor's hidden-comment ranges. Ranges are ordered and inside the body; anything else is ignored. */
function bodyParts(body: string, ranges: readonly { start: number; end: number }[]): BodyPart[] {
  const parts: BodyPart[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start < cursor || end <= start || end > body.length) continue;
    if (start > cursor) parts.push({ text: body.slice(cursor, start), hidden: false });
    parts.push({ text: body.slice(start, end), hidden: true });
    cursor = end;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), hidden: false });
  return parts;
}

/**
 * The read-only raw body box: exactly the text GitHub returned, hidden HTML comments struck through (they are removed
 * at promote). A hidden segment is announced as such; `truncated` says the preview was cut by the monitor.
 */
export function IssueBody({ body, ranges, truncated }: { body: string; ranges: readonly { start: number; end: number }[]; truncated: boolean }) {
  const labelId = useId();
  const parts = bodyParts(body, ranges);
  return <div className="taskIssueBody">
    <div className="taskIssueBodyHead">
      <span id={labelId} className="taskIssueBodyLabel">Raw body</span>
      <span className="taskIssueBodyCaption">Exactly what the agent will read</span>
    </div>
    <div className="taskIssueBodyBox" role="region" aria-labelledby={labelId} tabIndex={0}>
      {parts.length === 0
        ? <span className="taskIssueBodyEmpty">This issue has no body.</span>
        : parts.map((part, index) => part.hidden
          ? <del key={index} className="taskIssueHidden"><span className="visuallyHidden">Hidden comment: </span>{part.text}</del>
          : <span key={index}>{part.text}</span>)}
    </div>
    {truncated && <p className="taskIssueBodyCut">The preview shows only the start of a long body.</p>}
  </div>;
}

/** The task text a promote would store against the 4,000 character limit; the error tone marks one over it. */
export function IssueCharacterCount({ issue }: { issue: TaskIssue }) {
  return <p className={`taskIssueCount${issue.tooLong ? " over" : ""}`}>{COUNT_FORMAT.format(issue.characters)} / {LIMIT} characters</p>;
}

/** The one chip of an issue: too long, else promoted with its task ID, else who opened it (G77-G80). */
export function IssueStatusChip({ issue }: { issue: TaskIssue }) {
  if (issue.tooLong) return <span className="commandChip negative">Too long</span>;
  if (issue.taskId) return <span className="commandChip positive">Promoted · {issue.taskId}</span>;
  return <span className={`commandChip${issue.authorAssociation === "outsider" ? " warning" : ""}`}>{issueAssociationLabel(issue.authorAssociation)}</span>;
}
