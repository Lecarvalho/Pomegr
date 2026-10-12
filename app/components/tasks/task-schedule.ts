import type { Task, TaskQueueSchedule } from "../../../shared/task-contract";

// Pure time helpers for scheduling.

const two = (value: number) => String(value).padStart(2, "0");

export function scheduleLabel(at: string): string | null {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time);
}

export function timeOfDay(at: string | null): string {
  const time = at === null ? NaN : Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function nextOccurrence(value: string, after: number): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match || !Number.isFinite(after)) return null;
  const date = new Date(after);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (date.getTime() <= after) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

export function localDateTime(at: string | null): string {
  const time = at === null ? NaN : Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function instantOfLocalDateTime(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** The Starts line of a board card in two parts, so the time can take the data font. The day is "today" when `now` falls on it. */
export function startsParts(task: Pick<Task, "state" | "scheduledAt" | "session">, now?: number): { day: string; time: string } | null {
  if (task.state !== "scheduled" || task.scheduledAt === null || task.session !== null) return null;
  const time = Date.parse(task.scheduledAt);
  if (!Number.isFinite(time)) return null;
  const today = now !== undefined && new Date(now).toDateString() === new Date(time).toDateString();
  return { day: today ? "today" : `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(time)},`, time: timeOfDay(task.scheduledAt) };
}

export function waitsForOwnTime(task: Pick<Task, "state" | "scheduledAt">, now: number): boolean {
  if (task.state !== "scheduled" || task.scheduledAt === null) return false;
  const time = Date.parse(task.scheduledAt);
  return Number.isFinite(time) && time > now;
}

export const NO_SCHEDULE: TaskQueueSchedule = { startAt: null, stopAfter: null };

export function editedSchedule(stored: TaskQueueSchedule, change: { startAt?: string; stopAfter?: string }, now: number): TaskQueueSchedule {
  const startAt = change.startAt === undefined ? stored.startAt : change.startAt === "" ? null : nextOccurrence(change.startAt, now);
  const startTime = startAt === null ? NaN : Date.parse(startAt);
  const base = Number.isFinite(startTime) ? Math.max(startTime, now) : now;
  let stopAfter = change.stopAfter === undefined ? stored.stopAfter : change.stopAfter === "" ? null : nextOccurrence(change.stopAfter, base);
  if (change.stopAfter === undefined && stopAfter !== null && Number.isFinite(startTime) && Date.parse(stopAfter) <= startTime) {
    stopAfter = nextOccurrence(timeOfDay(stopAfter), startTime);
  }
  return { startAt, stopAfter };
}
