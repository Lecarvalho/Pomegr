import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/live-events", () => ({
  subscribeLiveEvents: (listener: (event: unknown) => void) => {
    listener({ type: "connection", state: "connected", epoch: 0 });
    return () => {};
  },
}));

import { ActivitiesTab } from "../../app/components/dashboard/ActivitiesTab";
import { buildRequestLanes } from "../../app/components/dashboard/requests-actions/lane-model";
import { scopedRows } from "../../app/components/dashboard/requests-actions/model";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import type { Agent, MonitorState, RequestSnapshot } from "../../shared/monitor-contract";
import { historyCall, historyRequest, historyServer } from "./activities-test-server";
import { agent, repositorySession } from "./dashboard-test-fixtures";
import { renderPanel, requestFeed, setPhone, snapshot } from "./requests-actions-test-fixtures";

const child: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder", role: "builder", model: "small-model" };
const compactA: Agent = { ...agent, id: "compact-a", parentId: "primary", label: "Compactor A", role: "compaction" };
const compactB: Agent = { ...agent, id: "compact-b", parentId: "primary", label: "Compactor B", role: "compaction" };
const AGENTS = [agent, child, compactA, compactB];

/** Request n: primary, child, a compaction agent, primary; tokens differ per lane. */
function laneSnapshots(count = 12): RequestSnapshot[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const slot = index % 4;
    if (slot === 1) return snapshot(number, "child", { uncachedInputTokens: 500, cacheWriteTokens: 200, cacheReadTokens: 1_000, outputTokens: 100 });
    if (slot === 2) return snapshot(number, number % 8 === 3 ? "compact-a" : "compact-b", { uncachedInputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 500 });
    return snapshot(number, "primary", { uncachedInputTokens: 5_000, cacheWriteTokens: 2_000, cacheReadTokens: 90_000, outputTokens: 1_000 });
  });
}

function lanes(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(".requestLane"));
}

function laneNamed(container: HTMLElement, name: string) {
  const lane = lanes(container).find((candidate) => candidate.querySelector(".requestLaneName")?.textContent === name);
  if (!lane) throw new Error(`No lane named ${name}`);
  return lane;
}

