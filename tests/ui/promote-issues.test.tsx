import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import { createEmptyTaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory = vi.hoisted(() => ({ snapshot: { revision: 1, readiness: "ready", repositories: [] } as RepositoryInventorySnapshot, loading: false }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory.snapshot, loading: inventory.loading, connected: true, refresh: vi.fn() }) }));

import { PromoteIssuesSection } from "../../app/components/design-system/DesignSystemPromoteIssuesSample";
import { IssueNotices } from "../../app/components/tasks/IssuePreview";
import { PromoteIssuesMissing, PromoteIssuesView } from "../../app/components/tasks/PromoteIssuesView";
import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { issueCountLine, issueDateLabel, keepSelection } from "../../app/components/tasks/promote-issues-model";
import type { TaskIssue } from "../../app/components/tasks/task-issues-desktop";

const repositoryId = "repo-0123456789abcdef01234567";
const DIGEST = "a".repeat(64);

type Answer = Record<string, unknown>;
const taskIssues = vi.fn<(repositoryId: string, operation: string, payload: Record<string, unknown>) => Promise<Answer>>();
const taskAction = vi.fn(async () => ({ ok: true }));

/** A bridge answer for one issue, shaped like the monitor's list entry. */
function entry(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = typeof overrides.body === "string" ? overrides.body : `Body of issue ${number}.`;
  return {
    number, title: `Issue ${number} title`, body, bodyTruncated: false, hiddenComments: { count: 0, ranges: [] }, characters: 100, tooLong: false,
    authorAssociation: "collaborator", updatedAt: "2026-10-08T12:00:00.000Z", digest: DIGEST, taskId: null, ...overrides,
  };
}

