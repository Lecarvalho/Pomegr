import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTaskReference } from "../../shared/session-catalog-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));

import { SessionTaskTab } from "../../app/components/dashboard/SessionTaskTab";
import { checkRows, completionSummary, outcomeChip, queueBlockedNote, taskBrief } from "../../app/components/tasks/session-task-model";

const repositoryId = "repo-0123456789abcdef01234567";
const boardHref = `/tasks?repository=${repositoryId}`;
const sessionId = "claude:this-session";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const reference: SessionTaskReference = { id: "T-14", repositoryId, state: null, featureId: "feat-1", feature: "Task board v1", step: 2 };

const mine = task(14, {
  text: "Add the complete_task and block_task tools.\nBind each call to the session.",
  featureId: "feat-1", step: 2, state: "queued",
  run: { provider: "claude", model: "opus", effort: "high" },
  completeWhen: { checks: ["pr_open", "tree_clean"], own: "Both tools validate their input." },
  session: { id: sessionId, title: "Wire the tools", state: "working", observedModel: "opus" },
});

const siblings = [
  task(12, { featureId: "feat-1", step: 1, state: "done", text: "Store and privacy rules" }),
  task(13, { featureId: "feat-1", step: 2, state: "needs_review", text: "Queue gate", session: { id: "claude:other", title: "Queue auto-advance", state: "idle", observedModel: null } }),
  task(15, { featureId: "feat-1", step: 3, state: "queued", text: "Run plan" }),
  task(16, { featureId: "feat-1", step: 4, text: "Fourth step" }),
  task(17, { featureId: "feat-1", step: 3, state: "done", text: "Parallel next" }),
];

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    version: 1, readiness: "ready", repositoryId, columns: [{ id: "col-1", name: "Backlog", position: 0 }],
    features: [{ id: "feat-1", name: "Task board v1", done: false }],
    tasks: [mine, ...siblings], queue: { status: "running", blockedBy: null, pauseReason: null, order: [] }, ...overrides,
  };
}

function setBoard(next: TaskBoard) {
  useTasks.mockReturnValue({ board: next, refresh: vi.fn() });
}