function barNumbers(root: Element) {
  return Array.from(root.querySelectorAll(".requestsActionsBar"), (bar) => Number(/^Request #(\d+),/u.exec(bar.getAttribute("aria-label") ?? "")?.[1]));
}

beforeEach(() => setPhone(false));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("request lanes", () => {
  it("assigns every request to exactly one lane with one shared compaction lane", () => {
    const rows = scopedRows(requestFeed([...laneSnapshots(), snapshot(13, "ghost")]), [], "all");
    const { lanes: model, laneByRequest } = buildRequestLanes(rows, AGENTS, "fresh", true);
    expect(model.map((lane) => lane.id)).toEqual(["agent:primary", "agent:child", "agent:ghost", "compaction"]);
    expect(model.map((lane) => lane.primary)).toEqual([true, false, false, false]);
    expect(model.reduce((sum, lane) => sum + lane.rows.length, 0)).toBe(rows.length);
    expect(laneByRequest.size).toBe(rows.length);
    for (const lane of model) for (const row of lane.rows) expect(laneByRequest.get(row.id)).toBe(lane.id);
    expect(new Set(model.find((lane) => lane.kind === "compaction")!.rows.map((row) => row.agentId))).toEqual(new Set(["compact-a", "compact-b"]));

    const { container } = renderPanel(laneSnapshots(), { agents: AGENTS });
    expect(lanes(container).map((lane) => lane.querySelector(".requestLaneName")?.textContent)).toEqual(["Primary agent", "Builder", "Compactions"]);
    const drawn = lanes(container).flatMap((lane) => barNumbers(lane));
    expect(drawn.sort((left, right) => left - right)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(barNumbers(laneNamed(container, "Compactions"))).toEqual([3, 7, 11]);
    expect(barNumbers(laneNamed(container, "Builder"))).toEqual([2, 6, 10]);
    expect(laneNamed(container, "Builder").querySelector(".requestLaneLabel")).toHaveAttribute("title", "Builder · builder · small-model");
  });

  it("prints a maximum per lane that follows Fresh tokens and Full breakdown", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(laneSnapshots(), { agents: AGENTS });
    const maxima = () => lanes(container).map((lane) => lane.querySelector(".requestLaneMaximum")?.textContent);
    expect(screen.getByText("Per-lane scales")).toBeInTheDocument();
    expect(maxima()).toEqual(["max 8,000", "max 800", "max 1,500"]);
    const childBar = laneNamed(container, "Builder").querySelector(".requestsActionsSegment.uncached")!;
    const primaryBar = laneNamed(container, "Primary agent").querySelector(".requestsActionsSegment.uncached")!;
    expect(Number(childBar.getAttribute("height"))).toBeCloseTo(500 / 800 * 34);
    expect(Number(primaryBar.getAttribute("height"))).toBeCloseTo(5_000 / 8_000 * 96);

    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(maxima()).toEqual(["max 120K", "max 2,000", "max 1,500"]);
    await user.click(screen.getByRole("button", { name: "Fresh tokens" }));
    expect(maxima()).toEqual(["max 8,000", "max 800", "max 1,500"]);
  });

  it("draws the primary lane taller, and the only lane of a scoped subagent as primary", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(laneSnapshots(), { agents: AGENTS });
    const heights = () => lanes(container).map((lane) => Number(lane.querySelector("svg")!.getAttribute("viewBox")!.split(" ")[3]));
    expect(heights()).toEqual([118, 52, 52]);
    expect(lanes(container).map((lane) => lane.classList.contains("isPrimary"))).toEqual([true, false, false]);

    await user.selectOptions(screen.getByLabelText("Agent scope"), "child");
    expect(lanes(container).map((lane) => lane.querySelector(".requestLaneName")?.textContent)).toEqual(["Builder"]);
    expect(heights()).toEqual([118]);
  });

  it("selects a subagent bar and steps across lanes with arrow keys, keeping focus on the selected bar", () => {
    const { container } = renderPanel(laneSnapshots(), { agents: AGENTS });
    fireEvent.click(within(laneNamed(container, "Builder")).getByRole("button", { name: /^Request #6,/u }));
    expect(screen.getByRole("heading", { name: "Request #6" })).toBeInTheDocument();
    expect(laneNamed(container, "Builder").querySelector(".requestsActionsBar.isSelected")).toHaveAttribute("aria-label", expect.stringMatching(/^Request #6,/u));

    const group = screen.getByRole("group", { name: "Model requests by agent, positions 1 to 12" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Request #7" })).toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute("aria-label", expect.stringMatching(/^Request #7,/u));
    expect(document.activeElement?.closest(".requestLane")).toBe(laneNamed(container, "Compactions"));
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Request #5" })).toBeInTheDocument();
    expect(document.activeElement?.closest(".requestLane")).toBe(laneNamed(container, "Primary agent"));
  });

  it("keeps the Activities feed on the request selected from a lane", async () => {
    const user = userEvent.setup();
    const sessionId = "claude:lanes";
    const requests = Array.from({ length: 40 }, (_, index) => historyRequest(index + 1, (index + 1) % 2 ? "child" : "primary"));
    const server = historyServer({ requests, calls: requests.map((request) => historyCall(`call-${request.number}`, request, "read", 1)), revision: "1", overview: true });
    const base = createEmptyMonitorState({ connected: true });
    const state: MonitorState = {
      ...base,
      agents: [agent, child],
      session: { ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }), id: sessionId, title: "Session", project: "Pomegr" },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("/api/state")
      ? Promise.resolve(new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } }))
      : server.fetcher(input, init)));
    const { container } = render(<LiveClockProvider running={false}><ActivitiesTab sessionId={sessionId} historical={false} paused={false} route={{ agent: null, request: null }} onRouteChange={vi.fn()} onOpenAgent={vi.fn()} /></LiveClockProvider>);
    await screen.findByRole("heading", { name: "Request #40" });
    const feed = screen.getByRole("region", { name: "Activity feed" });
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    await waitFor(() => expect(lanes(container).map((lane) => lane.querySelector(".requestLaneName")?.textContent)).toEqual(["Primary agent", "Builder"]));

    await user.click(within(laneNamed(container, "Builder")).getByRole("button", { name: /^Request #37,/u }));
    await screen.findByRole("heading", { name: "Request #37" });
    await waitFor(() => expect(within(feed).getByRole("button", { name: /Request #37/u })).toHaveAttribute("aria-pressed", "true"));

    fireEvent.keyDown(screen.getByRole("group", { name: /^Model requests by agent/u }), { key: "ArrowRight" });
    await screen.findByRole("heading", { name: "Request #38" });
    await waitFor(() => expect(within(feed).getByRole("button", { name: /Request #38/u })).toHaveAttribute("aria-pressed", "true"));
    expect(laneNamed(container, "Primary agent").querySelector(".requestsActionsBar.isSelected")).toHaveAttribute("aria-label", expect.stringMatching(/^Request #38,/u));
  });

  it("renders no request snapshot or agent identifiers in the lane markup", () => {
    const { container } = renderPanel(laneSnapshots(), { agents: AGENTS });
    const markup = container.querySelector(".requestLanes")!.outerHTML;
    expect(markup).not.toMatch(/request-\d/u);
    expect(markup).not.toMatch(/compact-[ab]|agent:/u);
  });
});
