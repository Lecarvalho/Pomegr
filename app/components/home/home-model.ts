import type { SessionSummary } from "../../../shared/monitor-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { DEFAULT_TASK_COLUMNS, type TaskBoard, type TaskHome, type TaskQueuePauseReason } from "../../../shared/task-contract";
import type { TaskLog } from "../tasks/task-desktop";
import { splitTaskTitle } from "../tasks/task-tags";
import { taskBoardHref } from "../tasks/TasksHome";

// The fixed rules behind Home: the greeting, the last-24-hours tiles, and Needs you. Each one reads numbers and fixed kinds and writes fixed
// words. No model runs, no answer of a model is read, and no heuristic is called an AI judgment (docs/internal/design/home.md).

export const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Home reads the task log of the boards that changed last, and no more. */
export const HOME_LOG_BOARDS = 12;

/** The log of each board Home read, by repository ID; null where it could not be read. */
export type HomeLogReads = ReadonlyMap<string, TaskLog | null>;

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  return hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
}

// ---- The last 24 hours ----

type LogKind = TaskLog["entries"][number]["kind"];
/** The four events the tiles count, in their fixed order, with the words of a tile: the full label, and the short one a phone draws. */
export const DAY_EVENTS: readonly { kinds: readonly LogKind[]; label: string; short: string }[] = [
  { kinds: ["started", "grant_start"], label: "Started", short: "Started" },
  { kinds: ["review"], label: "Reached Review", short: "Review" },
  { kinds: ["merged", "grant_merge"], label: "Merged", short: "Merged" },
  { kinds: ["done", "grant_done"], label: "Marked Done", short: "Done" },
];

/**
 * How many tasks started, reached Review, were merged, and were marked Done in the logs of the last 24 hours, in the order of `DAY_EVENTS`. A task
 * counts once for each event. Null where no log could be read, so a missing log never says that nothing happened; `unreadable` counts the logs
 * that could not be read when others could.
 */
export function dayCounts(reads: HomeLogReads, now: number): { counts: number[]; unreadable: number } | null {
  const counted = DAY_EVENTS.map(() => new Set<string>());
  let readable = 0;
  let unreadable = 0;
  for (const [repositoryId, log] of reads) {
    if (log === null) { unreadable += 1; continue; }
    readable += 1;
    for (const entry of log.entries) {
      if (entry.task === null || entry.at < now - DAY_WINDOW_MS) continue;
      const event = DAY_EVENTS.findIndex((candidate) => candidate.kinds.includes(entry.kind));
      if (event >= 0) counted[event].add(`${repositoryId}/${entry.task}`);
    }
  }
  return readable === 0 ? null : { counts: counted.map((tasks) => tasks.size), unreadable };
}

// ---- Needs you ----

export const PAUSE_WORDS: Record<TaskQueuePauseReason, string> = {
  cli_missing: "CLI not found", plugin_missing: "Plugin missing", unsupported_platform: "Windows only", start_failed: "A start failed",
  session_not_linked: "Session not linked", worktree_dirty: "Worktree has changes", environment_invalid: "Environment invalid",
};

/** The word for the newest result a Needs review task has since it reported complete, and whether it is a failure the owner can act on now. */
const DETAILS: Partial<Record<LogKind, { words: string; urgent: boolean }>> = {
  checks_failed: { words: "CI failed", urgent: true },
  checks_passed: { words: "CI passed", urgent: false },
  review_failed: { words: "Review failed", urgent: true },
  review_passed: { words: "Review passed", urgent: false },
  grant_merge_refused: { words: "Merge refused", urgent: true },
  merged: { words: "Merged", urgent: false },
  grant_merge: { words: "Merged", urgent: false },
};
export type NeedsDetail = { words: string; urgent: boolean };

/** The newest CI, review, or merge entry that follows the task's newest `review` entry, or null. */
export function needsDetail(log: TaskLog, taskId: string): NeedsDetail | null {
  const entries = log.entries.filter((entry) => entry.task === taskId).sort((left, right) => left.id - right.id);
  const reported = entries.findLastIndex((entry) => entry.kind === "review");
  if (reported < 0) return null;
  for (let index = entries.length - 1; index > reported; index -= 1) {
    const detail = DETAILS[entries[index].kind];
    if (detail) return detail;
  }
  return null;
}

