import type { Task, TaskQueueSchedule } from "../../../shared/task-contract";

// Pure time helpers for scheduling. The monitor stores instants; the controls show and take local wall-clock values.
// A queue time is typed as a time of day and means its next occurrence, so the monitor never needs a time zone.

const two = (value: number) => String(value).padStart(2, "0");

/** "Oct 9, 02:00" in local time, or null for a value that is not a time. */
export function scheduleLabel(at: string): string | null {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(time);
}

/** The local "HH:MM" of an instant for a time input, or "" for none. */
export function timeOfDay(at: string | null): string {
  const time = at === null ? NaN : Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The next instant after `after` (epoch milliseconds) at which the local clock reads `value` ("HH:MM"), or null. */
export function nextOccurrence(value: string, after: number): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (!match || !Number.isFinite(after)) return null;
  const date = new Date(after);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (date.getTime() <= after) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

/** The local "YYYY-MM-DDTHH:MM" of an instant for a date-and-time input, or "" for none. */
export function localDateTime(at: string | null): string {
  const time = at === null ? NaN : Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The instant of a date-and-time input's local value, or null for an empty or unreadable one. */
export function instantOfLocalDateTime(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** A scheduled task's own start time while it still waits for a session, as "Starts Oct 9, 02:00" (D81), or null. */
export function startsLine(task: Pick<Task, "state" | "scheduledAt" | "session">): string | null {
  if (task.state !== "scheduled" || task.scheduledAt === null || task.session !== null) return null;
  const label = scheduleLabel(task.scheduledAt);
  return label === null ? null : `Starts ${label}`;
}

/** Whether a scheduled task still waits for its own time at `now` (epoch milliseconds). */
export function waitsForOwnTime(task: Pick<Task, "state" | "scheduledAt">, now: number): boolean {
  if (task.state !== "scheduled" || task.scheduledAt === null) return false;
  const time = Date.parse(task.scheduledAt);
  return Number.isFinite(time) && time > now;
}

export const NO_SCHEDULE: TaskQueueSchedule = { startAt: null, stopAfter: null };

/**
 * The schedule to send when one of its two times of day changes. A blank value clears that time. The start is the
 * next occurrence after `now`; the stop is the next occurrence after the start, or after `now` without one. A stop
 * that no longer comes after the start is moved to its next occurrence after it, keeping its time of day.
 */
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
