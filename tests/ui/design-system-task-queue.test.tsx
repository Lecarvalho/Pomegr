import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueueControlsSection, TaskGatesSection } from "../../app/components/design-system/DesignSystemTaskGatesSample";
import { forbidNetwork, reading, sample, sectionOf } from "./design-system-helpers";

// The Queue controls, the Start gates and the Schedule of /design-system, drawn from static data.
describe("Design-system reference page, task queue", () => {
  forbidNetwork();

  it("renders the queue switch, banners, header actions and Queue settings", () => {
    render(<QueueControlsSection />);
    const queue = sectionOf("Queue controls");

    expect(within(within(sample(queue, "Queue switch, off")).getByRole("group", { name: "Queue" })).getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
    expect(within(within(sample(queue, "Queue switch, on")).getByRole("group", { name: "Queue" })).getByRole("button", { name: "On" })).toHaveAttribute("aria-pressed", "true");
    expect(within(sample(queue, "Queue switch, busy")).getByRole("button", { name: "On" })).toBeDisabled();

    // The page header actions: the Repository select, the Queue switch, then Promote issues. No view switch.
    const actions = sample(queue, "Page header actions, desktop app").querySelector(".taskHeadActions") as HTMLElement;
    const follows = (first: HTMLElement, second: HTMLElement) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    const repository = within(actions).getByRole("combobox", { name: "Repository" });
    const queueGroup = within(actions).getByRole("group", { name: "Queue" });
    const promote = within(actions).getByRole("link", { name: "Promote issues" });
    expect(follows(repository, queueGroup)).toBe(true);
    expect(follows(queueGroup, promote)).toBe(true);
    // While the board has no feature, the desktop app adds + New feature between the Queue switch and Promote issues.
    expect(follows(queueGroup, within(actions).getByRole("button", { name: "+ New feature" }))).toBe(true);
    expect(follows(within(actions).getByRole("button", { name: "+ New feature" }), promote)).toBe(true);
    expect(actions.children).toHaveLength(4);
    expect(within(actions).queryByRole("group", { name: "Tasks view" })).toBeNull();

    // The Board banner of a blocked queue carries every action; a paused queue keeps only Open T-n; a browser has none.
    const boardBanner = within(sample(queue, "Banner, blocked")).getByRole("region", { name: "Queue status" });
    expect(boardBanner).toHaveTextContent("T-2's agent reported it cannot continue.");
    expect(within(boardBanner).getByRole("button", { name: "Open T-2" })).toHaveClass("commandSecondaryAction");
    expect(within(boardBanner).getByRole("button", { name: "Mark done and resume" })).toHaveClass("commandSecondaryAction");
    expect(within(boardBanner).getByRole("button", { name: "Requeue T-2" })).toHaveClass("commandQuietAction");
    expect(boardBanner).toHaveTextContent("Nothing new starts until you resolve T-2.");
    const paused = within(sample(queue, "Banner, paused")).getByRole("region", { name: "Queue status" });
    expect(paused).toHaveTextContent("Queue paused");
    expect(paused).toHaveTextContent("command-line tool was not found");
    expect(within(paused).queryByRole("button", { name: "Mark done and resume" })).toBeNull();
    expect(within(within(sample(queue, "Banner, browser")).getByRole("region", { name: "Queue status" })).queryByRole("button")).toBeNull();

    // Queue settings: one h2, then the three sections as h3 with no panel frame of their own.
    const settings = sample(queue, "Queue settings, desktop app").querySelector(".taskQueueSettings") as HTMLElement;
    expect(within(settings).getByRole("heading", { level: 2, name: "Queue settings" })).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: "Close" })).toHaveClass("commandIconAction");
    expect(within(settings).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Start gates", "Schedule", "When the queue blocks"]);
    expect(settings.querySelector(".panel")).toBeNull();
    expect(settings.querySelectorAll(".taskGatesPanel:not(.taskSchedulePanel) .taskGateRow")).toHaveLength(5);
    expect(within(settings).getByText("Checked before every session Pomegr starts.")).toBeInTheDocument();
    expect(within(settings).getByRole("combobox", { name: "Do not start above" }).closest(".taskGateThreshold")).not.toBeNull();
    expect(within(settings).getByRole("group", { name: "Queue start" })).toHaveClass("commandSegmented");
    expect(within(settings).getByLabelText("Stop starting tasks after")).toHaveClass("taskTimeInput");
    expect(within(settings).getByText("Stalled")).toHaveClass("isError");
    expect(within(settings).getByText("Needs review")).toHaveClass("isReview");
    const readOnly = sample(queue, "Queue settings, browser").querySelector(".taskQueueSettings") as HTMLElement;
    expect(within(readOnly).queryByRole("combobox")).toBeNull();
    expect(within(readOnly).queryByRole("group", { name: "Queue start" })).toBeNull();
    expect(readOnly.querySelectorAll(".taskSchedulePanel .taskGateRow")).toHaveLength(2);
  });

  it("renders the Start gates and Schedule panels in every reading", () => {
    render(<TaskGatesSection />);
    const gates = sectionOf("Start gates and schedule");

    // Every sample is a frameless section of the Queue settings panel, under an h3.
    expect(gates.querySelectorAll(".taskQueueSettings").length).toBeGreaterThan(0);
    const held = sample(gates, "Start gates, held");
    expect(within(held).getByRole("heading", { level: 3, name: "Start gates" })).toBeInTheDocument();
    expect(held.querySelector(".panel")).toBeNull();
    expect(reading(held, "Claude Code capacity")).toHaveTextContent("5h 91% · 7d 37% · above threshold");
    expect(reading(held, "Claude Code capacity")).toHaveClass("isMono", "is-error");
    expect(reading(held, "Codex capacity")).toHaveTextContent("5h 38% · 7d 12%");
    expect(reading(held, "Provider status")).toHaveClass("is-ok");
    expect(reading(held, "Working tree")).toHaveTextContent("Clean");
    expect(within(held).getByText("Do not start above").nextElementSibling).toHaveTextContent("85% of the usage window");
    expect(within(held).queryByRole("combobox")).toBeNull();
    expect(within(sample(gates, "Start gates, desktop app")).getByRole("combobox", { name: "Do not start above" })).toHaveTextContent("85% of the usage window");

    const stopped = sample(gates, "Start gates, stopped");
    expect(reading(stopped, "Earlier task finished")).toHaveTextContent("Blocked by T-2");
    expect(reading(stopped, "Provider status")).toHaveTextContent("Incident: Claude Code");
    expect(reading(stopped, "Working tree")).toHaveTextContent("Uncommitted changes");
    for (const label of ["Earlier task finished", "Provider status", "Working tree"]) expect(reading(stopped, label)).toHaveClass("is-error");

    const unknown = sample(gates, "Start gates, unknown");
    expect(reading(unknown, "Earlier task finished")).toHaveTextContent("No task queued");
    for (const label of ["Earlier task finished", "Claude Code capacity", "Codex capacity", "Provider status", "Working tree"]) expect(reading(unknown, label)).toHaveClass("is-muted");
    expect(within(sample(gates, "Start gates, not available")).getByText("Start gates are not available yet.")).toBeInTheDocument();

    const notSet = sample(gates, "Schedule, browser, not set");
    expect(reading(notSet, "Start")).toHaveTextContent("Run now");
    expect(reading(notSet, "Stop starting tasks after")).toHaveTextContent("Not set");
    const set = sample(gates, "Schedule, browser, set");
    expect(reading(set, "Start").textContent).toMatch(/^Starts .+, once the queue is on\.$/);
    expect(reading(set, "Stop starting tasks after").textContent).toMatch(/^No task starts from /);
    expect(within(set).getByText(/A running session is never stopped by the schedule/)).toBeInTheDocument();

    const runNow = sample(gates, "Schedule, desktop app, run now");
    expect(within(runNow).getByRole("group", { name: "Queue start" })).toHaveClass("commandSegmented");
    expect(within(runNow).getByRole("button", { name: "Run now" })).toHaveAttribute("aria-pressed", "true");
    expect(within(runNow).getByRole("button", { name: "Start at a time" })).toHaveAttribute("aria-pressed", "false");
    expect(within(runNow).queryByLabelText("Start at")).toBeNull();
    expect(within(runNow).getByLabelText("Stop starting tasks after")).toHaveClass("taskTimeInput");
    const atTime = sample(gates, "Schedule, desktop app, start at a time");
    expect(within(atTime).getByRole("button", { name: "Start at a time" })).toHaveAttribute("aria-pressed", "true");
    expect(within(atTime).getByLabelText("Start at")).toHaveAttribute("type", "time");
    expect(within(atTime).getByLabelText("Start at")).toHaveClass("taskTimeInput");
  });
});
