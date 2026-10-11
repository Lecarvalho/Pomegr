"use client";

import { useId } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { QueueTaskCard } from "./QueueTaskCard";
import { waitingLine } from "./task-gates-model";
import { isMovableQueueTask, moveChoices, type QueueFeature } from "./task-queue-model";
import type { useQueueDrag } from "./use-queue-drag";

const NOTE = "Steps run in order, one task at a time. A task's step is the place of its card on the board. Drag a task that waits in the queue onto another step to change when it runs. Tasks that started or finished stay where they are.";
const READ_ONLY_NOTE = "Steps run in order, one task at a time. A task's step is the place of its card on the board. Tasks that started or finished stay where they are.";

type Drag = ReturnType<typeof useQueueDrag>;

export function QueueFeaturePanel({ panel, board, nextId, queue, onOpenTask, drag, onMove }: {
  panel: QueueFeature;
  board: Pick<TaskBoard, "columns" | "tasks">;
  nextId: string | null;
  queue: TaskBoard["queue"];
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
  drag?: Drag;
  onMove?(task: Task, target: Task): void;
}) {
  const headingId = useId();
  return <section className="panel taskQueuePanel" aria-labelledby={headingId} data-feature-id={panel.feature.id}>
    <div className="taskQueueHead">
      <h3 id={headingId} className="taskQueueHeading">{panel.feature.name}</h3>
      <span className="taskQueueCaption"><span className="taskQueueNum">{panel.done}</span> of <span className="taskQueueNum">{panel.total}</span> {panel.total === 1 ? "task" : "tasks"} done</span>
    </div>
    <ol className="taskQueueSteps" aria-label={`Steps of ${panel.feature.name}`}>
      {panel.steps.map(({ step, task }) => {
        const movable = drag !== undefined && onMove !== undefined && isMovableQueueTask(task);
        const handlers = movable ? drag.targetHandlers(task) : undefined;
        const moveTo = (to: number) => {
          const target = panel.steps.find((candidate) => candidate.step === to)?.task;
          if (target) onMove?.(task, target);
        };
        return <li key={task.id} className={`taskQueueStep${handlers && drag?.over === task.id ? " isDragOver" : ""}${task.state === "done" ? " isAllDone" : ""}`} data-step={step} {...handlers}>
          <div className="taskQueueStepLabel">
            <span className="taskQueueStepName">Step {step}</span>
          </div>
          <ul className="taskQueueCards" aria-label={`Step ${step} task`}>
            <QueueTaskCard task={task} nextQueued={task.id === nextId} waiting={waitingLine(queue, task.id)} onOpen={onOpenTask}
              move={movable ? { drag: drag.cardHandlers(task.id), choices: moveChoices(board, panel, task), onMove: moveTo } : undefined} />
          </ul>
        </li>;
      })}
    </ol>
    <p className="taskQueueNote">{drag ? NOTE : READ_ONLY_NOTE}</p>
  </section>;
}
