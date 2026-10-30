import { describe, expect, it } from "vitest";
import { homeSuggestions } from "../../app/components/agent-chat/agent-chat-presentation";
import { HOME_LOG_BOARDS, arilLine, greetingFor, isWaiting, isWorking, logBoards, needsDetail, needsYou, runningSessions, updatedAgo, suggestionFacts, type HomeLogReads, type NeedsLine } from "../../app/components/home/home-model";
import type { TaskLog } from "../../app/components/tasks/task-desktop";
import type { SessionSummary } from "../../shared/monitor-contract";
import type { TaskBoard, TaskHome, TaskHomeBoard } from "../../shared/task-contract";

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

const session = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id, provider: "claude", source: "Claude Code", title: `Session ${id}`, project: "Some project", createdAt: new Date(NOW - 12 * 60_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(),
  isLive: true, needsInput: false, activityStatus: "working", summaryReadiness: "ready", agentCount: 1, activeAgentCount: 1, latestContextTotal: null, progress: null, currentActivity: null, repositoryId: POMEGR, ...overrides,
});
const needs = (served: TaskHome, logs: HomeLogReads = new Map(), sessions: SessionSummary[] = []) => needsYou({ home: served, names: NAMES, logs, sessions });
const words = (lines: NeedsLine[]) => lines.map((line) => `${line.action}${line.detail ? ` [${line.detail.words}${line.detail.urgent ? ", amber" : ""}]` : ""} | ${line.repository}`);

