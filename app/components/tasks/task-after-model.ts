import { TASK_BOUNDS, type Task } from "../../../shared/task-contract";
import { idList } from "./task-ready-groups";

// What a task runs after, in words. The monitor stores the list and holds the start (`Task.after`, `runs_after`); this
// module reads the board the client already holds and orders nothing.

type AfterTask = Pick<Task, "id" | "after" | "state">;

/** The tasks a task still waits for: those it runs after that are on the board and not Done, in the stored order. */
export function unfinishedAfter(task: Pick<Task, "after">, tasks: readonly Pick<Task, "id" | "state">[]): string[] {
  const states = new Map(tasks.map((other) => [other.id, other.state]));
  return (task.after ?? []).filter((id) => states.has(id) && states.get(id) !== "done");
}

/** The line of a card that is not waiting in the queue and still runs after an unfinished task. */
export function afterCardLine(task: AfterTask, tasks: readonly AfterTask[]): string | null {
  const ids = unfinishedAfter(task, tasks);
  return ids.length > 0 ? `Runs after ${idList(ids)}` : null;
}

/** The fixed line of a list that would make tasks wait for each other. */
export const AFTER_LOOP_MESSAGE = "These tasks would wait for each other, so nothing was changed.";
export const AFTER_FAILURE_MESSAGE = "The change could not be saved.";
export const AFTER_HELPER = "This task starts only when every task here is Done or deleted. Pomegr starts and stops nothing for it.";
export const AFTER_LIMIT = TASK_BOUNDS.afterPerTask;

/** Whether `taskId` running after `list` would make tasks wait for each other, by the lists the board holds. */
export function afterMakesLoop(tasks: readonly AfterTask[], taskId: string, list: readonly string[]): boolean {
  const lists = new Map(tasks.map((task) => [task.id, task.after ?? []]));
  const seen = new Set<string>();
  const pending = [...list];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(lists.get(id) ?? []));
  }
  return false;
}

/** The tasks the select offers: every other task of the board that is not Done and not listed yet, by number. */
export function afterCandidates<T extends AfterTask>(tasks: readonly T[], task: AfterTask): T[] {
  const listed = new Set(task.after ?? []);
  return tasks.filter((other) => other.id !== task.id && other.state !== "done" && !listed.has(other.id))
    .toSorted((left, right) => Number(left.id.slice(2)) - Number(right.id.slice(2)));
}

/** The start-status line of a task that may not start yet because it runs after unfinished tasks. */
export function afterStartLine(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  return `It runs after ${idList(ids)}, which ${ids.length === 1 ? "is" : "are"} not done, so it cannot start yet.`;
}
