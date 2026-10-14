"use client";

import Link from "next/link";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { sessionFeatureHref } from "../tasks/SessionTaskCell";

export function SessionTaskMeta({ task, taskHref }: { task: SessionTaskReference; taskHref: string | null }) {
  const boardHref = sessionFeatureHref(task);
  return <span className="sessionTaskMeta">
    <span className="sessionTaskMetaGroup">
      <span>Task</span>
      {taskHref ? <Link className="commandTextLink sessionTaskMetaId" href={taskHref}>{task.id}</Link> : <span className="sessionTaskMetaId isPlain">{task.id}</span>}
    </span>
    {task.feature !== null && <span className="sessionTaskMetaGroup">
      <span aria-hidden="true">·</span>
      <span>Feature</span>
      {boardHref ? <Link className="commandTextLink sessionTaskMetaFeature" href={boardHref}>{task.feature}</Link> : <span className="sessionTaskMetaFeature">{task.feature}</span>}
    </span>}
  </span>;
}
