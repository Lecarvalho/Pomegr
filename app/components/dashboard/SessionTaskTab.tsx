"use client";

import Link from "next/link";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { plainTaskText, type Task } from "../../../shared/task-contract";
import { sessionTaskHref } from "../tasks/SessionTaskCell";
import {
  checkRows, completionSummary, definitionStatus, modelSummary, outcomeChip, plannedParts, queueBlockedNote, referenceChip, startedLine, stepLabel, taskBrief,
  type CheckRow, type SessionTaskFull, type TextPart,
} from "../tasks/session-task-model";
import { TaskIssueChip } from "../tasks/TaskIssueChip";
import { taskCardTitle, taskChip, taskIssueNumber, taskSessionHref } from "../tasks/task-presentation";
import { useSessionTask } from "../tasks/use-session-task";

function Parts({ parts, empty }: { parts: TextPart[]; empty: string }) {
  if (parts.length === 0) return <>{empty}</>;
  return <>{parts.map((part, index) => <span key={index}>{index > 0 && " · "}{part.code ? <code>{part.text}</code> : part.text}</span>)}</>;
}

function BoardAction({ href }: { href: string | null }) {
  return href ? <Link className="commandSecondaryAction" href={href}>Open on board</Link> : null;
}

function RelatedRow({ task, sessionId, boardHref }: { task: Task; sessionId: string; boardHref: string | null }) {
  const chip = taskChip(task);
  const sessionHref = task.session && task.session.id !== sessionId ? taskSessionHref(task.session.id) : null;
  const href = sessionHref ?? boardHref;
  const title = taskCardTitle(task);
  return <li className={`sessionTaskRow${task.state === "done" ? " isDone" : ""}`} data-task-id={task.id}>
    <span className="sessionTaskRowId">{task.id}</span>
    {href ? <Link className="commandTextLink sessionTaskRowTitle" href={href} title={title}>{title}</Link> : <span className="sessionTaskRowTitle" title={title}>{title}</span>}
    <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
  </li>;
}

function FeaturePanel({ task, model, sessionId, boardHref }: { task: SessionTaskReference; model: SessionTaskFull; sessionId: string; boardHref: string | null }) {
  const headingId = useId();
  const name = model.feature?.name ?? task.feature;
  if (name === null || !model.progress) return null;
  return <aside aria-label="Feature">
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

function useOverflows(collapsed: boolean, text: string) {
  const element = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !collapsed) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [collapsed, text]);
  return { element, overflows };
}

