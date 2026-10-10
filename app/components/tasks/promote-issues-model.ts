import type { IssueListStatus, TaskIssue, TaskIssueList } from "./task-issues-desktop";

// Fixed copy and small pure helpers for the Promote issues page. None of them reads issue text beyond counts.

export const PROMOTE_ISSUES_CAPTION = "Promoting copies the issue title and body into a task once. Later edits and comments are never read.";
export const TRUNCATED_LINE = "Showing the first 100 open issues.";
export const GITHUB_SETTINGS_HREF = "/settings?section=github";

export const promoteIssuesHref = (repositoryId: string) => `/tasks/issues?${new URLSearchParams({ repository: repositoryId })}`;
export const tasksHref = (repositoryId: string) => `/tasks?${new URLSearchParams({ repository: repositoryId })}`;

/** A state the page draws in place of the list: a fixed title and detail, and for a sign-in problem the way to Settings. */
export type IssuesNotice = { title?: string; detail: string; settings?: string };

const NOTICES: Record<Exclude<IssueListStatus, "ok">, IssuesNotice> = {
  not_signed_in: { title: "GitHub is not signed in", detail: "Pomegr reads issues through your GitHub CLI session.", settings: "Open GitHub settings" },
  cli_missing: { title: "The GitHub CLI is not installed", detail: "Pomegr reads issues through the GitHub CLI.", settings: "Open GitHub settings" },
  no_access: { title: "No access to this repository", detail: "Your GitHub account cannot read this repository's issues." },
  issues_disabled: { title: "Issues are turned off", detail: "This repository has GitHub issues turned off." },
  not_found: { title: "Repository not found on GitHub", detail: "Pomegr could not match this repository to a GitHub project." },
  unavailable: { title: "Issues could not be read", detail: "Pomegr could not read the issues. Try Refresh." },
};

/** The notice for a read that did not return a list: a list status other than `ok`, or a failed call. */
export function issuesNotice(status: Exclude<IssueListStatus, "ok"> | "failed"): IssuesNotice {
  return NOTICES[status === "failed" ? "unavailable" : status];
}

/** A browser has no bridge: it reads nothing and says where issues are read. */
export const DESKTOP_ONLY_NOTICE: IssuesNotice = { detail: "GitHub issues are read in the Pomegr desktop app." };
export const EMPTY_NOTICE: IssuesNotice = { title: "No open issues", detail: "GitHub lists no open issue for this repository." };
export const LOADING_NOTICE: IssuesNotice = { title: "Reading open issues", detail: "Pomegr is asking GitHub for the open issues." };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "{repository} · 6 open issues, 3 not promoted"; a list cut at 100 says "100+". The repository name is left out while unknown. */
export function issueCountLine(name: string | null, list: Pick<TaskIssueList, "issues" | "truncated">): string {
  const open = list.issues.length;
  const notPromoted = list.issues.filter((issue) => issue.taskId === null).length;
  const issues = list.truncated ? `${open}+ open issues` : plural(open, "open issue", "open issues");
  return `${name ? `${name} · ` : ""}${issues}, ${notPromoted} not promoted`;
}

/** "Updated 8 Oct", with the year when it is not the current one. Only the update time is served, never an opened date. */
export function issueDateLabel(updatedAt: string | null, now: Date = new Date()): string | null {
  if (!updatedAt) return null;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return null;
  const sameYear = date.getFullYear() === now.getFullYear();
  return `Updated ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })}`;
}

/** After a read: the chosen issue stays chosen when it is still listed, else the first issue is chosen. */
export function keepSelection(selected: number | null, issues: readonly TaskIssue[]): number | null {
  if (selected !== null && issues.some((issue) => issue.number === selected)) return selected;
  return issues[0]?.number ?? null;
}

/** An issue can be promoted unless its task text is too long or it is already on the board. */
export const canPromote = (issue: TaskIssue) => !issue.tooLong && issue.taskId === null;
