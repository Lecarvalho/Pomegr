import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, CacheEvent, RequestSnapshot, RequestSnapshotFeed } from "../../shared/monitor-contract";
import { RequestsActionsPanel } from "../../app/components/dashboard/RequestsActionsPanel";
import { snapshotEventKey } from "../../app/components/dashboard/requests-actions/model";
import { agent } from "./dashboard-test-fixtures";

const childAgent: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder" };
const baseTime = Date.parse("2026-08-09T12:00:00.000Z");

function snapshot(index: number, agentId = "primary", overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  const uncachedInputTokens = overrides.uncachedInputTokens ?? 2_000_000 - index * 1_000;
  const cacheWriteTokens = overrides.cacheWriteTokens ?? 2_000;
  const cacheReadTokens = overrides.cacheReadTokens ?? 3_000;
  const outputTokens = overrides.outputTokens ?? 4_000;
  return {
    id: `request-${index}`,
    agentId,
    observedAt: new Date(baseTime + index * 60_000).toISOString(),
    cacheLifetime: "1h",
    uncachedInputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: uncachedInputTokens + cacheWriteTokens + cacheReadTokens + outputTokens,
    precedingWork: [],
    precedingAssociation: null,
    issuedWork: [],
    issuedAssociation: null,
    ...overrides,
  };
}

function requestFeed(items: RequestSnapshot[], status: RequestSnapshotFeed["status"] = "ready"): RequestSnapshotFeed {
  return { status, items };
}

function renderPanel(items: RequestSnapshot[], options: { agents?: Agent[]; cacheWriteAvailable?: boolean; historical?: boolean } = {}) {
  return render(<RequestsActionsPanel
    agents={options.agents ?? [agent]}
    requestSnapshots={requestFeed(items)}
    contextBoundaries={[]}
    cacheWriteAvailable={options.cacheWriteAvailable ?? true}
    historical={options.historical ?? false}
  />);
}

function chart(container: HTMLElement): SVGSVGElement {
  return container.querySelector("svg.requestsActionsChart") as SVGSVGElement;
}

function axisLabels(container: HTMLElement): string[] {
  const svg = chart(container);
  const labels = Array.from(svg.querySelectorAll(".requestsActionsAxis:last-child text")).map((node) => node.textContent || "");
  return labels.length > 2 ? [labels[0], labels.at(-1) || ""] : labels;
}

function setPhone(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem("pomegr-disclosure-cache-evidence");
});

