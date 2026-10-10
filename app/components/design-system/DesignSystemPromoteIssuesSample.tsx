"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CommandPageHeader } from "../command-center/CommandPage";
import { IssueBody, IssueCharacterCount, IssueNotices, IssueStatusChip } from "../tasks/IssuePreview";
import { BackToTasks, PromoteIssuesAction } from "../tasks/promote-issues-action";
import { DESKTOP_ONLY_NOTICE, EMPTY_NOTICE, LOADING_NOTICE, PROMOTE_ISSUES_CAPTION, issueCountLine, issuesNotice, type IssuesNotice } from "../tasks/promote-issues-model";
import { IssuesState, PromoteIssuesSplit } from "../tasks/promote-issues-split";
import type { TaskIssue } from "../tasks/task-issues-desktop";
import { Sample, Section } from "./DesignSystemKit";

// Static issues with invented text: no bridge, no read, nothing from a real repository.

const noop = () => undefined;
const REPOSITORY_ID = "repo-0123456789abcdef01234567";

function sampleIssue(number: number, title: string, body: string, overrides: Partial<TaskIssue> = {}): TaskIssue {
  const ranges = [...body.matchAll(/<!--[\s\S]*?-->/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "");
  return {
    number, title, body, bodyTruncated: false, hiddenComments: { count: ranges.length, ranges }, characters: title.length + 2 + stripped.length, tooLong: false,
    authorAssociation: "collaborator", updatedAt: "2026-10-08T12:00:00.000Z", digest: "0".repeat(64), taskId: null, ...overrides,
  };
}

const NORMAL = sampleIssue(144, "Dark theme: chips are hard to read on raised panels",
  "In the dark theme, chips drawn on a raised panel have low contrast. The amber and green ones are fine; the neutral one is hard to read.\n\nA slightly lighter muted color for chips on raised panels would fix it.");
const OUTSIDER = sampleIssue(139, "Queue pauses when the worktree is on another drive",
  "The queue pauses when the data folder is on D: and the repository is on C:.\n\n<!-- internal note: reproduction steps are in the wiki -->\n\nThe manual start of the same task works.",
  { authorAssociation: "outsider", updatedAt: "2026-10-06T12:00:00.000Z" });
const TOO_LONG = sampleIssue(131, "Rework the Usage limits page", "A proposal to rework the Usage limits page in four parts.\n\nPart 1. Window cards\nEach window gets a card with its percentage, reset time and origin.",
  { characters: 9480, tooLong: true, authorAssociation: "member", updatedAt: "2026-09-29T12:00:00.000Z" });
const PROMOTED = sampleIssue(142, "Sessions list: the feature name is cut short", "On the Sessions list, a long feature name ends in an ellipsis and cannot be read.\n\nExpected: the full name is reachable.",
  { authorAssociation: "owner", taskId: "T-34", updatedAt: "2026-10-07T12:00:00.000Z" });
const ISSUES = [NORMAL, OUTSIDER, TOO_LONG, PROMOTED];

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

function Wide({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="designSystemGrid"><Sample label={label} note={note}><Frame>{children}</Frame></Sample></div>;
}

function SplitSample() {
  const [selected, setSelected] = useState(NORMAL.number);
  return <PromoteIssuesSplit repositoryId={REPOSITORY_ID} issues={ISSUES} truncated={false} selected={ISSUES.find((issue) => issue.number === selected) ?? null} onSelect={setSelected} onPromote={noop} />;
}

const STATES: { label: string; note: string; notice: IssuesNotice }[] = [
  { label: "Loading", note: "First read; the last list stays on screen during a Refresh.", notice: LOADING_NOTICE },
  { label: "No open issues", note: "A read that returned nothing.", notice: EMPTY_NOTICE },
  { label: "GitHub not signed in", note: "A text link to Settings, never a button.", notice: issuesNotice("not_signed_in") },
  { label: "GitHub CLI missing", note: "Same link.", notice: issuesNotice("cli_missing") },
  { label: "No access", note: "", notice: issuesNotice("no_access") },
  { label: "Issues turned off", note: "", notice: issuesNotice("issues_disabled") },
  { label: "Repository not found", note: "", notice: issuesNotice("not_found") },
  { label: "Read failed", note: "One generic message; Refresh stays enabled.", notice: issuesNotice("failed") },
  { label: "Desktop only", note: "A browser reads no issues and attempts no read.", notice: DESKTOP_ONLY_NOTICE },
];

export function PromoteIssuesSection() {
  return <Section id="promote-issues" title="Promote issues" lede="The page that lists a repository's open GitHub issues and previews one before it becomes a task. It is read once when the page opens in the desktop app and again on Refresh; the issue title and body are third-party text and are only ever drawn as text. Promote opens the task modal for the one chosen issue.">
    <div className="designSystemGrid">
      <Sample label="Tasks header action" note="A Secondary link with a circle-dot glyph, last among the head actions, drawn only in the desktop app. The header has no primary action.">
        <PromoteIssuesAction repositoryId={REPOSITORY_ID} />
      </Sample>
      <Sample label="Issue row chips" note="One chip per row: Too long wins, then Promoted with the task ID, then who opened it, in the warning tone for an outside contributor.">
        <IssueStatusChip issue={NORMAL} />
        <IssueStatusChip issue={OUTSIDER} />
        <IssueStatusChip issue={TOO_LONG} />
        <IssueStatusChip issue={PROMOTED} />
      </Sample>
      <Sample label="Character count" note="The task text a promote would store, against the 4,000 limit; over it reads in the error color.">
        <IssueCharacterCount issue={NORMAL} />
        <IssueCharacterCount issue={TOO_LONG} />
      </Sample>
    </div>
    <Wide label="Page header" note="The shared page header: the Quiet back link is its breadcrumb, the count line is its meta, and Refresh is its action.">
      <CommandPageHeader title="Promote issues" breadcrumb={<BackToTasks repositoryId={REPOSITORY_ID} />}
        meta={<p className="promoteIssuesCount">{issueCountLine("pomegr", { issues: ISSUES, truncated: false })}</p>}
        actions={<button type="button" className="commandQuietAction">Refresh</button>} />
    </Wide>
    <Wide label="List and detail" note="Rows are buttons with aria-pressed; the chosen row takes the raised fill. Choose a row to see its notices, raw body and Promote.">
      <div className="promoteIssuesPanel">
        <p className="promoteIssuesCaption">{PROMOTE_ISSUES_CAPTION}</p>
        <SplitSample />
      </div>
    </Wide>
    <div className="designSystemGrid">
      <Sample label="Notices" note="Soft fill, one-pixel line, one block of text. Outside contributor and hidden comment are warnings, too long is an error, already promoted is positive and ends in a text link.">
        <Frame>
          <IssueNotices issue={{ ...OUTSIDER, tooLong: true, characters: 9480 }}>
            <div className="taskNotice positive"><span>Already on the board as T-34.</span><Link className="commandTextLink" href="/tasks">Open task</Link></div>
          </IssueNotices>
        </Frame>
      </Sample>
      <Sample label="Raw body" note="Read-only text in the data font. A hidden HTML comment is struck through and announced as hidden; it is not copied into the task.">
        <Frame><IssueBody body={OUTSIDER.body} ranges={OUTSIDER.hiddenComments.ranges} truncated={false} /></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      {STATES.map((state) => <Sample key={state.label} label={state.label} note={state.note || undefined}>
        <Frame><div className="promoteIssuesPanel"><IssuesState notice={state.notice} /></div></Frame>
      </Sample>)}
    </div>
  </Section>;
}
