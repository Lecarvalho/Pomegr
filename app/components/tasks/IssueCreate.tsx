"use client";

import { useEffect, useId, useState } from "react";
import {
  createTaskIssue, issueCreateFailure, issueCreateFailureMessage, readGitHubStatus, taskIssuesAvailable,
  type GitHubStatus, type TaskIssueCreateError, type TaskIssueResult,
} from "./task-issues-desktop";

// Creating a GitHub issue from a task (design contract G129-G131, G265). The task text is sent once, by the monitor, from
// the saved task: the renderer only names the task. A failed create never costs the task, so both forms report it as one
// fixed line and stay usable. Without the desktop bridge (a browser) neither the checkbox nor the action is drawn.

export const ISSUE_CREATE_HELPER = "The task text is sent to GitHub once, with its first line as the issue title. Anyone who can see the repository can read it. Later edits here are not sent.";

export type IssueCreateReason = "not_signed_in" | "cli_missing" | "issues_disabled" | "no_access" | "unreadable";
/** `hidden` is a browser and the moment before the first answer: nothing is drawn. */
export type IssueCreateOption = { kind: "hidden" } | { kind: "can" } | { kind: "cannot"; reason: IssueCreateReason };

const REASON_TEXT: Record<IssueCreateReason, string> = {
  not_signed_in: "You are not signed in to GitHub. Sign in from Settings to create issues.",
  cli_missing: "The GitHub CLI is not installed.",
  issues_disabled: "Issues are turned off for this repository.",
  no_access: "You cannot create issues in this repository.",
  unreadable: "GitHub could not be read.",
};

/** Whether the connected account may create issues in this repository, from one status read. */
export function issueCreateOptionOf(result: TaskIssueResult<GitHubStatus>): IssueCreateOption {
  if (!result.ok) return { kind: "cannot", reason: "unreadable" };
  const { connection, repository } = result.value;
  if (connection !== "connected") return { kind: "cannot", reason: connection };
  if (!repository) return { kind: "cannot", reason: "unreadable" };
  if (repository.capabilities.includes("create_issues")) return { kind: "can" };
  return { kind: "cannot", reason: repository.capabilities.includes("issues_disabled") ? "issues_disabled" : "no_access" };
}

/** Reads the GitHub status once when the form opens, on the desktop only. An explicit read: nothing polls. */
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

/**
 * The New task checkbox under the Task counter (G129-G131). It is drawn checked when the account can create issues;
 * otherwise it is unchecked and disabled, and the helper names the one reason.
 */
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

/**
 * The Source row of a task with no GitHub issue (G265): "Not on GitHub" and Create GitHub issue. The monitor reads the
 * saved task, so an unsaved draft disables it. `saveFirst` is the line to draw here, or null when the footer already says it.
 */
export function IssueCreateRow({ repositoryId, taskId, unsaved, saveFirst, onChanged }: {
  repositoryId: string;
  taskId: string;
  unsaved: boolean;
  /** The line to draw under the row while the draft is unsaved; null when the footer already shows it. */
  saveFirst: string | null;
  /** The board must be read again: the issue was created, or the monitor says the task already has one. */
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

/** The row as drawn, with no state: the design system shows its states from static data. */
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
