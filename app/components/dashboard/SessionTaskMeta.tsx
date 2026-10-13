"use client";

import Link from "next/link";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { sessionTaskHref } from "../tasks/SessionTaskCell";
import { stepLabel } from "../tasks/session-task-model";
import { useSessionTask } from "../tasks/use-session-task";

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
