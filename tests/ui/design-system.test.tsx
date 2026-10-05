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
const SECTION_HEADINGS = ["Buttons", "Form fields", "Request charts", "Events rail", "Agent roster", "Agent inspector", "Chips and pills", "Panels and dividers", "Command table", "Settings tab rail", "Typography and tokens"];
const SAMPLE_SOURCES = ["DesignSystemView", "DesignSystemKit", "DesignSystemAgentSamples", "DesignSystemLayoutSamples", "DesignSystemEventsSample"].map((name) => `app/components/design-system/${name}.tsx`);

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
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
  });

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
    const agentsHeader = within(tableSection).getByRole("columnheader", { name: "Agents" });
    expect(agentsHeader).not.toHaveAttribute("aria-sort");
    expect(within(tableSection).getByRole("columnheader", { name: "Status" })).not.toHaveClass("commandTableSortable");
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
