import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/live-events", () => ({
  subscribeLiveEvents: (listener: (event: unknown) => void) => {
    listener({ type: "connection", state: "connected", epoch: 0 });
    return () => {};
  },
}));

import { ActivitiesTab } from "../../app/components/dashboard/ActivitiesTab";
import { buildRequestLanes } from "../../app/components/dashboard/requests-actions/lane-model";
import { scopedRows, type RequestRow } from "../../app/components/dashboard/requests-actions/model";
import { LANE_LEFT, MAXIMUM_GUTTER, placeLaneBandLabels, type LaneBandLabel } from "../../app/components/dashboard/requests-actions/RequestLaneChart";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import type { Agent, CacheReadDropFeed, MonitorState, RequestSnapshot } from "../../shared/monitor-contract";
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

function readDrop(target: RequestSnapshot): CacheReadDropFeed {
  return { status: "ready", items: [{ agentId: target.agentId, count: 1, occurrences: [{ id: `drop-${target.id}`, observedAt: target.observedAt, previousCacheReadPercent: 90, cacheReadPercent: 5, gapMs: 1_000 }] }] };
}

/** Rows at indexes 0..n-1 with optional evidence and compaction flags, laid out 17 units apart. */
function bandEntries(count: number, flags: Record<number, { evidence?: boolean; compaction?: boolean }>) {
  const rows = scopedRows(requestFeed(Array.from({ length: count }, (_, index) => snapshot(index + 1))), [], "all");
  return rows.map((row, index): { row: RequestRow; index: number } => ({ index, row: {
    ...row,
    compactionBefore: Boolean(flags[index]?.compaction),
    cacheEvidence: flags[index]?.evidence ? { kind: "refill" } : undefined,
  } }));
}

