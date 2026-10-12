"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { TASK_ID_PATTERN, type TaskBoard } from "../../../shared/task-contract";
import { dropPosition, isNoopMove, leavesReady } from "./task-board-model";
import type { TaskMove } from "./task-desktop";
import { isBoardStepTask, reorderTarget, type QueueFeature } from "./task-queue-model";
import { dropKey } from "./use-queue-drag";

export type ColumnDropHandlers = {
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
};

/** Where the dragged card would land: before `beforeId`, or at the end of the column when it is null. */
export type CardDropLine = { columnId: string; beforeId: string | null };

/** The band at each end of a lane's card list, or of the page, that scrolls it, and the most it scrolls in one frame. */
const SCROLL_EDGE = 56;
const SCROLL_MAX = 16;
/** The frame the steps are measured in. A browser may draw fewer frames during a drag, so a step grows with the time since the last one. */
const FRAME_MS = 1000 / 60;
const FRAME_CATCH_UP = 6;

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

/**
 * What a drag near an end scrolls, and the band it is measured in. Where a lane has a height its card list scrolls,
 * between the list's own ends. Where lanes grow with their cards (a phone) the list does not scroll, so the page does,
 * between the shell's sticky header and the bottom of the window.
 */
export function dragScrollPort(list: HTMLElement): { target: Element; top: number; bottom: number } {
  const overflow = getComputedStyle(list).overflowY;
  if (overflow === "auto" || overflow === "scroll") {
    const rect = list.getBoundingClientRect();
    return { target: list, top: rect.top, bottom: rect.bottom };
  }
  const header = document.querySelector(".commandHeader")?.getBoundingClientRect().bottom ?? 0;
  return { target: document.scrollingElement ?? document.documentElement, top: Math.max(0, header), bottom: window.innerHeight };
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

/** The Ready lane's step targets: the lane, its features' steps, and the step action a drop sends. */
export type CardStepDrop = { columnId: string | null; panels: readonly QueueFeature[]; onStep(id: string, step: number): void };

/**
 * The step of `featureId` under the pointer, read from the groups drawn in the lane: a step group's number, null for
 * the new-step zone or the gap after the feature's last group, and undefined anywhere else.
 */
function stepUnder(event: DragEvent<HTMLElement>, featureId: string) {
  const own = (element: Element) => element.getAttribute("data-step-feature") === featureId;
  const over = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-step-feature]") : null;
  if (over) return !own(over) ? undefined : over.hasAttribute("data-new-step") ? null : Number(over.getAttribute("data-step"));
  const last = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-step-feature]:not([data-new-step])")].filter(own).at(-1);
  if (!last) return undefined;
  // The zone is drawn in this gap once the pointer is in it, so the gap ends at the element after the zone.
  const zone = last.nextElementSibling?.hasAttribute("data-new-step") ? last.nextElementSibling : null;
  const next = (zone ?? last).nextElementSibling;
  return event.clientY >= last.getBoundingClientRect().bottom && (!next || event.clientY < next.getBoundingClientRect().top) ? null : undefined;
}

export function useCardDrag(board: TaskBoard, onMove: (move: TaskMove) => void, steps?: CardStepDrop) {
  const dragged = useRef<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<CardDropLine | null>(null);
  const [overStep, setOverStep] = useState<string | null>(null);
  const scroll = useRef<{ list: HTMLElement; y: number; frame: number; at: number | null } | null>(null);

  const stopScroll = useCallback(() => {
    if (scroll.current) cancelAnimationFrame(scroll.current.frame);
    scroll.current = null;
  }, []);
  useEffect(() => stopScroll, [stopScroll]);

  // The pointer can rest near an end while no event arrives, so the list, or the page, scrolls on each frame until the drag moves on.
  const scrollNear = (list: HTMLElement | null, y: number) => {
    if (!list) { stopScroll(); return; }
    if (scroll.current) { scroll.current.list = list; scroll.current.y = y; return; }
    const tick = (now: number) => {
      const state = scroll.current;
      if (!state) return;
      const frames = state.at === null ? 1 : Math.min((now - state.at) / FRAME_MS, FRAME_CATCH_UP);
      state.at = now;
      const port = dragScrollPort(state.list);
      const step = Math.round(dragScrollStep(port.top, port.bottom, state.y) * frames);
      // The page scrolls smoothly (`scroll-behavior: smooth` on the root), and a smooth scroll that is replaced on each
      // frame never gets anywhere, so each step is an instant one.
      if (step !== 0 && typeof port.target.scrollBy === "function") port.target.scrollBy({ top: step, behavior: "instant" });
      else if (step !== 0) port.target.scrollTop += step;
      state.frame = requestAnimationFrame(tick);
    };
    scroll.current = { list, y, frame: requestAnimationFrame(tick), at: null };
  };

  const finish = useCallback(() => { dragged.current = null; setOverColumn(null); setDropLine(null); setOverStep(null); stopScroll(); }, [stopScroll]);

  // Only a drag this board started is accepted.
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

  /** The step a drop here gives the dragged card, by the Queue view's rule, or null when the drop is a card move. */
  const stepTarget = (event: DragEvent<HTMLElement>, id: string, columnId: string) => {
    if (!steps || steps.columnId !== columnId) return null;
    const task = board.tasks.find((candidate) => candidate.id === id);
    const panel = task && isBoardStepTask(task) ? steps.panels.find((candidate) => candidate.feature.id === task.featureId) : undefined;
    if (!task || !panel) return null;
    const step = stepUnder(event, panel.feature.id);
    const target = step === undefined ? null : reorderTarget(panel, task, step);
    return step === undefined || target === null ? null : { key: dropKey(panel.feature.id, step), step: target };
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
      const step = stepTarget(event, id, columnId);
      setOverStep(step?.key ?? null);
      const beforeId = beforeCard(event);
      const line = !step && moveTo(id, columnId, beforeId) ? { columnId, beforeId } : null;
      setDropLine((current) => current?.columnId === line?.columnId && current?.beforeId === line?.beforeId ? current : line);
      scrollNear(event.currentTarget.querySelector<HTMLElement>(".taskColumnList"), event.clientY);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setOverColumn((current) => current === columnId ? null : current);
      setDropLine((current) => current?.columnId === columnId ? null : current);
      if (steps?.columnId === columnId) setOverStep(null);
      stopScroll();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const beforeId = beforeCard(event);
      const step = dragged.current === null ? null : stepTarget(event, dragged.current, columnId);
      const moved = take();
      if (moved && step) { steps?.onStep(moved, step.step); return; }
      const move = moved ? moveTo(moved, columnId, beforeId) : null;
      if (move) onMove(move);
    },
  });

  return { overColumn, dropLine, overStep, cardHandlers, columnHandlers };
}
