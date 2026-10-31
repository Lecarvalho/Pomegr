import type { RepositorySummary } from "../../../shared/monitor-contract";
import { DEFAULT_TASK_COLUMNS, type TaskHome, type TaskHomeBoard, type TaskQueueStatus } from "../../../shared/task-contract";
import { PAUSE_WORDS } from "../home/home-model";

// The fixed rules behind the Tasks overview: the totals of the header, the widths of the flow bar, which boards get a card, and the
// words of a card's moving line. Each reads the Tasks home answer and nothing else, so it can name only what that answer carries: the five
// counts, the queue, and the time of the newest change. No model runs and no count is estimated. [Task board design](docs/internal/design/task-board.md#tasks-home)
// owns the rules.

type Repository = RepositorySummary;

/** The five stages in board order, with the tone each draws in the flow bar, the legend, and the counts. */
export const STAGES = DEFAULT_TASK_COLUMNS.map((name, index) => ({ name, tone: (["backlog", "ready", "progress", "review", "done"] as const)[index] }));
export type StageTone = (typeof STAGES)[number]["tone"];

/** The narrowest a stage that holds any task is drawn, in percent of the bar, so a single task among hundreds stays visible. */
export const FLOW_MIN_PERCENT = 1.5;

const sum = (counts: readonly number[]) => counts.reduce((total, count) => total + count, 0);

export type OverviewTotals = {
  /** Every task that is not Done: Backlog, Ready, In progress, and Review. */
  open: number;
  /** The tasks in the Review column. */
  review: number;
  done: number;
  /** The boards that could not be read. They add nothing to the sums above. */
  unavailable: number;
};

/** The sums over the boards that answered. A board that is unavailable adds no count, and is counted apart so the header can say so. */
export function overviewTotals(home: Pick<TaskHome, "boards">, repositoryIds: ReadonlySet<string>): OverviewTotals {
  const totals: OverviewTotals = { open: 0, review: 0, done: 0, unavailable: 0 };
  for (const board of home.boards) {
    // A board of a repository the inventory no longer lists has no card, so it has no place in the sums either.
    if (!repositoryIds.has(board.repositoryId)) continue;
    if (board.readiness !== "ready") { totals.unavailable += 1; continue; }
    totals.open += sum(board.counts.slice(0, 4));
    totals.review += board.counts[3] ?? 0;
    totals.done += board.counts[4] ?? 0;
  }
  return totals;
}

export type FlowSegment = { stage: string; tone: StageTone; count: number; width: string };

/**
 * The stages that hold a task, each as a share of the bar. A stage with no task is not drawn at all. A share never falls under
 * `FLOW_MIN_PERCENT`; the bar then shrinks its segments evenly to fit.
 */
export function flowSegments(counts: readonly number[]): FlowSegment[] {
  const total = sum(counts);
  if (total === 0) return [];
  return STAGES.flatMap(({ name, tone }, index) => {
    const count = counts[index] ?? 0;
    return count === 0 ? [] : [{ stage: name, tone, count, width: `${Math.max(FLOW_MIN_PERCENT, (count / total) * 100).toFixed(1)}%` }];
  });
}

export type QueueWord = { text: string; tone: "on" | "off" | "paused" | "blocked" };

/** The queue in words: the switch carries on and off, and the word carries a pause or a block, which the switch cannot. */
export function queueWord(queue: TaskHomeBoard["queue"]): QueueWord {
  if (queue.status === "blocked") return { text: queue.blockedBy ? `Blocked by ${queue.blockedBy}` : "Blocked", tone: "blocked" };
  if (queue.status === "paused") return { text: "Paused", tone: "paused" };
  return queue.status === "running" ? { text: "Queue on", tone: "on" } : { text: "Queue off", tone: "off" };
}

/** The switch is on in every status but off. Pressing it while paused asks the queue to try again. */
export const queueIsOn = (status: TaskQueueStatus) => status !== "idle";

/**
 * The line at the foot of a board card, in words made only of its counts and its queue: what runs, what stops the queue, what waits
 * for review, and what is ready. It names no task, because the Tasks home carries no title or ID of a task that is running.
 */
export function movingLine(board: Pick<TaskHomeBoard, "counts" | "queue">): { moving: boolean; text: string } {
  const [, ready = 0, running = 0, review = 0] = board.counts;
  const parts = [running > 0 ? `${running} in progress` : "Nothing running"];
  if (board.queue.status === "blocked") parts.push(board.queue.blockedBy ? `Queue blocked by ${board.queue.blockedBy}` : "Queue blocked");
  else if (board.queue.status === "paused") parts.push(board.queue.pauseReason ? `Queue paused: ${PAUSE_WORDS[board.queue.pauseReason]}` : "Queue paused");
  if (review > 0) parts.push(`${review} in review`);
  if (running === 0 && ready > 0 && (board.queue.status === "idle" || board.queue.status === "running")) parts.push(`${ready} ready to start`);
  return { moving: running > 0, text: parts.join(" · ") };
}

export type OverviewCard = { repository: Repository; board: TaskHomeBoard };
export type OverviewQuiet = { repository: Repository; unavailable: boolean };

/**
 * A repository with tasks gets a card, newest change first, and the others keep the inventory's order. A repository with no stored board, a board
 * with no task, and a board that is unavailable get a compact row. An unavailable board never reads a count.
 */
export function splitOverviewBoards(home: Pick<TaskHome, "boards">, repositories: readonly Repository[]): { cards: OverviewCard[]; quiet: OverviewQuiet[] } {
  const boards = new Map(home.boards.map((board) => [board.repositoryId, board]));
  const cards: OverviewCard[] = [];
  const quiet: OverviewQuiet[] = [];
  for (const repository of repositories) {
    const board = boards.get(repository.id);
    if (board?.readiness === "unavailable") quiet.push({ repository, unavailable: true });
    else if (board && sum(board.counts) > 0) cards.push({ repository, board });
    else quiet.push({ repository, unavailable: false });
  }
  const changed = ({ board }: OverviewCard) => Date.parse(board.updatedAt ?? "") || 0;
  return { cards: cards.sort((left, right) => changed(right) - changed(left)), quiet };
}

/** The detail under a board's name: how many features are open. */
export function boardDetail(board: Pick<TaskHomeBoard, "openFeatures">): string {
  return board.openFeatures > 0 ? `${board.openFeatures} open ${board.openFeatures === 1 ? "feature" : "features"}` : "No open feature";
}
