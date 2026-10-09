import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const clientAccess = vi.hoisted(() => ({ mode: "unknown" as "unknown" | "local" | "lan" }));

vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  return { ...actual, useClientAccess: () => ({ mode: clientAccess.mode, canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});

import { DesignSystemView } from "../../app/components/design-system/DesignSystemView";
import DesignSystemPage from "../../app/design-system/page";

const ROLE_HEADINGS = ["Primary", "Secondary", "Segmented", "Quiet", "Text link", "Icon"];
const SECTION_HEADINGS = ["Buttons", "Form fields", "Request charts", "Events rail", "Agent roster", "Agent inspector", "Chips and pills", "Panels and dividers", "Command table", "Settings tab rail", "Task fields", "Task cards and board", "Task queue", "Start gates and schedule", "Sessions list Task cell", "Typography and tokens"];
const SAMPLE_SOURCES = [
  "DesignSystemView", "DesignSystemKit", "DesignSystemAgentSamples", "DesignSystemLayoutSamples", "DesignSystemEventsSample", "DesignSystemTaskFieldsSample",
  "DesignSystemTaskBoardSample", "DesignSystemTaskQueueSample", "DesignSystemTaskGatesSample", "DesignSystemSessionTaskSample",
].map((name) => `app/components/design-system/${name}.tsx`).concat("app/components/design-system/DesignSystemTaskSampleData.ts");
const REPOSITORY_ID = "repo-0123456789abcdef01234567";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function sectionOf(name: string) {
  return screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
}

/** The labelled sample inside a design-system section. */
function sample(root: HTMLElement, label: string) {
  return within(root).getByText(label, { selector: ".designSystemSample > span" }).closest(".designSystemSample") as HTMLElement;
}

/** The reading of a Start gates or Schedule row, from its label. */
function reading(root: HTMLElement, label: string) {
  return within(root).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

describe("Design-system reference page", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network use is forbidden on the design-system page")));
  });

  afterEach(() => {
    clientAccess.mode = "unknown";
    delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("renders every control section from the real shared classes on the web without touching the network", () => {
    render(<DesignSystemPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Design system" })).toBeInTheDocument();
    for (const name of SECTION_HEADINGS) expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();

    const buttons = screen.getByRole("region", { name: "Buttons" });
    for (const name of ROLE_HEADINGS) {
      const role = within(buttons).getByRole("article", { name: new RegExp(`^${name}\\b`) });
      expect(within(role).getByText("Default")).toBeInTheDocument();
      expect(within(role).getByText("Hover")).toBeInTheDocument();
      expect(within(role).getByText("Disabled")).toBeInTheDocument();
      expect(within(role).getByText("Focus")).toBeInTheDocument();
    }
    expect(within(buttons).getAllByRole("button", { name: "Install plugin" })[0]).toHaveClass("commandPrimaryAction");
    expect(within(buttons).getAllByRole("button", { name: "Copy" })[0]).toHaveClass("commandSecondaryAction");
    expect(within(buttons).getAllByRole("button", { name: "Fresh tokens" })[0].parentElement).toHaveClass("commandSegmented");
    expect(within(buttons).getAllByRole("button", { name: "Download report" })[0]).toHaveClass("commandQuietAction");
    expect(within(buttons).getAllByRole("button", { name: "Show 20" })[0]).toHaveClass("commandTextLink");
    expect(within(buttons).getAllByRole("button", { name: "Copy transcript path" })[0]).toHaveClass("commandIconAction");
    expect(within(buttons).getAllByRole("button", { name: "Install plugin" }).some((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(within(buttons).getAllByRole("button", { name: "Full breakdown", pressed: true }).length).toBeGreaterThan(0);
    expect(within(buttons).getByText(/44px/)).toBeInTheDocument();

    expect(screen.getByRole("combobox", { name: "Sample scope" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sample scope, disabled" })).toBeDisabled();
    expect(screen.getAllByText("Claude Code").find((element) => element.classList.contains("providerBadge"))).toBeDefined();
    expect(screen.getAllByText("Codex").find((element) => element.classList.contains("providerBadge"))).toBeDefined();
    expect(screen.getByText("needs input")).toHaveClass("statusPill", "needs_input");
    expect(screen.getByRole("button", { name: /Live/, pressed: true })).toHaveClass("commandFilterChip");
    expect(screen.getByRole("region", { name: "Sample session totals" })).toHaveClass("sessionKpiStrip");
    expect(screen.getByText("--color-brand-fill")).toBeInTheDocument();
    expect(screen.getByText("--space-4")).toBeInTheDocument();
    expect(screen.queryByText(/Design system unavailable here/)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The first render of the whole page is cold and its role queries walk every sample; a hosted
    // Windows runner takes just over the default five seconds for it.
  }, 20_000);

  it("renders static lane and single-chart samples with a neutral, described minimap", () => {
    render(<DesignSystemView />);
    const lanes = screen.getByRole("region", { name: "Lane chart sample" });
    expect(within(lanes).getByRole("button", { name: "Direct subagents · 3 agents", expanded: true })).toHaveClass("commandQuietAction", "requestLaneLabel");
    expect(within(lanes).getByRole("button", { name: "Test sweep · workflow · 5 agents", expanded: false })).toHaveClass("commandQuietAction", "requestLaneLabel");
    expect(within(lanes).getByRole("button", { name: "Focus Primary agent · orchestrator · large-model", pressed: false })).toBeInTheDocument();
    expect(lanes.querySelector('.requestLane.isPrimary[data-lane-kind="agent"]')).not.toBeNull();
    expect(lanes.querySelector('.requestLane[data-lane-kind="compaction"]')).not.toBeNull();
    expect(lanes.querySelector('[class*="roleFamily-"]')).toBeNull();
    const minimap = within(lanes).getByRole("slider", { name: "Request window" });
    expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 9 to 40 of 40");
    expect(minimap).toHaveAccessibleDescription("Drag the window, or use arrow keys, Page Up / Page Down, Home and End.");

    const single = screen.getByRole("region", { name: "Single chart sample" });
    expect(single.querySelectorAll(".requestRoleSegment")).toHaveLength(32);
    expect(within(single).getByLabelText("Agent roles in view")).toHaveTextContent(/orchestrator ×1.*explore ×1/);
    expect(single.querySelector(".requestRoleNamed")).toHaveTextContent(/#34.*Primary agent.*orchestrator/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the Task fields samples from static data: grouped Run on, optional Effort and Done when", async () => {
    const user = userEvent.setup();
    render(<DesignSystemView />);
    const section = screen.getByRole("heading", { level: 2, name: "Task fields" }).closest("section") as HTMLElement;
    const selects = within(section).getAllByRole("combobox", { name: "Run on" });
    expect(selects[0]).toHaveTextContent("Claude Code · model-large");
    expect(selects[1]).toHaveTextContent("Not set");
    const efforts = within(section).getAllByRole("button", { name: "High" });
    expect(efforts[0]).toHaveAttribute("aria-pressed", "true");
    await user.click(efforts[0]);
    expect(efforts[0]).toHaveAttribute("aria-pressed", "false");
    expect(efforts[0].parentElement).toHaveClass("commandSegmented");
    expect(within(section).getAllByRole("checkbox", { name: "Pull request open" })[0]).toBeChecked();
    expect(within(section).getByText("Not passed")).toBeInTheDocument();
    expect(within(section).getByText("Passed")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the Events rail from static data: every kind, the expander, and the empty and unavailable states", async () => {
    const user = userEvent.setup();
    render(<DesignSystemView />);
    const section = screen.getByRole("heading", { level: 2, name: "Events rail" }).closest("section") as HTMLElement;
    const panels = within(section).getAllByRole("region", { name: "Events · newest first" });
    expect(panels).toHaveLength(4);
    const [full, empty, loading, unavailable] = panels as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    const rowName = /, \d\d:\d\d$/;
    // The estimate row has no owning tab, so it is plain text: 9 rows, 8 of them buttons.
    expect(full.querySelectorAll(".sessionEventRow")).toHaveLength(9);
    expect(full.querySelectorAll(".sessionEventRow.isStatic")).toHaveLength(1);
    expect(within(full).getAllByRole("button", { name: rowName })).toHaveLength(8);
    expect(within(full).getAllByRole("button", { name: rowName })[0]).toHaveClass("commandQuietAction", "sessionEventRow");
    await user.click(within(full).getByRole("button", { name: "Show 4 earlier" }));
    expect(full.querySelectorAll(".sessionEventRow")).toHaveLength(13);
    expect(within(full).getByRole("button", { name: "Show fewer" })).toHaveClass("commandTextLink");
    for (const label of ["Agent started", "Agent finished", "Agent stopped", "Signal reported", "Agent estimate updated", "User message", "Resource peak", "Commit observed", "Pull request opened", "Cache refill", "Context compacted"]) {
      expect(within(full).getAllByText(label, { selector: ".sessionEventLabel" }).length).toBeGreaterThan(0);
    }
    expect(within(full).getByText("×2")).toBeInTheDocument();
    expect(within(full).getByText("14 events")).toBeInTheDocument();
    expect(within(empty).getByText("No events recorded.")).toBeInTheDocument();
    expect(within(loading).getByText("Loading Event evidence…")).toBeInTheDocument();
    expect(within(unavailable).getByText("Event evidence unavailable.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the documented phone Activities exceptions from the shared selectors", () => {
    render(<DesignSystemView />);
    const sample = screen.getByRole("region", { name: "Phone Activities exceptions sample" });
    const selected = within(sample).getByLabelText("Selected request #34");
    expect(selected).toHaveClass("activityTableFrame", "isSelectedRequest");
    expect(selected.closest(".activityLayout")).toHaveClass("activityLayout", "isPhone");
    const callLine = within(sample).getByRole("button", { name: /Bash, verify-ui, 0\.8s/ });
    expect(callLine).toHaveClass("activityCallLine");
    expect(callLine.querySelector(".workKindIcon")).not.toBeNull();
    expect(callLine.querySelector("svg.activityCallChevron path")).toHaveAttribute("d", "M6 3l5 5-5 5");
    expect(within(sample).getByText(/Documented exceptions:/)).toBeInTheDocument();
  });

  it("renders the shipped section for actions without a recorded request closed and open from static props", () => {
    const { container } = render(<DesignSystemView />);
    const wrapper = (selector: string) => container.querySelector<HTMLElement>(selector) as HTMLElement;
    const title = "Actions without a recorded request";

    const closed = within(wrapper(".designSystemUnassociatedClosed")).getByRole("region", { name: `${title} 14 tool calls` });
    expect(closed).toHaveClass("activityUnassociated");
    expect(closed.textContent).toBe(`${title} 14 tool calls`);
    expect(within(closed).getByRole("button", { name: `${title} 14 tool calls` })).toHaveAttribute("aria-expanded", "false");
    expect(closed.querySelector("li, .activityUnassociatedMore, .activityUnassociatedBody")).toBeNull();

    const frame = wrapper(".designSystemUnassociatedOpen");
    const section = within(frame).getByRole("region", { name: `${title} 14 tool calls` });
    expect(within(section).getByRole("button", { name: `${title} 14 tool calls` })).toHaveAttribute("aria-expanded", "true");
    expect(section.querySelectorAll(".activityUnassociatedList > li.activityCallItem")).toHaveLength(6);
    expect(within(section).getByRole("button", { name: /Run the focused tests, 12\.8s, failed$/ })).toHaveClass("activityCallLine");
    expect(within(section).getByRole("button", { name: /Check the architecture, —$/ })).toBeInTheDocument();
    const more = within(section).getByRole("button", { name: "Show 8 more calls" });
    expect(more).toHaveClass("commandTextLink", "activityUnassociatedMore");
    expect(more).toBeEnabled();

    // The static request group sits above the section, which stays ruled apart from it and carries no
    // request number and no token value on any of its rows.
    const request = within(frame).getByLabelText("Request #12");
    expect(request.querySelector(".activityTokenValue")).not.toBeNull();
    expect(request.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(request.contains(section)).toBe(false);
    expect(section.querySelector(".activityTokenValue, .requestsActionsNumber, .activityRequestLine")).toBeNull();
    expect(section.textContent).not.toMatch(/#\d/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the shipped agent roster, inspector, command table, and settings rail from static data", async () => {
    const user = userEvent.setup();
    render(<DesignSystemView />);
    const section = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;

    const rosterSection = section("Agent roster");
    const roster = within(rosterSection).getByRole("region", { name: "Agent roster" });
    const primary = within(roster).getByRole("row", { name: /^Primary agent agent/ });
    expect(primary).toHaveClass("rosterPrimary", "rosterSelected");
    expect(primary).toHaveAttribute("aria-selected", "true");
    expect(await within(roster).findByRole("button", { name: /^Workflow · Test sweep/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(roster).getByRole("button", { name: /^Direct subagents/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(roster).getByRole("row", { name: /^Verify collapse at eight lanes — Collapse tests agent/ })).toBeInTheDocument();
    expect(within(rosterSection).getByRole("region", { name: "Agent inspector for Primary agent" })).toBeInTheDocument();
    expect(within(rosterSection).getByRole("group", { name: "Agent activity view" })).toHaveClass("commandSegmented");
    await user.click(within(roster).getByRole("button", { name: "Select Focus tests" }));
    expect(within(rosterSection).getByRole("region", { name: /^Agent inspector for Focus tests/ })).toBeInTheDocument();

    const inspector = within(section("Agent inspector")).getByRole("region", { name: /^Agent inspector for Verify collapse at eight lanes — Collapse tests$/ });
    expect(inspector).toHaveClass("agentInspector-inline");
    expect(within(inspector).getByRole("list", { name: "Agent lineage" })).toHaveTextContent(/Primary agent.*Workflow Test sweep · 4 agents.*Phase Verify · 1 siblings/);
    expect(within(inspector).getByRole("button", { name: /Activities for this agent/ })).toHaveClass("commandSecondaryAction", "inspectorActionRow");

    const tableSection = section("Command table");
    const sampleTable = within(tableSection).getByRole("table", { name: "Sample sessions" });
    const agentsHeader = within(sampleTable).getByRole("columnheader", { name: "Agents" });
    expect(agentsHeader).not.toHaveAttribute("aria-sort");
    expect(within(sampleTable).getByRole("columnheader", { name: "Status" })).not.toHaveClass("commandTableSortable");
    const groupedTable = within(tableSection).getByRole("table", { name: "Grouped sample sessions" });
    expect(within(groupedTable).getByRole("button", { name: /^pomegr/ })).toHaveClass("commandQuietAction", "commandSessionGroupToggle");
    expect(within(groupedTable).getByRole("button", { name: /^catalogus/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(groupedTable).getByRole("button", { name: "Show all 7 in pomegr" })).toHaveClass("commandTextLink");
    await user.click(within(agentsHeader).getByRole("button"));
    expect(agentsHeader).toHaveAttribute("aria-sort", "descending");
    await user.click(within(agentsHeader).getByRole("button"));
    expect(agentsHeader).toHaveAttribute("aria-sort", "ascending");
    const pages = within(tableSection).getByRole("navigation", { name: "Sample session pages" });
    expect(within(pages).getByText("Showing 1–4 of 9")).toBeInTheDocument();
    await user.click(within(pages).getByRole("button", { name: "Next" }));
    expect(within(pages).getByText("Showing 5–8 of 9")).toBeInTheDocument();
    expect(within(pages).getByRole("button", { name: "Go to page 2" })).toHaveAttribute("aria-current", "page");
    expect(within(pages).getByRole("button", { name: "Next" })).toHaveClass("commandSecondaryAction");
    expect(within(tableSection).getByText("No rows to display.")).toHaveClass("commandUnavailableNote");
    expect(within(tableSection).getByRole("heading", { name: "No sessions match these filters" })).toBeInTheDocument();

    const railSection = section("Settings tab rail");
    expect(within(railSection).getByRole("tab", { name: "Appearance", selected: true })).toBeInTheDocument();
    await user.click(within(railSection).getByRole("tab", { name: "Storage" }));
    expect(within(railSection).getByRole("tab", { name: "Storage", selected: true })).toHaveClass("active");
    expect(within(railSection).getByRole("tabpanel")).toHaveTextContent(/Retention and cleanup threshold/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders every task card state from synthetic tasks, with the chip tone and border each state takes", () => {
    render(<DesignSystemView />);
    const board = sectionOf("Task cards and board");
    const card = (label: string) => sample(board, label).querySelector(".taskCard") as HTMLElement;
    const chip = (label: string) => card(label).querySelector(".taskCardChip") as HTMLElement;

    expect(chip("Not queued")).toHaveTextContent("Not queued");
    expect(card("Not queued")).not.toHaveClass("isLive", "isAttention");
    expect(chip("Queued · next")).toHaveTextContent("Queued · next");
    expect(chip("Queued · next")).toHaveClass("commandChip", "isInk");
    expect(card("Queued · next").querySelector(".taskCardFeature")).toHaveTextContent("Upload reliability · step 2 of 3 · parallel");
    expect(chip("Scheduled")).toHaveClass("info");
    expect(card("Scheduled").querySelector(".taskCardStarts")?.textContent).toMatch(/^Starts /);
    // A bound session's state is borrowed; a differing planned model is the one amber line.
    expect(card("Session working")).toHaveClass("isLive");
    expect(chip("Session working")).toHaveTextContent("In progress");
    expect(chip("Session working")).toHaveClass("positive");
    expect(card("Session working").querySelector(".taskCardModelDiffers")).toHaveTextContent("Planned model-large, observed model-small");
    for (const label of ["Needs review", "Stalled", "Blocked by agent"]) {
      expect(card(label)).toHaveClass("isAttention");
      expect(chip(label)).toHaveTextContent(label);
      expect(chip(label)).toHaveClass("warning");
    }
    expect(card("Done")).toHaveClass("isDone");
    expect(within(card("Done")).getByRole("link", { name: "Open session" })).toHaveClass("commandTextLink", "taskCardLink");
    expect(within(card("Done")).getByRole("link", { name: "Open session" }).getAttribute("href")).toMatch(/^\/sessions\//);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the desktop-only card, column and filter controls, inert", async () => {
    const user = userEvent.setup();
    render(<DesignSystemView />);
    const board = sectionOf("Task cards and board");

    const desktop = sample(board, "Card, desktop app").querySelector(".taskCard") as HTMLElement;
    expect(desktop).toHaveAttribute("draggable", "true");
    expect(within(desktop).getByRole("button", { name: "Show the retry count in the upload log" })).toHaveClass("commandQuietAction", "taskCardOpen");
    const moves = within(desktop).getByRole("toolbar", { name: "Move T-3" });
    expect(within(moves).getAllByRole("button")).toHaveLength(4);
    expect(within(moves).getByRole("button", { name: "Move T-3 up" })).toBeDisabled();
    expect(within(moves).getByRole("button", { name: "Move T-3 to the next column" })).toHaveClass("commandIconAction");

    const readOnlyHeader = sample(board, "Column header");
    expect(within(readOnlyHeader).getByRole("heading", { level: 3, name: "In progress" })).toBeInTheDocument();
    expect(within(readOnlyHeader).queryByRole("button")).toBeNull();
    const desktopHeader = sample(board, "Column header, desktop app");
    await user.click(within(desktopHeader).getByRole("button", { name: "Edit column In progress" }));
    expect(within(desktopHeader).getByRole("textbox", { name: "Column name" })).toHaveValue("In progress");
    expect(within(desktopHeader).getByRole("button", { name: "Delete column In progress" })).toBeDisabled();
    expect(within(desktopHeader).getByText("A column must be empty to be deleted.")).toBeInTheDocument();
    await user.click(within(sample(board, "Add column")).getByRole("button", { name: /Add column/ }));
    expect(within(sample(board, "Add column")).getByRole("textbox")).toBeInTheDocument();

    const filter = sample(board, "Feature filter");
    expect(within(filter).getByRole("button", { name: /^All/, pressed: true })).toHaveClass("commandSecondaryAction");
    expect(within(filter).getByRole("button", { name: /^No feature/ })).toBeInTheDocument();
    expect(within(filter).queryByRole("button", { name: "+ New feature" })).toBeNull();
    const desktopFilter = sample(board, "Feature filter, desktop app");
    expect(within(desktopFilter).getByRole("button", { name: "+ New feature" })).toHaveClass("commandQuietAction");
    await user.click(within(desktopFilter).getByRole("button", { name: /^Upload reliability/ }));
    expect(within(desktopFilter).getByText("Moving cards is off while a feature filter is on.")).toBeInTheDocument();

    const strip = within(sample(board, "Capacity strip")).getByRole("region", { name: "Provider capacity" });
    expect(strip).toHaveTextContent("Claude Code 5h 91% · 7d 37%");
    expect(strip).toHaveTextContent("Codex 5h 38% · 7d 12%");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the whole task board read-only and with desktop controls, and each non-ready board state", () => {
    render(<DesignSystemView />);
    const board = sectionOf("Task cards and board");

    const browser = sample(board, "Board, browser (blocked queue)");
    expect(within(browser).getByRole("region", { name: "Queue status" })).toHaveTextContent("Queue blocked");
    expect(within(browser).getByRole("region", { name: "Task board" })).toBeInTheDocument();
    expect(browser.querySelectorAll(".taskColumn")).toHaveLength(5);
    expect(browser.querySelector(".taskCard[draggable]")).toBeNull();
    expect(browser.querySelector(".taskColumnEdit")).toBeNull();
    expect(browser.querySelector(".taskBoardFootnote")).toBeNull();

    const desktop = sample(board, "Board, desktop app (queue on)");
    expect(desktop.querySelectorAll(".taskCard[draggable='true']")).toHaveLength(8);
    expect(desktop.querySelectorAll(".taskColumnEdit")).toHaveLength(5);
    expect(desktop.querySelector(".taskBoardFootnote")).toHaveTextContent(/^Drag a card to another column/);
    expect(within(desktop).queryByRole("region", { name: "Queue status" })).toBeNull();
    expect(within(desktop).getByRole("button", { name: "+ New feature" })).toBeInTheDocument();

    const blocked = sample(board, "Board, desktop app (blocked queue)");
    expect(within(blocked).getByRole("button", { name: "Open T-2" })).toHaveClass("commandSecondaryAction");
    expect(within(blocked).queryByRole("button", { name: "Mark done and resume" })).toBeNull();

    expect(sample(board, "Board, loading").querySelector(".taskBoardSkeleton")).toHaveAttribute("aria-label", "Loading tasks");
    expect(within(sample(board, "Board, unavailable")).getByRole("status")).toHaveTextContent("Tasks are unavailable.");
    expect(within(sample(board, "Board, desktop only")).getByText("Desktop only")).toHaveClass("commandChip");
    expect(within(sample(board, "Board, no tasks")).getByText("No tasks on this board yet.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the queue switch, banners, step cards, feature panels, single tasks and rules from static data", () => {
    render(<DesignSystemView />);
    const queue = sectionOf("Task queue");

    expect(within(within(sample(queue, "Queue switch, off")).getByRole("group", { name: "Queue" })).getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
    expect(within(within(sample(queue, "Queue switch, on")).getByRole("group", { name: "Queue" })).getByRole("button", { name: "On" })).toHaveAttribute("aria-pressed", "true");
    expect(within(sample(queue, "Queue switch, busy")).getByRole("button", { name: "On" })).toBeDisabled();

    const boardBanner = within(sample(queue, "Banner, blocked (Board)")).getByRole("region", { name: "Queue status" });
    expect(boardBanner).toHaveTextContent("T-2 reported complete, but one check did not pass.");
    expect(within(boardBanner).getByRole("button", { name: "Open T-2" })).toHaveClass("commandSecondaryAction");
    const resolvable = within(sample(queue, "Banner, blocked (Queue)")).getByRole("region", { name: "Queue status" });
    expect(resolvable).toHaveTextContent('the check "CI passed" did not pass');
    expect(within(resolvable).getByRole("button", { name: "Mark done and resume" })).toHaveClass("commandSecondaryAction");
    expect(within(resolvable).getByRole("button", { name: "Requeue T-2" })).toHaveClass("commandQuietAction");
    const paused = within(sample(queue, "Banner, paused")).getByRole("region", { name: "Queue status" });
    expect(paused).toHaveTextContent("Queue paused");
    expect(paused).toHaveTextContent("command-line tool was not found");
    expect(within(paused).queryByRole("button", { name: "Mark done and resume" })).toBeNull();
    expect(within(within(sample(queue, "Banner, browser")).getByRole("region", { name: "Queue status" })).queryByRole("button")).toBeNull();

    const cards = sample(queue, "Queue cards");
    expect(cards.querySelectorAll(".taskQueueCard")).toHaveLength(3);
    expect(cards.querySelector(".taskCardWaiting")).toHaveTextContent("Waiting: Claude Code is above 85% of the five-hour window");
    expect(within(cards).getByRole("combobox", { name: "Move T-3 to step" })).toBeInTheDocument();

    const browserPanel = within(sample(queue, "Feature panel, browser")).getByRole("region", { name: "Upload reliability" });
    expect(browserPanel.querySelector(".taskQueueCaption")).toHaveTextContent("1 of 4 tasks done");
    expect(within(browserPanel).getByText("Parallel · 2")).toBeInTheDocument();
    expect(within(browserPanel).getByText("One worktree each")).toBeInTheDocument();
    expect(browserPanel.querySelector(".taskQueueStep.isAllDone")).not.toBeNull();
    expect(browserPanel.querySelector(".taskQueueNote")?.textContent).not.toMatch(/Drag/);
    expect(browserPanel.querySelector(".taskQueueNewStep")).toBeNull();
    const desktopPanel = within(sample(queue, "Feature panel, desktop app")).getByRole("region", { name: "Upload reliability" });
    expect(desktopPanel.querySelector(".taskQueueNote")?.textContent).toMatch(/^Steps run in order\..*Drag a queued task/);
    expect(within(desktopPanel).getByRole("group", { name: "New last step" })).toHaveTextContent("Drop a queued task here to add a step at the end");
    expect(desktopPanel.querySelectorAll(".taskQueueCard[draggable='true']")).toHaveLength(3);

    const singles = within(sample(queue, "Single tasks")).getByRole("region", { name: "Single tasks" });
    expect(within(singles).getByText("T-7").closest("li")?.querySelector(".taskCardChip")?.textContent).toMatch(/^Scheduled · /);
    expect(within(singles).getByText("T-6").closest("li")?.querySelector(".taskCardChip")).toHaveTextContent("In progress");
    expect(within(sample(queue, "Single tasks, none queued")).getByText("No single task is queued.")).toBeInTheDocument();
    const rules = within(sample(queue, "When the queue blocks")).getByRole("list");
    expect(within(rules).getByText("Needs review")).toHaveClass("taskBlockState", "isReview");
    expect(within(rules).getByText("Stalled")).toHaveClass("isError");
    expect(within(rules).getByText("Blocked by agent")).toHaveClass("isError");

    const browserView = sample(queue, "Queue view, browser (blocked queue)");
    expect(browserView.querySelector(".taskQueueRow > .taskQueueAside")).not.toBeNull();
    expect(within(browserView).getByRole("region", { name: "Queue status" })).toBeInTheDocument();
    expect(within(browserView).getByRole("heading", { level: 2, name: "Schedule" })).toBeInTheDocument();
    expect(within(browserView).queryByRole("combobox", { name: "Do not start above" })).toBeNull();
    const desktopView = sample(queue, "Queue view, desktop app (queue on)");
    expect(within(desktopView).getByRole("combobox", { name: "Do not start above" })).toBeInTheDocument();
    expect(within(desktopView).getByRole("group", { name: "Queue start" })).toHaveClass("commandSegmented");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the Start gates and Schedule panels in every reading from static data", () => {
    render(<DesignSystemView />);
    const gates = sectionOf("Start gates and schedule");

    const held = sample(gates, "Start gates, held");
    expect(reading(held, "Claude Code capacity")).toHaveTextContent("5h 91% · 7d 37% · above threshold");
    expect(reading(held, "Claude Code capacity")).toHaveClass("isMono", "is-error");
    expect(reading(held, "Codex capacity")).toHaveTextContent("5h 38% · 7d 12%");
    expect(reading(held, "Provider status")).toHaveClass("is-ok");
    expect(reading(held, "Working tree")).toHaveTextContent("Clean");
    expect(within(held).getByText("Do not start above").nextElementSibling).toHaveTextContent("85% of the five-hour window");
    expect(within(held).queryByRole("combobox")).toBeNull();
    expect(within(sample(gates, "Start gates, desktop app")).getByRole("combobox", { name: "Do not start above" })).toHaveTextContent("85% of the five-hour window");

    const stopped = sample(gates, "Start gates, stopped");
    expect(reading(stopped, "Previous step done")).toHaveTextContent("Blocked by T-2");
    expect(reading(stopped, "Provider status")).toHaveTextContent("Incident: Claude Code");
    expect(reading(stopped, "Working tree")).toHaveTextContent("Uncommitted changes");
    for (const label of ["Previous step done", "Provider status", "Working tree"]) expect(reading(stopped, label)).toHaveClass("is-error");

    const unknown = sample(gates, "Start gates, unknown");
    expect(reading(unknown, "Previous step done")).toHaveTextContent("No task queued");
    for (const label of ["Previous step done", "Claude Code capacity", "Codex capacity", "Provider status", "Working tree"]) expect(reading(unknown, label)).toHaveClass("is-muted");
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
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the Sessions list Task cell for every outcome and the feature fields, from static references", async () => {
    const user = userEvent.setup();
    render(<DesignSystemView />);
    const cells = sectionOf("Sessions list Task cell");

    const working = sample(cells, "Working on the task");
    expect(within(working).getByRole("link", { name: "Open task T-14 on its board" })).toHaveAttribute("href", `/repositories/${REPOSITORY_ID}?tab=tasks`);
    expect(within(working).getByRole("link", { name: "Open task T-14 on its board" })).toHaveClass("commandTextLink", "commandSessionTaskId");
    expect(working.querySelector(".commandChip")).toBeNull();
    expect(working.querySelector(".commandSessionTaskFeature")).toHaveTextContent("Upload reliability · step 2");
    expect(sample(cells, "Needs review").querySelector(".commandChip")).toHaveClass("warning");
    expect(sample(cells, "Stalled").querySelector(".commandChip")).toHaveTextContent("Stalled");
    expect(sample(cells, "Stalled").querySelector(".commandChip")).toHaveClass("warning");
    expect(sample(cells, "Done").querySelector(".commandChip")).toHaveClass("neutral");
    expect(sample(cells, "Under a Feature group").querySelector(".commandSessionTaskFeature")?.textContent).toBe("Step 2");
    expect(sample(cells, "No feature").querySelector(".commandSessionTaskFeature")).toBeNull();
    expect(within(sample(cells, "Started by you")).getByTitle("Not started from a task")).toHaveTextContent("—");
    expect(within(sample(cells, "Table footnote")).getByText(/^Task shows the task a session was started for\./)).toHaveClass("commandUnavailableNote");

    const fields = sectionOf("Task fields");
    expect(within(fields).getAllByRole("combobox", { name: "Feature" })).toHaveLength(3);
    expect(within(fields).getAllByRole("combobox", { name: "Step in feature" })).toHaveLength(3);
    expect(within(fields).getAllByRole("combobox", { name: "Feature" })[0]).toHaveTextContent("Upload reliability");
    const created = sample(fields, "New feature");
    expect(within(created).getByRole("textbox", { name: "Feature name" })).toHaveValue("Retry telemetry");
    const placed = sample(fields, "Feature and Step");
    expect(placed.querySelector(".taskFeatureDetails > summary")).toHaveTextContent("In this feature4 tasks · 1 done");
    expect(placed.querySelectorAll(".taskFeatureItem")).toHaveLength(4);
    expect(placed.querySelector(".taskFeatureItem.hasStep")).toBeNull();
    const inPanel = sample(fields, "Feature and Step, in the Task panel");
    expect(inPanel.querySelectorAll(".taskFeatureItem")).toHaveLength(3);
    expect(inPanel.querySelectorAll(".taskFeatureItem.hasStep")).toHaveLength(3);
    await user.type(within(created).getByRole("textbox", { name: "Feature name" }), "!");
    expect(within(created).getByRole("textbox", { name: "Feature name" })).toHaveValue("Retry telemetry!");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hydrates the server-rendered page, including SVG titles, without a mismatch", async () => {
    const html = renderToString(<DesignSystemPage />);
    expect(html).toContain(">Possible full refill · request #38</title>");
    expect(html).not.toContain("<title></title>");
    const container = document.body.appendChild(document.createElement("div"));
    container.innerHTML = html;
    const recoverable = vi.fn();
    const root = await act(async () => hydrateRoot(container, <DesignSystemPage />, { onRecoverableError: recoverable }));
    expect(recoverable).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it("renders the unavailable view instead of the reference when the desktop bridge is present", () => {
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { getDesktopState: async () => null };
    render(<DesignSystemView />);
    expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
    expect(screen.getByText("Design system unavailable here")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Buttons" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install plugin" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the unavailable view for paired phone-access clients", () => {
    clientAccess.mode = "lan";
    render(<DesignSystemView />);
    expect(screen.getByText("Design system unavailable here")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Buttons" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays out of navigation, the LAN allowlist, and monitor clients", () => {
    expect(source("app/components/command-center/CommandCenterShell.tsx")).not.toMatch(/design-system/);
    expect(source("desktop/runtime/lan-gateway.mjs")).not.toMatch(/design-system/);
    expect(source("desktop/runtime/shell-main.mjs")).not.toMatch(/design-system/);
    for (const file of SAMPLE_SOURCES) {
      const view = source(file);
      expect(view).not.toMatch(/fetch\(|EventSource|\/api\//);
      expect(view).not.toMatch(/agents-client|usage-limits-client|provider-status-client|SessionCatalogContext|next\/link|next\/navigation/);
    }
  });
});