/** Text cut to a fixed number of lines. The expander is drawn only when the text does not fit. */
function ClampedText({ text, variant, children }: { text: string; variant: "brief" | "own"; children?: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const { element, overflows } = useOverflows(!open, text);
  const toggle = overflows && <button type="button" className="commandTextLink sessionTaskToggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>{open ? "Show less" : "Show all"}</button>;
  return <>
    <div ref={element} id={id} className={`sessionTaskClamp is-${variant}${open ? "" : " isClamped"}${overflows && !open ? " isCut" : ""}`}><p className="sessionTaskText">{text}</p></div>
    {(children || toggle) && <div className="sessionTaskFoot">{children}{children && <span className="sessionTaskSpacer" />}{toggle}</div>}
  </>;
}

const CHECK_GLYPHS: Record<CheckRow["tone"], ReactNode> = {
  waiting: <circle cx="7" cy="7" r="5" />,
  passed: <path d="M2.5 7.5l3 3 6-6.5" />,
  failed: <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />,
};

function TaskPanel({ task, model, boardHref, headingId }: { task: SessionTaskReference; model: SessionTaskFull; boardHref: string | null; headingId: string }) {
  const full = model.task;
  const started = startedLine(full);
  const issue = taskIssueNumber(full);
  const brief = taskBrief(plainTaskText(full.text));
  return <section className="panel sessionTaskPanel" aria-labelledby={headingId}>
    <div className="sessionTaskPanelHead">
      <h2 id={headingId} className="panelHeading sessionTaskPanelHeading">Task <code>{task.id}</code></h2>
      {started && <span className="sessionTaskStarted">{started}</span>}
      <span className="sessionTaskSpacer" />
      <BoardAction href={boardHref} />
    </div>
    {full.report?.blockReason && <div className="sessionTaskBlock">
      <span className="sessionTaskEyebrow">Block reason</span>
      <p className="sessionTaskText sessionTaskBlocked">{full.report.blockReason}</p>
      <span className="sessionTaskStatus">Reported by the agent.</span>
    </div>}
    {issue !== null && <div className="sessionTaskSource">
      <span className="sessionTaskEyebrow">Source</span>
      <TaskIssueChip number={issue} />
      <span className="sessionTaskStatus">GitHub issue</span>
    </div>}
    <div className="sessionTaskWell">
      {brief.lead !== null && <p className="sessionTaskLead">{brief.lead}</p>}
      <ClampedText text={brief.body} variant="brief" />
    </div>
  </section>;
}

function CompletePanel({ task }: { task: Task }) {
  const headingId = useId();
  const rows = checkRows(task);
  const chip = outcomeChip(task);
  const summary = completionSummary(task);
  return <section className="panel sessionTaskPanel" aria-labelledby={headingId}>
    <div className="sessionTaskFeatureHead">
      <h2 id={headingId} className="panelHeading sessionTaskPanelHeading">Complete when</h2>
      {chip && <span className={`commandChip ${chip.tone}`}>{chip.label}</span>}
      {summary && <span className="sessionTaskStatus">{summary}</span>}
    </div>
    {rows.length > 0 && <ul className="sessionTaskCheckList">{rows.map((row) => <li key={row.check} className="sessionTaskCheck" data-check={row.check}>
      <svg className={`sessionTaskCheckGlyph is-${row.tone}`} viewBox="0 0 14 14" aria-hidden="true">{CHECK_GLYPHS[row.tone]}</svg>
      <span>{row.label}</span><span className={`sessionTaskCheckResult is-${row.tone}`}>{row.result}</span>
    </li>)}</ul>}
    {task.completeWhen.own !== null && <div className={`sessionTaskBlock${rows.length > 0 ? " isRuled" : ""}`}>
      <span className="sessionTaskEyebrow">Definition of done</span>
      <ClampedText text={task.completeWhen.own} variant="own"><span className="sessionTaskStatus">{definitionStatus(task)}</span></ClampedText>
    </div>}
    {rows.length === 0 && task.completeWhen.own === null && <p className="sessionTaskNote">No check is set. The agent reports when the task is complete.</p>}
  </section>;
}

function RunPanel({ task }: { task: Task }) {
  const headingId = useId();
  const models = modelSummary(task);
  return <section className="panel sessionTaskPanel" aria-labelledby={headingId}>
    <h2 id={headingId} className="panelHeading sessionTaskPanelHeading">Run</h2>
    <dl className="sessionTaskFacts">
      <dt className="sessionTaskEyebrow">Planned</dt>
      <dd><Parts parts={plannedParts(task.run)} empty="Not set" /></dd>
      <dt className="sessionTaskEyebrow">Observed</dt>
      <dd className={models.differs ? "isDiffers" : undefined}>
        {models.observed.code ? <><code>{models.observed.text}</code><small>Latest recorded for the main agent{models.differs ? ", differs from planned" : ""}</small></> : "Not recorded yet"}
      </dd>
    </dl>
  </section>;
}

export function SessionTaskTab({ task, sessionId }: { task: SessionTaskReference; sessionId: string }) {
  const model = useSessionTask(task);
  const headingId = useId();
  const boardHref = sessionTaskHref(task);
  if (model.kind === "full") {
    return <div className="sessionTaskTab" data-task-view="full">
      <TaskPanel task={task} model={model} boardHref={boardHref} headingId={headingId} />
      <div className="sessionTaskSide">
        <CompletePanel task={model.task} />
        <RunPanel task={model.task} />
        <FeaturePanel task={task} model={model} sessionId={sessionId} boardHref={boardHref} />
      </div>
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
