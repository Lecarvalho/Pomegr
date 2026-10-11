import Link from "next/link";
import { promoteIssuesHref, tasksHref } from "./promote-issues-model";

export function PromoteIssuesAction({ repositoryId }: { repositoryId: string }) {
  return <Link className="commandSecondaryAction promoteIssuesAction" href={promoteIssuesHref(repositoryId)}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25" /><circle cx="8" cy="8" r="1.2" /></svg>
    Promote issues
  </Link>;
}

export function BackToTasks({ repositoryId }: { repositoryId?: string }) {
  return <Link className="commandQuietAction promoteIssuesBack" href={repositoryId ? tasksHref(repositoryId) : "/tasks"}>
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3L5 8l5 5" /></svg>
    Tasks
  </Link>;
}
