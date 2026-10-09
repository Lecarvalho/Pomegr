import type { Task, TaskBoard } from "../../../shared/task-contract";
import type { TaskMove } from "./task-desktop";
import { taskColumns } from "./task-presentation";

// Pure placement rules for the board: where a card sits, what a drop or a keyboard action asks for, and how an
// optimistic move reads. A move only ever changes `columnId` and `position`; a card's state and chip
// are never touched. The moves the monitor makes when a task's state changes arrive with the committed board and are
// not modeled here.

type BoardShape = Pick<TaskBoard, "columns" | "tasks">;

export type Placement = { columnId: string; index: number };

/** Where one card is drawn: its column and its 0-based index there, or null when it is on no drawn column. */
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

/** Cards of one column in drawn order, without the card being moved. */
function columnWithout(board: BoardShape, columnId: string, id: string) {
  return (taskColumns(board).find((column) => column.id === columnId)?.tasks ?? []).filter((task) => task.id !== id);
}

/**
 * The `position` that places `id` in `columnId` before the card `beforeId`, or last when `beforeId` is null or
 * not in that column. It is counted after `id` leaves its current place, which is what the monitor expects.
 */
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

/** The board as it reads once `move` is applied: dense positions in the touched columns, everything else as it was. */
export function applyMove(board: TaskBoard, move: TaskMove): TaskBoard {
  const moving = board.tasks.find((task) => task.id === move.id);
  const columns = taskColumns(board);
  if (!moving || !columns.some((column) => column.id === move.columnId)) return board;
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const placed = new Map<string, Task>();
  for (const column of columns) {
    const ids = column.tasks.filter((task) => task.id !== move.id).map((task) => task.id);
    if (column.id === move.columnId) ids.splice(Math.min(Math.max(move.position, 0), ids.length), 0, move.id);
    ids.forEach((id, position) => {
      const task = byId.get(id);
      if (task && (task.columnId !== column.id || task.position !== position)) placed.set(id, { ...task, columnId: column.id, position });
    });
  }
  return placed.size === 0 ? board : { ...board, tasks: board.tasks.map((task) => placed.get(task.id) ?? task) };
}

export type CardMoveKind = "up" | "down" | "left" | "right";

/**
 * The move behind one keyboard action on a card, or null when the card cannot go that way. Moving to a
 * neighbouring column keeps the card's row where the column is long enough, and appends otherwise.
 */
export function cardMove(board: BoardShape, id: string, kind: CardMoveKind): TaskMove | null {
  const columns = taskColumns(board);
  const columnIndex = columns.findIndex((column) => column.tasks.some((task) => task.id === id));
  if (columnIndex < 0) return null;
  const column = columns[columnIndex];
  const index = column.tasks.findIndex((task) => task.id === id);
  if (kind === "up") return index > 0 ? { id, columnId: column.id, position: index - 1 } : null;
  if (kind === "down") return index < column.tasks.length - 1 ? { id, columnId: column.id, position: index + 1 } : null;
  const target = columns[columnIndex + (kind === "left" ? -1 : 1)];
  return target ? { id, columnId: target.id, position: Math.min(index, target.tasks.length) } : null;
}
