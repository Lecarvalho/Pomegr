import Link from "next/link";
import { promoteIssuesHref, tasksHref } from "./promote-issues-model";

// The two links that join the Tasks page and the Promote issues page (design contract G20-G22, G62-G64).

/** The Secondary action in the Tasks header (G20-G22). It is a link: the page it opens is where an issue is chosen. */
export function PromoteIssuesAction({ repositoryId }: { repositoryId: string }) {
  return <Link className="commandSecondaryAction promoteIssuesAction" href={promoteIssuesHref(repositoryId)}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25" /><circle cx="8" cy="8" r="1.2" /></svg>
    Promote issues
  </Link>;
}

/** The Quiet back link in the Promote issues header (G62-G64). Without a repository it returns to `/tasks`. */
export function BackToTasks({ repositoryId }: { repositoryId?: string }) {
  return <Link className="commandQuietAction promoteIssuesBack" href={repositoryId ? tasksHref(repositoryId) : "/tasks"}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3L5 8l5 5" /></svg>
    Tasks
  </Link>;
}
