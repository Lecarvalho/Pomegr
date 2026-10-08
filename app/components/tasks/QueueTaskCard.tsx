"use client";

import type { HTMLAttributes } from "react";
import type { Task } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import { TaskRunLine } from "./TaskRunLine";
import { taskCardTitle, taskChip } from "./task-presentation";

export type QueueCardMove = {
  drag: Pick<HTMLAttributes<HTMLLIElement>, "onDragStart" | "onDragEnd">;
  /** Steps that accept this task, then "New last step". */
  choices: { step: number; label: string }[];
  onMove(step: number): void;
};

/**
 * One task in a step (design contract D131-D143): ID, state chip, title (the task text until its session has one),
 * and the planned run line. A queued task of a feature can be dragged and, from the keyboard, moved with the select.
 */
export function QueueTaskCard({ task, nextQueued, onOpen, move }: {
  task: Task;
  nextQueued: boolean;
  onOpen?: (task: Task, opener: HTMLElement) => void;
  move?: QueueCardMove;
}) {
  const chip = taskChip(task, nextQueued);
  const title = taskCardTitle(task);
  const className = ["taskCard", "taskQueueCard", move && "isMovable", chip.border === "live" && "isLive", chip.border === "attention" && "isAttention", task.state === "done" && "isDone"].filter(Boolean).join(" ");
  return <li className={className} data-task-id={task.id} data-task-state={task.state} draggable={move ? true : undefined} {...move?.drag}>
    <div className="taskCardTop">
      <span className="taskCardId">{task.id}</span>
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    </div>
    {onOpen
      ? <button type="button" className="commandQuietAction taskCardOpen" aria-haspopup="dialog" title={title} onClick={(event) => onOpen(task, event.currentTarget)}><span className="taskCardTitle">{title}</span></button>
      : <p className="taskCardTitle" title={title}>{title}</p>}
    <TaskRunLine run={task.run} />
    {move && move.choices.length > 0 && <div className="taskQueueMove">
      <CommandSelect aria-label={`Move ${task.id} to step`} placeholder="Move to step…" value={null}
        options={move.choices.map((choice) => ({ value: String(choice.step), label: choice.label }))} onChange={(value) => move.onMove(Number(value))} />
    </div>}
  </li>;
}