beforeEach(() => {
  vi.clearAllMocks();
  setBoard(board());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** jsdom lays nothing out, so a cut text is simulated: every clamped box reports more content than it shows. */
function overflowClampedText() {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(195);
}

const completePanel = () => screen.getByRole("region", { name: "Complete when" });
const runPanel = () => screen.getByRole("region", { name: "Run" });

describe("SessionTaskTab", () => {
  it("draws the task panel: heading, start line, board link and text, with no state chip", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(within(panel).getByRole("heading", { name: "Task T-14" })).toBeInTheDocument();
    expect(panel).toHaveTextContent("Started by Pomegr");
    expect(within(panel).getByRole("link", { name: "Open on board" })).toHaveAttribute("href", boardHref);
    expect(within(panel).getByRole("link", { name: "Open on board" })).toHaveClass("commandSecondaryAction");
    expect(panel.querySelector(".commandChip")).toBeNull();
    // The first line leads and the rest follows, both inside the well.
    const well = panel.querySelector(".sessionTaskWell") as HTMLElement;
    expect(well.querySelector(".sessionTaskLead")).toHaveTextContent("Add the complete_task and block_task tools.");
    expect(well.querySelector(".sessionTaskText")).toHaveTextContent("Bind each call to the session.");
  });

  it("leads with the first line only when more text follows it", () => {
    expect(taskBrief("One line")).toEqual({ lead: null, body: "One line" });
    expect(taskBrief("Title\n\nBody one\nBody two")).toEqual({ lead: "Title", body: "Body one\nBody two" });
    setBoard(board({ tasks: [{ ...mine, text: "One line" }, ...siblings] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(panel.querySelector(".sessionTaskLead")).toBeNull();
    expect(panel.querySelector(".sessionTaskText")).toHaveTextContent("One line");
  });

  it("draws no expander for a text that fits", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("cuts a long text and opens it with Show all", () => {
    overflowClampedText();
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    const toggle = within(panel).getByRole("button", { name: "Show all" });
    expect(toggle).toHaveClass("commandTextLink");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const clamp = panel.querySelector(".sessionTaskClamp") as HTMLElement;
    expect(toggle).toHaveAttribute("aria-controls", clamp.id);
    expect(clamp).toHaveClass("isClamped", "isCut");
    fireEvent.click(toggle);
    expect(within(panel).getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    expect(clamp).not.toHaveClass("isClamped");
    // The Definition of done has its own expander.
    expect(within(completePanel()).getByRole("button", { name: "Show all" })).toBeInTheDocument();
  });

  it("draws the run panel: planned and observed as labelled rows", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const terms = [...runPanel().querySelectorAll("dt")];
    expect(terms.map((term) => term.textContent)).toEqual(["Planned", "Observed"]);
    expect(terms.every((term) => term.classList.contains("sessionTaskEyebrow"))).toBe(true);
    expect([...runPanel().querySelectorAll("dd")].map((value) => value.textContent)).toEqual(["Claude Code · opus · high", "opusLatest recorded for the main agent"]);
  });

  it("shows one source line for a task promoted from a GitHub issue: Source, the #N chip, then GitHub issue", () => {
    setBoard(board({ tasks: [{ ...mine, source: { kind: "github_issue", number: 142 } }, ...siblings] }));
    const { container } = render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    const line = panel.querySelector(".sessionTaskSource") as HTMLElement;
    expect([...line.children].map((child) => child.textContent)).toEqual(["Source", "#142", "GitHub issue"]);
    expect(within(line).getByRole("img", { name: "GitHub issue #142" })).toHaveClass("commandChip", "taskIssueChip");
    expect(panel.querySelectorAll(".sessionTaskSource")).toHaveLength(1);
    // The line leads the body, before the task text, and no promote time is invented for it.
    const text = panel.querySelector(".sessionTaskText") as HTMLElement;
    expect(line.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.textContent).not.toMatch(/promoted|\d{4}/i);
    expect(container.querySelector("a[href*='github'], .sessionTaskSource a, .sessionTaskSource button")).toBeNull();
  });

  it("shows no source line for a task with no source, an older monitor's task, or a reduced form", () => {
    const older = { ...mine } as Partial<Task>;
    delete older.source;
    for (const tasks of [[mine, ...siblings], [older as Task, ...siblings]]) {
      setBoard(board({ tasks }));
      const { unmount } = render(<SessionTaskTab task={reference} sessionId={sessionId} />);
      expect(screen.getByRole("region", { name: "Task T-14" }).querySelector(".sessionTaskSource")).toBeNull();
      unmount();
    }
    setBoard(board({ readiness: "loading", tasks: [] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(document.querySelector(".sessionTaskSource")).toBeNull();
  });

  it("is read only: no form field, no IPC call, and no button but the text expanders", () => {
    const taskAction = vi.fn();
    const bridge = window as unknown as { pomegrDesktop?: unknown };
    bridge.pomegrDesktop = { taskAction };
    overflowClampedText();
    const { container } = render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(container.querySelector("input, textarea, select, form")).toBeNull();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.every((button) => button.classList.contains("sessionTaskToggle"))).toBe(true);
    for (const button of buttons) fireEvent.click(button);
    expect(taskAction).not.toHaveBeenCalled();
    bridge.pomegrDesktop = undefined;
  });

  it("shows the agent-judged condition as agent-reported, not yet reported, and every check waiting", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = completePanel();
    expect(panel).toHaveTextContent("Definition of done");
    expect(panel).toHaveTextContent("Both tools validate their input.");
    expect(panel).toHaveTextContent("Agent-reported. Not yet reported.");
    const rows = within(panel).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Pull request openWaiting for report", "Working tree cleanWaiting for report"]);
    // No outcome yet: no chip, since the session header shows the state.
    expect(panel.querySelector(".commandChip")).toBeNull();
    expect(panel.querySelector(".sessionTaskFeatureHead")).toHaveTextContent("Complete whenNot yet reported");
  });

  it("marks each check with a decorative glyph in the tone of its result", () => {
    const reported = { ...mine, state: "needs_review" as const, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: false }], blockReason: null } };
    setBoard(board({ tasks: [reported, ...siblings] }));
    render(<SessionTaskTab task={{ ...reference, state: "needs_review" }} sessionId={sessionId} />);
    const glyphs = [...completePanel().querySelectorAll(".sessionTaskCheck > svg")];
    expect(glyphs.map((glyph) => glyph.getAttribute("class"))).toEqual(["sessionTaskCheckGlyph is-passed", "sessionTaskCheckGlyph is-failed"]);
    expect(glyphs.every((glyph) => glyph.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("shows the outcome once, as a chip and a summary in the Complete when head", () => {
    const report = { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: false }], blockReason: null };
    setBoard(board({ tasks: [{ ...mine, state: "needs_review", report }, ...siblings] }));
    render(<SessionTaskTab task={{ ...reference, state: "needs_review" }} sessionId={sessionId} />);
    const head = completePanel().querySelector(".sessionTaskFeatureHead") as HTMLElement;
    expect(within(head).getByText("Needs review")).toHaveClass("commandChip", "warning");
    expect(head).toHaveTextContent("1 check did not pass");
    expect(screen.getByRole("region", { name: "Task T-14" }).querySelector(".commandChip")).toBeNull();
  });

  it("words the outcome summary for each state", () => {
    const passed = { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open" as const, passed: true }], blockReason: null };
    expect(outcomeChip(mine)).toBeNull();
    expect(completionSummary(mine)).toBe("Not yet reported");
    expect(completionSummary({ ...mine, state: "needs_review", report: passed })).toBe("Every check passed");
    expect(completionSummary({ ...mine, state: "needs_review", report: { ...passed, attention: "Look at this" } })).toBe("The agent asks for your attention");
    expect(completionSummary({ ...mine, state: "blocked", report: { ...passed, results: [], blockReason: "No remote" } })).toBe("The agent cannot continue");
    expect(completionSummary({ ...mine, state: "stalled" })).toBe("The session ended with no report");
    expect(outcomeChip({ ...mine, state: "done" })).toEqual({ label: "Done", tone: "neutral" });
    expect(completionSummary({ ...mine, state: "done" })).toBeNull();
  });

  it("omits the Definition of done when there is no own condition, and the checks when none are set", () => {
    setBoard(board({ tasks: [{ ...mine, completeWhen: { checks: [], own: null } }, ...siblings] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const panel = completePanel();
    expect(panel).not.toHaveTextContent("Definition of done");
    expect(within(panel).queryByRole("list")).not.toBeInTheDocument();
    expect(panel).toHaveTextContent("No check is set. The agent reports when the task is complete.");
  });

  it("shows each check result, the failed count outcome and a block reason as plain text", () => {
    const reported = { ...mine, state: "needs_review" as const, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: false }], blockReason: "Cannot reach the remote." } };
    setBoard(board({ tasks: [reported, ...siblings] }));
    render(<SessionTaskTab task={{ ...reference, state: "needs_review" }} sessionId={sessionId} />);
    const panel = completePanel();
    expect(within(panel).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Pull request openPassed", "Working tree cleanDid not pass"]);
    expect(panel).toHaveTextContent("Agent-reported. The agent reported it cannot continue.");
    // The block reason leads the task panel, above the task text.
    const taskPanel = screen.getByRole("region", { name: "Task T-14" });
    const reason = within(taskPanel).getByText("Cannot reach the remote.");
    expect(reason).toHaveClass("sessionTaskBlocked");
    expect(reason.compareDocumentPosition(taskPanel.querySelector(".sessionTaskWell") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels Validated with the user as agent-reported, with no pass or fail", () => {
    const completeWhen = { checks: ["pr_open" as const, "user_validated" as const], own: null };
    const reported = { ...mine, completeWhen, state: "needs_review" as const, report: { at: "2026-10-08T11:00:00.000Z", results: [{ check: "pr_open" as const, passed: true }], blockReason: null } };
    setBoard(board({ tasks: [reported, ...siblings] }));
    render(<SessionTaskTab task={{ ...reference, state: "needs_review" }} sessionId={sessionId} />);
    expect(within(completePanel()).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Pull request openPassed", "Validated with the userAgent-reported"]);
  });

  it("shows the monitor's reading of each check while the task waits for its report", () => {
    const session = { id: sessionId, title: null, state: "working", observedModel: null, checks: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: false }] };
    setBoard(board({ tasks: [{ ...mine, session }, ...siblings] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(within(completePanel()).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["Pull request openHolds now", "Working tree cleanNot yet"]);
  });

  it("keeps a reading out of a task that has an outcome or a report", () => {
    const session = { id: sessionId, title: null, state: "closed", observedModel: null, checks: [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: true }] };
    expect(checkRows({ ...mine, session, state: "stalled" }).map((row) => row.result)).toEqual(["No report", "No report"]);
    const report = { at: "2026-10-09T10:00:00.000Z", results: [{ check: "pr_open" as const, passed: false }], blockReason: null };
    expect(checkRows({ ...mine, session, state: "needs_review", report }).map((row) => row.result)).toEqual(["Did not pass", "Not checked"]);
  });

  it("tells a condition Pomegr could not verify from one that did not pass", () => {
    const at = "2026-10-09T10:00:00.000Z";
    const unverified = { at, results: [{ check: "pr_open" as const, passed: false, unavailable: true }, { check: "tree_clean" as const, passed: false, unavailable: true }], blockReason: null };
    const mixed = { at, results: [{ check: "pr_open" as const, passed: false }, { check: "tree_clean" as const, passed: false, unavailable: true }], blockReason: null };
    expect(checkRows({ ...mine, state: "needs_review", report: mixed }).map((row) => [row.result, row.tone])).toEqual([["Did not pass", "failed"], ["Not verified", "waiting"]]);
    expect(completionSummary({ ...mine, state: "needs_review", report: unverified })).toBe("2 checks not verified");
    expect(completionSummary({ ...mine, state: "needs_review", report: { ...unverified, results: unverified.results.slice(1) } })).toBe("1 check not verified");
    expect(completionSummary({ ...mine, state: "needs_review", report: mixed })).toBe("1 check did not pass, 1 not verified");
    setBoard(board({ tasks: [{ ...mine, state: "needs_review", report: mixed }, ...siblings] }));
    render(<SessionTaskTab task={{ ...reference, state: "needs_review" }} sessionId={sessionId} />);
    const [failed, unknown] = within(completePanel()).getAllByRole("listitem");
    expect(failed.querySelector(".sessionTaskCheckResult")).toHaveClass("is-failed");
    expect(unknown).toHaveTextContent("Working tree cleanNot verified");
    expect(unknown.querySelector(".sessionTaskCheckResult")).toHaveClass("is-waiting");
    expect(unknown.querySelector(".sessionTaskCheckResult")).not.toHaveClass("is-failed");
  });

  it("does not wait forever for a report that will not come", () => {
    expect(checkRows({ ...mine, state: "stalled" }).map((row) => row.result)).toEqual(["No report", "No report"]);
  });

  it("lists the feature with its progress, the same-step tasks and the next-step tasks", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const side = screen.getByRole("complementary", { name: "Feature" });
    expect(within(side).getByRole("link", { name: "Task board v1" })).toHaveAttribute("href", boardHref);
    expect(side).toHaveTextContent("2 of 6 done");
    expect(side).toHaveTextContent("Same step as this session");
    const sameStep = within(side).getAllByRole("list")[0];
    expect(within(sameStep).getAllByRole("listitem").map((row) => row.getAttribute("data-task-id"))).toEqual(["T-13"]);
    expect(within(sameStep).getByRole("link", { name: "Queue auto-advance" })).toHaveAttribute("href", "/sessions/claude-other");
    expect(within(sameStep).getByText("Needs review")).toHaveClass("commandChip");
    const next = within(side).getAllByRole("list")[1];
    expect(within(next).getAllByRole("listitem").map((row) => row.getAttribute("data-task-id"))).toEqual(["T-15", "T-17"]);
    expect(within(next).getByRole("link", { name: "Run plan" })).toHaveAttribute("href", boardHref);
    expect(within(next).getByText("Done")).toHaveClass("commandChip");
    expect(side.querySelector(".sessionTaskBlockedNote")).toBeNull();
  });

  it("crops a related task's title to two lines and keeps the whole title as its tooltip", () => {
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const title = within(screen.getByRole("complementary", { name: "Feature" })).getByRole("link", { name: "Run plan" });
    expect(title).toHaveClass("sessionTaskRowTitle");
    expect(title).toHaveAttribute("title", "Run plan");
    const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    expect(styles).toMatch(/\.sessionTaskRowTitle, \.sessionTaskRowTitle\.commandTextLink \{[^}]*overflow: hidden; display: -webkit-box[^}]*-webkit-line-clamp: 2; line-clamp: 2/);
  });

  it("explains a blocked queue under the Next rows", () => {
    setBoard(board({ queue: { status: "blocked", blockedBy: "T-12", pauseReason: null, order: [] } }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(screen.getByRole("complementary", { name: "Feature" })).toHaveTextContent("Queue blocked by T-12. T-15, T-17 will not start when this session completes.");
  });

  it("words the blocked note for the cases where this task is the blocker or already done", () => {
    const base = { task: mine, nextStep: [siblings[2]], queue: { blocked: true, by: "T-14" } };
    expect(queueBlockedNote(base)).toBe("This task blocks the queue. T-15 will not start until it is resolved.");
    expect(queueBlockedNote({ ...base, task: { ...mine, state: "done" }, queue: { blocked: true, by: "T-12" } })).toBe("Queue blocked by T-12. T-15 will not start until it is resolved.");
    expect(queueBlockedNote({ ...base, nextStep: [], queue: { blocked: true, by: "T-12" } })).toBe("Queue blocked by T-12.");
  });

  it("draws no feature panel for a task without a feature", () => {
    setBoard(board({ tasks: [{ ...mine, featureId: null, step: null }] }));
    render(<SessionTaskTab task={{ ...reference, featureId: null, feature: null, step: null }} sessionId={sessionId} />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("shows the Not set planned run, and no observed model before one is recorded", () => {
    setBoard(board({ tasks: [{ ...mine, run: { provider: null, model: null, effort: null }, session: { ...mine.session!, observedModel: null } }] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(runPanel()).toHaveTextContent("PlannedNot set");
    expect(runPanel()).toHaveTextContent("ObservedNot recorded yet");
  });

  it("flags an observed model that differs from the planned one", () => {
    setBoard(board({ tasks: [{ ...mine, session: { ...mine.session!, observedModel: "sonnet" } }] }));
    render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    const observed = runPanel().querySelectorAll("dd")[1];
    expect(observed).toHaveTextContent("sonnetLatest recorded for the main agent, differs from planned");
    expect(observed).toHaveClass("isDiffers");
  });

  it.each([
    ["desktop_only", "Task details are shown in the Pomegr desktop app or a browser on the same computer."],
    ["unavailable", "Pomegr could not read the task board."],
  ] as const)("reduces to the reference when the board is %s, with no task text", (readiness, sentence) => {
    setBoard(board({ readiness, tasks: [] }));
    render(<SessionTaskTab task={{ ...reference, state: "done" }} sessionId={sessionId} />);
    const panel = screen.getByRole("region", { name: "Task T-14" });
    expect(panel).toHaveTextContent(sentence);
    expect(panel).toHaveTextContent("Done");
    expect(panel).toHaveTextContent("Task board v1 · step 2");
    expect(screen.queryByRole("region", { name: "Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Complete when" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Open on board" })).toHaveAttribute("href", boardHref);
  });

  it("draws only the reference and no sentence while the board loads", () => {
    setBoard(board({ readiness: "loading", tasks: [] }));
    const { container } = render(<SessionTaskTab task={reference} sessionId={sessionId} />);
    expect(container.querySelector(".sessionTaskNote")).toBeNull();
    expect(container).toHaveTextContent("Task board v1 · step 2");
    expect(container).not.toHaveTextContent("Add the complete_task");
  });
});
