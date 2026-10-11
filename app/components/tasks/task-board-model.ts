import type { Task, TaskBoard } from "../../../shared/task-contract";
import type { TaskMove } from "./task-desktop";
import { taskColumns } from "./task-presentation";

// Pure placement rules for the board.

type BoardShape = Pick<TaskBoard, "columns" | "tasks">;

export function waitsInQueue(task: Pick<Task, "state" | "session">) {
  return (task.state === "queued" || task.state === "scheduled") && task.session === null;
}

export function readyColumnId(board: BoardShape) {
  return taskColumns(board)[1]?.id ?? null;
}

export function leavesReady(board: BoardShape, move: Pick<TaskMove, "id" | "columnId">) {
  const task = board.tasks.find((candidate) => candidate.id === move.id);
  return task !== undefined && waitsInQueue(task) && move.columnId !== readyColumnId(board);
}

function settledReady(cards: Task[], features: TaskBoard["features"]) {
  const featureOrder = new Map(features.map((feature, index) => [feature.id, index]));
  const placed = (task: Task) => task.featureId !== null && featureOrder.has(task.featureId);
  const waiting = cards.filter(waitsInQueue);
  // The sort is stable: the waiting cards of one feature keep the order of their cards.
  const inOrder = [
    ...waiting.filter(placed).sort((left, right) => (featureOrder.get(left.featureId ?? "") ?? 0) - (featureOrder.get(right.featureId ?? "") ?? 0)),
    ...waiting.filter((task) => !placed(task)),
  ];
  let next = 0;
  return cards.map((task) => waitsInQueue(task) ? inOrder[next++] : task);
}

export type Placement = { columnId: string; index: number };

export function placementOf(board: BoardShape, id: string): Placement | null {
  for (const column of taskColumns(board)) {
    const index = column.tasks.findIndex((task) => task.id === id);
    if (index >= 0) return { columnId: column.id, index };
  }
  return null;
}

export function samePlacement(left: Placement | null, right: Placement | null) {
  return left === right || (left !== null && right !== null && left.columnId === right.columnId && left.index === right.index);
}

function columnWithout(board: BoardShape, columnId: string, id: string) {
  return (taskColumns(board).find((column) => column.id === columnId)?.tasks ?? []).filter((task) => task.id !== id);
}

export function dropPosition(board: BoardShape, id: string, columnId: string, beforeId: string | null) {
  const rest = columnWithout(board, columnId, id);
  const at = beforeId === null ? -1 : rest.findIndex((task) => task.id === beforeId);
  return at < 0 ? rest.length : at;
}

/** True when the move would leave the card exactly where it is, so nothing needs sending. */
export function isNoopMove(board: BoardShape, move: TaskMove) {
  const current = placementOf(board, move.id);
  if (!current) return true;
  const length = columnWithout(board, move.columnId, move.id).length;
  return current.columnId === move.columnId && current.index === Math.min(Math.max(move.position, 0), length);
}

/** The board as it reads once `move` is applied. */
export function applyMove(board: TaskBoard, move: TaskMove): TaskBoard {
  const moving = board.tasks.find((task) => task.id === move.id);
  const columns = taskColumns(board);
  if (!moving || !columns.some((column) => column.id === move.columnId) || leavesReady(board, move)) return board;
  const readyId = readyColumnId(board);
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const placed = new Map<string, Task>();
  for (const column of columns) {
    let cards = column.tasks.filter((task) => task.id !== move.id);
    if (column.id === move.columnId) {
      cards.splice(Math.min(Math.max(move.position, 0), cards.length), 0, moving);
      if (column.id === readyId) cards = settledReady(cards, board.features);
    }
    cards.map((task) => task.id).forEach((id, position) => {
      const task = byId.get(id);
      if (task && (task.columnId !== column.id || task.position !== position)) placed.set(id, { ...task, columnId: column.id, position });
    });
  }
  return placed.size === 0 ? board : { ...board, tasks: board.tasks.map((task) => placed.get(task.id) ?? task) };
}

export type CardMoveKind = "up" | "down" | "left" | "right";

/** The move behind one keyboard action on a card, or null when the card cannot go that way. */
export function cardMove(board: BoardShape, id: string, kind: CardMoveKind): TaskMove | null {
  const columns = taskColumns(board);
  const columnIndex = columns.findIndex((column) => column.tasks.some((task) => task.id === id));
  if (columnIndex < 0) return null;
  const column = columns[columnIndex];
  const index = column.tasks.findIndex((task) => task.id === id);
  if (kind === "up") return index > 0 ? { id, columnId: column.id, position: index - 1 } : null;
  if (kind === "down") return index < column.tasks.length - 1 ? { id, columnId: column.id, position: index + 1 } : null;
  const target = columns[columnIndex + (kind === "left" ? -1 : 1)];
  return target && !leavesReady(board, { id, columnId: target.id }) ? { id, columnId: target.id, position: Math.min(index, target.tasks.length) } : null;
}
