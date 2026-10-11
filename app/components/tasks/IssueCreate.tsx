"use client";

import { useEffect, useId, useState } from "react";
import {
  createTaskIssue, issueCreateFailure, issueCreateFailureMessage, readGitHubStatus, taskIssuesAvailable,
  type GitHubStatus, type TaskIssueCreateError, type TaskIssueResult,
} from "./task-issues-desktop";

export const ISSUE_CREATE_HELPER = "The task text is sent to GitHub once, with its first line as the issue title. Anyone who can see the repository can read it. Later edits here are not sent.";

export type IssueCreateReason = "not_signed_in" | "cli_missing" | "issues_disabled" | "no_access" | "unreadable";
export type IssueCreateOption = { kind: "hidden" } | { kind: "can" } | { kind: "cannot"; reason: IssueCreateReason };

const REASON_TEXT: Record<IssueCreateReason, string> = {
  not_signed_in: "You are not signed in to GitHub. Sign in from Settings to create issues.",
  cli_missing: "The GitHub CLI is not installed.",
  issues_disabled: "Issues are turned off for this repository.",
  no_access: "You cannot create issues in this repository.",
  unreadable: "GitHub could not be read.",
};

export function issueCreateOptionOf(result: TaskIssueResult<GitHubStatus>): IssueCreateOption {
  if (!result.ok) return { kind: "cannot", reason: "unreadable" };
  const { connection, repository } = result.value;
  if (connection !== "connected") return { kind: "cannot", reason: connection };
  if (!repository) return { kind: "cannot", reason: "unreadable" };
  if (repository.capabilities.includes("create_issues")) return { kind: "can" };
  return { kind: "cannot", reason: repository.capabilities.includes("issues_disabled") ? "issues_disabled" : "no_access" };
}

export function useIssueCreateOption(repositoryId: string): IssueCreateOption {
  const [option, setOption] = useState<IssueCreateOption>({ kind: "hidden" });
  useEffect(() => {
    if (!taskIssuesAvailable()) return;
    let current = true;
    void readGitHubStatus(repositoryId).then((result) => { if (current) setOption(issueCreateOptionOf(result)); });
    return () => { current = false; };
  }, [repositoryId]);
  return option;
}

export function IssueCreateCheckbox({ option, checked, disabled, onChange }: {
  option: IssueCreateOption;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  const inputId = useId();
  const helperId = useId();
  if (option.kind === "hidden") return null;
  const can = option.kind === "can";
  return <div className="newTaskField taskIssueOption">
    <div className="taskCheckRow">
      <input id={inputId} type="checkbox" checked={can && checked} disabled={!can || disabled} aria-describedby={helperId}
        onChange={(event) => onChange(event.currentTarget.checked)} />
      <label htmlFor={inputId}>Also create a GitHub issue</label>
    </div>
    <p id={helperId} className="newTaskHelper">{can ? ISSUE_CREATE_HELPER : REASON_TEXT[option.reason]}</p>
  </div>;
}

export function IssueCreateRow({ repositoryId, taskId, unsaved, saveFirst, onChanged }: {
  repositoryId: string;
  taskId: string;
  unsaved: boolean;
  saveFirst: string | null;
  /** The board must be read again. */
  onChanged(): void;
}) {
  const helperId = useId();
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<TaskIssueCreateError | null>(() => issueCreateFailure(repositoryId, taskId));
  const create = async () => {
    if (creating || unsaved) return;
    setCreating(true);
    setFailure(null);
    const result = await createTaskIssue(repositoryId, taskId);
    setCreating(false);
    if (result.ok) { onChanged(); return; }
    setFailure(result.error);
    if (result.error === "conflict") onChanged();
  };
  return <IssueCreateRowView helperId={helperId} creating={creating} disabled={unsaved} saveFirst={unsaved ? saveFirst : null}
    failure={failure} onCreate={() => void create()} />;
}

export function IssueCreateRowView({ helperId, creating, disabled, saveFirst, failure, onCreate }: {
  helperId: string;
  creating: boolean;
  disabled: boolean;
  saveFirst: string | null;
  failure: TaskIssueCreateError | null;
  onCreate(): void;
}) {
  return <div className="taskIssueSource">
    <div className="taskSourceRow">
      <span className="taskSourceLabel">Source</span>
      <span className="taskSourceNone">Not on GitHub</span>
      <button type="button" className="commandSecondaryAction taskIssueCreateAction" disabled={creating || disabled} aria-describedby={helperId} onClick={onCreate}>
        {creating ? "Creating…" : "Create GitHub issue"}
      </button>
    </div>
    <p id={helperId} className="newTaskHelper">{ISSUE_CREATE_HELPER}</p>
    {saveFirst && <p className="newTaskHelper" role="status">{saveFirst}</p>}
    {failure && <p className="newTaskError" role="status">{issueCreateFailureMessage(failure)}</p>}
  </div>;
}