function expectClearBand(labels: LaneBandLabel[], entries: { row: RequestRow; index: number }[], right: number) {
  const icons = entries.filter(({ row }) => row.cacheEvidence).map(({ index }) => [LANE_LEFT + 17 * index, LANE_LEFT + 17 * index + 14]);
  for (const label of labels) {
    expect(label.start).toBeGreaterThanOrEqual(LANE_LEFT);
    expect(label.end).toBeLessThanOrEqual(right);
    expect(label.end - label.start).toBeGreaterThanOrEqual(label.text.length * 6);
    for (const [from, to] of icons) expect(label.end <= from || label.start >= to).toBe(true);
    for (const other of labels) if (other !== label) expect(label.end <= other.start || label.start >= other.end).toBe(true);
  }
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

  it("names each lane with its full agent, role and model in the title and accessible name", () => {
    const longName = "Audit browser polling traffic across every provider adapter";
    const { container } = renderPanel([...laneSnapshots(), snapshot(13, "ghost")], { agents: [agent, { ...child, label: longName }, compactA, compactB] });
    const builder = screen.getByRole("group", { name: `${longName} · builder · small-model` });
    expect(builder).toHaveClass("requestLane");
    expect(builder.querySelector(".requestLaneLabel")).toHaveAttribute("title", `${longName} · builder · small-model`);
    expect(builder.querySelector(".requestLaneName")).toHaveTextContent(longName);
    expect(builder.querySelector(".requestLaneMeta")).toHaveTextContent("builder · small-model");
    expect(screen.getByRole("group", { name: "Compactions · compaction · 2 agents" })).toHaveAttribute("data-lane-kind", "compaction");
    const unknown = screen.getByRole("group", { name: "Unknown agent · not in the agent roster" });
    expect(unknown.querySelector(".requestLaneLabel")).toHaveAttribute("title", "Unknown agent · not in the agent roster");
    expect(lanes(container)).toHaveLength(4);
  });

  it("sizes every lane viewBox to the measured plot width and keeps band marks clear of the maximum gutter", () => {
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(function (this: SVGElement) {
      return { width: this.classList.contains("requestLaneAxis") ? 600 : 0, height: 18, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const { container } = renderPanel(laneSnapshots(), { agents: AGENTS, cacheReadDrops: readDrop(snapshot(6, "child")) });
    expect(lanes(container).map((lane) => lane.querySelector("svg")!.getAttribute("viewBox"))).toEqual(["0 0 600 118", "0 0 600 52", "0 0 600 52"]);
    expect(lanes(container).map((lane) => lane.querySelector("svg")!.getAttribute("height"))).toEqual(["118", "52", "52"]);
    expect(container.querySelector(".requestLaneAxis")).toHaveAttribute("viewBox", "0 0 600 18");
    for (const maximum of container.querySelectorAll(".requestLaneMaximum")) expect(maximum).toHaveAttribute("x", "600");
    for (const segment of container.querySelectorAll(".requestLanePlot .requestsActionsSegment")) {
      expect(Number(segment.getAttribute("x")) + Number(segment.getAttribute("width"))).toBeLessThanOrEqual(600 - MAXIMUM_GUTTER + 0.001);
    }

    const icon = laneNamed(container, "Builder").querySelector(".requestsActionsRefill .cacheRefillIcon")!;
    expect(icon).toHaveAttribute("width", "14");
    const [, iconTop] = /translate\(([\d.]+) ([\d.]+)\)/u.exec(icon.parentElement!.getAttribute("transform")!)!.slice(1).map(Number);
    expect(iconTop + 14).toBeLessThanOrEqual(18);
    fireEvent.click(within(laneNamed(container, "Builder")).getByRole("button", { name: /^Request #6,/u }));
    const bandText = Array.from(laneNamed(container, "Builder").querySelectorAll(".requestsActionsRefillLabel, .requestsActionsSelectedLabel"));
    expect(bandText.map((text) => text.textContent)).toEqual(["Possible refill", "#6"]);
    for (const text of bandText) expect(Number(text.getAttribute("y"))).toBeLessThanOrEqual(18);
  });

  it("centers the selected request number over the first and last bars of a full window", () => {
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(function (this: SVGElement) {
      return { width: this.classList.contains("requestLaneAxis") ? 600 : 0, height: 18, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const { container } = renderPanel(Array.from({ length: 60 }, (_, index) => snapshot(index + 1, "primary", { uncachedInputTokens: 1_000 })));
    const bars = container.querySelectorAll(".requestLanePlot .requestsActionsBar");
    expect(bars).toHaveLength(60);
    for (const [bar, marker] of [[bars[59], "#60"], [bars[0], "#1"]] as const) {
      fireEvent.click(bar);
      const segment = bar.querySelector(".requestsActionsSegment")!;
      const label = container.querySelector(".requestsActionsSelectedLabel")!;
      expect(label).toHaveTextContent(marker);
      expect(label).toHaveAttribute("text-anchor", "middle");
      expect(Number(label.getAttribute("x"))).toBeCloseTo(Number(segment.getAttribute("x")) + Number(segment.getAttribute("width")) / 2);
    }
  });

  it("lays out band labels without overlapping each other, evidence icons or the gutter", () => {
    const geometry = (right: number) => ({ barX: (index: number) => LANE_LEFT + 17 * index, width: 14, left: LANE_LEFT, right });
    const spacious = bandEntries(24, { 5: { evidence: true }, 20: { compaction: true } });
    const labels = placeLaneBandLabels(spacious, geometry(1000), spacious[5].row.id, spacious[5].row);
    expect(labels.map((label) => [label.kind, label.anchor])).toEqual([["evidence", "start"], ["selected", "end"], ["compaction", "start"]]);
    expectClearBand(labels, spacious, 1000);

    const crowded = bandEntries(8, { 1: { evidence: true }, 2: { evidence: true, compaction: true }, 3: { evidence: true, compaction: true }, 7: { evidence: true } });
    for (const selected of [1, 2, 7]) {
      const placed = placeLaneBandLabels(crowded, geometry(140), crowded[selected].row.id, crowded[selected].row);
      expect(placed.length).toBeLessThan(4);
      expectClearBand(placed, crowded, 140);
    }

    const edge = bandEntries(12, { 11: { evidence: true } });
    const [atEdge] = placeLaneBandLabels(edge, geometry(LANE_LEFT + 17 * 12), null, edge[11].row);
    expect(atEdge).toMatchObject({ kind: "evidence", anchor: "end" });
  });

  it("keeps the phone single chart marker and selected label unchanged", () => {
    setPhone(true);
    const { container } = renderPanel([snapshot(1), snapshot(2)], { cacheReadDrops: readDrop(snapshot(2)) });
    const icon = container.querySelector(".requestsActionsChart .requestsActionsRefill .cacheRefillIcon")!;
    expect(icon).toHaveAttribute("width", "16");
    expect(icon.parentElement!.getAttribute("transform")).toMatch(/ 8\)$/u);
    fireEvent.click(screen.getByRole("button", { name: /^Request #2,/u }));
    expect(container.querySelector(".requestsActionsChart .requestsActionsBar.isSelected .requestsActionsSelectedLabel")).toHaveTextContent("#2");
    expect(container.querySelector(".requestLanes")).toBeNull();
  });

  it("styles lanes as a 220px ellipsized label column beside the plot", () => {
    const styles = readFileSync(join(process.cwd(), "app", "styles", "request-lanes.css"), "utf8");
    expect(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8")).toContain('@import "./styles/request-lanes.css";');
    expect(styles).toMatch(/\.requestLane, \.requestLaneAxisRow\s*\{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\)/u);
    for (const name of ["requestLaneName", "requestLaneMeta"]) {
      expect(styles).toMatch(new RegExp(`\\.${name}\\s*\\{[^}]*overflow:\\s*hidden;[^}]*text-overflow:\\s*ellipsis;[^}]*white-space:\\s*nowrap`, "u"));
    }
    expect(styles).toMatch(/\.requestLanePlot \.requestsActionsRefill \.cacheRefillIcon\s*\{\s*width:\s*14px;\s*height:\s*14px/u);
  });

  it("renders no request snapshot or agent identifiers in the lane markup", () => {
    const { container } = renderPanel(laneSnapshots(), { agents: AGENTS });
    const markup = container.querySelector(".requestLanes")!.outerHTML;
    expect(markup).not.toMatch(/request-\d/u);
    expect(markup).not.toMatch(/compact-[ab]|agent:/u);
  });
});
