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

/** The Ready lane as the monitor settles it: the waiting cards of each parallel group together, where its first card is. Every other card keeps its place. */
function settledReady(cards: Task[]) {
  const waiting = cards.filter(waitsInQueue);
  const placed = new Set<string>();
  const inOrder: Task[] = [];
  for (const task of waiting) {
    if (placed.has(task.id)) continue;
    for (const member of task.group === null ? [task] : waiting.filter((other) => other.group === task.group)) { placed.add(member.id); inOrder.push(member); }
  }
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

/** The cards a move carries: the one card, or with `group: "block"` the waiting cards of its parallel group, in lane order. */
function movingCards(board: BoardShape, move: TaskMove): Task[] {
  const moving = board.tasks.find((task) => task.id === move.id);
  if (!moving) return [];
  if (move.group !== "block" || !waitsInQueue(moving) || moving.group === null) return [moving];
  const lane = taskColumns(board).find((column) => column.id === moving.columnId)?.tasks ?? [];
  return lane.filter((task) => task.id === moving.id || (waitsInQueue(task) && task.group === moving.group));
}

/**
 * The board as it reads once `move` is applied, by the monitor's rules: a grouped card that lands away from every
 * other waiting card of its group, or is moved with `group: "leave"`, leaves the group, and each group's waiting
 * cards stand together.
 */
export function applyMove(board: TaskBoard, move: TaskMove): TaskBoard {
  const block = movingCards(board, move);
  const columns = taskColumns(board);
  if (block.length === 0 || !columns.some((column) => column.id === move.columnId) || leavesReady(board, move)) return board;
  const readyId = readyColumnId(board);
  const carried = new Set(block.map((task) => task.id));
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const placed = new Map<string, Task>();
  for (const column of columns) {
    let cards = column.tasks.filter((task) => !carried.has(task.id));
    if (column.id === move.columnId) {
      cards.splice(Math.min(Math.max(move.position, 0), cards.length), 0, ...block);
      const [moving] = block;
      if (move.group !== "block" && moving.group !== null && waitsInQueue(moving)) {
        const waiting = cards.filter(waitsInQueue);
        const at = waiting.indexOf(moving);
        const beside = [waiting[at - 1], waiting[at + 1]].some((other) => other !== undefined && other.group === moving.group);
        if (move.group === "leave" || !beside) {
          const left = { ...moving, group: null };
          cards[cards.indexOf(moving)] = left;
          byId.set(left.id, left);
          placed.set(left.id, left);
          // A group left with one card in the queue is no group.
          const rest = board.tasks.filter((other) => other.id !== moving.id && other.group === moving.group);
          if (rest.length === 1) {
            const alone = { ...rest[0], group: null };
            byId.set(alone.id, alone);
            placed.set(alone.id, alone);
            cards = cards.map((task) => task.id === alone.id ? alone : task);
          }
        }
      }
      if (column.id === readyId) cards = settledReady(cards);
    }
    cards.map((task) => task.id).forEach((id, position) => {
      const task = byId.get(id);
      if (task && (task.columnId !== column.id || task.position !== position)) placed.set(id, { ...task, columnId: column.id, position });
    });
  }
  return placed.size === 0 ? board : { ...board, tasks: board.tasks.map((task) => placed.get(task.id) ?? task) };
}

/** A unit of the Ready lane: the waiting cards of one parallel group that sit together, or one card. */
export type ReadyUnit = { group: string | null; tasks: Task[] };

export function readyUnits(cards: readonly Task[]): ReadyUnit[] {
  const units: ReadyUnit[] = [];
  for (const task of cards) {
    const group = waitsInQueue(task) ? task.group : null;
    const open = units.at(-1);
    if (group !== null && open?.group === group) open.tasks.push(task);
    else units.push({ group, tasks: [task] });
  }
  return units;
}

export type CardMoveKind = "up" | "down" | "left" | "right";

/** The move behind one keyboard action on a card, or null when the card cannot go that way. */
export function cardMove(board: BoardShape, id: string, kind: CardMoveKind): TaskMove | null {
  const columns = taskColumns(board);
  const columnIndex = columns.findIndex((column) => column.tasks.some((task) => task.id === id));
  if (columnIndex < 0) return null;
  const column = columns[columnIndex];
  const index = column.tasks.findIndex((task) => task.id === id);
  if (kind === "up" || kind === "down") {
    // In Ready a parallel group is one place in the order: a card steps inside its own group, and past a whole group outside it.
    const units = column.id === readyColumnId(board) ? readyUnits(column.tasks) : column.tasks.map((task) => ({ group: null, tasks: [task] }));
    const at = units.findIndex((unit) => unit.tasks.some((task) => task.id === id));
    const inUnit = units[at].tasks.findIndex((task) => task.id === id);
    if (kind === "up") {
      if (inUnit > 0) return { id, columnId: column.id, position: index - 1 };
      return at > 0 ? { id, columnId: column.id, position: index - units[at - 1].tasks.length } : null;
    }
    if (inUnit < units[at].tasks.length - 1) return { id, columnId: column.id, position: index + 1 };
    return at < units.length - 1 ? { id, columnId: column.id, position: index + units[at + 1].tasks.length } : null;
  }
  const target = columns[columnIndex + (kind === "left" ? -1 : 1)];
  return target && !leavesReady(board, { id, columnId: target.id }) ? { id, columnId: target.id, position: Math.min(index, target.tasks.length) } : null;
}
