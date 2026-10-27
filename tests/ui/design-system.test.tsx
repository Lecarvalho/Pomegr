import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
import { TaskFieldsSection } from "../../app/components/design-system/DesignSystemTaskFieldsSample";
import { FeatureModalSamples } from "../../app/components/design-system/DesignSystemFeatureModalSample";
import { EventsRailSection } from "../../app/components/design-system/DesignSystemEventsSample";
import { TaskBoardSection } from "../../app/components/design-system/DesignSystemTaskBoardSample";
import { QueueControlsSection, TaskGatesSection } from "../../app/components/design-system/DesignSystemTaskGatesSample";
import { SessionTaskSection } from "../../app/components/design-system/DesignSystemSessionTaskSample";
import { AgentChatSection } from "../../app/components/design-system/DesignSystemAgentChatSample";
import { AgentRosterSection, AgentInspectorSection, InspectorSheetSection } from "../../app/components/design-system/DesignSystemAgentSamples";
import { CommandTableSection, SettingsRailSection } from "../../app/components/design-system/DesignSystemLayoutSamples";
import { RevisionEvidenceSection } from "../../app/components/design-system/DesignSystemRepositorySamples";
import DesignSystemPage from "../../app/design-system/page";
const ROLE_HEADINGS = ["Primary", "Secondary", "Segmented", "Quiet", "Text link", "Icon"];
const SECTION_HEADINGS = ["Buttons", "Form fields", "Request charts", "Events rail", "Agent roster", "Agent grid tile states", "Agent inspector", "Inspector sheet frame", "Revision evidence", "Repository setup row states", "Chips and pills", "Panels and dividers", "Command table", "Settings tab rail", "Task fields", "Task cards and board", "Queue controls", "Start gates and schedule", "Sessions list Task cell", "Assigned sessions", "Promote issues", "GitHub settings", "Agent chat", "Typography and tokens"];
const SAMPLE_SOURCES = [
  "DesignSystemView", "DesignSystemKit", "DesignSystemAgentSamples", "DesignSystemAgentGridSample", "DesignSystemLayoutSamples", "DesignSystemEventsSample", "DesignSystemTaskFieldsSample", "DesignSystemFeatureModalSample",
  "DesignSystemTaskBoardSample", "DesignSystemTaskGatesSample", "DesignSystemSessionTaskSample", "DesignSystemAssignedSessionsSample", "DesignSystemAgentChatSample", "DesignSystemRepositorySamples",
].map((name) => `app/components/design-system/${name}.tsx`).concat("app/components/design-system/DesignSystemTaskSampleData.ts");
const REPOSITORY_ID = "repo-0123456789abcdef01234567";
function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}
function sectionOf(name: string) {
  return screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
}
function sample(root: HTMLElement, label: string) {
  return within(root).getByText(label, { selector: ".designSystemSample > span" }).closest(".designSystemSample") as HTMLElement;
}
function reading(root: HTMLElement, label: string) {
  return within(root).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

// Keep page composition/hydration coverage; isolate samples so queries do not traverse unrelated sections.
describe("Design-system reference page", { timeout: 20_000 }, () => {
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
    expect(within(screen.getByRole("region", { name: "Chips and pills" })).getByText("needs input")).toHaveClass("statusPill", "needs_input");
    expect(screen.getByRole("button", { name: /Live/, pressed: true })).toHaveClass("commandFilterChip");
    expect(screen.getByRole("region", { name: "Sample session totals" })).toHaveClass("sessionKpiStrip");
    expect(screen.getByText("--color-brand-fill")).toBeInTheDocument();
    expect(screen.getByText("--space-4")).toBeInTheDocument();
    expect(screen.queryByText(/Design system unavailable here/)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The full-page composition check retains its cold-render allowance.
  }, 40_000);

  it("mounts the inspector sheet and revision evidence sections directly", () => {
    render(<><InspectorSheetSection /><RevisionEvidenceSection /></>);
    expect(screen.getByRole("heading", { name: "Inspector sheet frame" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Revision evidence" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 5_000);

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

  it("renders the Task fields samples from static data: grouped Run on, required Effort and Complete when", async () => {
    const user = userEvent.setup();
    render(<TaskFieldsSection />);
    const section = screen.getByRole("heading", { level: 2, name: "Task fields" }).closest("section") as HTMLElement;
    const chosen = within(sample(section, "Run on and Effort, chosen"));
    expect(chosen.getByRole("combobox", { name: "Run on" })).toHaveTextContent("Claude Code · model-large");
    // Only the sample of a task stored with nothing chosen shows Not set.
    expect(within(sample(section, "Stored task with nothing chosen, no model list")).getByRole("combobox", { name: "Run on" })).toHaveTextContent("Not set");
    expect(within(sample(section, "Remote Control, on")).getByRole("combobox", { name: "Run on" })).toHaveTextContent("Claude Code · Default model");
    const effort = chosen.getByRole("button", { name: "High" });
    expect(effort).toHaveAttribute("aria-pressed", "true");
    await user.click(effort);
    expect(effort).toHaveAttribute("aria-pressed", "true");
    expect(effort.parentElement).toHaveClass("commandSegmented");
    expect(within(sample(section, "Complete when, new task")).getByRole("checkbox", { name: "PR open" })).toBeChecked();
    // The three review verdict samples also show the builder report's outcomes.
    expect(within(section).getAllByText("Not passed")).toHaveLength(5);
    expect(within(section).getAllByText("Passed")).toHaveLength(8);
    // A condition Pomegr could not verify is muted: it takes neither result color.
    const unverified = within(section).getAllByText("Not verified");
    expect(unverified.length).toBeGreaterThan(0);
    for (const note of unverified) expect(note.className).toBe("taskCheckResult");
    // The rich text sample with tags draws them as the chips row above the title line.
    const tagged = within(section).getByRole("group", { name: "Tags: backend, recce, bug" });
    expect(tagged.parentElement).toHaveClass("taskRichText");
    expect(tagged.nextElementSibling).toHaveClass("taskRichTitle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the Events rail from static data: every kind, the expander, and the empty and unavailable states", async () => {
    const user = userEvent.setup();
    render(<EventsRailSection />);
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
    await user.click(within(full).getByRole("button", { name: "Show 9 earlier" }));
    expect(full.querySelectorAll(".sessionEventRow")).toHaveLength(18);
    expect(within(full).getByRole("button", { name: "Show fewer" })).toHaveClass("commandTextLink");
    for (const label of ["Agent started", "Agent finished", "Agent stopped", "Signal reported", "Agent estimate updated", "User message", "Resource peak", "Commit observed", "Pull request opened", "Cache refill", "Context compacted", "Task updated", "Task added", "Task removed", "Task reported complete", "Task reported blocked"]) {
      expect(within(full).getAllByText(label, { selector: ".sessionEventLabel" }).length).toBeGreaterThan(0);
    }
    expect(within(full).getByText("×2")).toBeInTheDocument();
    expect(within(full).getByText("19 events")).toBeInTheDocument();
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
    render(<><AgentRosterSection /><AgentInspectorSection /><CommandTableSection /><SettingsRailSection /></>);
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

  it("renders every task card state from synthetic tasks, with the chip the lane leaves and the border each state takes", () => {
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
    expect(card("Done")).toHaveClass("isDone");
    // Open session is muted with an arrow glyph, never the brand link color.
    const open = within(card("Done")).getByRole("link", { name: "Open session" });
    expect(open).toHaveClass("commandTextLink", "taskCardLink");
    expect(open.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(open.getAttribute("href")).toMatch(/^\/sessions\//);
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(fetchSpy).not.toHaveBeenCalled();
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

    const blocked = sample(board, "Board, desktop app (blocked queue)");
    expect(within(blocked).getByRole("button", { name: "Open T-2" })).toHaveClass("commandSecondaryAction");
    expect(within(blocked).getByRole("button", { name: "Mark done and resume" })).toHaveClass("commandSecondaryAction");
    expect(within(blocked).getByRole("button", { name: "Requeue T-2" })).toHaveClass("commandQuietAction");
    expect(within(sample(board, "Board, browser (blocked queue)")).getByRole("region", { name: "Queue status" }).querySelector("button")).toBeNull();

    expect(sample(board, "Board, loading").querySelector(".taskBoardSkeleton")).toHaveAttribute("aria-label", "Loading tasks");
    expect(within(sample(board, "Board, unavailable")).getByRole("status")).toHaveTextContent("Tasks are unavailable.");
    expect(within(sample(board, "Board, desktop only")).getByText("Desktop only")).toHaveClass("commandChip");
    expect(within(sample(board, "Board, no tasks")).getByText("No tasks on this board yet.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the queue switch, banners, header actions and Queue settings from static data", () => {
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
    expect(within(actions).getByRole("link", { name: "Promote issues" })).toBeInTheDocument();

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
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the Start gates and Schedule panels in every reading from static data", () => {
    render(<TaskGatesSection />);
    const gates = sectionOf("Start gates and schedule");

    // Every sample is a frameless section of the Queue settings panel, under an h3.
    expect(gates.querySelectorAll(".taskQueueSettings").length).toBeGreaterThan(0);
    expect(within(sample(gates, "Start gates, held")).getByRole("heading", { level: 3, name: "Start gates" })).toBeInTheDocument();
    expect(sample(gates, "Start gates, held").querySelector(".panel")).toBeNull();
    const held = sample(gates, "Start gates, held");
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
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the Feature modal as static chrome: both modes, the live primary, the unread fields and the three failure lines", async () => {
    const user = userEvent.setup();
    const { container: fields } = render(<FeatureModalSamples />);

    const created = sample(fields, "Feature modal, new feature");
    expect(within(created).getByRole("heading", { level: 2, name: "New feature" })).toBeInTheDocument();
    expect(created.querySelector(".taskModalSubtitle")).toHaveTextContent("pomegr");
    const title = within(created).getByRole("textbox", { name: "Title" });
    expect(title).toHaveAttribute("maxlength", "80");
    expect(title).toHaveAttribute("placeholder", "What is this feature?");
    expect(within(created).getByRole("textbox", { name: "Description" })).not.toHaveAttribute("maxlength");
    const version = within(created).getByRole("textbox", { name: "App version" });
    expect(version).toHaveClass("taskOwnInput", "featureVersion");
    expect(version).toHaveAttribute("maxlength", "40");
    expect(created.querySelectorAll(".newTaskField.featureField")).toHaveLength(3);
    expect([...created.querySelectorAll(".featureCounter")].map((counter) => counter.textContent)).toEqual(["0 / 80", "0 / 2,000"]);
    const create = within(created).getByRole("button", { name: "Create feature" });
    expect(create).toBeDisabled();
    expect(create).toHaveClass("commandPrimaryAction");
    expect(within(created).getByRole("button", { name: "Cancel" })).toHaveClass("commandQuietAction");
    await user.type(title, "Retry telemetry");
    expect(created.querySelector(".featureCounter")).toHaveTextContent("15 / 80");
    expect(create).toBeEnabled();
    // The Description counter takes the error colour past its bound, and the primary is disabled.
    fireEvent.change(within(created).getByRole("textbox", { name: "Description" }), { target: { value: "x".repeat(2001) } });
    expect(created.querySelectorAll(".featureCounter")[1]).toHaveClass("isOver");
    expect(created.querySelectorAll(".featureCounter")[1]).toHaveTextContent("2,001 / 2,000");
    expect(create).toBeDisabled();

    const stored = sample(fields, "Feature modal, feature, saved");
    expect(within(stored).getByRole("heading", { level: 2, name: "Feature" })).toBeInTheDocument();
    expect(stored.querySelector(".taskModalTitleGroup .commandChip")).toHaveClass("taskCardChip", "neutral");
    expect(stored.querySelector(".taskModalTitleGroup .commandChip")).toHaveTextContent("1 of 3 done");
    const save = within(stored).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(save).toHaveClass("commandPrimaryAction");
    expect(within(stored).getByRole("button", { name: "Delete feature" })).toHaveClass("commandQuietAction");
    expect(within(stored).queryByRole("button", { name: "Cancel" })).toBeNull();
    const tasks = stored.querySelector("details.taskFeatureDetails") as HTMLDetailsElement;
    expect(tasks.open).toBe(false);
    expect(tasks.querySelector(".taskFeatureLabel")).toHaveTextContent("Tasks");
    expect(tasks.querySelector(".taskFeatureCount")).toHaveTextContent("3 tasks · 1 done");
    expect(tasks.querySelectorAll(".taskFeatureItem")).toHaveLength(3);
    expect(tasks.querySelector(".taskFeatureOpen")).toBeInTheDocument();
    await user.type(within(stored).getByRole("textbox", { name: "App version" }), "1");
    expect(save).toBeEnabled();
    expect(within(sample(fields, "Feature modal, feature, changed")).getByRole("button", { name: "Save" })).toBeEnabled();

    const unread = sample(fields, "Feature modal, details not read");
    expect(within(unread).getByRole("textbox", { name: "Description" })).toBeDisabled();
    expect(within(unread).getByRole("textbox", { name: "App version" })).toBeDisabled();
    expect(within(unread).getByRole("textbox", { name: "Title" })).toBeEnabled();
    expect(within(unread).getByRole("alert")).toHaveTextContent("The description and app version could not be read.");

    const duplicate = sample(fields, "Feature modal, duplicate title");
    const line = within(duplicate).getByRole("alert");
    expect(line).toHaveClass("newTaskError");
    expect(line).toHaveTextContent("Another feature already has this title.");
    expect(within(duplicate).getByRole("textbox", { name: "Title" }).getAttribute("aria-describedby")?.split(" ")).toContain(line.id);
    expect(within(sample(fields, "Feature modal, could not save")).getByRole("alert")).toHaveTextContent("The feature could not be saved.");
    expect(within(sample(fields, "Feature modal, feature limit")).getByRole("alert")).toHaveTextContent("This board already holds 50 features. Delete one first.");
    // The delete footer: the confirmation with the tasks, the started task that blocks it, and the failed delete.
    const confirmation = sample(fields, "Feature modal, delete confirmation");
    expect(within(confirmation).queryByRole("button", { name: "Save" })).toBeNull();
    const group = within(confirmation).getByRole("group", { name: "Confirm delete" });
    expect(group.querySelector(".taskModalNote")).toHaveTextContent("Delete this feature? Its 3 tasks stay on the board with no feature. This cannot be undone.");
    expect(within(group).getByRole("button", { name: "Delete feature" })).toHaveClass("commandSecondaryAction");
    await user.click(within(group).getByRole("button", { name: "Keep feature" }));
    expect(within(confirmation).queryByRole("group", { name: "Confirm delete" })).toBeNull();
    expect(within(confirmation).getByRole("button", { name: "Delete feature" })).toHaveClass("commandQuietAction");
    const blocked = sample(fields, "Feature modal, delete blocked");
    expect(blocked.querySelector(".taskModalResolve .taskModalNote")).toHaveTextContent("T-2 is running. Delete the feature after its tasks finish.");
    expect(within(blocked).getByRole("button", { name: "Delete feature" })).toBeDisabled();
    expect(within(sample(fields, "Feature modal, could not delete")).getByRole("alert")).toHaveTextContent("The feature could not be deleted.");
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("renders the Sessions list Task cell for every outcome and the feature fields, from static references", async () => {
    const user = userEvent.setup();
    render(<><SessionTaskSection /><TaskFieldsSection /></>);
    const cells = sectionOf("Sessions list Task cell");

    const working = sample(cells, "Working on the task");
    expect(within(working).getByRole("link", { name: "Open task T-14 on its board" })).toHaveAttribute("href", `/tasks?repository=${REPOSITORY_ID}`);
    expect(within(working).getByRole("link", { name: "Open task T-14 on its board" })).toHaveClass("commandTextLink", "commandSessionTaskId");
    expect(working.querySelector(".commandChip")).toBeNull();
    expect(working.querySelector(".commandSessionTaskFeature")).toHaveTextContent("Upload reliability");
    expect(sample(cells, "Needs review").querySelector(".commandChip")).toHaveClass("warning");
    expect(sample(cells, "Stalled").querySelector(".commandChip")).toHaveTextContent("Stalled");
    expect(sample(cells, "Stalled").querySelector(".commandChip")).toHaveClass("warning");
    expect(sample(cells, "Done").querySelector(".commandChip")).toHaveClass("neutral");
    expect(sample(cells, "Under a Feature group").querySelector(".commandSessionTaskFeature")).toBeNull();
    expect(sample(cells, "No feature").querySelector(".commandSessionTaskFeature")).toBeNull();
    expect(within(sample(cells, "Started by you")).getByTitle("Not started from a task, reviewing one, or assigned to one")).toHaveTextContent("—");
    expect(within(sample(cells, "Table footnote")).getByText(/^Task shows the task a session was started for or reviewed \(marked Review\), and the tasks it is assigned to\./)).toHaveClass("commandUnavailableNote");

    const fields = sectionOf("Task fields");
    expect(within(fields).getAllByRole("combobox", { name: "Feature" })).toHaveLength(4);
    expect(within(fields).queryByRole("combobox", { name: "Step" })).not.toBeInTheDocument();
    expect(within(fields).getAllByRole("combobox", { name: "Feature" })[0]).toHaveTextContent("Upload reliability");
    const created = sample(fields, "New feature");
    expect(within(created).getByRole("textbox", { name: "Feature name" })).toHaveValue("Retry telemetry");
    const placed = sample(fields, "Feature");
    expect(placed.querySelector(".taskFeatureDetails > summary")).toHaveTextContent("In this feature3 tasks · 1 done");
    expect(placed.querySelectorAll(".taskFeatureItem")).toHaveLength(3);
    const inPanel = sample(fields, "Feature, in the Task modal");
    expect(inPanel.querySelectorAll(".taskFeatureItem")).toHaveLength(3);
    await user.type(within(created).getByRole("textbox", { name: "Feature name" }), "!");
    expect(within(created).getByRole("textbox", { name: "Feature name" })).toHaveValue("Retry telemetry!");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the Aril chat from invented conversations: the launcher states, the panel, every proposal state and the composer", () => {
    render(<AgentChatSection />);
    const chat = sectionOf("Agent chat");
    const launcherOf = (label: string, name: string) => within(sample(chat, label)).getByRole("button", { name });
    expect(launcherOf("Launcher", "Open Aril, the Pomegr agent")).toHaveClass("agentChatLauncher", "isStatic");
    expect(launcherOf("Launcher, answering", "Open Aril, the Pomegr agent, answering")).toHaveTextContent("Aril · answering…");
    const fresh = launcherOf("Launcher, new answer", "Open Aril, the Pomegr agent, new answer");
    expect(fresh.querySelector(".agentChatLauncherDot")).not.toBeNull();

    const empty = sample(chat, "Panel, empty");
    expect(within(empty).getByRole("region", { name: "Aril, the Pomegr agent" })).toHaveClass("agentChatPanel", "isStatic");
    expect(within(empty).getByRole("heading", { level: 3, name: "Ask Aril about this board" })).toBeInTheDocument();
    expect(within(empty).getAllByRole("button").filter((button) => button.classList.contains("agentChatSuggestion"))).toHaveLength(4);
    expect(within(empty).getByRole("combobox", { name: "Repository" })).toHaveTextContent("pomegr");
    expect(within(empty).getByRole("textbox", { name: "Message Aril" })).toBeEnabled();

    const proposed = sample(chat, "Panel, proposal");
    const rows = within(within(proposed).getByRole("region", { name: "Proposed board changes" })).getAllByRole("listitem");
    expect(rows).toHaveLength(8);
    expect(rows[3]).toHaveTextContent("Delete T-14");
    expect(within(proposed).getByRole("button", { name: "Apply changes" })).toHaveClass("commandPrimaryAction");
    expect(within(proposed).getByRole("button", { name: "Dismiss" })).toHaveClass("commandQuietAction");

    const writing = sample(chat, "Panel, answer being written");
    expect(within(writing).getByRole("status")).toHaveTextContent("Reading repository files…");
    expect(within(writing).getByRole("button", { name: "Stop" })).toHaveClass("commandSecondaryAction");
    expect(within(writing).queryByRole("button", { name: "Send" })).toBeNull();

    const history = sample(chat, "Panel, conversations");
    expect(within(history).getByRole("heading", { level: 3, name: "Conversations" })).toBeInTheDocument();
    expect(history.querySelectorAll(".agentChatHistoryItem")).toHaveLength(3);
    expect(history.querySelectorAll(".agentChatHistoryOpen[aria-current='true']")).toHaveLength(1);
    expect(within(history).getByRole("button", { name: "Conversations", pressed: true })).toHaveClass("commandIconAction");

    const notes = sample(chat, "Panel, notes under an answer");
    expect(within(notes).getByText("This answer took too long and was stopped.")).toBeInTheDocument();
    expect(within(notes).getByText(/^Aril wrote a proposal that Pomegr could not read/)).toHaveClass("taskNotice", "warning");
    expect(within(sample(chat, "Panel, no repository")).getByRole("textbox", { name: "Message Aril" })).toBeDisabled();

    const chipOf = (label: string) => sample(chat, label).querySelector(".commandChip");
    expect(sample(chat, "Proposal, pending").querySelector(".commandChip")).toBeNull();
    expect(within(sample(chat, "Proposal, pending")).getByText("Nothing changes until you apply.")).toBeInTheDocument();
    expect(within(sample(chat, "Proposal, pending, with a delete")).getByText("Nothing changes until you apply. Deleting cannot be undone.")).toBeInTheDocument();
    expect(within(sample(chat, "Proposal, applying")).getByRole("region", { name: "Proposed board changes" })).toHaveAttribute("aria-busy", "true");
    expect(within(sample(chat, "Proposal, applying")).getByRole("button", { name: "Apply changes" })).toBeDisabled();
    expect(chipOf("Proposal, applied")).toHaveTextContent("Applied");
    expect(chipOf("Proposal, partly applied")).toHaveTextContent("Partly applied");
    expect(chipOf("Proposal, dismissed")).toHaveTextContent("Dismissed");
    expect([...sample(chat, "Proposal, every result word").querySelectorAll(".agentChatOpResult")].map((result) => result.textContent)).toEqual([
      "Done", "Created T-19", "Not valid", "Not found", "Board is full", "No longer possible", "Not supported", "Pomegr did not answer",
    ]);
    expect(sample(chat, "Proposal, partly applied")).toHaveTextContent("Created T-19, but it could not be queued");
    expect(sample(chat, "Proposal, partly applied")).toHaveTextContent("Not run");
    expect([...sample(chat, "Proposal, new tasks placed").querySelectorAll(".agentChatOpTitle")].map((title) => title.textContent)).toEqual(["Create task below T-12", "Create task in Ready"]);
    expect(sample(chat, "Proposal, new tasks placed")).toHaveTextContent("position 1");
    expect([...sample(chat, "Proposal, a new task not placed").querySelectorAll(".agentChatOpResult")].map((result) => result.textContent)).toEqual(["Created T-19, but it could not be placed", "Not run"]);

    const startCard = (label: string) => within(sample(chat, label)).getByRole("region", { name: "Proposed session start" });
    expect(within(startCard("Session start, proposed")).getByRole("button", { name: "Start session" })).toHaveClass("commandPrimaryAction");
    expect(startCard("Session start, proposed")).toHaveTextContent("Nothing starts until you select Start session and confirm in the desktop dialog.");
    expect(chipOf("Session start, proposed")).toBeNull();
    expect(startCard("Session start, held")).toHaveTextContent("Not started. A start gate held this task.");
    expect(startCard("Session start, held")).toHaveTextContent("This task is held: Claude Code is above 85% of the five-hour window.");
    expect(within(startCard("Session start, held")).getByRole("button", { name: "Start session" })).toBeEnabled();
    expect(startCard("Session start, failed")).toHaveTextContent("Not started. Install or update the Pomegr plugin in this repository to start sessions.");
    expect(chipOf("Session start, launched")).toHaveTextContent("Session started");
    expect(startCard("Session start, launched")).toHaveTextContent("Session started in a new terminal window.");
    expect(within(startCard("Session start, launched")).queryByRole("button")).toBeNull();
    expect(within(startCard("Session start, on a paired device")).queryByRole("button", { name: "Start session" })).toBeNull();
    expect(within(startCard("Session start, on a paired device")).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    const queueCard = (label: string) => within(sample(chat, label)).getByRole("region", { name: "Proposed queue change" });
    expect(within(queueCard("Queue change, on, proposed")).getByRole("button", { name: "Turn queue on" })).toHaveClass("commandPrimaryAction");
    expect(queueCard("Queue change, on, proposed")).toHaveTextContent("Pomegr may then start queued tasks by itself on the computer that runs Pomegr");
    expect(within(queueCard("Queue change, off, proposed")).getByRole("button", { name: "Turn queue off" })).toHaveClass("commandPrimaryAction");
    expect(queueCard("Queue change, off, proposed")).toHaveTextContent("No new task starts then, and running sessions continue.");
    expect(within(queueCard("Queue change, on a paired device")).getByRole("button", { name: "Turn queue on" })).toBeEnabled();
    expect(queueCard("Queue change, turned on")).toHaveTextContent("Queue turned on.");
    expect(within(queueCard("Queue change, turned on")).queryByRole("button")).toBeNull();
    expect(queueCard("Queue change, turned on and held").querySelector(".agentChatOpResult")).toHaveClass("is-muted");
    expect(queueCard("Queue change, turned off")).toHaveTextContent("Queue turned off.");
    expect(queueCard("Queue change, not changed")).toHaveTextContent("Queue not changed. Pomegr did not answer. Try again.");
    expect(within(queueCard("Queue change, not changed")).getByRole("button", { name: "Turn queue on" })).toBeEnabled();

    expect(within(sample(chat, "Composer, error")).getByRole("alert")).toHaveTextContent("Aril is already answering. Wait for it to finish.");
    expect(within(sample(chat, "Composer, over the limit")).getByText("4,012 / 4,000")).toHaveClass("isOver");
    expect(within(sample(chat, "Composer, over the limit")).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(sample(chat, "Composer, answering elsewhere")).getByText("Aril is answering in another conversation.")).toBeInTheDocument();
    const text = sample(chat, "Answer text");
    expect(text.querySelector("img, a, script")).toBeNull();
    expect(text).toHaveTextContent("<img src=x onerror=alert(1)> [a link](javascript:alert(1))");
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);

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
