"use client";

import Link from "next/link";
import { useId } from "react";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { plainTaskText, type Task } from "../../../shared/task-contract";
import { sessionTaskHref } from "../tasks/SessionTaskCell";
import {
  checkRows, definitionStatus, modelSummary, plannedParts, queueBlockedNote, referenceChip, startedLine, stepLabel,
  type SessionTaskFull, type TextPart,
} from "../tasks/session-task-model";
import { TaskIssueChip } from "../tasks/TaskIssueChip";
import { taskCardTitle, taskChip, taskIssueNumber, taskSessionHref } from "../tasks/task-presentation";
import { useSessionTask } from "../tasks/use-session-task";

function Parts({ parts, empty }: { parts: TextPart[]; empty: string }) {
  if (parts.length === 0) return <>{empty}</>;
  return <>{parts.map((part, index) => <span key={index}>{index > 0 && " · "}{part.code ? <code>{part.text}</code> : part.text}</span>)}</>;
}

/** "Open on board" (D410): the Secondary role, to the repository board that holds the task. */
function BoardAction({ href }: { href: string | null }) {
  return href ? <Link className="commandSecondaryAction" href={href}>Open on board</Link> : null;
}

/** A related task: its number, its title linked to its session (or to the board when it has none), and its chip. */
function RelatedRow({ task, sessionId, boardHref }: { task: Task; sessionId: string; boardHref: string | null }) {
  const chip = taskChip(task);
  const sessionHref = task.session && task.session.id !== sessionId ? taskSessionHref(task.session.id) : null;
  const href = sessionHref ?? boardHref;
  const title = taskCardTitle(task);
  return <li className={`sessionTaskRow${task.state === "done" ? " isDone" : ""}`} data-task-id={task.id}>
    <span className="sessionTaskRowId">{task.id}</span>
    {href ? <Link className="commandTextLink sessionTaskRowTitle" href={href}>{title}</Link> : <span className="sessionTaskRowTitle">{title}</span>}
    <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
  </li>;
}

function FeaturePanel({ task, model, sessionId, boardHref }: { task: SessionTaskReference; model: SessionTaskFull; sessionId: string; boardHref: string | null }) {
  const headingId = useId();
  const name = model.feature?.name ?? task.feature;
  if (name === null || !model.progress) return null;
  return <aside className="sessionTaskSide" aria-label="Feature">
    <section className="panel sessionTaskPanel" aria-labelledby={headingId}>
      <div className="sessionTaskFeatureHead">
        <h2 id={headingId} className="panelHeading sessionTaskPanelHeading">
          {boardHref ? <Link className="commandTextLink sessionTaskFeatureLink" href={boardHref}>{name}</Link> : name}
        </h2>
        <span className="sessionTaskProgress"><code>{model.progress.done}</code> of <code>{model.progress.total}</code> done</span>
      </div>
      {model.sameStep.length > 0 && <>
        <span className="sessionTaskSideLabel">Same step as this session</span>
        <ul className="sessionTaskRows">{model.sameStep.map((entry) => <RelatedRow key={entry.id} task={entry} sessionId={sessionId} boardHref={boardHref} />)}</ul>
      </>}
      {model.nextStep.length > 0 && <>
        <span className="sessionTaskSideLabel isNext">Next</span>
        <ul className="sessionTaskRows">{model.nextStep.map((entry) => <RelatedRow key={entry.id} task={entry} sessionId={sessionId} boardHref={boardHref} />)}</ul>
      </>}
      {model.queue.blocked && <p className="sessionTaskBlockedNote">{queueBlockedNote(model)}</p>}
    </section>
  </aside>;
}

