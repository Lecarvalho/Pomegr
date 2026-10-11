"use client";

import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";
import { TASK_ID_PATTERN, type Task, type TaskBoard } from "../../../shared/task-contract";
import { reorderMove } from "./task-queue-model";

export type QueueDropHandlers = {
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
};

/** Drag between the steps of one feature: a waiting card dropped on another waiting card's step takes that step. */
export function useQueueDrag(board: Pick<TaskBoard, "columns" | "tasks">, onReorder: (task: Task, target: Task) => void) {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const finish = useCallback(() => { dragged.current = null; setOver(null); }, []);
  const draggedTask = () => {
    const id = dragged.current;
    return id !== null && TASK_ID_PATTERN.test(id) ? board.tasks.find((task) => task.id === id) : undefined;
  };

  const cardHandlers = (id: string) => ({
    onDragStart: (event: DragEvent<HTMLElement>) => {
      dragged.current = id;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      }
    },
    onDragEnd: finish,
  });

  const targetHandlers = (target: Task): QueueDropHandlers => {
    const key = target.id;
    return {
      onDragOver: (event) => {
        const task = draggedTask();
        if (!task || reorderMove(board, task, target) === null) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        setOver(key);
      },
      onDragLeave: (event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setOver((current) => current === key ? null : current);
      },
      onDrop: (event) => {
        const task = draggedTask();
        finish();
        if (!task || reorderMove(board, task, target) === null) return;
        event.preventDefault();
        onReorder(task, target);
      },
    };
  };

  return { over, cardHandlers, targetHandlers };
}
