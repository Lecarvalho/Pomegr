import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, ContextHistoryBoundary, RequestSnapshot } from "../../shared/monitor-contract";
import { agent } from "./dashboard-test-fixtures";
import { renderPanel, requestFeed, RequestsActionsPanel, setPhone, snapshot } from "./requests-actions-test-fixtures";

const builder: Agent = { ...agent, id: "builder", parentId: "primary", label: "Builder", role: "builder", model: "small-model" };
const AGENTS = [agent, builder];

/** Odd requests from the primary agent, even ones from the builder. */
function mixedSnapshots(count: number): RequestSnapshot[] {
  return Array.from({ length: count }, (_, index) => snapshot(index + 1, index % 2 ? "builder" : "primary"));
}

/** A compaction between request n and n + 1, so request n + 1 carries the boundary. */
function compactionAfter(number: number): ContextHistoryBoundary {
  return { id: `compact-${number}`, agentId: "primary", timestamp: new Date(Date.parse("2026-08-09T12:00:30.000Z") + number * 60_000).toISOString(), kind: "automatic_compaction", preTokens: null };
}

function follows(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("phone Activities chart", () => {
  it("draws only the single chart, then its track and legend, the minimap and the Largest strip", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = renderPanel(mixedSnapshots(12), { agents: AGENTS });

    expect(screen.queryByRole("group", { name: "Chart layout" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lanes" })).toBeNull();
    expect(container.querySelector(".requestLanes")).toBeNull();
    const svg = container.querySelector("svg.requestsActionsChart")!;
    expect(svg.querySelectorAll(".requestRoleSegment")).toHaveLength(svg.querySelectorAll(".requestsActionsBar").length);
    expect(screen.getByRole("button", { name: /^Request #2, Builder,/u })).toBeInTheDocument();

    const legend = screen.getByLabelText("Agent roles in view");
    expect(legend.children).toHaveLength(2);
    const minimap = screen.getByRole("slider", { name: "Request window" });
    const largest = screen.getByRole("region", { name: "Largest requests" });
    expect(largest.querySelectorAll(".requestsActionsLargestRow")).toHaveLength(5);
    expect(follows(svg, legend) && follows(legend, minimap) && follows(minimap, largest)).toBe(true);

    await user.click(screen.getByRole("button", { name: /^Request #2,/u }));
    expect(container.querySelector(".requestRoleNamed")).toHaveTextContent("#2Builderbuilder");

    await user.click(within(largest).getAllByRole("button", { name: /^Locate request/u })[0]);
    expect(screen.getByRole("heading", { name: /^Request #\d+$/u })).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("puts compaction text in the reserved band above the bars and drops text that would overlap", () => {
    setPhone(true);
    const { container } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed(Array.from({ length: 20 }, (_, index) => snapshot(index + 1)))}
      contextBoundaries={[compactionAfter(3), compactionAfter(4), compactionAfter(12)]} cacheWriteAvailable historical={false} />);
    const svg = container.querySelector("svg.requestsActionsChart")!;
    expect(svg.querySelectorAll(".requestsActionsBar .requestsActionsCompaction line")).toHaveLength(3);
    expect(svg.querySelector(".requestsActionsBar text")).toBeNull();

    // Requests 4 and 5 sit one bar apart, so only one of their two labels fits.
    const compactionText = Array.from(svg.querySelectorAll(".requestsActionsCompaction text"));
    expect(compactionText).toHaveLength(2);
    const bandText = [...compactionText, svg.querySelector(".requestsActionsSelectedLabel")!];
    const baselines = new Set(bandText.map((text) => text.getAttribute("y")));
    expect(baselines.size).toBe(1);
    const barTop = Math.min(...Array.from(svg.querySelectorAll(".requestsActionsSegment"), (segment) => Number(segment.getAttribute("y"))));
    expect(Number([...baselines][0])).toBeLessThan(barTop);
  });

  it("keeps lanes, the layout toggle and in-bar compaction text on desktop", async () => {
    setPhone(false);
    const user = userEvent.setup();
    const { container } = render(<RequestsActionsPanel agents={AGENTS} requestSnapshots={requestFeed(mixedSnapshots(8))}
      contextBoundaries={[compactionAfter(4)]} cacheWriteAvailable historical={false} />);
    expect(container.querySelector(".requestLanes")).not.toBeNull();
    expect(screen.getByRole("group", { name: "Chart layout" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Single chart" }));
    fireEvent.click(screen.getByRole("button", { name: /^Request #5,/u }));
    expect(container.querySelector("svg.requestsActionsChart .requestsActionsBar .requestsActionsCompaction text")).toHaveTextContent("compaction");
    expect(container.querySelector("svg.requestsActionsChart .requestsActionsBar.isSelected .requestsActionsSelectedLabel")).toHaveTextContent("#5");
  });
});
