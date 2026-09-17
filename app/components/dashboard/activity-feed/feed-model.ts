import type { ActivityFeed } from "../../../../shared/monitor-contract";
import type { ActivityRequestGroup, HistoryActivity } from "../../../../shared/session-history-contract";

/** The grouped request-range fields of one `kind=activity` history response. */
export type ActivityFeedPage = {
  status: "ready" | "loading" | "unavailable";
  revision: string;
  groups: ActivityRequestGroup[];
  range: { from: number; to: number };
  requestTotal: number;
  callTotal: number;
  byKind: ActivityFeed["byKind"];
  shellTasks: { total: number; failed: number };
};

const EMPTY_SHELL = { total: 0, failed: 0 };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCall(value: unknown): value is HistoryActivity {
  return record(value) && typeof value.id === "string" && typeof value.timestamp === "string" && typeof value.tool === "string"
    && typeof value.workKind === "string" && (value.durationMs === null || typeof value.durationMs === "number");
}

function isGroup(value: unknown): value is ActivityRequestGroup {
  if (!record(value) || !record(value.request) || !Array.isArray(value.calls) || typeof value.noMatchingCalls !== "boolean") return false;
  const request = value.request;
  const continuation = value.continuation;
  return typeof request.id === "string" && typeof request.number === "number" && Number.isSafeInteger(request.number) && request.number > 0
    && typeof request.agentId === "string" && value.calls.every(isCall)
    && (continuation === null || (record(continuation) && typeof continuation.cursor === "string" && count(continuation.remaining)));
}

function empty(status: ActivityFeedPage["status"], revision: string): ActivityFeedPage {
  return { status, revision, groups: [], range: { from: 0, to: 0 }, requestTotal: 0, callTotal: 0, byKind: [], shellTasks: EMPTY_SHELL };
}

/** Validate the grouped fields; a ready body without them is an unavailable (older) index. */
export function parseActivityFeedPage(value: unknown): ActivityFeedPage | null {
  if (!record(value) || value.kind !== "activity") return null;
  const status = value.status;
  if (status !== "ready" && status !== "loading" && status !== "unavailable") return null;
  const revision = typeof value.revision === "string" ? value.revision : "";
  if (status !== "ready") return empty(status, revision);
  const { requestGroups, range, requestTotal, callTotal, byKind, shellTasks } = value;
  if (!Array.isArray(requestGroups) || !requestGroups.every(isGroup) || !record(range) || !count(range.from) || !count(range.to)
    || !count(requestTotal) || !count(callTotal) || !Array.isArray(byKind)
    || !byKind.every((row) => record(row) && typeof row.kind === "string" && count(row.count))
    || !record(shellTasks) || !count(shellTasks.total) || !count(shellTasks.failed)) return empty("unavailable", revision);
  return {
    status, revision, groups: requestGroups, range: { from: range.from, to: range.to }, requestTotal, callTotal,
    byKind: byKind as ActivityFeed["byKind"], shellTasks: { total: shellTasks.total, failed: shellTasks.failed },
  };
}

/** Merge continuation calls into a group: deduped by call id, chronological. */
export function mergeCalls(current: HistoryActivity[], next: HistoryActivity[]): HistoryActivity[] {
  const byId = new Map(current.map((call) => [call.id, call]));
  for (const call of next) byId.set(call.id, call);
  return [...byId.values()].sort((left, right) => (Date.parse(left.timestamp) - Date.parse(right.timestamp)) || left.id.localeCompare(right.id));
}

/** A final path segment that names a file: an extension after a non-space character. */
const FILE_TOKEN = /^[^\\/]*[^\s\\/.]\.[A-Za-z][A-Za-z0-9]{0,9}$/u;

/**
 * Targets show basenames only. A detail with a path separator is shortened when it has no
 * whitespace, starts like an absolute or relative path, or ends in a file-like segment (which may
 * contain spaces); other prose, such as a shell description, stays as recorded.
 */
export function targetBasename(detail: string): string {
  const trimmed = detail.trim();
  if (!/[\\/]/u.test(trimmed)) return trimmed;
  const withoutTrailing = trimmed.replace(/[\\/]+$/u, "");
  const last = withoutTrailing.split(/[\\/]/u).at(-1) || withoutTrailing;
  const pathLike = !/\s/u.test(trimmed) || /^(?:[A-Za-z]:[\\/]|[\\/~.])/u.test(trimmed) || FILE_TOKEN.test(last);
  return pathLike ? last : trimmed;
}
