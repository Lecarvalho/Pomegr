"use client";

import { useId } from "react";
import type { Task } from "../../../shared/task-contract";
import { QueueTaskCard } from "./QueueTaskCard";
import { isMovableQueueTask, moveChoices, stepModeLabel, type QueueFeature } from "./task-queue-model";
import { dropKey, type QueueDropHandlers, type useQueueDrag } from "./use-queue-drag";

/** Design contract D146 on the desktop, where tasks can be dragged; the read-only copy drops the drag sentence. */
const NOTE = "Steps run in order. Tasks inside one step run at the same time. Drag a queued task to another step to change when it runs. Tasks that started or finished stay where they are.";
const READ_ONLY_NOTE = "Steps run in order. Tasks inside one step run at the same time. Tasks that started or finished stay where they are.";
const NEW_STEP_TEXT = "Drop a queued task here to add a step at the end";

type Drag = ReturnType<typeof useQueueDrag>;

/** One unfinished feature: its progress, its steps in order, the new-step drop zone and the note (D117-D146). */
export function QueueFeaturePanel({ panel, nextId, onOpenTask, drag, onMove }: {
  panel: QueueFeature;
  /** The task listed first in `queue.order`: it reads "Queued · next". */
  nextId: string | null;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
  /** Present only in the desktop app; without it the panel is read-only. */
  drag?: Drag;
  onMove?(id: string, step: number): void;
}) {
  const headingId = useId();
  const zone = drag?.targetHandlers(panel, null);
  const fill = (handlers: QueueDropHandlers | undefined, step: number | null) => handlers && drag?.over === dropKey(panel.feature.id, step) ? " isDragOver" : "";
  return <section className="panel taskQueuePanel" aria-labelledby={headingId} data-feature-id={panel.feature.id}>
    <div className="taskQueueHead">
      <h3 id={headingId} className="taskQueueHeading">{panel.feature.name}</h3>
      <span className="taskQueueCaption"><span className="taskQueueNum">{panel.done}</span> of <span className="taskQueueNum">{panel.total}</span> {panel.total === 1 ? "task" : "tasks"} done</span>
    </div>
    <ol className="taskQueueSteps" aria-label={`Steps of ${panel.feature.name}`}>
      {panel.steps.map((step) => {
        const handlers = drag && !step.allDone ? drag.targetHandlers(panel, step.step) : undefined;
        return <li key={step.step} className={`taskQueueStep${fill(handlers, step.step)}${step.allDone ? " isAllDone" : ""}`} data-step={step.step} {...handlers}>
          <div className="taskQueueStepLabel">
            <span className="taskQueueStepName">Step {step.step}</span>
            <span className="taskQueueStepMode">{stepModeLabel(step)}</span>
            {step.tasks.length > 1 && <span className="taskQueueStepNote">One worktree each</span>}
          </div>
          <ul className="taskQueueCards" aria-label={`Step ${step.step} tasks`}>
            {step.tasks.map((task) => <QueueTaskCard key={task.id} task={task} nextQueued={task.id === nextId} onOpen={onOpenTask}
              move={drag && onMove && isMovableQueueTask(task) ? { drag: drag.cardHandlers(task.id), choices: moveChoices(panel, task), onMove: (to) => onMove(task.id, to) } : undefined} />)}
          </ul>
        </li>;
      })}
      {zone && <li className={`taskQueueNewStep${fill(zone, null)}`} {...zone}>
        <div role="group" aria-label="New last step">{NEW_STEP_TEXT}</div>
      </li>}
    </ol>
    <p className="taskQueueNote">{drag ? NOTE : READ_ONLY_NOTE}</p>
  </section>;
}
