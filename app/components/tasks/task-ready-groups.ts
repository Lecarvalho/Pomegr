import type { Task, TaskBoard } from "../../../shared/task-contract";
import { readyUnits, waitsInQueue } from "./task-board-model";

// The Ready lane's parallel groups: a projection of the lane's card order and each task's group. It never reorders a
// card and reads no stored value of its own. Cards that sit next to each other are no group: only a shared group is.

/** The waiting cards of one parallel group that sit together in Ready. `started` lists its members that already run, by number. */
export type ReadyParallelGroup = { kind: "parallel"; key: string; group: string; tasks: Task[]; started: string[] };
/** Any other card of Ready, drawn where it is. `waiting` says that it waits in the queue. */
export type ReadyCard = { kind: "card"; key: string; task: Task; waiting: boolean };
export type ReadySegment = ReadyParallelGroup | ReadyCard;

const idNumber = (id: string) => Number(id.slice(2));

export function readySegments(cards: readonly Task[], board: Pick<TaskBoard, "tasks">): ReadySegment[] {
  const started = new Map<string, string[]>();
  for (const task of board.tasks) {
    if (task.group === null || waitsInQueue(task)) continue;
    started.set(task.group, [...(started.get(task.group) ?? []), task.id]);
  }
  return readyUnits(cards).map((unit): ReadySegment => {
    const [first] = unit.tasks;
    if (unit.group === null) return { kind: "card", key: first.id, task: first, waiting: waitsInQueue(first) };
    return { kind: "parallel", key: `${unit.group}:${first.id}`, group: unit.group, tasks: unit.tasks,
      started: (started.get(unit.group) ?? []).toSorted((left, right) => idNumber(left) - idNumber(right)) };
  });
}

/** The IDs of the waiting cards of a segment: what a group action on it names. */
export function segmentWaitingIds(segment: ReadySegment): string[] {
  if (segment.kind === "parallel") return segment.tasks.map((task) => task.id);
  return segment.waiting ? [segment.task.id] : [];
}

/** The most members a parallel group holds. */
export const READY_GROUP_LIMIT = 16;

/** The IDs a "Run in parallel" between two segments next to each other sends, or null when they cannot run together. */
export function linkIds(above: ReadySegment | undefined, below: ReadySegment | undefined): string[] | null {
  if (!above || !below) return null;
  const ids = [...segmentWaitingIds(above), ...segmentWaitingIds(below)];
  const members = (segment: ReadySegment) => segment.kind === "parallel" ? segment.tasks.length + segment.started.length : 1;
  return segmentWaitingIds(above).length > 0 && segmentWaitingIds(below).length > 0 && members(above) + members(below) <= READY_GROUP_LIMIT ? ids : null;
}

/** "T-4", "T-4 and T-5", "T-4, T-5, and T-9". */
export function idList(ids: readonly string[]) {
  if (ids.length < 3) return ids.join(" and ");
  return `${ids.slice(0, -1).join(", ")}, and ${ids.at(-1)}`;
}