/** One thing the owner has to do: the action in words, a failure detail, the repository, and where it is done. It names no task and no title. */
export type NeedsKind = "session" | "review" | "stalled" | "blocked" | "queue";
export type NeedsLine = { key: string; kind: NeedsKind; action: string; detail: NeedsDetail | null; repository: string; href: string };
export const NEEDS_LINES_SHOWN = 8;

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("{n}", String(count)));

/** A live session that waits for the owner: Pomegr observed that an agent needs input. */
export const isWaiting = (session: SessionSummary) => session.isLive && (session.needsInput || session.activityStatus === "needs_input");
/** A live session whose agent is working and does not wait for the owner. */
export const isWorking = (session: SessionSummary) => session.isLive && !isWaiting(session) && session.activityStatus === "working";

const repositoryOf = (session: SessionSummary, names: ReadonlyMap<string, string>) => (session.repositoryId ? names.get(session.repositoryId) : undefined) ?? session.project;
function sessionHref(session: SessionSummary): string {
  try { return `/sessions/${encodeSessionRoute(session.id)}`; } catch { return "/sessions"; }
}

/** Groups the lines by kind and repository, in this order: sessions that wait, finished tasks (failures in their own lines), stalled, blocked, paused queues. */
export function needsYou(input: { home: TaskHome; names: ReadonlyMap<string, string>; logs: HomeLogReads; sessions: readonly SessionSummary[] }): { lines: NeedsLine[]; total: number } {
  const { home, names, logs, sessions } = input;
  const lines: NeedsLine[] = [];

  // Sessions that wait, one line for each repository.
  const waiting = new Map<string, SessionSummary[]>();
  for (const session of sessions.filter(isWaiting)) {
    const key = session.repositoryId ?? `project:${session.project}`;
    waiting.set(key, [...(waiting.get(key) ?? []), session]);
  }
  for (const [key, group] of waiting) {
    const only = group.length === 1;
    lines.push({
      key: `session:${key}`, kind: "session", action: plural(group.length, "Answer a session that is waiting for you", "Answer {n} sessions that are waiting for you"), detail: null, repository: repositoryOf(group[0], names),
      href: only ? sessionHref(group[0]) : group[0].repositoryId ? `/sessions?${new URLSearchParams({ repository: group[0].repositoryId })}` : "/sessions",
    });
  }

  // Tasks, in the order the Tasks home serves them. A repository the inventory no longer lists has no board to open.
  const known = home.attention.filter((item) => names.has(item.repositoryId));
  const finished = new Map<string, { repositoryId: string; detail: NeedsDetail | null; count: number }>();
  const stalled = new Map<string, { repositoryId: string; count: number }>();
  const blocked = new Map<string, { repositoryId: string; count: number }>();
  for (const item of known) {
    if (item.state === "needs_review") {
      const log = logs.get(item.repositoryId);
      const found = log ? needsDetail(log, item.taskId) : null;
      // A failure has its own line; a passed result or none joins the plain line of its repository.
      const detail = found?.urgent ? found : null;
      const key = `${item.repositoryId}:${detail?.words ?? ""}`;
      finished.set(key, { repositoryId: item.repositoryId, detail, count: (finished.get(key)?.count ?? 0) + 1 });
    } else {
      const bucket = item.state === "stalled" ? stalled : blocked;
      bucket.set(item.repositoryId, { repositoryId: item.repositoryId, count: (bucket.get(item.repositoryId)?.count ?? 0) + 1 });
    }
  }
  // Within a repository the plain line comes before its failures.
  for (const [key, group] of [...finished].sort(([, left], [, right]) => Number(left.detail !== null) - Number(right.detail !== null))) {
    lines.push({ key: `review:${key}`, kind: "review", action: plural(group.count, "Review 1 finished task", "Review {n} finished tasks"), detail: group.detail, repository: names.get(group.repositoryId)!, href: taskBoardHref(group.repositoryId) });
  }
  for (const group of stalled.values()) lines.push({ key: `stalled:${group.repositoryId}`, kind: "stalled", action: plural(group.count, "Check 1 stalled task", "Check {n} stalled tasks"), detail: null, repository: names.get(group.repositoryId)!, href: taskBoardHref(group.repositoryId) });
  for (const group of blocked.values()) lines.push({ key: `blocked:${group.repositoryId}`, kind: "blocked", action: plural(group.count, "Unblock 1 task", "Unblock {n} tasks"), detail: null, repository: names.get(group.repositoryId)!, href: taskBoardHref(group.repositoryId) });

  for (const board of home.boards) {
    if (board.readiness !== "ready" || board.queue.status !== "paused" || !names.has(board.repositoryId)) continue;
    lines.push({
      key: `queue:${board.repositoryId}`, kind: "queue", action: "Restart the paused queue", detail: { words: board.queue.pauseReason ? PAUSE_WORDS[board.queue.pauseReason] : "Paused", urgent: true },
      repository: names.get(board.repositoryId)!, href: taskBoardHref(board.repositoryId),
    });
  }
  return { lines, total: lines.length };
}