describe("Needs you", () => {
  it("is one line for each thing to do, grouped by kind and repository and phrased as the action, in a fixed order", () => {
    const served = home({
      boards: [board(POMEGR), board(CLAPLINE, { queue: { status: "paused", blockedBy: null, pauseReason: "cli_missing" } })],
      attention: [
        { repositoryId: POMEGR, taskId: "T-41", title: "Retry the upload", state: "needs_review" },
        { repositoryId: CLAPLINE, taskId: "T-12", title: "Move the settings page", state: "needs_review" },
        { repositoryId: CLAPLINE, taskId: "T-13", title: "Rename the export", state: "needs_review" },
        { repositoryId: POMEGR, taskId: "T-35", title: "Cut the work into tasks", state: "stalled" },
        { repositoryId: POMEGR, taskId: "T-36", title: "Cut the other work", state: "stalled" },
        { repositoryId: CLAPLINE, taskId: "T-9", title: "Rename the thing", state: "blocked" },
      ],
      attentionTotal: 6,
    });
    const logs: HomeLogReads = new Map([[POMEGR, log(entry(1, "T-41", "review", 1), entry(2, "T-41", "checks_failed", 2))]]);
    const { lines, total } = needs(served, logs, [session("claude:one", { repositoryId: CLAPLINE, activityStatus: "needs_input", needsInput: true })]);
    expect(total).toBe(lines.length);
    expect(words(lines)).toEqual([
      "Answer a session that is waiting for you | clapline",
      "Review 2 finished tasks | clapline",
      "Review 1 finished task [CI failed, amber] | pomegr",
      "Check 2 stalled tasks | pomegr",
      "Unblock 1 task | clapline",
      "Restart the paused queue [CLI not found, amber] | clapline",
    ]);
    // A line names no task and no title, and links to the board of its repository, or to the session.
    expect(JSON.stringify(lines)).not.toMatch(/T-\d|Retry the upload|Move the settings|Cut the/);
    expect(lines.map((line) => line.href)).toEqual(["/sessions/claude-one", `/tasks?repository=${CLAPLINE}`, `/tasks?repository=${POMEGR}`, `/tasks?repository=${POMEGR}`, `/tasks?repository=${CLAPLINE}`, `/tasks?repository=${CLAPLINE}`]);
  });

  it("puts a failure in its own line and joins a passed result, or none, to the plain line of its repository", () => {
    const served = home({ attention: [
      { repositoryId: POMEGR, taskId: "T-1", title: "A", state: "needs_review" },
      { repositoryId: POMEGR, taskId: "T-2", title: "B", state: "needs_review" },
      { repositoryId: POMEGR, taskId: "T-3", title: "C", state: "needs_review" },
      { repositoryId: POMEGR, taskId: "T-4", title: "D", state: "needs_review" },
      { repositoryId: POMEGR, taskId: "T-5", title: "E", state: "needs_review" },
    ], attentionTotal: 5 });
    const logs: HomeLogReads = new Map([[POMEGR, log(
      entry(1, "T-1", "review", 1), entry(2, "T-1", "checks_failed", 2), entry(3, "T-2", "review", 1), entry(4, "T-2", "review_passed", 2),
      entry(5, "T-3", "review", 1), entry(6, "T-3", "grant_merge_refused", 2), entry(7, "T-4", "review", 1), entry(8, "T-4", "merged", 2),
    )]]);
    expect(words(needs(served, logs).lines)).toEqual(["Review 3 finished tasks | pomegr", "Review 1 finished task [CI failed, amber] | pomegr", "Review 1 finished task [Merge refused, amber] | pomegr"]);
  });

  it("uses amber only for a failure: a failed check, a failed review, a refused merge, and the reason a queue is paused", () => {
    const reasons = ["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked", "worktree_dirty", "environment_invalid"] as const;
    const served = home({ boards: reasons.map((reason, index) => board(`repo-${String(index).repeat(24)}`, { queue: { status: "paused", blockedBy: null, pauseReason: reason } })) });
    const names = new Map(served.boards.map((entry, index) => [entry.repositoryId, `r${index}`]));
    const queues = needsYou({ home: served, names, logs: new Map(), sessions: [] }).lines;
    expect(queues.map((line) => line.detail)).toEqual([
      "CLI not found", "Plugin missing", "Windows only", "A start failed", "Session not linked", "Worktree has changes", "Environment invalid",
    ].map((words) => ({ words, urgent: true })));
    expect(queues.every((line) => line.action === "Restart the paused queue")).toBe(true);
    const noReason = home({ boards: [board(POMEGR, { queue: { status: "paused", blockedBy: null, pauseReason: null } })] });
    expect(words(needs(noReason).lines)).toEqual(["Restart the paused queue [Paused, amber] | pomegr"]);
    // No other line has a detail, so no other line is amber.
    const others = needs(home({ attention: [{ repositoryId: POMEGR, taskId: "T-1", title: "A", state: "needs_review" }, { repositoryId: POMEGR, taskId: "T-2", title: "B", state: "stalled" }, { repositoryId: POMEGR, taskId: "T-3", title: "C", state: "blocked" }], attentionTotal: 3 }),
      new Map([[POMEGR, log(entry(1, "T-1", "review", 1), entry(2, "T-1", "checks_passed", 2))]]), [session("claude:w", { needsInput: true })]).lines;
    expect(others.map((line) => line.detail)).toEqual([null, null, null, null]);
  });

  it("is nothing when nothing waits: a running queue, a blocked queue, a session that works or idles, and a task in a quiet state are no lines", () => {
    const running = home({ boards: [
      board(POMEGR, { queue: { status: "running", blockedBy: null, pauseReason: null } }),
      board(CLAPLINE, { queue: { status: "blocked", blockedBy: "T-3", pauseReason: null } }),
    ] });
    const quiet = [session("claude:a"), session("claude:b", { activityStatus: "idle" }), session("claude:c", { activityStatus: "open" }), session("claude:d", { isLive: false, needsInput: true, activityStatus: "needs_input" })];
    expect(needs(running, new Map(), quiet)).toEqual({ lines: [], total: 0 });
  });

  it("groups the sessions that wait by repository, with one link to the session or to the repository's sessions", () => {
    const waiting = (id: string, repositoryId: string | null, project = "Some project") => session(id, { repositoryId, project, needsInput: true, activityStatus: "needs_input" });
    const { lines } = needs(home(), new Map(), [waiting("claude:a", POMEGR), waiting("codex:b", POMEGR), waiting("claude:c", CLAPLINE), waiting("claude:d", null, "Loose project")]);
    expect(words(lines)).toEqual([
      "Answer 2 sessions that are waiting for you | pomegr", "Answer a session that is waiting for you | clapline", "Answer a session that is waiting for you | Loose project",
    ]);
    expect(lines.map((line) => line.href)).toEqual([`/sessions?repository=${POMEGR}`, "/sessions/claude-c", "/sessions/claude-d"]);
  });

  it("leaves out the tasks of a repository the inventory no longer lists", () => {
    const served = home({ attention: [{ repositoryId: GONE, taskId: "T-1", title: "Gone", state: "stalled" }, { repositoryId: POMEGR, taskId: "T-2", title: "Kept", state: "blocked" }], attentionTotal: 2, boards: [board(GONE, { queue: { status: "paused", blockedBy: null, pauseReason: "cli_missing" } })] });
    expect(words(needs(served).lines)).toEqual(["Unblock 1 task | pomegr"]);
  });

  it("adds a failure detail only where the log of the task's repository was read", () => {
    const served = home({ attention: [{ repositoryId: POMEGR, taskId: "T-1", title: "A", state: "needs_review" }, { repositoryId: CLAPLINE, taskId: "T-2", title: "B", state: "needs_review" }], attentionTotal: 2 });
    const logs: HomeLogReads = new Map([[POMEGR, log(entry(1, "T-1", "review", 1), entry(2, "T-1", "review_failed", 2))], [CLAPLINE, null]]);
    expect(words(needs(served, logs).lines)).toEqual(["Review 1 finished task | clapline", "Review 1 finished task [Review failed, amber] | pomegr"]);
  });
});

