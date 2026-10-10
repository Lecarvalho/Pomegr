"use client";

import { useCallback, useRef, useState } from "react";
import type { DragEvent } from "react";
import { TASK_ID_PATTERN, type TaskBoard } from "../../../shared/task-contract";
import { dropPosition, isNoopMove, leavesReady } from "./task-board-model";
import type { TaskMove } from "./task-desktop";

// Native HTML drag and drop for cards (design contract D86, D442, D443). The payload is the plain-text task ID with
// effect move. Dropping on a column appends the card to it; dropping on a card places it before that card; dropping a
// card on itself changes nothing. The column under the pointer takes the raised fill while a card is over it or any
// card in it, and loses it when the pointer leaves, the card drops, or the drag ends. A card that waits in the queue
// stays in Ready: no other column offers itself as its drop target, and a drop there sends nothing.

export type ColumnDropHandlers = {
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
};

export function useCardDrag(board: TaskBoard, onMove: (move: TaskMove) => void) {
  const dragged = useRef<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const finish = useCallback(() => { dragged.current = null; setOverColumn(null); }, []);

  // Only a drag this board started is accepted: a column offers itself as a drop target only then, so text or files
  // dragged in from elsewhere never move a card.
  const take = () => {
    const id = dragged.current;
    finish();
    return id !== null && TASK_ID_PATTERN.test(id) && board.tasks.some((task) => task.id === id) ? id : null;
  };
  const send = (id: string, columnId: string, beforeId: string | null) => {
    const move = { id, columnId, position: dropPosition(board, id, columnId, beforeId) };
    if (!leavesReady(board, move) && !isNoopMove(board, move)) onMove(move);
  };

  const cardHandlers = (id: string) => ({
    onDragStart: (event: DragEvent<HTMLLIElement>) => {
      dragged.current = id;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      }
    },
    onDragEnd: finish,
    onDrop: (event: DragEvent<HTMLLIElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const moved = take();
      if (moved && moved !== id) send(moved, board.tasks.find((task) => task.id === id)?.columnId ?? "", id);
    },
  });

  const columnHandlers = (columnId: string): ColumnDropHandlers => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (dragged.current === null || leavesReady(board, { id: dragged.current, columnId })) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setOverColumn(columnId);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setOverColumn((current) => current === columnId ? null : current);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const moved = take();
      if (moved) send(moved, columnId, null);
    },
  });

  return { overColumn, cardHandlers, columnHandlers };
}
