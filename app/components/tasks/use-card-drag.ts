"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { TASK_ID_PATTERN, type TaskBoard } from "../../../shared/task-contract";
import { dropPosition, isNoopMove, leavesReady } from "./task-board-model";
import type { TaskMove } from "./task-desktop";

// Native HTML drag and drop for cards (design contract D86, D442, D443). The payload is the plain-text task ID with
// effect move. The lane takes every drop: over the upper half of a card the dragged card lands before it, over the
// lower half after it, in a gap before the first card whose middle is below the pointer, and anywhere else in the lane
// at the end. The same reading draws the drop line while the card is dragged, so the line is where the card lands; a
// drop that would change nothing draws no line and sends nothing. The column under the pointer takes the strong line
// while a card is over it or any card in it, and loses it when the pointer leaves, the card drops, or the drag ends. A
// card that waits in the queue stays in Ready: no other column offers itself as its drop target, and a drop there
// sends nothing. While the pointer is near the top or bottom of a lane's card list, the list scrolls that way.

export type ColumnDropHandlers = {
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
};

/** Where the dragged card would land: before `beforeId`, or at the end of the column when it is null. */
export type CardDropLine = { columnId: string; beforeId: string | null };

/** The band at each end of a lane's card list that scrolls it, and the most it scrolls in one frame. */
const SCROLL_EDGE = 56;
const SCROLL_MAX = 16;

/**
 * The pixels to scroll a list in one frame for a pointer at `y`: negative near or above its top, positive near or
 * below its bottom, faster the closer to the end, and zero in the middle. A short list keeps a third at each end.
 */
export function dragScrollStep(top: number, bottom: number, y: number) {
  const edge = Math.min(SCROLL_EDGE, (bottom - top) / 3);
  if (!(edge > 0)) return 0;
  const speed = (depth: number) => Math.ceil(Math.min(depth / edge, 1) * SCROLL_MAX);
  if (y < top + edge) return -speed(top + edge - y);
  if (y > bottom - edge) return speed(y - (bottom - edge));
  return 0;
}

/** The card the dragged card would land before, read from the cards drawn in the lane; null is the end of the lane. */
function beforeCard(event: DragEvent<HTMLElement>) {
  const cards = [...event.currentTarget.querySelectorAll<HTMLElement>("li[data-task-id]")];
  const idAt = (index: number) => cards[index]?.getAttribute("data-task-id") ?? null;
  const middle = (card: HTMLElement) => { const rect = card.getBoundingClientRect(); return rect.top + rect.height / 2; };
  const over = event.target instanceof Element ? event.target.closest<HTMLElement>("li[data-task-id]") : null;
  const index = over ? cards.indexOf(over) : -1;
  if (over && index >= 0) return event.clientY > middle(over) ? idAt(index + 1) : idAt(index);
  return idAt(cards.findIndex((card) => event.clientY < middle(card)));
}

export function useCardDrag(board: TaskBoard, onMove: (move: TaskMove) => void) {
  const dragged = useRef<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<CardDropLine | null>(null);
  const scroll = useRef<{ list: HTMLElement; y: number; frame: number } | null>(null);

  const stopScroll = useCallback(() => {
    if (scroll.current) cancelAnimationFrame(scroll.current.frame);
    scroll.current = null;
  }, []);
  useEffect(() => stopScroll, [stopScroll]);

  // The pointer can rest near an end while no event arrives, so the list scrolls on each frame until the drag moves on.
  const scrollNear = (list: HTMLElement | null, y: number) => {
    if (!list) { stopScroll(); return; }
    if (scroll.current) { scroll.current.list = list; scroll.current.y = y; return; }
    const tick = () => {
      const state = scroll.current;
      if (!state) return;
      const rect = state.list.getBoundingClientRect();
      const step = dragScrollStep(rect.top, rect.bottom, state.y);
      if (step !== 0) state.list.scrollTop += step;
      state.frame = requestAnimationFrame(tick);
    };
    scroll.current = { list, y, frame: requestAnimationFrame(tick) };
  };

  const finish = useCallback(() => { dragged.current = null; setOverColumn(null); setDropLine(null); stopScroll(); }, [stopScroll]);

  // Only a drag this board started is accepted: a column offers itself as a drop target only then, so text or files
  // dragged in from elsewhere never move a card.
  const take = () => {
    const id = dragged.current;
    finish();
    return id !== null && TASK_ID_PATTERN.test(id) && board.tasks.some((task) => task.id === id) ? id : null;
  };
  /** The move a drop before `beforeId` makes, or null when the card would stay where it is. */
  const moveTo = (id: string, columnId: string, beforeId: string | null): TaskMove | null => {
    if (beforeId === id) return null;
    const move = { id, columnId, position: dropPosition(board, id, columnId, beforeId) };
    return leavesReady(board, move) || isNoopMove(board, move) ? null : move;
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
  });

  const columnHandlers = (columnId: string): ColumnDropHandlers => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const id = dragged.current;
      if (id === null || leavesReady(board, { id, columnId })) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setOverColumn(columnId);
      const beforeId = beforeCard(event);
      const line = moveTo(id, columnId, beforeId) ? { columnId, beforeId } : null;
      setDropLine((current) => current?.columnId === line?.columnId && current?.beforeId === line?.beforeId ? current : line);
      scrollNear(event.currentTarget.querySelector<HTMLElement>(".taskColumnList"), event.clientY);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setOverColumn((current) => current === columnId ? null : current);
      setDropLine((current) => current?.columnId === columnId ? null : current);
      stopScroll();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const beforeId = beforeCard(event);
      const moved = take();
      const move = moved ? moveTo(moved, columnId, beforeId) : null;
      if (move) onMove(move);
    },
  });

  return { overColumn, dropLine, cardHandlers, columnHandlers };
}
