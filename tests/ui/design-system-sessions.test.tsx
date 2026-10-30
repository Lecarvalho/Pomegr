import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AgentInspectorSection, AgentRosterSection } from "../../app/components/design-system/DesignSystemAgentSamples";
import { EventsRailSection } from "../../app/components/design-system/DesignSystemEventsSample";
import { PhoneActivitySamples, RequestChartSamples } from "../../app/components/design-system/DesignSystemRequestSamples";
import { forbidNetwork, sectionOf } from "./design-system-helpers";

// The session evidence samples: request charts, phone Activities, the Events rail, and the agent roster with its inspector.
describe("Design-system reference page, sessions and charts", () => {
  forbidNetwork();

  it("renders static lane and single-chart samples with a neutral, described minimap", () => {
    render(<RequestChartSamples />);
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
  });

  it("renders the documented phone Activities exceptions and the section of actions without a recorded request, closed and open", () => {
    const { container } = render(<PhoneActivitySamples />);
    const exceptions = screen.getByRole("region", { name: "Phone Activities exceptions sample" });
    const selected = within(exceptions).getByLabelText("Selected request #34");
    expect(selected).toHaveClass("activityTableFrame", "isSelectedRequest");
    expect(selected.closest(".activityLayout")).toHaveClass("activityLayout", "isPhone");
    const callLine = within(exceptions).getByRole("button", { name: /Bash, verify-ui, 0\.8s/ });
    expect(callLine).toHaveClass("activityCallLine");
    expect(callLine.querySelector(".workKindIcon")).not.toBeNull();
    expect(callLine.querySelector("svg.activityCallChevron path")).toHaveAttribute("d", "M6 3l5 5-5 5");
    expect(within(exceptions).getByText(/Documented exceptions:/)).toBeInTheDocument();

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
  });

  it("renders the Events rail from static data: every kind, the expander, and the empty and unavailable states", async () => {
    const user = userEvent.setup();
    render(<EventsRailSection />);
    const section = sectionOf("Events rail");
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
  });

  it("renders the shipped agent roster and the inline inspector from static data", async () => {
    const user = userEvent.setup();
    render(<><AgentRosterSection /><AgentInspectorSection /></>);

    const rosterSection = sectionOf("Agent roster");
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

    const inspector = within(sectionOf("Agent inspector")).getByRole("region", { name: /^Agent inspector for Verify collapse at eight lanes — Collapse tests$/ });
    expect(inspector).toHaveClass("agentInspector-inline");
    expect(within(inspector).getByRole("list", { name: "Agent lineage" })).toHaveTextContent(/Primary agent.*Workflow Test sweep · 4 agents.*Phase Verify · 1 siblings/);
    expect(within(inspector).getByRole("button", { name: /Activities for this agent/ })).toHaveClass("commandSecondaryAction", "inspectorActionRow");
  });
});
