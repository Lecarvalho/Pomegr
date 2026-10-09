"use client";

import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";
import { TASK_ID_PATTERN, type Task } from "../../../shared/task-contract";
import { reorderTarget, type QueueFeature } from "./task-queue-model";

// Native HTML drag and drop for queued cards (design contract D123, D124, D134, D145, D448). The payload is the
// plain-text task ID with effect move. A step row, or the dashed new-step zone, takes a drop only from a queued
// task of the same feature and only when the monitor would accept it: a step whose tasks are all done ignores
// drag-over and drop, and a drop that would change nothing sends nothing. The fill clears when the pointer leaves,
// the card drops, or the drag ends.

export type QueueDropHandlers = {
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
};

/** Identifies one drop target: a step of a feature, or its new-step zone (`step` null). */
export const dropKey = (featureId: string, step: number | null) => `${featureId}:${step ?? "new"}`;

export function useQueueDrag(tasks: readonly Task[], onReorder: (id: string, step: number) => void) {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const finish = useCallback(() => { dragged.current = null; setOver(null); }, []);
  const draggedTask = () => {
    const id = dragged.current;
    return id !== null && TASK_ID_PATTERN.test(id) ? tasks.find((task) => task.id === id) : undefined;
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

  /** `step` null is the new-step zone. */
  const targetHandlers = (panel: QueueFeature, step: number | null): QueueDropHandlers => {
    const key = dropKey(panel.feature.id, step);
    return {
      onDragOver: (event) => {
        const task = draggedTask();
        if (!task || reorderTarget(panel, task, step) === null) return;
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
        if (!task) return;
        const target = reorderTarget(panel, task, step);
        if (target === null) return;
        event.preventDefault();
        onReorder(task.id, target);
      },
    };
  };

  return { over, cardHandlers, targetHandlers };
}
