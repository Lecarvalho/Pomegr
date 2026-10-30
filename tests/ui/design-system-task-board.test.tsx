import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TaskBoardSection } from "../../app/components/design-system/DesignSystemTaskBoardSample";
import { forbidNetwork, sample, sectionOf } from "./design-system-helpers";

// The task cards, lanes, feature filter, capacity strip and boards of /design-system, drawn from synthetic tasks.
describe("Design-system reference page, task board", () => {
  forbidNetwork();

  it("renders every task card state, with the chip the lane leaves and the border each state takes", () => {
    render(<TaskBoardSection />);
    const board = sectionOf("Task cards and board");
    const card = (label: string) => sample(board, label).querySelector(".taskCard") as HTMLElement;
    const chip = (label: string) => card(label).querySelector(".taskCardChip") as HTMLElement | null;

    // A lane that already says the state leaves the chip out: Backlog says Not queued, Ready says Queued, In progress says In progress, Review says Needs review, Done says Done.
    for (const label of ["Backlog, Not queued", "Backlog, tags", "Backlog, long text", "Ready, Queued", "In progress, Working", "Review, Needs review", "Done"]) expect(chip(label), label).toBeNull();
    expect(card("Backlog, Not queued")).not.toHaveClass("isLive", "isAttention");
    expect(card("Backlog, Not queued").querySelector(".taskCardTop .taskCardFeature")?.textContent).toBe("· Client cleanup");
    expect(card("Backlog, tags").querySelector(".taskCardTitle")?.textContent).toBe("Make plan-intent consume atomic across browser tabs");
    expect([...card("Backlog, tags").querySelectorAll(".taskTags .taskTag")].map((tag) => tag.textContent)).toEqual(["frontend", "tech-debt"]);
    expect(card("Backlog, long text").querySelector(".taskCardExcerpt")).toBeNull();
    // The queued card relies on its place in the lane and its wait line; a task on the provider's default model names the provider.
    expect(card("Ready, Queued").querySelector(".taskCardWaiting")?.textContent).toMatch(/^3rd in queue · Waiting: /);
    expect(card("Ready, Queued").querySelector(".taskCardPlanned")?.textContent).toBe("Claude Code");
    // The one task the monitor names as next is labeled Next on the board.
    expect(chip("Ready, Next")).toHaveTextContent(/^Next$/);
    expect(chip("Ready, Next")).toHaveClass("commandChip", "isInk");
    expect(chip("Ready, Scheduled")).toHaveClass("info");
    expect(card("Ready, Scheduled").querySelector(".taskCardStarts")?.textContent).toMatch(/^Starts /);
    expect(chip("Ready, Not queued")).toHaveTextContent("Not queued");
    // A bound session's state is borrowed; a differing planned model is the one amber line.
    expect(card("In progress, Working")).toHaveClass("isLive");
    expect(card("In progress, Working").querySelector(".taskCardModelDiffers")).toHaveTextContent("Planned model-large, observed model-small");
    expect(chip("In progress, Needs input")).toHaveTextContent("Needs input");
    expect(chip("In progress, Needs input")).toHaveClass("warning");
    for (const label of ["In progress, Needs input", "In progress, Stalled", "In progress, Blocked by agent", "Review, Needs review"]) expect(card(label), label).toHaveClass("isAttention");
    for (const [label, state] of [["In progress, Stalled", "Stalled"], ["In progress, Blocked by agent", "Blocked by agent"]]) {
      expect(chip(label)).toHaveTextContent(state);
      expect(chip(label)).toHaveClass("warning");
    }
    expect(card("From a GitHub issue").querySelector(".taskCardTop .taskIssueChip")).toHaveTextContent("#142");
    // A promoted card in the narrowest lane wraps its attention chip to a second line.
    const narrow = sample(board, "From a GitHub issue, needs attention");
    expect(narrow.querySelector(".designSystemNarrowLane")).not.toBeNull();
    expect(narrow.querySelector(".taskCard")).toHaveClass("isAttention");
    expect(narrow.querySelector(".taskCardTop .taskIssueChip")).toHaveTextContent("#142");
    expect(narrow.querySelector(".taskCardTop .taskCardChip")).toHaveTextContent("Blocked by agent");
    expect(card("Done")).toHaveClass("isDone");
    // Open session is muted with an arrow glyph, never the brand link color.
    const open = within(card("Done")).getByRole("link", { name: "Open session" });
    expect(open).toHaveClass("commandTextLink", "taskCardLink");
    expect(open.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(open.getAttribute("href")).toMatch(/^\/sessions\//);
    // The feature's name follows the ID in the meta row of a card outside Ready.
    expect(sample(board, "Card outside Ready, feature name").querySelector(".taskCardTop .taskCardFeature")?.textContent).toBe("· Upload reliability");
  });

  it("renders the desktop-only card, column and filter controls, inert", async () => {
    const user = userEvent.setup();
    render(<TaskBoardSection />);
    const board = sectionOf("Task cards and board");

    const desktop = sample(board, "Card, desktop app").querySelector(".taskCard") as HTMLElement;
    expect(desktop).toHaveAttribute("draggable", "true");
    expect(within(desktop).getByRole("button", { name: "Show the retry count in the upload log" })).toHaveClass("commandQuietAction", "taskCardOpen");
    const moves = within(desktop).getByRole("toolbar", { name: "Move T-3" });
    expect(within(moves).getAllByRole("button")).toHaveLength(4);
    expect(within(moves).getByRole("button", { name: "Move T-3 up" })).toBeDisabled();
    expect(within(moves).getByRole("button", { name: "Move T-3 to the next column" })).toHaveClass("commandIconAction");
    // A waiting card of a parallel group adds Take out of group after the four arrows.
    expect(within(sample(board, "Card, desktop app, in a parallel group")).getByRole("button", { name: "Take T-3 out of its parallel group" })).toHaveClass("commandQuietAction", "taskMoveLeave");

    const readOnlyHeader = sample(board, "Column header");
    expect(within(readOnlyHeader).getByRole("heading", { level: 3, name: "In progress" })).toBeInTheDocument();
    expect(within(readOnlyHeader).queryByRole("button")).toBeNull();

    const filter = sample(board, "Feature filter");
    const filterSelect = within(filter).getByRole("combobox", { name: "Feature" });
    expect(filterSelect).toHaveTextContent(/^All \(\d+\)$/);
    expect(filterSelect.closest(".commandSelect")).toHaveClass("taskFeatureSelect");
    await user.click(filterSelect);
    const filterOptions = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(filterOptions[0]).toMatch(/^All \(\d+\)$/);
    // Done features follow No feature, last.
    expect(filterOptions.at(-2)).toMatch(/^No feature \(\d+\)$/);
    expect(filterOptions.at(-1)).toMatch(/^Archive export \(\d+\), done$/);
    await user.click(filterSelect);
    expect(within(filter).queryByRole("button", { name: "+ New feature" })).toBeNull();
    const desktopFilter = sample(board, "Feature filter, desktop app");
    expect(within(desktopFilter).getByRole("button", { name: "+ New feature" })).toHaveClass("commandQuietAction");
    // With All chosen the row has no Edit feature.
    expect(within(desktopFilter).queryByRole("button", { name: "Edit feature" })).toBeNull();
    await user.click(within(desktopFilter).getByRole("combobox", { name: "Feature" }));
    await user.click(screen.getByRole("option", { name: /^Upload reliability \(\d+\)$/ }));
    expect(within(desktopFilter).getByRole("combobox", { name: "Feature" })).toHaveTextContent(/^Upload reliability \(\d+\)$/);
    expect(within(desktopFilter).getByText("Moving cards is off while a feature filter is on.")).toBeInTheDocument();
    // The selected feature's progress comes before that line, with its counts in the data font.
    const progress = desktopFilter.querySelector(".taskFeatureProgress") as HTMLElement;
    expect(progress.textContent).toMatch(/^\d+ of \d+ tasks done( · \d+ running)?$/);
    expect(progress.querySelectorAll(".taskFeatureProgressNum").length).toBeGreaterThanOrEqual(2);
    expect(progress.compareDocumentPosition(within(desktopFilter).getByText("Moving cards is off while a feature filter is on.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // With one feature chosen: the eyebrow, the select, Edit feature, + New feature, then the progress line and the helper.
    const row = within(sample(board, "Feature filter, desktop app, a feature chosen")).getByRole("group", { name: "Filter by feature" });
    expect([...row.children].map((child) => child.textContent?.replace(/\s+/g, " ").trim().slice(0, 14))).toEqual(["Feature", "Upload reliabi", "Edit feature", "+ New feature", "1 of 3 tasks d", "Moving cards i"]);
    expect(within(row).getByRole("button", { name: "Edit feature" })).toHaveClass("commandQuietAction");
    expect(within(row).getByRole("button", { name: "+ New feature" })).toHaveClass("commandQuietAction");

    const strip = within(sample(board, "Capacity strip")).getByRole("region", { name: "Provider capacity" });
    expect(strip).toHaveTextContent("Claude Code 5h 91% · 7d 37%");
    expect(strip).toHaveTextContent("Codex 5h 38% · 7d 12%");
    expect(strip.querySelector("button")).toBeNull();
    const stripEnd = sample(board, "Capacity strip, on the Board").querySelector(".taskCapacityEnd") as HTMLElement;
    expect(stripEnd.querySelector(".taskCapacitySettings")?.textContent).toMatch(/^Do not start above 85% · stops starting after \d\d:\d\d$/);
    expect(stripEnd.querySelectorAll(".taskCapacityValue")).toHaveLength(2);
    expect(stripEnd.lastElementChild).toBe(within(stripEnd).getByRole("button", { name: "Queue settings" }));
    expect(within(stripEnd).getByRole("button", { name: "Queue settings" })).toHaveClass("commandQuietAction", "taskQueueSettingsAction");
    expect(within(stripEnd).getByRole("button", { name: "Queue settings" })).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("renders lanes: the first with + New task forced visible, an empty one, and one under a dragged card", () => {
    render(<TaskBoardSection />);
    const board = sectionOf("Task cards and board");

    const revealed = sample(board, "Lane, + New task revealed");
    const lane = revealed.querySelector(".designSystemRevealAdd .taskColumn");
    expect(lane).not.toBeNull();
    expect(within(lane as HTMLElement).getByRole("heading", { level: 3, name: "Backlog" })).toBeInTheDocument();
    expect(within(lane as HTMLElement).getByRole("button", { name: "New task" })).toHaveClass("commandQuietAction", "taskColumnAdd");
    expect(lane).not.toHaveClass("isDropTarget");

    const empty = sample(board, "Lane, empty");
    expect(empty.querySelectorAll(".taskCard")).toHaveLength(0);
    expect(within(empty).getByRole("button", { name: "New task" })).toBeInTheDocument();

    const dropTarget = sample(board, "Lane, drop target");
    expect(dropTarget.querySelector(".taskColumn")).toHaveClass("isDropTarget");
    expect(dropTarget.querySelector(".taskCard:last-child")).toHaveClass("isDropAfter");
    expect(within(dropTarget).queryByRole("button", { name: "New task" })).toBeNull();
    expect(within(dropTarget).getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("renders the Ready lane's parallel groups: the frame, the whole-group actions, the rest state, the join target and a held member", () => {
    render(<TaskBoardSection />);
    const board = sectionOf("Task cards and board");

    const plain = sample(board, "Ready lane, parallel group");
    const group = plain.querySelector(".taskReadyGroup") as HTMLElement;
    expect(group.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 2");
    expect(group.querySelector(".taskReadyActions")).toBeNull();
    expect([...group.querySelectorAll("li.taskReadyCard")].map((card) => card.getAttribute("data-task-id"))).toEqual(["T-2", "T-3"]);
    expect(plain.querySelector(".taskReadyLink")).toBeNull();
    expect(plain.textContent).not.toMatch(/Step|One at a time|Single tasks/);

    const desktop = sample(board, "Ready lane, desktop app");
    const toolbar = within(desktop).getByRole("toolbar", { name: "Parallel group of T-2 and T-3" });
    expect([...toolbar.querySelectorAll("[data-group-move]")].map((arrow) => arrow.getAttribute("data-group-move"))).toEqual(["up", "down"]);
    expect(within(toolbar).getByRole("button", { name: "Ungroup" })).toHaveClass("commandQuietAction", "taskReadyUngroup");
    expect(desktop.querySelector(".designSystemRevealLink .taskReadyLink .taskReadyLinkAction")).toHaveTextContent("Run in parallel");
    // Both hover-only actions are forced visible in this sample.
    expect(desktop.querySelector(".designSystemRevealGroup")).not.toBeNull();

    // At rest the toolbar stays in the tree, and no sample forces it visible.
    const rest = sample(board, "Ready lane, group at rest, desktop app");
    expect(within(rest).getByRole("toolbar", { name: "Parallel group of T-2 and T-3" })).toHaveClass("taskReadyActions");
    expect(rest.querySelector(".designSystemRevealGroup, .designSystemRevealLink")).toBeNull();

    // A join target takes the group, with no drop line.
    const join = sample(board, "Ready lane, join target");
    expect(join.querySelector(".taskReadyGroup")).toHaveClass("isJoinTarget");
    expect(join.querySelector(".isDropBefore, .isDropAfter")).toBeNull();

    // A held member: one card waiting, its sibling started.
    const held = sample(board, "Ready lane, a member held");
    expect(held.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 1 · T-3 started");
    expect(held.querySelector('[data-task-id="T-2"] .taskCardWaiting')?.textContent).toMatch(/ · T-3 started$/);
  });

  it("renders the whole task board read-only and with desktop controls, and each non-ready board state", () => {
    render(<TaskBoardSection />);
    const board = sectionOf("Task cards and board");

    const browser = sample(board, "Board, browser (blocked queue)");
    expect(within(browser).getByRole("region", { name: "Queue status" })).toHaveTextContent("Queue blocked");
    expect(within(browser).getByRole("region", { name: "Task board" })).toBeInTheDocument();
    expect(browser.querySelectorAll(".taskColumn")).toHaveLength(5);
    expect(browser.querySelector(".taskCard[draggable]")).toBeNull();
    expect(browser.querySelector(".taskColumnEdit")).toBeNull();
    expect(browser.querySelector(".taskBoardFootnote")).toBeNull();
    // A browser reads lanes only: the + New task action is desktop-app only.
    expect(browser.querySelector(".taskColumnAdd")).toBeNull();
    // A browser's banner names the blocker and offers no action.
    expect(within(browser).getByRole("region", { name: "Queue status" }).querySelector("button")).toBeNull();

    const desktop = sample(board, "Board, desktop app (queue on)");
    expect(desktop.querySelectorAll(".taskCard[draggable='true']")).toHaveLength(8);
    expect(desktop.querySelectorAll(".taskColumnHeader button")).toHaveLength(0);
    // + New task ends the first lane only; the header has no primary action.
    const lanes = desktop.querySelectorAll<HTMLElement>(".taskColumn");
    expect(desktop.querySelectorAll(".taskColumnAdd")).toHaveLength(1);
    expect(within(lanes[0]).getByRole("button", { name: "New task" })).toHaveClass("commandQuietAction", "taskColumnAdd");
    expect(desktop.querySelector(".commandPrimaryAction")).toBeNull();
    expect(desktop.querySelector(".taskBoardFootnote")).toHaveTextContent(/^Drag a card to move it\. Ready starts from the top, one card at a time\./);
    // The group frame with its actions and the Run in parallel link are drawn from the shipped components.
    expect(desktop.querySelector(".taskReadyGroup")).toHaveAttribute("data-ready-group", "grp-0123456789ab");
    expect(within(desktop).getByRole("button", { name: "Ungroup" })).toHaveClass("taskReadyUngroup");
    expect(within(desktop).getByRole("button", { name: "Take T-3 out of its parallel group" })).toHaveClass("taskMoveLeave");
    expect(desktop.querySelectorAll(".taskReadyLinkAction").length).toBeGreaterThan(0);
    expect(desktop.textContent).not.toMatch(/Move to step|New step|Single tasks|One at a time/);
    expect(within(desktop).queryByRole("region", { name: "Queue status" })).toBeNull();
    expect(within(desktop).getByRole("button", { name: "+ New feature" })).toBeInTheDocument();

    expect(sample(board, "Board, loading").querySelector(".taskBoardSkeleton")).toHaveAttribute("aria-label", "Loading tasks");
    expect(within(sample(board, "Board, unavailable")).getByRole("status")).toHaveTextContent("Tasks are unavailable.");
    expect(within(sample(board, "Board, desktop only")).getByText("Desktop only")).toHaveClass("commandChip");
    expect(within(sample(board, "Board, no tasks")).getByText("No tasks on this board yet.")).toBeInTheDocument();
  });
});
