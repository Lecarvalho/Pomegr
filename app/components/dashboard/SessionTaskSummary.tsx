"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { sessionTaskHref } from "../tasks/SessionTaskCell";
import { modelSummary, nextIds, queueBlockedLine, referenceChip, stepLabel, summaryDoneWhen, type TextPart } from "../tasks/session-task-model";
import { useSessionTask } from "../tasks/use-session-task";

/** "Task" and the task ID in the session header's meta row; the ID is plain text on the Task tab itself (`taskHref` null). */
export function SessionTaskMeta({ task, taskHref }: { task: SessionTaskReference; taskHref: string | null }) {
  const { stepTotal } = useSessionTask(task);
  const boardHref = sessionTaskHref(task);
  return <span className="sessionTaskMeta">
    <span className="sessionTaskMetaGroup">
      <span>Task</span>
      {taskHref ? <Link className="commandTextLink sessionTaskMetaId" href={taskHref}>{task.id}</Link> : <span className="sessionTaskMetaId isPlain">{task.id}</span>}
    </span>
    {task.feature !== null && <span className="sessionTaskMetaGroup">
      <span aria-hidden="true">·</span>
      <span>Feature</span>
      {boardHref ? <Link className="commandTextLink sessionTaskMetaFeature" href={boardHref}>{task.feature}</Link> : <span className="sessionTaskMetaFeature">{task.feature}</span>}
      {task.step !== null && <span className="sessionTaskMetaStep">{stepLabel(task.step, stepTotal)}</span>}
    </span>}
  </span>;
}

function Part({ part }: { part: TextPart }) {
  return part.code ? <code>{part.text}</code> : <>{part.text}</>;
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return <div className="sessionTaskCell"><span className="sessionTaskEyebrow">{label}</span><span className="sessionTaskValue">{children}</span></div>;
}

/**
 * The compact task panel at the top of the Overview tab. Its heading opens the Task tab. Task content comes only from the
 * committed board; until it is ready (or when it is not available here) the panel carries the reference's own fields
 * and one quiet sentence.
 */
export function SessionTaskSummary({ task, taskHref }: { task: SessionTaskReference; taskHref: string }) {
  const model = useSessionTask(task);
  const headingId = useId();
  const chip = referenceChip(task.state);
  const models = model.kind === "full" ? modelSummary(model.task) : null;
  const featureCell = task.feature !== null && <Cell label="Feature">
    {task.feature}{task.step !== null && <> · <code>{stepLabel(task.step, model.stepTotal)}</code></>}
  </Cell>;
  return <section className="panel sessionTaskSummary" aria-labelledby={headingId} data-task-view={model.kind}>
    <h2 id={headingId} className="panelHeading sessionTaskHeading">
      <Link className="commandQuietAction panelHeadingLink" href={taskHref}>
        Task <code>{task.id}</code>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>
      </Link>
    </h2>
    {chip && <span className={`commandChip ${chip.tone}`}>{chip.label}</span>}
    {model.kind === "reduced" ? <>
      {featureCell}
      {model.note && <p className="sessionTaskNote">{model.note}</p>}
    </> : models && <>
      {featureCell}
      <Cell label="Done when">{summaryDoneWhen(model.task)}</Cell>
      <Cell label="Model">Planned <Part part={models.planned} /> · observed <Part part={models.observed} /></Cell>
      <Cell label="Next">
        {model.queue.blocked ? <span className="sessionTaskBlocked">{queueBlockedLine(model.queue.by)}</span> : model.nextStep.length > 0 ? <code>{nextIds(model.nextStep)}</code> : "—"}
      </Cell>
    </>}
  </section>;
}
