import { describe, expect, it } from "vitest";
import { homeSuggestions } from "../../app/components/agent-chat/agent-chat-presentation";
import { HOME_LOG_BOARDS, arilLine, greetingFor, logBoards, needsDetail, needsYou, suggestionFacts, type HomeLogReads } from "../../app/components/home/home-model";
import type { TaskLog } from "../../app/components/tasks/task-desktop";
import type { TaskHome, TaskHomeBoard } from "../../shared/task-contract";

// The fixed rules behind Home: no model, only numbers and fixed kinds in, fixed words out.
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const hoursAgo = (hours: number) => NOW - hours * 3_600_000;
const POMEGR = `repo-${"a".repeat(24)}`;
const CLAPLINE = `repo-${"b".repeat(24)}`;
const GONE = `repo-${"c".repeat(24)}`;
const NAMES = new Map([[POMEGR, "pomegr"], [CLAPLINE, "clapline"]]);

type Entry = TaskLog["entries"][number];
const entry = (id: number, task: string | null, kind: Entry["kind"], at: number): Entry => ({ id, task, kind, at, pullRequest: null });
const log = (...entries: Entry[]): TaskLog => ({ entries, more: false, arilCursor: 0 });

const board = (repositoryId: string, overrides: Partial<TaskHomeBoard> = {}): TaskHomeBoard => ({
  repositoryId, readiness: "ready", counts: [0, 0, 0, 0, 0], openFeatures: 0, queue: { status: "idle", blockedBy: null, pauseReason: null }, updatedAt: "2026-10-30T10:00:00.000Z", ...overrides,
});
const home = (overrides: Partial<TaskHome> = {}): TaskHome => ({ version: 1, readiness: "ready", boards: [board(POMEGR), board(CLAPLINE)], attention: [], attentionTotal: 0, ...overrides });

describe("greetingFor", () => {
  it("greets by the owner's local hour", () => {
    expect([4, 5, 11, 12, 17, 18, 23, 0].map(greetingFor)).toEqual(["Good evening", "Good morning", "Good morning", "Good afternoon", "Good afternoon", "Good evening", "Good evening", "Good evening"]);
  });
});

describe("the Aril line", () => {
  it("counts each task once for each event in the last 24 hours, in a fixed order, and leaves out an event with no count", () => {
    const reads: HomeLogReads = new Map([
      [POMEGR, log(
        entry(1, "T-1", "started", hoursAgo(20)), entry(2, "T-1", "grant_start", hoursAgo(19)), entry(3, "T-2", "started", hoursAgo(18)),
        entry(4, "T-1", "review", hoursAgo(10)), entry(5, "T-3", "grant_merge", hoursAgo(2)), entry(6, "T-3", "merged", hoursAgo(1)),
        entry(7, "T-9", "done", hoursAgo(25)), entry(8, "T-4", "checks_passed", hoursAgo(1)),
      )],
      // The same task number in another repository is another task.
      [CLAPLINE, log(entry(1, "T-1", "started", hoursAgo(3)), entry(2, "T-5", "grant_done", hoursAgo(1)))],
    ]);
    expect(arilLine(reads, NOW)).toBe("In the last 24 hours: 3 started, 1 reached Review, 1 merged, 1 marked Done.");
  });

  it("says that nothing was logged only when a log was read and holds no event in the window", () => {
    expect(arilLine(new Map([[POMEGR, log(entry(1, "T-1", "done", hoursAgo(30)))]]), NOW)).toBe("Nothing was logged in the last 24 hours.");
    expect(arilLine(new Map([[POMEGR, log()]]), NOW)).toBe("Nothing was logged in the last 24 hours.");
  });

  it("draws no line when no log could be read, and says so when only some could not", () => {
    expect(arilLine(new Map(), NOW)).toBeNull();
    expect(arilLine(new Map([[POMEGR, null]]), NOW)).toBeNull();
    expect(arilLine(new Map([[POMEGR, log(entry(1, "T-1", "review", hoursAgo(1)))], [CLAPLINE, null]]), NOW))
      .toBe("In the last 24 hours: 1 reached Review. Some logs could not be read.");
  });

  it("ignores an entry with no task, such as a usage pause", () => {
    expect(arilLine(new Map([[POMEGR, log(entry(1, null, "grant_usage_hold", hoursAgo(1)))]]), NOW)).toBe("Nothing was logged in the last 24 hours.");
  });
});