describe("the running sessions", () => {
  const board = (repositoryId: string, tasks: { id: string; text: string; session?: string; assigned?: string[] }[], readiness: TaskBoard["readiness"] = "ready") => ({
    version: 1, readiness, repositoryId, columns: [], features: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] },
    tasks: tasks.map((task) => ({ id: task.id, text: task.text, session: task.session ? { id: task.session, title: null, state: "working", observedModel: null, observedEffort: null } : null, ...(task.assigned ? { assigned: task.assigned.map((id) => ({ id, title: null, state: "working", observedModel: null, observedEffort: null })) } : {}) })),
  }) as unknown as TaskBoard;
  const boards = (...entries: TaskBoard[]): ReadonlyMap<string, TaskBoard> => new Map(entries.map((entry) => [entry.repositoryId, entry]));

  it("are the live sessions that work or wait, a waiting one first, at most four, with the total counted", () => {
    const sessions = [
      session("claude:idle", { activityStatus: "idle" }), session("claude:open", { activityStatus: "open" }), session("claude:old", { isLive: false }),
      session("claude:a", { updatedAt: new Date(NOW - 10 * 60_000).toISOString() }), session("claude:b", { updatedAt: new Date(NOW - 5 * 60_000).toISOString() }),
      session("claude:c", { updatedAt: new Date(NOW - 1 * 60_000).toISOString() }), session("claude:d", { updatedAt: new Date(NOW - 20 * 60_000).toISOString() }),
      session("codex:waiting", { provider: "codex", source: "Codex", activityStatus: "needs_input", needsInput: true, updatedAt: new Date(NOW - 30 * 60_000).toISOString() }),
    ];
    const running = runningSessions(sessions, NAMES, boards(board(POMEGR, [])), NOW);
    expect(running.total).toBe(5);
    expect(running.shown.map((entry) => [entry.key, entry.waiting])).toEqual([["codex:waiting", true], ["claude:c", false], ["claude:b", false], ["claude:a", false]]);
  });

  it("show the title of the task a session was started for or assigned to, and a session's own title for any other, a review session included", () => {
    const sessions = [session("claude:started"), session("claude:assigned"), session("claude:review"), session("claude:none", { repositoryId: null })];
    const tasks = board(POMEGR, [
      { id: "T-1", text: "[ui] Build the new Home\nWith the details below.", session: "claude:started" },
      { id: "T-2", text: "Assigned work", assigned: ["claude:assigned"] },
    ]);
    const shown = runningSessions(sessions, NAMES, boards(tasks), NOW).shown;
    expect(Object.fromEntries(shown.map((entry) => [entry.key, entry.title]))).toEqual({
      "claude:started": "Build the new Home", "claude:assigned": "Assigned work", "claude:review": "Session claude:review", "claude:none": "Session claude:none",
    });
  });

  it("are not settled while a board a title comes from has not answered, so no title is drawn and then replaced", () => {
    const sessions = [session("claude:a"), session("claude:b", { repositoryId: CLAPLINE })];
    expect(runningSessions(sessions, NAMES, boards(board(POMEGR, [])), NOW).settled).toBe(false);
    expect(runningSessions(sessions, NAMES, boards(board(POMEGR, [], "loading"), board(CLAPLINE, [])), NOW).settled).toBe(false);
    expect(runningSessions(sessions, NAMES, boards(board(POMEGR, [], "desktop_only"), board(CLAPLINE, [], "unavailable")), NOW).settled).toBe(true);
    expect(runningSessions([session("claude:x", { repositoryId: null })], NAMES, boards(), NOW).settled).toBe(true);
  });

  it("describe where and when: the repository and when the session last changed, with no provider", () => {
    const [first] = runningSessions([session("claude:a", { updatedAt: new Date(NOW - 3 * 60_000).toISOString() })], NAMES, boards(board(POMEGR, [])), NOW).shown;
    expect(first.meta).toBe("pomegr · updated 3 min ago");
    const [project] = runningSessions([session("codex:b", { source: "Codex", repositoryId: null, project: "Loose project", updatedAt: "not a date" })], NAMES, boards(), NOW).shown;
    expect(project.meta).toBe("Loose project");
    expect(updatedAgo(new Date(NOW - 20_000).toISOString(), NOW)).toBe("updated just now");
    expect(updatedAgo(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe("updated 59 min ago");
    expect(updatedAgo(new Date(NOW - 135 * 60_000).toISOString(), NOW)).toBe("updated 2 h ago");
    expect(updatedAgo(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe("updated 2 d ago");
    expect(updatedAgo(null, NOW)).toBeNull();
    expect(updatedAgo("not a date", NOW)).toBeNull();
  });

  it("treat a session that needs input as waiting whichever field says so, and one that works as working", () => {
    expect([isWaiting(session("a", { needsInput: true })), isWaiting(session("b", { activityStatus: "needs_input" })), isWaiting(session("c")), isWaiting(session("d", { isLive: false, needsInput: true }))]).toEqual([true, true, false, false]);
    expect([isWorking(session("a")), isWorking(session("b", { needsInput: true })), isWorking(session("c", { activityStatus: "idle" }))]).toEqual([true, false, false]);
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
