import { describe, expect, it } from "vitest";
import type { RepositorySummary } from "../../shared/monitor-contract";
import type { TaskHomeBoard } from "../../shared/task-contract";
import { FLOW_MIN_PERCENT, STAGES, boardDetail, flowSegments, movingLine, overviewTotals, queueIsOn, queueWord, splitOverviewBoards } from "../../app/components/tasks/tasks-overview-model";

const idOf = (letter: string) => `repo-${letter.repeat(24)}`;
const repository = (letter: string, displayName = letter): RepositorySummary => ({
  id: idOf(letter), name: displayName, displayName, sessionCount: 1, liveCount: 0, historyCount: 1, providerCount: 1, updatedAt: null, providers: [],
});
const board = (letter: string, counts: number[], overrides: Partial<TaskHomeBoard> = {}): TaskHomeBoard => ({
  repositoryId: idOf(letter), readiness: "ready", counts, openFeatures: 0, queue: { status: "idle", blockedBy: null, pauseReason: null }, updatedAt: null, ...overrides,
});
const unavailable = (letter: string): TaskHomeBoard => board(letter, [], { readiness: "unavailable" });

describe("overview totals", () => {
  const known = new Set([idOf("a"), idOf("b"), idOf("c")]);

  it("sums open as every task that is not Done, in review as the Review column, and done as the Done column", () => {
    expect(overviewTotals({ boards: [board("a", [243, 0, 1, 2, 122]), board("b", [38, 1, 0, 0, 153])] }, known)).toEqual({ open: 285, review: 2, done: 275, unavailable: 0 });
  });

  it("adds no count for a board that is unavailable or that the inventory does not list, and counts the first apart", () => {
    expect(overviewTotals({ boards: [board("a", [1, 1, 1, 1, 1]), unavailable("b"), board("z", [9, 9, 9, 9, 9])] }, known)).toEqual({ open: 4, review: 1, done: 1, unavailable: 1 });
  });

  it("is zero for no board", () => {
    expect(overviewTotals({ boards: [] }, known)).toEqual({ open: 0, review: 0, done: 0, unavailable: 0 });
  });
});

describe("the flow bar", () => {
  it("has the five stages in board order", () => {
    expect(STAGES.map((stage) => stage.name)).toEqual(["Backlog", "Ready", "In progress", "Review", "Done"]);
    expect(STAGES.map((stage) => stage.tone)).toEqual(["backlog", "ready", "progress", "review", "done"]);
  });

  it("sizes each stage by its share and leaves a stage with no task out", () => {
    expect(flowSegments([50, 0, 25, 0, 25]).map(({ stage, width }) => [stage, width])).toEqual([["Backlog", "50.0%"], ["In progress", "25.0%"], ["Done", "25.0%"]]);
    expect(flowSegments([1, 1, 1, 1, 1]).map(({ width }) => width)).toEqual(["20.0%", "20.0%", "20.0%", "20.0%", "20.0%"]);
  });

  it("keeps a stage that holds a task visible, at no less than the minimum", () => {
    const segments = flowSegments([1000, 0, 1, 0, 0]);
    expect(FLOW_MIN_PERCENT).toBe(1.5);
    expect(segments.map(({ width }) => width)).toEqual(["99.9%", "1.5%"]);
  });

  it("draws nothing for a board with no task", () => {
    expect(flowSegments([0, 0, 0, 0, 0])).toEqual([]);
    expect(flowSegments([])).toEqual([]);
  });
});