function TaskPanel({ task, model, boardHref, headingId }: { task: SessionTaskReference; model: SessionTaskFull; boardHref: string | null; headingId: string }) {
  const full = model.task;
  const started = startedLine(full);
  const models = modelSummary(full);
  const rows = checkRows(full);
  const planned = plannedParts(full.run);
  const chip = taskChip(full);
  const issue = taskIssueNumber(full);
  return <section className="panel sessionTaskPanel" aria-labelledby={headingId}>
    <div className="sessionTaskPanelHead">
      <h2 id={headingId} className="panelHeading sessionTaskPanelHeading">Task <code>{task.id}</code></h2>
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
      {started && <span className="sessionTaskStarted">{started}</span>}
      <span className="sessionTaskSpacer" />
      <BoardAction href={boardHref} />
    </div>
    {issue !== null && <div className="sessionTaskSource">
      <span className="sessionTaskLabel">Source</span>
      <TaskIssueChip number={issue} />
      <span className="sessionTaskStatus">GitHub issue</span>
    </div>}
    <div className="sessionTaskBlock">
      <span className="sessionTaskLabel">Task</span>
      <p className="sessionTaskText">{plainTaskText(full.text)}</p>
    </div>
    <div className="sessionTaskRunFacts">
      <div className="sessionTaskCell"><span className="sessionTaskEyebrow">Planned</span><span className="sessionTaskValue"><Parts parts={planned} empty="Not set" /></span></div>
      <div className="sessionTaskCell"><span className="sessionTaskEyebrow">Observed</span>
        <span className={`sessionTaskValue${models.differs ? " isDiffers" : ""}`}>
          {models.observed.code ? <><code>{models.observed.text}</code> as the latest recorded for the main agent{models.differs ? ", differs from planned" : ""}</> : "Not recorded yet"}
        </span>
      </div>
    </div>
    {full.doneWhen.own !== null && <div className="sessionTaskBlock isRuled">
      <span className="sessionTaskLabel">Definition of done</span>
      <p className="sessionTaskText">{full.doneWhen.own}</p>
      <span className="sessionTaskStatus">{definitionStatus(full)}</span>
    </div>}
    {rows.length > 0 && <div className="sessionTaskChecks isRuled">
      <span className="sessionTaskLabel">Checks when the agent reports complete</span>
      <ul className="sessionTaskCheckList">{rows.map((row) => <li key={row.check} className="sessionTaskCheck" data-check={row.check}>
        <span>{row.label}</span><span className={`sessionTaskCheckResult is-${row.tone}`}>{row.result}</span>
      </li>)}</ul>
    </div>}
    {full.report?.blockReason && <div className="sessionTaskBlock isRuled">
      <span className="sessionTaskLabel">Block reason</span>
      <p className="sessionTaskText">{full.report.blockReason}</p>
      <span className="sessionTaskStatus">Reported by the agent.</span>
    </div>}
  </section>;
}

/**
 * The read-only Task tab of a session started for a task: the task as the board holds it (with its source line for a task
 * promoted from a GitHub issue), and its feature. There is no
 * mutation here; changing a task happens on the board in the desktop app. Without a ready board, or without the task on it,
 * only the reference's own fields are drawn.
 */
export function SessionTaskTab({ task, sessionId }: { task: SessionTaskReference; sessionId: string }) {
  const model = useSessionTask(task);
  const headingId = useId();
  const boardHref = sessionTaskHref(task);
  if (model.kind === "full") {
    return <div className="sessionTaskTab" data-task-view="full">
      <TaskPanel task={task} model={model} boardHref={boardHref} headingId={headingId} />
      <FeaturePanel task={task} model={model} sessionId={sessionId} boardHref={boardHref} />
    </div>;
  }
  const chip = referenceChip(task.state);
  return <div className="sessionTaskTab" data-task-view="reduced">
    <section className="panel sessionTaskPanel" aria-labelledby={headingId}>
      <div className="sessionTaskPanelHead">
        <h2 id={headingId} className="panelHeading sessionTaskPanelHeading">Task <code>{task.id}</code></h2>
        {chip && <span className={`commandChip ${chip.tone}`}>{chip.label}</span>}
        <span className="sessionTaskSpacer" />
        <BoardAction href={boardHref} />
      </div>
      {task.feature !== null && <p className="sessionTaskFeatureLine">
        <span className="sessionTaskEyebrow">Feature</span> {task.feature}{task.step !== null && <> · <code>{stepLabel(task.step, model.stepTotal)}</code></>}
      </p>}
      {model.note && <p className="sessionTaskNote">{model.note}</p>}
    </section>
  </div>;
}
