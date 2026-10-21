"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { TaskIssueChip } from "./TaskIssueChip";
import { TaskRow, TaskRowNone } from "./TaskRows";
import {
  createTaskIssue, issueCreateFailure, issueCreateFailureMessage, readGitHubStatus, taskIssuesAvailable,
  type GitHubStatus, type TaskIssueCreateError, type TaskIssueResult,
} from "./task-issues-desktop";

/** The New task checkbox's helper. The confirmation of an existing task says the same in `ISSUE_CONFIRM_FACTS`. */
export const ISSUE_CREATE_HELPER = "The task text is sent to GitHub once, with its first line as the issue title. Anyone who can see the repository can read it. Later edits here are not sent.";
/**
 * What creating an issue from a saved task sends and who can read it, as the confirmation states it before anything is sent.
 * The monitor posts the first line as the title and the whole saved text as the body (`createIssue` in `server/serving/task-issue-routes.mjs`).
 */
export const ISSUE_CONFIRM_FACTS = [
  "Title: the task's first line. Body: the whole text.",
  "Anyone who can see the repository can read it.",
  "Sent once. Later edits here stay here.",
] as const;

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

/** The GitHub issue row of the task modal: the issue chip for a task that has one, else None and, where offered, Create issue… with its confirmation. */
export function TaskIssueRow({ number, offered, repositoryId, repositoryName, taskId, unsaved, saveFirst, onChanged }: {
  number: number | null;
  /** The desktop can create an issue for this task. */
  offered: boolean;
  repositoryId: string;
  repositoryName: string | null;
  taskId: string;
  unsaved: boolean;
  saveFirst: string | null;
  /** The board must be read again. */
  onChanged(): void;
}) {
  if (number !== null) return <TaskRow label="GitHub issue"><TaskIssueChip number={number} /></TaskRow>;
  if (!offered) return <TaskRow label="GitHub issue"><TaskRowNone>None</TaskRowNone></TaskRow>;
  return <IssueCreateRow repositoryId={repositoryId} repositoryName={repositoryName} taskId={taskId} unsaved={unsaved} saveFirst={saveFirst} onChanged={onChanged} />;
}

function IssueCreateRow({ repositoryId, repositoryName, taskId, unsaved, saveFirst, onChanged }: {
  repositoryId: string;
  repositoryName: string | null;
  taskId: string;
  unsaved: boolean;
  saveFirst: string | null;
  onChanged(): void;
}) {
  const factsId = useId();
  const [confirming, setConfirming] = useState(false);
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
  return <IssueCreateRowView factsId={factsId} repositoryName={repositoryName} confirming={confirming} creating={creating} disabled={unsaved}
    saveFirst={unsaved ? saveFirst : null} failure={failure}
    onOpen={() => setConfirming(true)} onCancel={() => { setConfirming(false); setFailure(null); }} onCreate={() => void create()} />;
}

/** The row for a task that is not on GitHub. Nothing is sent before **Create issue** in the confirmation. */
export function IssueCreateRowView({ factsId, repositoryName, confirming, creating, disabled, saveFirst, failure, onOpen, onCancel, onCreate }: {
  factsId: string;
  repositoryName: string | null;
  confirming: boolean;
  creating: boolean;
  disabled: boolean;
  saveFirst: string | null;
  failure: TaskIssueCreateError | null;
  onOpen(): void;
  onCancel(): void;
  onCreate(): void;
}) {
  const open = !confirming;
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  // The row moves focus only after the owner opens or closes the group, never when a sample draws it open.
  const moveFocus = useRef<"group" | "trigger" | null>(null);
  useEffect(() => {
    const target = moveFocus.current === "group" && confirming ? cancel.current : moveFocus.current === "trigger" && !confirming ? trigger.current : null;
    if (!target) return;
    moveFocus.current = null;
    target.focus({ preventScroll: true });
  }, [confirming]);
  const openGroup = () => { moveFocus.current = "group"; onOpen(); };
  const closeGroup = () => { moveFocus.current = "trigger"; onCancel(); };
  // Create issue disables itself while the create runs, and a disabled button drops focus to the dialog, where Escape would close the
  // whole modal. The group takes focus first, so Escape stays with the group, and Cancel takes it back when the create fails.
  const startCreate = () => { group.current?.focus({ preventScroll: true }); onCreate(); };
  useEffect(() => {
    if (!creating && group.current && document.activeElement === group.current) cancel.current?.focus({ preventScroll: true });
  }, [creating]);
  // Escape closes the group and nothing else: the dialog stays open, and a create in flight is not abandoned.
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (!creating) closeGroup();
  };
  return <TaskRow label="GitHub issue" top={confirming ? "check" : undefined}
    end={open && <button ref={trigger} type="button" className="commandQuietAction taskIssueCreateAction" disabled={disabled} onClick={openGroup}>Create issue…</button>}>
    {confirming
      ? <div ref={group} className="taskIssueConfirm" role="group" aria-label="Confirm GitHub issue" aria-describedby={titleId} tabIndex={-1} onKeyDown={keyDown}>
        <p id={titleId} className="taskIssueConfirmTitle">Create an issue in {repositoryName ?? "this repository"}?</p>
        <ul id={factsId} className="taskIssueConfirmFacts">{ISSUE_CONFIRM_FACTS.map((fact) => <li key={fact}>{fact}</li>)}</ul>
        <div className="taskIssueConfirmActions">
          <button type="button" className="commandSecondaryAction" disabled={creating || disabled} aria-describedby={factsId} onClick={startCreate}>{creating ? "Creating…" : "Create issue"}</button>
          <button ref={cancel} type="button" className="commandQuietAction" disabled={creating} onClick={closeGroup}>Cancel</button>
        </div>
      </div>
      : <TaskRowNone>None</TaskRowNone>}
    {saveFirst && <p className="newTaskHelper" role="status">{saveFirst}</p>}
    {failure && <p className="newTaskError" role="status">{issueCreateFailureMessage(failure)}</p>}
  </TaskRow>;
}