describe("which boards get a card", () => {
  const repositories = [repository("a", "Alpha"), repository("b", "Beta"), repository("c", "Gamma"), repository("d", "Delta"), repository("e", "Epsilon")];

  it("gives a card to each board with a task, newest change first, and a compact row to every other repository in inventory order", () => {
    const { cards, quiet } = splitOverviewBoards({ boards: [
      board("a", [1, 0, 0, 0, 0], { updatedAt: "2026-10-10T10:00:00.000Z" }),
      board("b", [0, 0, 0, 0, 0]),
      board("c", [0, 0, 0, 0, 3], { updatedAt: "2026-10-12T10:00:00.000Z" }),
      unavailable("d"),
    ] }, repositories);
    expect(cards.map(({ repository: entry }) => entry.displayName)).toEqual(["Gamma", "Alpha"]);
    expect(quiet.map(({ repository: entry, unavailable: flag }) => [entry.displayName, flag])).toEqual([["Beta", false], ["Delta", true], ["Epsilon", false]]);
  });

  it("keeps the inventory order among boards that changed at the same time or never", () => {
    const { cards } = splitOverviewBoards({ boards: [board("b", [1, 0, 0, 0, 0]), board("a", [1, 0, 0, 0, 0])] }, repositories);
    expect(cards.map(({ repository: entry }) => entry.displayName)).toEqual(["Alpha", "Beta"]);
  });

  it("words the open features", () => {
    expect(boardDetail({ openFeatures: 0 })).toBe("No open feature");
    expect(boardDetail({ openFeatures: 1 })).toBe("1 open feature");
    expect(boardDetail({ openFeatures: 21 })).toBe("21 open features");
  });
});

describe("the queue in words", () => {
  it("names a block or a pause and otherwise says on or off", () => {
    expect(queueWord({ status: "running", blockedBy: null, pauseReason: null })).toEqual({ text: "Queue on", tone: "on" });
    expect(queueWord({ status: "idle", blockedBy: null, pauseReason: null })).toEqual({ text: "Queue off", tone: "off" });
    expect(queueWord({ status: "paused", blockedBy: null, pauseReason: "start_failed" })).toEqual({ text: "Paused", tone: "paused" });
    expect(queueWord({ status: "blocked", blockedBy: "T-12", pauseReason: null })).toEqual({ text: "Blocked by T-12", tone: "blocked" });
    expect(queueWord({ status: "blocked", blockedBy: null, pauseReason: null })).toEqual({ text: "Blocked", tone: "blocked" });
  });

  it("reads the switch as on in every status but idle", () => {
    expect(["idle", "running", "blocked", "paused"].map((status) => queueIsOn(status as TaskHomeBoard["queue"]["status"]))).toEqual([false, true, true, true]);
  });
});

describe("the moving line", () => {
  const idle = { status: "idle", blockedBy: null, pauseReason: null } as const;

  it("says what runs, what waits for review, and what is ready, and pulses only for a running task", () => {
    expect(movingLine({ counts: [3, 2, 1, 4, 5], queue: idle })).toEqual({ moving: true, text: "1 in progress · 4 in review" });
    expect(movingLine({ counts: [3, 2, 0, 4, 5], queue: idle })).toEqual({ moving: false, text: "Nothing running · 4 in review · 2 ready to start" });
    expect(movingLine({ counts: [3, 0, 0, 0, 5], queue: idle })).toEqual({ moving: false, text: "Nothing running" });
  });

  it("names the block or the pause, and offers no ready count while the queue is held", () => {
    expect(movingLine({ counts: [0, 2, 0, 0, 0], queue: { status: "blocked", blockedBy: "T-9", pauseReason: null } }).text).toBe("Nothing running · Queue blocked by T-9");
    expect(movingLine({ counts: [0, 2, 0, 0, 0], queue: { status: "blocked", blockedBy: null, pauseReason: null } }).text).toBe("Nothing running · Queue blocked");
    expect(movingLine({ counts: [0, 2, 0, 0, 0], queue: { status: "paused", blockedBy: null, pauseReason: "cli_missing" } }).text).toBe("Nothing running · Queue paused: CLI not found");
    expect(movingLine({ counts: [0, 2, 0, 0, 0], queue: { status: "paused", blockedBy: null, pauseReason: null } }).text).toBe("Nothing running · Queue paused");
  });

  it("names no task, because the Tasks home carries none that is running", () => {
    const line = movingLine({ counts: [3, 2, 2, 4, 5], queue: { status: "blocked", blockedBy: "T-9", pauseReason: null } });
    expect(line.text.match(/T-\d+/g)).toEqual(["T-9"]);
  });
});