describe("the detail of a Needs review task", () => {
  it("is the newest CI, review, or merge result after the task's newest review entry", () => {
    const entries = [
      entry(1, "T-1", "review", hoursAgo(9)), entry(2, "T-1", "checks_failed", hoursAgo(8)), entry(3, "T-1", "sent_back", hoursAgo(7)),
      entry(4, "T-1", "review", hoursAgo(6)), entry(5, "T-1", "checks_passed", hoursAgo(5)), entry(6, "T-1", "review_failed", hoursAgo(4)),
      entry(7, "T-2", "review", hoursAgo(4)), entry(8, "T-2", "grant_merge_refused", hoursAgo(3)),
    ];
    // Ids, not array order, decide which entry is newest.
    expect(needsDetail(log(...entries.reverse()), "T-1")).toEqual({ words: "Review failed", urgent: true });
    expect(needsDetail(log(...entries), "T-2")).toEqual({ words: "Merge refused", urgent: true });
  });

  it("names a passed result and a merge in muted words, and an old result before the latest report does not count", () => {
    expect(needsDetail(log(entry(1, "T-1", "review", 1), entry(2, "T-1", "checks_passed", 2)), "T-1")).toEqual({ words: "CI passed", urgent: false });
    expect(needsDetail(log(entry(1, "T-1", "review", 1), entry(2, "T-1", "review_passed", 2)), "T-1")).toEqual({ words: "Review passed", urgent: false });
    expect(needsDetail(log(entry(1, "T-1", "review", 1), entry(2, "T-1", "grant_merge", 2)), "T-1")).toEqual({ words: "Merged", urgent: false });
    expect(needsDetail(log(entry(1, "T-1", "checks_failed", 1), entry(2, "T-1", "review", 2)), "T-1")).toBeNull();
  });

  it("is null for a task with no review entry or with only other entries after it", () => {
    expect(needsDetail(log(entry(1, "T-1", "checks_failed", 1)), "T-1")).toBeNull();
    expect(needsDetail(log(entry(1, "T-1", "review", 1), entry(2, "T-1", "assigned", 2)), "T-1")).toBeNull();
    expect(needsDetail(log(entry(1, "T-2", "review", 1), entry(2, "T-2", "checks_failed", 2)), "T-1")).toBeNull();
  });
});