describe("RequestsActionsPanel", () => {
  it("renders a 60-request desktop window from a 1,000-row retained feed", () => {
    const { container } = renderPanel(Array.from({ length: 1_000 }, (_, index) => snapshot(index + 1)));
    expect(container.querySelectorAll(".requestsActionsBar")).toHaveLength(60);
    expect(axisLabels(container)).toEqual(["#941", "#1000"]);
    expect(screen.getByRole("heading", { name: "Request #1000" })).toBeInTheDocument();
    expect(screen.getByText("Numbers are positions in the retained feed (latest 100 per agent), not provider ids.")).toBeInTheDocument();
  });

  it("changes scope to the newest row and keeps a chart click in the current window", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 10 }, (_, index) => snapshot(index + 1, index % 2 ? "child" : "primary"));
    const { container } = renderPanel(items, { agents: [agent, childAgent] });
    await user.selectOptions(screen.getByLabelText("Agent scope"), "primary");
    expect(screen.getByRole("heading", { name: "Request #5" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#1", "#5"]);

    const bars = container.querySelectorAll(".requestsActionsBar");
    fireEvent.click(bars[2]);
    expect(screen.getByRole("heading", { name: "Request #3" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#1", "#5"]);
    expect(bars[2]).toHaveClass("isSelected");
    expect(bars[2].querySelector(".requestsActionsSelection")).toBeInTheDocument();
  });

  it("recenters the window when a Largest requests row is selected", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    const largest = screen.getByRole("button", { name: /Locate request #1,/ });
    largest.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Request #1" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#1", "#60"]);
  });

  it("moves selection and the window by one at the boundary with Prev and ArrowLeft", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[0]);
    expect(screen.getByRole("heading", { name: "Request #41" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prev" }));
    expect(screen.getByRole("heading", { name: "Request #40" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#40", "#99"]);

    fireEvent.keyDown(chart(container), { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Request #39" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#39", "#98"]);
  });

  it("keeps focus on the newly selected bar across repeated ArrowLeft steps", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    const first = container.querySelectorAll(".requestsActionsBar")[0] as SVGGElement;
    fireEvent.click(first);
    chart(container).focus();
    fireEvent.keyDown(chart(container), { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Request #40" })).toBeInTheDocument();
    expect(document.activeElement).toHaveClass("requestsActionsBar");
    expect(document.activeElement).toHaveAttribute("aria-label", expect.stringContaining("Request #40"));

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("heading", { name: "Request #39" })).toBeInTheDocument();
    expect(document.activeElement).toHaveClass("requestsActionsBar");
    expect(document.activeElement).toHaveAttribute("aria-label", expect.stringContaining("Request #39"));
    expect(axisLabels(container)).toEqual(["#39", "#98"]);
  });

  it("keeps selection and window while changing mode and draws the appropriate stacks", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[9]);
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    const labels = axisLabels(container);
    expect(container.querySelectorAll(".requestsActionsSegment.read")).toHaveLength(0);
    expect(container.querySelectorAll(".requestsActionsOutline")).toHaveLength(60);

    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(labels);
    expect(container.querySelectorAll(".requestsActionsSegment.read")).toHaveLength(60);
    expect(container.querySelectorAll(".requestsActionsOutline")).toHaveLength(0);
  });

  it("hides cache-write evidence for Codex and keeps zero-valued geometry finite", () => {
    const { container } = renderPanel([snapshot(1, "primary", {
      uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0,
    })], { cacheWriteAvailable: false });
    expect(screen.queryByText("Cache write")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".requestsActionsSegment.write")).toHaveLength(0);
    expect(container.querySelectorAll(".requestsActionsStat.write")).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("renders bounded action associations and explicit empty states", () => {
    const actionRow = snapshot(1, "primary", {
      precedingWork: [{ kind: "read", count: 2 }, { kind: "test", count: 1 }],
      precedingAssociation: "transcript_adjacency",
      issuedWork: [{ kind: "write", count: 1 }],
      issuedAssociation: "recorded_link",
    });
    const { rerender } = renderPanel([actionRow]);
    expect(screen.getByText("Results available before").parentElement).toHaveTextContent("transcript adjacency");
    expect(screen.getByText("Actions issued by request").parentElement).toHaveTextContent("recorded link");
    expect(screen.getByText("Reading ×2")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("Editing")).toBeInTheDocument();

    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([snapshot(2)])} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getAllByText("None recorded")).toHaveLength(2);
  });

  it("renders older monitor snapshots without action fields as no recorded work", () => {
    const legacySnapshot = snapshot(1);
    for (const field of ["precedingWork", "precedingAssociation", "issuedWork", "issuedAssociation"]) Reflect.deleteProperty(legacySnapshot, field);
    renderPanel([legacySnapshot]);
    expect(screen.getByRole("region", { name: "Selected request" })).toBeInTheDocument();
    expect(screen.getAllByText("None recorded")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Locate request #1, Primary agent" })).toBeInTheDocument();
  });

  it("shows the unavailable and ready-empty states without rendering a chart", () => {
    const { container, rerender } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([], "unavailable")} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getByText("No request observations for this session yet.")).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsChart")).not.toBeInTheDocument();
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([])} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getByText("No request observations for this session yet.")).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsChart")).not.toBeInTheDocument();
  });

  it("remounts cleanly for a new session key", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const props = { agents: [agent], requestSnapshots: requestFeed(items), contextBoundaries: [], cacheWriteAvailable: true, historical: false };
    const { container, rerender } = render(<RequestsActionsPanel key="session-one" {...props} />);
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[0]);
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(screen.getByRole("heading", { name: "Request #41" })).toBeInTheDocument();
    rerender(<RequestsActionsPanel key="session-two" {...props} />);
    expect(screen.getByRole("heading", { name: "Request #100" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fresh tokens" })).toHaveAttribute("aria-pressed", "true");
    expect(axisLabels(container)).toEqual(["#41", "#100"]);
  });

  it("follows a live tail append only when the newest request was selected and retains identity otherwise", () => {
    const initial = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const { container, rerender } = renderPanel(initial);
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([...initial, snapshot(101)])} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getByRole("heading", { name: "Request #101" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#42", "#101"]);

    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[8]);
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    const retained = [...initial.slice(1), snapshot(102)];
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed(retained)} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(screen.getByRole("heading", { name: "Request #49" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Request #49" }).closest("section")).toBeInTheDocument();
  });

  it("moves the minimap window without moving the selected request", () => {
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    const minimap = screen.getByRole("slider", { name: "Request window" });
    vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue({ left: 0, right: 100, top: 0, bottom: 26, width: 100, height: 26, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(minimap, { button: 0, pointerId: 1, clientX: 50, clientY: 10 });
    fireEvent.pointerMove(minimap, { pointerId: 1, clientX: 60, clientY: 10 });
    fireEvent.pointerUp(minimap, { pointerId: 1, clientX: 60, clientY: 10 });
    expect(screen.getByRole("heading", { name: "Request #100" })).toBeInTheDocument();
    expect(minimap).toHaveAttribute("aria-valuetext", "Requests 41 to 100");

    fireEvent.pointerDown(minimap, { button: 0, pointerId: 2, clientX: 0, clientY: 10 });
    expect(minimap).toHaveAttribute("aria-valuetext", "Requests 1 to 60");
    expect(container.querySelector(".requestsActionsDetail")).toHaveTextContent("Request #100");
  });

  it("canonicalizes equivalent cache timestamps and rejects invalid join keys", () => {
    expect(snapshotEventKey("primary", "2026-08-09T08:04:00.000-04:00")).toBe(snapshotEventKey("primary", "2026-08-09T12:04:00.000Z"));
    expect(snapshotEventKey("primary", "not-a-timestamp")).toBeNull();
    expect(snapshotEventKey("primary", "2026-08-09T12:04:00.000Z")).not.toBe(snapshotEventKey("child", "2026-08-09T12:04:00.000Z"));
  });

  it("matches cache evidence by normalized timestamp across scope and recenters the request", async () => {
    const user = userEvent.setup();
    const items: RequestSnapshot[] = [];
    for (let index = 1; index <= 100; index += 1) {
      items.push(snapshot(index * 2 - 1, "primary"));
      items.push(snapshot(index * 2, "child"));
    }
    const target = items.find((item) => item.agentId === "child" && item.id === "request-100")!;
    const shiftedTimestamp = new Date(Date.parse(target.observedAt) - 4 * 60 * 60_000).toISOString().replace("Z", "-04:00");
    const event: CacheEvent = {
      id: "cache-child-target",
      agentId: "child",
      kind: "refill",
      observedAt: shiftedTimestamp,
      promptInputTokens: 5_000,
      cacheReadPercent: 5,
      cacheWriteTokens: 5_000,
      previousCacheReadPercent: null,
      gapMs: null,
      relatedEventId: null,
    };
    const { container } = render(<RequestsActionsPanel
      agents={[agent, childAgent]}
      requestSnapshots={requestFeed(items)}
      contextBoundaries={[]}
      cacheWriteAvailable
      historical={false}
      cacheEvents={{ status: "ready", items: [event], possibleFullRefills: [] }}
    />);
    await user.selectOptions(screen.getByLabelText("Agent scope"), "primary");
    const disclosure = container.querySelector("details.cacheEvidenceDisclosure")!;
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(disclosure.querySelector("summary")!);
    const evidenceRow = screen.getByRole("button", { name: /Locate Cache refill/ });
    evidenceRow.focus();
    await user.keyboard("{Enter}");
    expect(evidenceRow).toHaveAttribute("aria-pressed", "true");
    expect(evidenceRow).toHaveClass("active");
    const evidenceList = screen.getByRole("list");
    expect(within(evidenceList).getByText("5%")).toBeInTheDocument();
    expect(within(evidenceList).getByText("Builder")).toBeInTheDocument();
    expect(evidenceList.querySelector("time")).not.toBeInTheDocument();
    expect(within(evidenceList).queryByText(/Cache write|Prompt input|Pomegr/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Agent scope")).toHaveValue("child");
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Selected request" })).toHaveTextContent("Builder");
    expect(axisLabels(container)).toEqual(["#20", "#79"]);
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[0]);
    expect(evidenceRow).toHaveAttribute("aria-pressed", "false");
    fireEvent.blur(evidenceRow);
    expect(evidenceRow).not.toHaveClass("active");
  });

  it("uses a 20-bar phone window, omits the minimap, shows three largest rows, and scrolls on locate", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1)));
    expect(container.querySelectorAll(".requestsActionsBar")).toHaveLength(20);
    expect(axisLabels(container)).toEqual(["#81", "#100"]);
    expect(screen.queryByRole("slider", { name: "Request window" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Locate request #1, Primary agent" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Locate request/ })).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: /Locate request #1,/ }));
    expect(screen.getByRole("heading", { name: "Request #1" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(["#1", "#20"]);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
  });
});
