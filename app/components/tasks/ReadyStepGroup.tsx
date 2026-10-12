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
export function ReadyStepGroup({ group, renderCard, stepTarget = false }: {
  group: StepGroup | ReadySingleGroup;
  renderCard(task: Task): ReactNode;
  /** The dragged card would take this step. */
  stepTarget?: boolean;
}) {
  const name = group.kind === "single" ? "Single tasks" : `${group.feature.name}, step ${group.step} of ${group.last}`;
  return <li className={`taskReadyGroup${isFramed(group) ? " isParallel" : ""}${stepTarget ? " isStepTarget" : ""}`} data-ready-group={group.kind}
    data-step-feature={group.kind === "step" ? group.feature.id : undefined} data-step={group.kind === "step" ? group.step : undefined}>
    <Caption group={group} />
    <ul className="taskReadyCards" aria-label={name}>{group.tasks.map(renderCard)}</ul>
  </li>;
}

/** The zone a dragged card is dropped on to take a step of its own, after its feature's last step. */
export function ReadyNewStepZone({ featureId, label }: { featureId: string; label: string }) {
  return <li className="taskReadyNewStep" data-step-feature={featureId} data-new-step="">
    <div role="group" aria-label="New step">{label}</div>
  </li>;
}