describe("Needs you", () => {
  it("lists paused queues first, then the tasks the Tasks home serves, with fixed words for the reason", () => {
    const served = home({
      boards: [board(POMEGR), board(CLAPLINE, { queue: { status: "paused", blockedBy: null, pauseReason: "cli_missing" } })],
      attention: [
        { repositoryId: POMEGR, taskId: "T-41", title: "Retry the upload", state: "needs_review" },
        { repositoryId: POMEGR, taskId: "T-35", title: "Cut the work into tasks", state: "stalled" },
        { repositoryId: CLAPLINE, taskId: "T-9", title: "Rename the export", state: "blocked" },
      ],
      attentionTotal: 3,
    });
    const logs: HomeLogReads = new Map([[POMEGR, log(entry(1, "T-41", "review", 1), entry(2, "T-41", "checks_failed", 2), entry(3, "T-35", "checks_failed", 3))]]);
    const { items, total } = needsYou(served, NAMES, logs);
    expect(total).toBe(4);
    expect(items.map((item) => (item.kind === "queue" ? `queue ${item.repositoryName}: ${item.reason}` : `${item.taskId} ${item.state} ${item.detail?.words ?? "-"}`)))
      .toEqual(["queue clapline: CLI not found", "T-41 needs_review CI failed", "T-35 stalled -", "T-9 blocked -"]);
  });

  it("words each pause reason, and a queue that is not paused is not an item", () => {
    const reasons = ["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked", "worktree_dirty", "environment_invalid"] as const;
    const served = home({ boards: reasons.map((reason, index) => board(`repo-${String(index).repeat(24)}`, { queue: { status: "paused", blockedBy: null, pauseReason: reason } })) });
    const names = new Map(served.boards.map((entry, index) => [entry.repositoryId, `r${index}`]));
    expect(needsYou(served, names, new Map()).items.map((item) => (item.kind === "queue" ? item.reason : ""))).toEqual([
      "CLI not found", "Plugin missing", "Windows only", "A start failed", "Session not linked", "Worktree has changes", "Environment invalid",
    ]);
    const noReason = home({ boards: [board(POMEGR, { queue: { status: "paused", blockedBy: null, pauseReason: null } })] });
    expect(needsYou(noReason, NAMES, new Map()).items.map((item) => (item.kind === "queue" ? item.reason : ""))).toEqual(["Paused"]);
    const running = home({ boards: [
      board(POMEGR, { queue: { status: "running", blockedBy: null, pauseReason: null } }),
      board(CLAPLINE, { queue: { status: "blocked", blockedBy: "T-3", pauseReason: null } }),
    ] });
    expect(needsYou(running, NAMES, new Map())).toEqual({ items: [], total: 0 });
  });

  it("leaves out the items of a repository the inventory no longer lists, and takes them out of the count", () => {
    const served = home({
      attention: [
        { repositoryId: GONE, taskId: "T-1", title: "Gone", state: "stalled" },
        { repositoryId: POMEGR, taskId: "T-2", title: "Kept", state: "blocked" },
      ],
      attentionTotal: 61,
    });
    const { items, total } = needsYou(served, NAMES, new Map());
    expect(items).toHaveLength(1);
    // The monitor serves at most 50 and counts them all: 61 tasks wait, and one of the served 50 is not listed.
    expect(total).toBe(60);
  });

  it("adds a detail only to a Needs review task, and only where its log was read", () => {
    const served = home({ attention: [
      { repositoryId: POMEGR, taskId: "T-1", title: "A", state: "needs_review" },
      { repositoryId: CLAPLINE, taskId: "T-2", title: "B", state: "needs_review" },
      { repositoryId: POMEGR, taskId: "T-3", title: "C", state: "blocked" },
    ], attentionTotal: 3 });
    const logs: HomeLogReads = new Map([[POMEGR, log(entry(1, "T-1", "review", 1), entry(2, "T-1", "review_passed", 2), entry(3, "T-3", "review", 1), entry(4, "T-3", "checks_failed", 2))], [CLAPLINE, null]]);
    expect(needsYou(served, NAMES, logs).items.map((item) => (item.kind === "task" ? item.detail?.words ?? null : "queue"))).toEqual(["Review passed", null, null]);
  });
});

describe("the boards whose logs Home reads", () => {
  it("are the ones that changed last, at most twelve, and none until the Tasks home is ready", () => {
    const boards = Array.from({ length: 15 }, (_, index) => board(`repo-${String(index % 10).repeat(23)}${index < 10 ? "0" : "1"}`, { updatedAt: new Date(NOW - index * 60_000).toISOString() }));
    const ids = logBoards(home({ boards }));
    expect(ids).toHaveLength(HOME_LOG_BOARDS);
    expect(ids[0]).toBe(boards[0].repositoryId);
    expect(ids.at(-1)).toBe(boards[11].repositoryId);
    expect(logBoards(home({ readiness: "loading", boards }))).toEqual([]);
    expect(logBoards(home({ boards: [board(POMEGR, { readiness: "unavailable" }), board(CLAPLINE, { updatedAt: null })] }))).toEqual([CLAPLINE]);
  });
});

describe("the suggestion chips", () => {
  it("are the first three of a fixed list whose condition holds", () => {
    expect(homeSuggestions({ attention: true, work: true })).toEqual(["What needs my attention first?", "Which task should run first, and why?", "Is any task too big for one session?"]);
    expect(homeSuggestions({ attention: false, work: true })).toEqual(["Which task should run first, and why?", "Is any task too big for one session?", "Break this feature into tasks: "]);
    expect(homeSuggestions({ attention: false, work: false })).toEqual(["Break this feature into tasks: ", "Which model fits this kind of task: "]);
  });

  it("read the counts of Backlog, Ready, and In progress, and whether anything needs the owner", () => {
    expect(suggestionFacts(home({ boards: [board(POMEGR, { counts: [0, 0, 0, 4, 9] })] }), 0)).toEqual({ attention: false, work: false });
    expect(suggestionFacts(home({ boards: [board(POMEGR, { counts: [0, 2, 0, 0, 0] })] }), 2)).toEqual({ attention: true, work: true });
    expect(suggestionFacts(home({ boards: [board(POMEGR, { readiness: "unavailable", counts: [] })] }), 0)).toEqual({ attention: false, work: false });
  });
});