// ---- Running sessions ----

export const HOME_RUNNING_SHOWN = 4;

/** When a session last changed: "updated just now", or "updated n min ago", "n h ago", "n d ago". Null where the time is not known. */
export function updatedAgo(updatedAt: string | null | undefined, now: number): string | null {
  const updated = Date.parse(updatedAt ?? "");
  if (!Number.isFinite(updated)) return null;
  const minutes = Math.max(0, Math.floor((now - updated) / 60_000));
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `updated ${hours} h ago` : `updated ${Math.floor(hours / 24)} d ago`;
}

export type RunningSession = { key: string; title: string; waiting: boolean; meta: string; href: string };

/** The repositories whose boards the running list joins titles from: the shown sessions' own. */
export function runningCandidates(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter((session) => isWaiting(session) || isWorking(session))
    .sort((left, right) => Number(isWaiting(right)) - Number(isWaiting(left)) || (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0));
}

/** The title of the task a session was started for or assigned to, from the board the session's repository holds, or null. */
function taskTitleOf(session: SessionSummary, boards: ReadonlyMap<string, TaskBoard>): string | null {
  const board = session.repositoryId ? boards.get(session.repositoryId) : undefined;
  const task = board?.readiness === "ready" ? board.tasks.find((candidate) => candidate.session?.id === session.id || candidate.assigned?.some((assigned) => assigned.id === session.id)) : undefined;
  const title = task ? splitTaskTitle(task.text).title.trim() : "";
  return title === "" ? null : title;
}

/**
 * The live sessions that work or wait, at most four, a waiting one first. A session started for a task shows the title line of the task; any other
 * shows its own title. `settled` is false while a board a title comes from has not answered, so no title is drawn and then replaced.
 */
export function runningSessions(sessions: readonly SessionSummary[], names: ReadonlyMap<string, string>, boards: ReadonlyMap<string, TaskBoard>, now: number): { shown: RunningSession[]; total: number; settled: boolean } {
  const candidates = runningCandidates(sessions);
  const shown = candidates.slice(0, HOME_RUNNING_SHOWN);
  const settled = shown.every((session) => !session.repositoryId || (boards.has(session.repositoryId) && boards.get(session.repositoryId)!.readiness !== "loading"));
  return {
    total: candidates.length, settled,
    shown: shown.map((session) => ({
      key: session.id, title: taskTitleOf(session, boards) ?? session.title, waiting: isWaiting(session), href: sessionHref(session),
      meta: [repositoryOf(session, names), updatedAgo(session.updatedAt, now)].filter((part): part is string => Boolean(part)).join(" · "),
    })),
  };
}

/** The boards whose logs Home reads: the ones that changed last. */
export function logBoards(home: TaskHome): string[] {
  if (home.readiness !== "ready") return [];
  return home.boards
    .filter((board) => board.readiness === "ready")
    .sort((left, right) => (Date.parse(right.updatedAt ?? "") || 0) - (Date.parse(left.updatedAt ?? "") || 0))
    .slice(0, HOME_LOG_BOARDS)
    .map((board) => board.repositoryId);
}

/** Facts for the suggestion chips: whether anything needs the owner, and whether a board holds work that has not reached Review. */
export function suggestionFacts(home: TaskHome, needs: number): { attention: boolean; work: boolean } {
  const open = DEFAULT_TASK_COLUMNS.indexOf("Review");
  return { attention: needs > 0, work: home.boards.some((board) => board.readiness === "ready" && board.counts.slice(0, open).some((count) => count > 0)) };
}
