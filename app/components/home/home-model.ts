import { DEFAULT_TASK_COLUMNS, type TaskHome, type TaskHomeAttentionState, type TaskQueuePauseReason } from "../../../shared/task-contract";
import type { TaskLog } from "../tasks/task-desktop";

// The fixed rules behind Home: the greeting, the Aril line, and Needs you. Each one reads numbers and fixed kinds and writes fixed
// words. No model runs, no answer of a model is read, and no heuristic is called an AI judgment (docs/internal/design/home.md).

export const ARIL_LINE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Home reads the task log of the boards that changed last, and no more. */
export const HOME_LOG_BOARDS = 12;
export const NEEDS_YOU_SHOWN = 5;

/** The log of each board Home read, by repository ID; null where it could not be read. */
export type HomeLogReads = ReadonlyMap<string, TaskLog | null>;

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  return hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
}

// ---- The Aril line ----

type LogKind = TaskLog["entries"][number]["kind"];
const EVENTS: readonly { kinds: readonly LogKind[]; words(count: number): string }[] = [
  { kinds: ["started", "grant_start"], words: (count) => `${count} started` },
  { kinds: ["review"], words: (count) => `${count} reached Review` },
  { kinds: ["merged", "grant_merge"], words: (count) => `${count} merged` },
  { kinds: ["done", "grant_done"], words: (count) => `${count} marked Done` },
];

/**
 * The one line under the greeting: how many tasks started, reached Review, merged, and were marked Done in the logs of the last 24
 * hours. A task counts once for each event. Null where no log could be read, so a missing log never says that nothing happened.
 */
export function arilLine(reads: HomeLogReads, now: number): string | null {
  const counted = EVENTS.map(() => new Set<string>());
  let readable = 0;
  let unreadable = 0;
  for (const [repositoryId, log] of reads) {
    if (log === null) { unreadable += 1; continue; }
    readable += 1;
    for (const entry of log.entries) {
      if (entry.task === null || entry.at < now - ARIL_LINE_WINDOW_MS) continue;
      const event = EVENTS.findIndex((candidate) => candidate.kinds.includes(entry.kind));
      if (event >= 0) counted[event].add(`${repositoryId}/${entry.task}`);
    }
  }
  if (readable === 0) return null;
  const parts = EVENTS.flatMap((event, index) => (counted[index].size > 0 ? [event.words(counted[index].size)] : []));
  const line = parts.length > 0 ? `In the last 24 hours: ${parts.join(", ")}.` : "Nothing was logged in the last 24 hours.";
  return unreadable > 0 ? `${line} Some logs could not be read.` : line;
}

// ---- Needs you ----

export const ATTENTION_WORDS: Record<TaskHomeAttentionState, string> = { needs_review: "Needs review", stalled: "Stalled", blocked: "Blocked by agent" };

export const PAUSE_WORDS: Record<TaskQueuePauseReason, string> = {
  cli_missing: "CLI not found", plugin_missing: "Plugin missing", unsupported_platform: "Windows only", start_failed: "A start failed",
  session_not_linked: "Session not linked", worktree_dirty: "Worktree has changes", environment_invalid: "Environment invalid",
};

/** The word for the newest result a Needs review task has since it reported complete, and whether the owner can act on it now. */
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

export type NeedsItem =
  | { kind: "task"; key: string; repositoryId: string; repositoryName: string; taskId: string; title: string; state: TaskHomeAttentionState; detail: NeedsDetail | null }
  | { kind: "queue"; key: string; repositoryId: string; repositoryName: string; reason: string };

/**
 * What waits for the owner now, from the Tasks home: every paused queue, then every task that needs review, is stalled, or is blocked, newest
 * change first. A repository the inventory no longer lists has no board to open, so its items are left out. `total` counts all of them.
 */
export function needsYou(home: TaskHome, names: ReadonlyMap<string, string>, logs: HomeLogReads): { items: NeedsItem[]; total: number } {
  const queues: NeedsItem[] = home.boards
    .filter((board) => board.readiness === "ready" && board.queue.status === "paused" && names.has(board.repositoryId))
    .map((board) => ({ kind: "queue", key: `queue:${board.repositoryId}`, repositoryId: board.repositoryId, repositoryName: names.get(board.repositoryId)!, reason: board.queue.pauseReason ? PAUSE_WORDS[board.queue.pauseReason] : "Paused" }));
  const known = home.attention.filter((item) => names.has(item.repositoryId));
  const tasks: NeedsItem[] = known.map((item) => {
    const log = logs.get(item.repositoryId);
    return { kind: "task", key: `${item.repositoryId}:${item.taskId}`, repositoryId: item.repositoryId, repositoryName: names.get(item.repositoryId)!, taskId: item.taskId, title: item.title, state: item.state, detail: item.state === "needs_review" && log ? needsDetail(log, item.taskId) : null };
  });
  // The monitor serves at most 50 tasks and counts them all; the ones of unlisted repositories are taken out of the count.
  const taskTotal = home.attentionTotal - (home.attention.length - known.length);
  return { items: [...queues, ...tasks], total: queues.length + taskTotal };
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