const list = (issues: Record<string, unknown>[], extra: Answer = {}): Answer => ({ ok: true, status: "ok", readAt: "2026-10-09T09:00:00.000Z", truncated: false, issues, ...extra });
const withStatus = (status: string): Answer => ({ ok: true, status, readAt: null, truncated: false, issues: [] });
const page = () => render(<PromoteIssuesView repositoryId={repositoryId} />);
const refreshButton = () => screen.getByRole("button", { name: "Refresh" });
const rows = () => within(screen.getByRole("list", { name: "Open issues" })).getAllByRole("button");
const detail = () => screen.getByRole("article");
const promote = () => screen.getByRole("button", { name: "Promote" });

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
  inventory.loading = false;
  inventory.snapshot = { revision: 1, readiness: "ready", repositories: [{
    id: repositoryId, name: "example", displayName: "Example project", sessionCount: 0, liveCount: 0, historyCount: 0, providerCount: 0, updatedAt: null, providers: [],
  }] };
  taskIssues.mockResolvedValue(list([entry(144), entry(139)]));
  // The page reads the committed board for the task modal's Feature field; it reads no GitHub issue for it.
  useTasks.mockReturnValue({ board: { ...createEmptyTaskBoard(repositoryId, "ready"), columns: [{ id: "col-1", name: "Backlog", position: 0 }] }, refresh: vi.fn(async () => {}) });
  setBridge({ taskAction, taskIssues });
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("without the desktop bridge", () => {
  it("says where issues are read, draws no Refresh, and reads nothing", () => {
    setBridge(undefined);
    page();
    expect(screen.getByRole("heading", { level: 1, name: "Promote issues" })).toBeInTheDocument();
    expect(screen.getByText("GitHub issues are read in the Pomegr desktop app.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.queryByText("Promoting copies the issue title and body into a task once. Later edits and comments are never read.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
    expect(taskIssues).not.toHaveBeenCalled();
  });

  it("treats a desktop build from before the issues bridge the same way", () => {
    setBridge({ taskAction });
    page();
    expect(screen.getByText("GitHub issues are read in the Pomegr desktop app.")).toBeInTheDocument();
    expect(taskIssues).not.toHaveBeenCalled();
  });

  it("draws nothing for the issues on the server pass", () => {
    expect(renderToString(<PromoteIssuesView repositoryId={repositoryId} />)).not.toMatch(/Refresh|desktop app|Reading open issues/);
  });
});

describe("reading", () => {
  it("reads once when the page opens and once per Refresh, and on no other trigger", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByRole("list", { name: "Open issues" });
    expect(taskIssues).toHaveBeenCalledTimes(1);
    expect(taskIssues).toHaveBeenCalledWith(repositoryId, "list", {});
    // No timer, focus or visibility event reads.
    act(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("online")); });
    expect(taskIssues).toHaveBeenCalledTimes(1);
    await user.click(refreshButton());
    await waitFor(() => expect(taskIssues).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refreshButton()).toBeEnabled());
    await user.click(refreshButton());
    await waitFor(() => expect(taskIssues).toHaveBeenCalledTimes(3));
    for (const call of taskIssues.mock.calls) expect(call).toEqual([repositoryId, "list", {}]);
  });

  it("sends one read when the page opens even where effects run twice", async () => {
    render(<StrictMode><PromoteIssuesView repositoryId={repositoryId} /></StrictMode>);
    await screen.findByRole("list", { name: "Open issues" });
    expect(taskIssues).toHaveBeenCalledTimes(1);
    expect(refreshButton()).toBeEnabled();
  });

  it("shows a loading state first, then keeps the last list on screen, busy and with Refresh disabled, during a refresh", async () => {
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    taskIssues.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    page();
    const section = screen.getByRole("region", { name: "Promote issues" });
    expect(section).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Reading open issues")).toBeInTheDocument();
    expect(refreshButton()).toBeDisabled();
    await act(async () => { first.resolve(list([entry(144), entry(139)])); await first.promise; });
    await screen.findByRole("list", { name: "Open issues" });
    expect(section).not.toHaveAttribute("aria-busy");
    expect(screen.queryByText("Reading open issues")).not.toBeInTheDocument();

    await user.click(refreshButton());
    expect(section).toHaveAttribute("aria-busy", "true");
    expect(refreshButton()).toBeDisabled();
    // The list stays; nothing is drawn and then withdrawn.
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText("Reading open issues")).not.toBeInTheDocument();
    await act(async () => { second.resolve(list([entry(144), entry(139), entry(120)])); await second.promise; });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(section).not.toHaveAttribute("aria-busy");
    expect(refreshButton()).toBeEnabled();
  });

  it("selects the first issue when the list arrives and keeps the chosen one across a refresh while it is listed", async () => {
    taskIssues.mockResolvedValueOnce(list([entry(144), entry(139), entry(120)]));
    const user = userEvent.setup();
    page();
    await screen.findByRole("list", { name: "Open issues" });
    expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(within(detail()).getByRole("heading", { level: 2, name: "Issue 144 title" })).toBeInTheDocument();
    await user.click(rows()[1]);
    expect(rows()[1]).toHaveAttribute("aria-pressed", "true");
    expect(within(detail()).getByRole("heading", { level: 2, name: "Issue 139 title" })).toBeInTheDocument();

    // A new first issue appears; the chosen one stays chosen by its number.
    taskIssues.mockResolvedValueOnce(list([entry(150), entry(144), entry(139)]));
    await user.click(refreshButton());
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(within(detail()).getByRole("heading", { level: 2, name: "Issue 139 title" })).toBeInTheDocument();

    // The chosen issue is gone: the first one is chosen.
    taskIssues.mockResolvedValueOnce(list([entry(150), entry(144)]));
    await user.click(refreshButton());
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  it("keeps the last list and says so when a refresh fails, with Refresh still enabled", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByRole("list", { name: "Open issues" });
    taskIssues.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    await user.click(refreshButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Pomegr could not refresh the issues. The list shown is from the last read.");
    expect(rows()).toHaveLength(2);
    expect(refreshButton()).toBeEnabled();
    taskIssues.mockResolvedValueOnce(list([entry(144), entry(139)]));
    await user.click(refreshButton());
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("states", () => {
  it("draws the count line with the repository name, and counts what is not promoted", async () => {
    taskIssues.mockResolvedValue(list([entry(144), entry(139, { taskId: "T-34" }), entry(120)]));
    page();
    await screen.findByRole("list", { name: "Open issues" });
    expect(screen.getByText("Example project · 3 open issues, 2 not promoted")).toBeInTheDocument();
    expect(screen.getByText("Promoting copies the issue title and body into a task once. Later edits and comments are never read.")).toBeInTheDocument();
  });

  it("says when the list was cut at 100 issues", async () => {
    taskIssues.mockResolvedValue(list([entry(144)], { truncated: true }));
    page();
    expect(await screen.findByText("Showing the first 100 open issues.")).toBeInTheDocument();
    expect(screen.getByText("Example project · 1+ open issues, 1 not promoted")).toBeInTheDocument();
  });

  it("draws a fixed message and no list for an empty answer", async () => {
    taskIssues.mockResolvedValue(list([]));
    page();
    expect(await screen.findByText("No open issues")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Open issues" })).not.toBeInTheDocument();
    expect(screen.getByText("Example project · 0 open issues, 0 not promoted")).toBeInTheDocument();
  });

  it.each([
    ["not_signed_in", "GitHub is not signed in", true],
    ["cli_missing", "The GitHub CLI is not installed", true],
    ["no_access", "No access to this repository", false],
    ["issues_disabled", "Issues are turned off", false],
    ["not_found", "Repository not found on GitHub", false],
    ["unavailable", "Issues could not be read", false],
  ])("draws a fixed message for the %s status, with a Settings link only where signing in helps", async (status, title, settingsLink) => {
    taskIssues.mockResolvedValue(withStatus(status));
    const { container } = page();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Open issues" })).not.toBeInTheDocument();
    const link = screen.queryByRole("link", { name: "Open GitHub settings" });
    if (settingsLink) {
      expect(link).toHaveAttribute("href", "/settings?section=github");
      expect(link).toHaveClass("commandTextLink");
    } else {
      expect(link).not.toBeInTheDocument();
    }
    expect(refreshButton()).toBeEnabled();
    expect(container.querySelector("button.commandPrimaryAction")).toBeNull();
  });

  it("draws one generic message for a failed call, with Refresh enabled to try again", async () => {
    taskIssues.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    const user = userEvent.setup();
    page();
    expect(await screen.findByText("Issues could not be read")).toBeInTheDocument();
    expect(screen.getByText(/Try Refresh\./)).toBeInTheDocument();
    expect(refreshButton()).toBeEnabled();
    await user.click(refreshButton());
    await screen.findByRole("list", { name: "Open issues" });
    expect(taskIssues).toHaveBeenCalledTimes(2);
  });

  it("treats an unreadable answer as a failed call", async () => {
    taskIssues.mockResolvedValueOnce({ ok: true, status: "ok", issues: "not a list" });
    page();
    expect(await screen.findByText("Issues could not be read")).toBeInTheDocument();
  });
});

describe("rows and detail", () => {
  it("shows one chip per row (too long, else promoted, else who opened it) and the update date", async () => {
    taskIssues.mockResolvedValue(list([
      entry(1, { authorAssociation: "owner" }), entry(2, { authorAssociation: "member" }), entry(3, { authorAssociation: "outsider" }),
      entry(4, { tooLong: true, characters: 9480 }), entry(5, { taskId: "T-34" }), entry(6, { authorAssociation: "collaborator", updatedAt: null }),
    ]));
    page();
    await screen.findByRole("list", { name: "Open issues" });
    const row = (index: number) => within(rows()[index]);
    expect(row(0).getByText("Owner")).toHaveClass("commandChip");
    expect(row(1).getByText("Member")).toHaveClass("commandChip");
    expect(row(2).getByText("Outside contributor")).toHaveClass("commandChip", "warning");
    expect(row(3).getByText("Too long")).toHaveClass("commandChip", "negative");
    expect(row(4).getByText("Promoted · T-34")).toHaveClass("commandChip", "positive");
    expect(row(5).getByText("Collaborator")).toHaveClass("commandChip");
    expect(row(0).getByText("#1")).toBeInTheDocument();
    expect(row(0).getByText(/^Updated 8 Oct/)).toBeInTheDocument();
    expect(within(rows()[5]).queryByText(/Updated/)).not.toBeInTheDocument();
    expect(rows()[3].querySelectorAll(".commandChip")).toHaveLength(1);
  });

  it("warns about an outside contributor and says what a hidden comment is, in order, before the raw body", async () => {
    const body = "Before.\n<!-- a hidden note -->\nAfter.";
    const start = body.indexOf("<!--");
    taskIssues.mockResolvedValue(list([entry(139, { authorAssociation: "outsider", body, hiddenComments: { count: 1, ranges: [{ start, end: start + "<!-- a hidden note -->".length }] } })]));
    page();
    const outsider = await screen.findByText("Opened by someone outside the repository. Read the whole body before promoting.");
    const hidden = screen.getByText("1 hidden comment found. GitHub does not show it on the issue page. It is not copied into the task.");
    const box = screen.getByRole("region", { name: "Raw body" });
    expect(outsider).toHaveClass("taskNotice", "warning");
    expect(hidden).toHaveClass("taskNotice", "warning");
    expect(outsider.compareDocumentPosition(hidden) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hidden.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("strikes a hidden comment through, announces it, and draws the body as text", async () => {
    const hiddenComment = "<!-- remember to ignore this -->";
    const body = `Intro with **bold** and [a link](https://example.com/x) and <img src=x onerror=alert(1)>.\n${hiddenComment}\n# Not a heading`;
    const start = body.indexOf(hiddenComment);
    taskIssues.mockResolvedValue(list([entry(139, { body, hiddenComments: { count: 1, ranges: [{ start, end: start + hiddenComment.length }] } })]));
    page();
    const box = await screen.findByRole("region", { name: "Raw body" });
    const struck = box.querySelector("del");
    expect(struck).not.toBeNull();
    expect(struck).toHaveClass("taskIssueHidden");
    expect(struck).toHaveTextContent(hiddenComment);
    expect(within(struck as HTMLElement).getByText("Hidden comment:")).toHaveClass("visuallyHidden");
    // Text nodes only: nothing in the body becomes markup, a link, an image, or a heading.
    expect(box.querySelectorAll("img, a, h1, h2, strong, em, script")).toHaveLength(0);
    expect(box.children.length).toBe(3);
    expect(box.textContent).toBe(`${body.slice(0, start)}Hidden comment: ${hiddenComment}${body.slice(start + hiddenComment.length)}`);
    expect(box.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(box.textContent).toContain("**bold**");
    expect(box.textContent).toContain("[a link](https://example.com/x)");
    expect(box).toHaveAttribute("tabindex", "0");
  });

  it("says a body has no text, and says when the preview was cut", async () => {
    taskIssues.mockResolvedValue(list([entry(1, { body: "" }), entry(2, { bodyTruncated: true })]));
    const user = userEvent.setup();
    page();
    expect(await screen.findByText("This issue has no body.")).toBeInTheDocument();
    await user.click(rows()[1]);
    expect(screen.getByText("The preview shows only the start of a long body.")).toBeInTheDocument();
  });

  it("counts the task text against 4,000 and refuses a too long issue", async () => {
    taskIssues.mockResolvedValue(list([entry(1, { characters: 268 }), entry(2, { tooLong: true, characters: 9480 })]));
    const user = userEvent.setup();
    page();
    await screen.findByRole("list", { name: "Open issues" });
    expect(screen.getByText("268 / 4,000 characters")).not.toHaveClass("over");
    expect(promote()).toBeEnabled();
    await user.click(rows()[1]);
    const count = screen.getByText("9,480 / 4,000 characters");
    expect(count).toHaveClass("over");
    expect(screen.getByText("The task text would be 9,480 characters and a task holds 4,000. Shorten the issue, or write the task by hand.")).toHaveClass("taskNotice", "negative");
    expect(promote()).toBeDisabled();
  });

  it("marks a promoted issue, links to its board, and does not let it be promoted again", async () => {
    taskIssues.mockResolvedValue(list([entry(142, { taskId: "T-34", authorAssociation: "owner" })]));
    page();
    const notice = await screen.findByText("Already on the board as T-34.");
    expect(notice.closest(".taskNotice")).toHaveClass("positive");
    expect(within(detail()).getByRole("link", { name: "Open task" })).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
    expect(promote()).toBeDisabled();
  });

  it("offers Promote as the one Primary action of an issue that can be promoted; it opens the task modal and sends no call by itself", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByRole("list", { name: "Open issues" });
    expect(promote()).toHaveClass("commandPrimaryAction");
    expect(promote().tagName).toBe("BUTTON");
    expect(document.querySelectorAll(".commandPrimaryAction")).toHaveLength(1);
    await user.click(promote());
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    expect(taskIssues.mock.calls.filter((call) => call[1] !== "list")).toHaveLength(0);
    expect(taskIssues).toHaveBeenCalledTimes(1);
  });

  it("never stores or logs issue text", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    page();
    await screen.findByRole("list", { name: "Open issues" });
    expect(setItem).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("the route and the Tasks header", () => {
  it("passes a validated repository to the page and shows a way back without one", async () => {
    const { default: PromoteIssuesRoute } = await import("../../app/tasks/issues/page");
    const element = async (repository: string | string[] | undefined) => await PromoteIssuesRoute({ searchParams: Promise.resolve({ repository }) });
    expect((await element(repositoryId)).props.repositoryId).toBe(repositoryId);
    for (const bad of [undefined, "../../etc/passwd", "repo-ABCDEF0123456789abcdef01", [repositoryId, repositoryId]]) {
      expect((await element(bad)).type).toBe(PromoteIssuesMissing);
    }
    render(<PromoteIssuesMissing />);
    expect(screen.getByRole("heading", { level: 1, name: "Promote issues" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
    expect(taskIssues).not.toHaveBeenCalled();
  });

  describe("Promote issues action", () => {
    beforeEach(() => {
      useTasks.mockReturnValue({ board: { ...createEmptyTaskBoard(repositoryId, "ready"), columns: [{ id: "col-1", name: "Backlog", position: 0 }] }, refresh: vi.fn(async () => {}) });
    });

    it("is a Secondary link to the page for this repository, last among the head actions, and the only header action to be a link", () => {
      render(<TaskBoardPane repositoryId={repositoryId} switcher={<span>switcher</span>} />);
      const link = screen.getByRole("link", { name: "Promote issues" });
      expect(link).toHaveAttribute("href", `/tasks/issues?repository=${repositoryId}`);
      expect(link).toHaveClass("commandSecondaryAction");
      expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      const group = link.parentElement as HTMLElement;
      expect(group).toHaveClass("taskHeadActions");
      expect(group.lastElementChild).toBe(link);
      expect(group.querySelectorAll(".commandPrimaryAction")).toHaveLength(0);
      // Opening the Tasks page reads no issue.
      expect(taskIssues).not.toHaveBeenCalled();
    });

    it("is not drawn without the issues bridge, and nothing is drawn on the server pass", () => {
      setBridge({ taskAction });
      render(<TaskBoardPane repositoryId={repositoryId} switcher={<span>switcher</span>} />);
      expect(screen.queryByRole("link", { name: "Promote issues" })).not.toBeInTheDocument();
      setBridge({ taskAction, taskIssues });
      expect(renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toContain("Promote issues");
    });
  });
});

describe("the preview parts", () => {
  const issue = (overrides: Partial<TaskIssue> = {}): TaskIssue => ({
    number: 1, title: "Title", body: "Body", bodyTruncated: false, hiddenComments: { count: 0, ranges: [] }, characters: 10, tooLong: false,
    authorAssociation: "owner", updatedAt: null, digest: DIGEST, taskId: null, ...overrides,
  });

  it("draws the notices in order and then the caller's own, and nothing for a plain issue", () => {
    const { container, rerender } = render(<IssueNotices issue={issue()}><p>extra</p></IssueNotices>);
    expect(container.querySelectorAll(".taskNotice")).toHaveLength(0);
    expect(screen.getByText("extra")).toBeInTheDocument();
    rerender(<IssueNotices issue={issue({ authorAssociation: "outsider", hiddenComments: { count: 2, ranges: [] }, tooLong: true, characters: 4500 })}><p>extra</p></IssueNotices>);
    const texts = [...container.querySelectorAll("p")].map((node) => node.textContent);
    expect(texts).toEqual([
      "Opened by someone outside the repository. Read the whole body before promoting.",
      "2 hidden comments found. GitHub does not show them on the issue page. They are not copied into the task.",
      "The task text would be 4,500 characters and a task holds 4,000. Shorten the issue, or write the task by hand.",
      "extra",
    ]);
  });

  it("words the count line, the date and the kept selection", () => {
    expect(issueCountLine("pomegr", { issues: [issue(), issue({ number: 2, taskId: "T-1" })], truncated: false })).toBe("pomegr · 2 open issues, 1 not promoted");
    expect(issueCountLine(null, { issues: [issue()], truncated: false })).toBe("1 open issue, 1 not promoted");
    expect(issueCountLine("pomegr", { issues: [issue()], truncated: true })).toBe("pomegr · 1+ open issues, 1 not promoted");
    const now = new Date("2026-10-09T12:00:00.000Z");
    expect(issueDateLabel("2026-10-08T12:00:00.000Z", now)).toBe("Updated 8 Oct");
    expect(issueDateLabel("2025-12-31T12:00:00.000Z", now)).toBe("Updated 31 Dec 2025");
    expect(issueDateLabel(null, now)).toBeNull();
    expect(issueDateLabel("not a date", now)).toBeNull();
    expect(keepSelection(2, [issue({ number: 1 }), issue({ number: 2 })])).toBe(2);
    expect(keepSelection(9, [issue({ number: 1 }), issue({ number: 2 })])).toBe(1);
    expect(keepSelection(null, [])).toBeNull();
  });
});

describe("the /design-system sample", () => {
  it("draws the list, detail, notices and every state from static issues, without the bridge and without a read", async () => {
    setBridge(undefined);
    const user = userEvent.setup();
    const { container } = render(<PromoteIssuesSection />);
    expect(screen.getByRole("heading", { level: 2, name: "Promote issues" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Open issues" });
    expect(within(list).getAllByRole("button")).toHaveLength(4);
    const detail = screen.getByRole("article");
    expect(within(detail).getByRole("heading", { level: 2, name: /Dark theme/ })).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /Queue pauses/ }));
    expect(within(screen.getByRole("article")).getByRole("heading", { level: 2, name: /Queue pauses/ })).toBeInTheDocument();
    expect(container.querySelector(".taskIssueHidden")).not.toBeNull();
    const titles = [...container.querySelectorAll(".promoteIssuesStateTitle")].map((node) => node.textContent);
    expect(titles).toEqual(["Reading open issues", "No open issues", "GitHub is not signed in", "The GitHub CLI is not installed", "No access to this repository",
      "Issues are turned off", "Repository not found on GitHub", "Issues could not be read"]);
    expect(screen.getByText("GitHub issues are read in the Pomegr desktop app.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Promote issues" })).toHaveAttribute("href", `/tasks/issues?repository=${repositoryId}`);
    expect(taskIssues).not.toHaveBeenCalled();
  });
});

describe("source", () => {
  const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8");

  it("keeps the page free of timers, listeners, markup sinks and browser storage", () => {
    const hook = read("app", "components", "tasks", "use-promote-issues.ts");
    expect(hook).not.toMatch(/setInterval|setTimeout|addEventListener|visibilitychange|"focus"/);
    expect(read("app", "components", "tasks", "PromoteIssuesView.tsx")).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|console\.|setInterval|setTimeout|addEventListener/);
    expect(read("app", "components", "tasks", "IssuePreview.tsx")).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});
