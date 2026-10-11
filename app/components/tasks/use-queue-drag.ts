"use client";

import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";
import { TASK_ID_PATTERN, type Task } from "../../../shared/task-contract";
import { reorderTarget, type QueueFeature } from "./task-queue-model";

export type QueueDropHandlers = {
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
};

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
