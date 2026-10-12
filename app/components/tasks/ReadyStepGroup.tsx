import type { ReactNode } from "react";
import type { Task } from "../../../shared/task-contract";
import { ParallelGlyph } from "./ParallelGlyph";
import { isFramed, type ReadySingleGroup, type ReadyStepGroup as StepGroup } from "./task-ready-groups";

function Caption({ group }: { group: StepGroup | ReadySingleGroup }) {
  if (group.kind === "single") return <div className="taskReadyCaption">
    <span className="taskReadyStep"><span className="taskReadyStepName">Single tasks</span></span>
    <span className="taskReadyMode">One at a time</span>
  </div>;
  return <div className="taskReadyCaption">
    <span className="taskReadyStep"><span className="taskReadyFeature">{group.feature.name} · </span><span className="taskReadyStepName">Step {group.step} of {group.last}</span></span>
    {group.size > 1
      ? <span className="taskReadyMode isParallel"><ParallelGlyph /><span>Parallel · <span className="taskReadyCount">{group.size}</span></span></span>
      : <span className="taskReadyMode">One task</span>}
  </div>;
}

/** One group of the Ready lane: its caption, then its waiting cards in the lane's own order. */
export function ReadyStepGroup({ group, renderCard }: { group: StepGroup | ReadySingleGroup; renderCard(task: Task): ReactNode }) {
  const name = group.kind === "single" ? "Single tasks" : `${group.feature.name}, step ${group.step} of ${group.last}`;
  return <li className={`taskReadyGroup${isFramed(group) ? " isParallel" : ""}`} data-ready-group={group.kind}>
    <Caption group={group} />
    <ul className="taskReadyCards" aria-label={name}>{group.tasks.map(renderCard)}</ul>
  </li>;
}
