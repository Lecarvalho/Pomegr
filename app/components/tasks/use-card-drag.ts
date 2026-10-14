"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { TASK_ID_PATTERN, type TaskBoard } from "../../../shared/task-contract";
import { isNoopMove, leavesReady, waitsInQueue } from "./task-board-model";
import type { TaskMove } from "./task-desktop";
import { taskColumns } from "./task-presentation";

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

/** The Ready lane's group targets: the lane, and the action a drop on a group sends. */
export type CardGroupDrop = { columnId: string | null; onJoin(id: string, memberId: string): void };

/** What is dragged: one card, or with `block` the whole parallel group of that card. */
type Dragged = { id: string; block: boolean };

/** What a drop here does: the card joins a group, or the card (or its group) moves before `beforeId`. */
type DropPlan = { join: { group: string; memberId: string } } | { move: TaskMove; beforeId: string | null };

/** The parallel group drawn under the pointer, with one of its waiting cards. */
function groupUnder(event: DragEvent<HTMLElement>) {
  const over = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ready-group]") : null;
  const group = over?.getAttribute("data-ready-group");
  const memberId = over?.getAttribute("data-group-task");
  return group && memberId ? { group, memberId } : null;
}

export function useCardDrag(board: TaskBoard, onMove: (move: TaskMove) => void, groups?: CardGroupDrop) {
  const dragged = useRef<Dragged | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<CardDropLine | null>(null);
  const [overGroup, setOverGroup] = useState<string | null>(null);
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

  const finish = useCallback(() => { dragged.current = null; setOverColumn(null); setDropLine(null); setOverGroup(null); stopScroll(); }, [stopScroll]);

  // Only a drag this board started is accepted.
  const take = () => {
    const current = dragged.current;
    finish();
    return current !== null && TASK_ID_PATTERN.test(current.id) && board.tasks.some((task) => task.id === current.id) ? current : null;
  };

  /**
   * What a drop here does. A waiting card over another group's frame joins that group. A group's card dropped outside
   * its frame leaves the group. A whole group moves as one block. Anything else is a card move, or nothing when the
   * card would stay where it is.
   */
  const plan = (event: DragEvent<HTMLElement>, current: Dragged, columnId: string): DropPlan | null => {
    const task = board.tasks.find((candidate) => candidate.id === current.id);
    if (!task) return null;
    const inReady = groups?.columnId === columnId;
    const over = inReady ? groupUnder(event) : null;
    const member = waitsInQueue(task) && task.group !== null;
    if (over && !current.block && waitsInQueue(task) && over.group !== task.group) return { join: over };
    const beforeId = beforeCard(event);
    const cards = taskColumns(board).find((column) => column.id === columnId)?.tasks ?? [];
    const carried = new Set(current.block && member ? cards.filter((card) => waitsInQueue(card) && card.group === task.group).map((card) => card.id) : [task.id]);
    if (beforeId !== null && carried.has(beforeId)) return null;
    const rest = cards.filter((card) => !carried.has(card.id));
    const at = beforeId === null ? -1 : rest.findIndex((card) => card.id === beforeId);
    const position = at < 0 ? rest.length : at;
    if (current.block && member) {
      const move: TaskMove = { id: task.id, columnId, position, group: "block" };
      return cards.findIndex((card) => carried.has(card.id)) === position ? null : { move, beforeId };
    }
    const move: TaskMove = { id: task.id, columnId, position };
    if (leavesReady(board, move)) return null;
    // Outside its own frame a group's card leaves the group, also when its place in the lane stays the same.
    if (inReady && member && over?.group !== task.group) return { move: { ...move, group: "leave" }, beforeId };
    return isNoopMove(board, move) ? null : { move, beforeId };
  };

  const cardHandlers = (id: string) => ({
    onDragStart: (event: DragEvent<HTMLLIElement>) => {
      // A card inside a group is the drag, not the group around it.
      event.stopPropagation();
      dragged.current = { id, block: false };
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      }
    },
    onDragEnd: finish,
  });

  /** The handlers of a group's frame: a drag that starts on the frame itself, not on one of its cards, carries the whole group. */
  const groupHandlers = (memberId: string) => ({
    onDragStart: (event: DragEvent<HTMLLIElement>) => {
      if (event.target !== event.currentTarget) return;
      dragged.current = { id: memberId, block: true };
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", memberId);
      }
    },
    onDragEnd: finish,
  });

  const columnHandlers = (columnId: string): ColumnDropHandlers => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const current = dragged.current;
      if (current === null || leavesReady(board, { id: current.id, columnId })) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setOverColumn(columnId);
      const target = plan(event, current, columnId);
      setOverGroup(target && "join" in target ? target.join.group : null);
      const line = target && "move" in target ? { columnId, beforeId: target.beforeId } : null;
      setDropLine((current) => current?.columnId === line?.columnId && current?.beforeId === line?.beforeId ? current : line);
      scrollNear(event.currentTarget.querySelector<HTMLElement>(".taskColumnList"), event.clientY);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setOverColumn((current) => current === columnId ? null : current);
      setDropLine((current) => current?.columnId === columnId ? null : current);
      if (groups?.columnId === columnId) setOverGroup(null);
      stopScroll();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const target = dragged.current === null ? null : plan(event, dragged.current, columnId);
      const moved = take();
      if (!moved || !target) return;
      if ("join" in target) groups?.onJoin(moved.id, target.join.memberId);
      else onMove(target.move);
    },
  });

  return { overColumn, dropLine, overGroup, cardHandlers, groupHandlers, columnHandlers };
}
