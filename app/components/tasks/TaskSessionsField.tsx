"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { SessionActivityStatus } from "../../../shared/monitor-contract";
import type { TaskAssignedSession, TaskSession } from "../../../shared/task-contract";
import { sessionState } from "../../dashboard-utils";
import { CommandSelect } from "../command-center/CommandSelect";
import { TaskRow } from "./TaskRows";
import { taskSessionHref } from "./task-presentation";

export const ASSIGN_HELPER = "An assigned session can report this task complete or blocked.";
const UNTITLED = "Untitled session";

export type TaskSessionCandidate = Pick<TaskAssignedSession, "id" | "title" | "state">;

function stateOf(state: string) {
  const shown = sessionState({ activityStatus: state as SessionActivityStatus });
  return { label: shown.label, tone: shown.state === "active" ? "positive" : shown.state === "attention" ? "warning" : "neutral" };
}

function SessionRow({ session, started, disabled, onUnassign }: {
  session: TaskAssignedSession;
  started: boolean;
  disabled?: boolean;
  onUnassign?(sessionId: string): void;
}) {
  const href = taskSessionHref(session.id);
  const title = session.title?.trim() || UNTITLED;
  const state = stateOf(session.state);
  return <li className="taskSessionsItem">
    <span className="taskSessionsName">
      {href ? <Link className="commandTextLink taskSessionsTitle" href={href} title={title}>{title}</Link> : <span className="taskSessionsTitle" title={title}>{title}</span>}
      <span className="taskSessionsRole">{started ? "Started by Pomegr" : "Assigned"}</span>
    </span>
    <span className={`commandChip taskCardChip ${state.tone}`}>{state.label}</span>
    {!started && onUnassign && <button type="button" className="commandQuietAction" disabled={disabled} aria-label={`Unassign ${title}`}
      onClick={() => onUnassign(session.id)}>Unassign</button>}
  </li>;
}

/**
 * The sessions of one task, as a row of the Run settings list: the value holds the one Pomegr started for it, then every assigned
 * session, then one add line with the owner's select.
 */
export function TaskSessionsField({ started, assigned, candidates, busy, error, onAssign, onUnassign }: {
  started: TaskSession | null;
  assigned: TaskAssignedSession[];
  /** The repository's sessions that are not on the task yet. Absent where the client cannot assign. */
  candidates?: TaskSessionCandidate[];
  busy?: boolean;
  error?: string | null;
  onAssign?(sessionId: string): void;
  onUnassign?(sessionId: string): void;
}) {
  const selectId = useId();
  const helperId = useId();
  const labelId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const offered = onAssign !== undefined && candidates !== undefined;
  if (!offered && started === null && assigned.length === 0) return null;
  const options = (candidates ?? []).map((candidate) => ({ value: candidate.id, label: `${candidate.title?.trim() || UNTITLED} · ${stateOf(candidate.state).label}` }));
  const value = options.some((option) => option.value === chosen) ? chosen : null;
  return <TaskRow label="Sessions" labelId={labelId} top="control">
    <div className="taskSessions" role="group" aria-labelledby={labelId}>
      {(started !== null || assigned.length > 0) && <ul className="taskSessionsList">
        {started && <SessionRow session={started} started />}
        {assigned.map((session) => <SessionRow key={session.id} session={session} started={false} disabled={busy} onUnassign={onUnassign} />)}
      </ul>}
      {offered && <>
        <div className="taskSessionsAssign">
          <CommandSelect id={selectId} aria-label="Session to assign" className="taskValueSelect" options={options} value={value}
            placeholder={options.length > 0 ? "Choose a session" : "No other session in this repository"} disabled={busy || options.length === 0} onChange={setChosen} />
          <button type="button" className="commandSecondaryAction" disabled={busy || value === null} aria-describedby={helperId}
            onClick={() => { if (value !== null) { onAssign(value); setChosen(null); } }}>Assign session</button>
        </div>
        <span id={helperId} className="newTaskHelper">{ASSIGN_HELPER}</span>
      </>}
      {error && <p className="newTaskError" role="alert">{error}</p>}
    </div>
  </TaskRow>;
}
