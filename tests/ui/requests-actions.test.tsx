import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, CacheEvent, CacheEventFeed, CacheReadDropFeed, ContextHistoryBoundary, RequestSnapshot, RequestSnapshotFeed } from "../../shared/monitor-contract";
import type { ComponentProps } from "react";
import { useSessionRequestSelection } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { RequestsActionsPanel as ControlledRequestsActionsPanel } from "../../app/components/dashboard/RequestsActionsPanel";
import { snapshotEventKey } from "../../app/components/dashboard/requests-actions/model";
import { agent } from "./dashboard-test-fixtures";
import { claudeCacheRefillFeeds } from "../helpers/claude-cache-refill.mjs";

function RequestsActionsPanel(props: Omit<ComponentProps<typeof ControlledRequestsActionsPanel>, "selection">) {
  const selection = useSessionRequestSelection(props);
  return <ControlledRequestsActionsPanel {...props} selection={selection} />;
}

const childAgent: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder" };
const baseTime = Date.parse("2026-08-09T12:00:00.000Z");
const EMPTY_BOUNDARIES: ContextHistoryBoundary[] = [];

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

function fullRefill(agentId: string, observedAt: string): CacheEventFeed["possibleFullRefills"] {
  return [{ agentId, count: 1, occurrences: [{ observedAt, reason: null, providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null }], reasons: [], toolChangeAttributions: [] }];
}

function renderPanel(items: RequestSnapshot[], options: { agents?: Agent[]; cacheWriteAvailable?: boolean; historical?: boolean; cacheReadDrops?: CacheReadDropFeed } = {}) {
  return render(<RequestsActionsPanel
    agents={options.agents ?? [agent]}
    requestSnapshots={requestFeed(items)}
    contextBoundaries={[]}
    cacheWriteAvailable={options.cacheWriteAvailable ?? true}
    historical={options.historical ?? false}
    cacheReadDrops={options.cacheReadDrops}
  />);
}

function HistoryLocateHarness({ sessionId, requests }: { sessionId: string; requests: RequestSnapshot[] }) {
  const selection = useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed(requests), contextBoundaries: EMPTY_BOUNDARIES, historical: false, sessionId, historyEnabled: true });
  return <><button type="button" onClick={() => selection.locate("request-10")}>Locate absent request</button><ControlledRequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed(requests)} contextBoundaries={EMPTY_BOUNDARIES} cacheWriteAvailable historical={false} selection={selection} /></>;
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.removeItem("pomegr-disclosure-cache-evidence");
});

describe("RequestsActionsPanel", () => {
  it("waits for slow navigation and retries the same request while history hydrates", async () => {
    vi.useFakeTimers();
    let resolveNavigation!: (value: unknown) => void;
    const response = (items: RequestSnapshot[], status = "ready") => ({ ok: true, json: async () => ({ status, kind: "requests", revision: "r1", total: 100, offset: 0, linkedCount: 0, items }) });
    const fetchPage = vi.fn().mockResolvedValueOnce(response([{ ...snapshot(100), number: 100 } as RequestSnapshot]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNavigation = resolve; }))
      .mockResolvedValueOnce(response([{ ...snapshot(10), number: 10 } as RequestSnapshot]));
    vi.stubGlobal("fetch", fetchPage);
    await act(async () => { render(<HistoryLocateHarness sessionId="slow-history" requests={[]} />); });
    fireEvent.click(screen.getByRole("button", { name: "Locate absent request" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await act(async () => { resolveNavigation(response([], "loading")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[2][0]).toContain("requestId=request-10");
    expect(screen.getByRole("heading", { name: "Request #10" })).toBeInTheDocument();
  });

  it("keeps persistent request labels across pages and loads an absent selection around its stable id", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      const query = new URL(url, "http://localhost").searchParams;
      const selected = query.get("requestId");
      const items = selected
        ? Array.from({ length: 20 }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }))
        : Array.from({ length: 20 }, (_, index) => ({ ...snapshot(index + 81), number: index + 81 }));
      return { ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "history-r1", total: 100, offset: selected ? 0 : 80, linkedCount: 0, items }) };
    }));
    const { container } = render(<HistoryLocateHarness sessionId="history-one" requests={Array.from({ length: 100 }, (_, index) => snapshot(index + 1))} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #100" })).toBeInTheDocument());
    expect(axisLabels(container)).toEqual(["#81", "#100"]);
    await user.click(screen.getByRole("button", { name: "Locate absent request" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #10" })).toBeInTheDocument());
    expect(axisLabels(container)).toEqual(["#1", "#20"]);
    expect(calls.at(-1)).toContain("requestId=request-10");
    expect(screen.getByText("Request numbers are stable labels within this session, not provider ids.", { exact: false })).toBeInTheDocument();
  });

  it("discards an earlier session-history response after the viewed session changes", async () => {
    const deferred: Array<(value: { ok: boolean; json: () => Promise<unknown> }) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => deferred.push(resolve))));
    const requests = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const { rerender } = render(<HistoryLocateHarness sessionId="history-one" requests={requests} />);
    await waitFor(() => expect(deferred).toHaveLength(1));
    rerender(<HistoryLocateHarness sessionId="history-two" requests={requests} />);
    await waitFor(() => expect(deferred).toHaveLength(2));
    deferred[1]({ ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "two", total: 1, offset: 0, linkedCount: 0, items: [{ ...snapshot(200), number: 200 }] }) });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #200" })).toBeInTheDocument());
    deferred[0]({ ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "one", total: 1, offset: 0, linkedCount: 0, items: [{ ...snapshot(1), number: 1 }] }) });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #200" })).toBeInTheDocument());
  });

  it("uses detail Prev and Next across pages even when stable labels have gaps", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const offset = new URL(url, "http://localhost").searchParams.get("offset");
      const start = offset === "0" ? 1 : 41;
      return { ok: true, json: async () => ({ status: "ready", kind: "requests", revision: "history-r1", total: 100, offset: start - 1, linkedCount: 0, items: Array.from({ length: 60 }, (_, index) => ({ ...snapshot(start + index), number: (start + index) * 2 })) }) };
    }));
    const { container } = render(<HistoryLocateHarness sessionId="history-steps" requests={Array.from({ length: 100 }, (_, index) => snapshot(index + 1))} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #200" })).toBeInTheDocument());
    await user.click(within(container).getByRole("button", { name: /^Request #82,/ }));
    await user.click(screen.getByRole("button", { name: "Prev" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #80" })).toBeInTheDocument());
    await user.click(within(container).getByRole("button", { name: /^Request #120,/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Request #122" })).toBeInTheDocument());
  });
  it("retains request 44's refill marker through parsing and detail-feed trimming after a synthetic message", () => {
    const feeds = claudeCacheRefillFeeds();
    const requests = feeds.requestSnapshots as RequestSnapshotFeed;
    const events = feeds.cacheEvents as CacheEventFeed;
    expect(requests.items).toHaveLength(66);
    expect(events.items).toHaveLength(20);
    expect(events.items.some((event) => event.observedAt === requests.items[43].observedAt)).toBe(false);
    const { container } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requests}
      contextBoundaries={[]} cacheWriteAvailable historical cacheEvents={events} />);
    const marker = container.querySelector(".requestsActionsRefill")!;
    expect(marker).toBeInTheDocument();
    expect(marker.querySelector("title")).toHaveTextContent("Possible full refill · request #44");
    expect(container.querySelectorAll(".requestsActionsMiniRefill")).toHaveLength(1);
    fireEvent.click(marker.closest(".requestsActionsBar")!);
    expect(screen.getByRole("heading", { name: "Request #44" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Request cache evidence" })).toHaveTextContent("Possible full refill");
  });

  it.each([
    { phone: false, count: 33, ordinals: [1, 17, 33] },
    { phone: false, count: 5, ordinals: [1, 5] },
    { phone: false, count: 1, ordinals: [1] },
    { phone: false, count: 2, ordinals: [2] },
    { phone: false, count: 1_000, ordinals: [941, 971, 1000] },
    { phone: true, count: 10, ordinals: [1, 10] },
    { phone: true, count: 1, ordinals: [1] },
    { phone: true, count: 2, ordinals: [2] },
    { phone: true, count: 100, ordinals: [81, 100] },
  ])("anchors readable axis labels to bars for $count requests (phone: $phone)", ({ phone, count, ordinals }) => {
    setPhone(phone);
    const { container } = renderPanel(Array.from({ length: count }, (_, index) => snapshot(index + 1)));
    const svg = chart(container);
    const labels = Array.from(svg.querySelectorAll(".requestsActionsAxis:last-child text"));
    expect(labels.map((label) => Number(label.textContent?.match(/^#(\d+)/)?.[1]))).toEqual(ordinals);
    labels.forEach((label, index) => {
      const bar = within(container).getByRole("button", { name: new RegExp(`^Request #${ordinals[index]},`) });
      const segment = bar.querySelector(".requestsActionsSegment")!;
      const center = Number(segment.getAttribute("x")) + Number(segment.getAttribute("width")) / 2;
      expect(Number(label.getAttribute("x"))).toBeCloseTo(center);
    });
    if (count === 33) {
      expect(labels[1]).toHaveTextContent(/^#17 · /);
      expect(Number(labels.at(-1)!.getAttribute("x"))).toBeLessThan(700);
    }
  });

  it("advances the last axis label with an appended request while keeping existing bars stationary", () => {
    const items = Array.from({ length: 33 }, (_, index) => snapshot(index + 1));
    const { container, rerender } = renderPanel(items);
    const positions = Array.from(container.querySelectorAll(".requestsActionsSegment.uncached"), (bar) => bar.getAttribute("x"));
    const previousLastX = Number(chart(container).querySelector(".requestsActionsAxis:last-child text:last-child")!.getAttribute("x"));
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([...items, snapshot(34)])} contextBoundaries={[]} cacheWriteAvailable historical={false} />);
    expect(Array.from(container.querySelectorAll(".requestsActionsSegment.uncached"), (bar) => bar.getAttribute("x")).slice(0, 33)).toEqual(positions);
    const lastLabel = chart(container).querySelector(".requestsActionsAxis:last-child text:last-child")!;
    const lastBar = container.querySelectorAll(".requestsActionsSegment.uncached")[33];
    expect(lastLabel).toHaveTextContent("#34");
    expect(Number(lastLabel.getAttribute("x"))).toBeGreaterThan(previousLastX);
    expect(Number(lastLabel.getAttribute("x"))).toBeCloseTo(Number(lastBar.getAttribute("x")) + Number(lastBar.getAttribute("width")) / 2);
  });

  it("renders a 60-request desktop window from a 1,000-row retained feed", () => {
    const { container } = renderPanel(Array.from({ length: 1_000 }, (_, index) => snapshot(index + 1)));
    expect(container.querySelectorAll(".requestsActionsBar")).toHaveLength(60);
    expect(axisLabels(container)).toEqual(["#941", "#1000"]);
    expect(screen.getByRole("heading", { name: "Request #1000" })).toBeInTheDocument();
    expect(screen.getByText("Request numbers are positions in the retained feed (latest 100 per agent), not provider ids. Before and Issued come from transcript adjacency and recorded links; they do not establish token cost per operation.")).toBeInTheDocument();
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
    const { container } = renderPanel(Array.from({ length: 100 }, (_, index) => snapshot(index + 1, "primary", {
      uncachedInputTokens: 1_000, cacheReadTokens: 90_000,
    })));
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[9]);
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    const labels = axisLabels(container);
    expect(container.querySelectorAll(".requestsActionsSegment.read")).toHaveLength(0);
    expect(container.querySelectorAll(".requestsActionsOutline")).toHaveLength(0);
    expect(screen.getByText("0–8,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("Rescaled · cache reads excluded")).toBeInTheDocument();
    expect(screen.getByText("Full prompt").parentElement).toHaveTextContent("93,000 tokens");
    const freshHeight = Number(container.querySelector(".requestsActionsSelection")!.getAttribute("height"));
    expect(freshHeight).toBeCloseTo(171.5);
    const selectedBar = container.querySelector(".requestsActionsBar.isSelected .requestsActionsSegment")!;
    const selectedLabel = container.querySelector(".requestsActionsSelectedLabel")!;
    expect(Number(selectedLabel.getAttribute("x"))).toBeCloseTo(
      Number(selectedBar.getAttribute("x")) + Number(selectedBar.getAttribute("width")) / 2,
    );
    expect(Number(selectedLabel.getAttribute("y"))).toBeCloseTo(70.5);

    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(labels);
    expect(container.querySelectorAll(".requestsActionsSegment.read")).toHaveLength(60);
    expect(container.querySelectorAll(".requestsActionsOutline")).toHaveLength(0);
    expect(screen.getByText("0–120K tokens")).toBeInTheDocument();
    expect(screen.getByText("All input + output")).toBeInTheDocument();
    expect(screen.getByText("Full prompt").parentElement).toHaveTextContent("93,000 tokens");

    await user.click(screen.getByRole("button", { name: "Fresh tokens" }));
    expect(screen.getByRole("heading", { name: "Request #50" })).toBeInTheDocument();
    expect(axisLabels(container)).toEqual(labels);
    expect(Number(container.querySelector(".requestsActionsSelection")!.getAttribute("height"))).toBe(freshHeight);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Request window" }), { key: "Home" });
    expect(screen.getByText("0–8,000 tokens")).toBeInTheDocument();
  });

  it("includes output when comparing full-breakdown requests in the minimap", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel([
      snapshot(1, "primary", { uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900, outputTokens: 9_000 }),
      snapshot(2, "primary", { uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900, outputTokens: 1_000 }),
    ]);
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    const heights = Array.from(container.querySelectorAll(".requestsActionsMiniBar"), (bar) => Number(bar.getAttribute("height")));
    expect(heights[0]).toBeCloseTo(22);
    expect(heights[1]).toBeCloseTo(4.4);
  });

  it("rescales on phones while preserving prompt size and selection", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const { container } = renderPanel([snapshot(1, "primary", {
      uncachedInputTokens: 2_000, cacheWriteTokens: 0, cacheReadTokens: 90_000, outputTokens: 1_000,
    })], { cacheWriteAvailable: false });
    expect(screen.getByText("0–3,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("Full prompt").parentElement).toHaveTextContent("92,000 tokens");
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(screen.getByText("0–120K tokens")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Request #1" })).toBeInTheDocument();
    expect(screen.getByText("Full prompt").parentElement).toHaveTextContent("92,000 tokens");
    expect(container.querySelectorAll(".requestsActionsOutline")).toHaveLength(0);
    expect(screen.queryByText("Cache write")).not.toBeInTheDocument();
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
    const detail = screen.getByRole("region", { name: "Selected request" });
    expect(within(detail).getByText("Before")).toBeInTheDocument();
    expect(within(detail).getByText("Issued")).toBeInTheDocument();
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

  it("keeps ordinary cache writes in bars and details without refill lines", () => {
    const target = snapshot(1, "primary", { uncachedInputTokens: 2, cacheWriteTokens: 40415, cacheReadTokens: 0 });
    const event: CacheEvent = { id: "initial", agentId: "primary", kind: "refill", observedAt: target.observedAt, promptInputTokens: 40417, cacheReadPercent: 0, cacheWriteTokens: 40415, previousCacheReadPercent: null, gapMs: null, relatedEventId: null };
    const { container } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([target])} contextBoundaries={[]} cacheWriteAvailable historical cacheEvents={{ status: "ready", items: [event], possibleFullRefills: [] }} />);
    expect(container.querySelector(".requestsActionsRefill")).toBeNull();
    expect(container.querySelector(".requestsActionsMiniRefill")).toBeNull();
    expect(container.querySelector(".requestsActionsSegment.write")).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsStat.write")).toHaveTextContent("40,415");
    expect(screen.queryByRole("region", { name: "Request cache evidence" })).not.toBeInTheDocument();
  });

  it("marks recorded and inferred refills, selects their request, and preserves markers across modes", async () => {
    const user = userEvent.setup();
    const target = snapshot(2);
    const event: CacheEvent = {
      id: "refill-2", agentId: "primary", kind: "refill", observedAt: target.observedAt,
      promptInputTokens: 5_000, cacheReadPercent: 5, cacheWriteTokens: 5_000,
      previousCacheReadPercent: 90, gapMs: 1_000, relatedEventId: null,
    };
    const { container } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([snapshot(1), target])} contextBoundaries={[]} cacheWriteAvailable historical={false}
      cacheEvents={{ status: "ready", items: [event], possibleFullRefills: fullRefill("primary", target.observedAt) }}
      cacheReadDrops={{ status: "ready", items: [] }} />);
    const marker = container.querySelector(".requestsActionsRefill")!;
    expect(marker.querySelector("title")).toHaveTextContent("Possible full refill · request #2");
    expect(marker.querySelector(".cacheRefillIcon")).toHaveAttribute("width", "16");
    expect(marker.querySelector(".cacheRefillIcon")).toHaveAttribute("height", "16");
    const bar = marker.closest(".requestsActionsBar")!;
    expect(bar).toHaveAttribute("aria-label", expect.stringContaining("Possible full refill"));
    expect(marker).not.toHaveClass("isInferred");
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Request #2" })).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsBar.isSelected .requestsActionsRefill")).toBeInTheDocument();
    fireEvent.click(marker);
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(container.querySelector(".requestsActionsRefill")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Request cache evidence" })).toHaveTextContent("Possible full refill");
    expect(screen.getByRole("region", { name: "Request cache evidence" })).toHaveTextContent("90% → 5%");
    expect(container.querySelector(".requestsActionsBar.isSelected")).toHaveAttribute("aria-label", expect.stringContaining("Possible full refill"));
  });

  it("renders read-drop evidence as an inferred marker and keeps it usable on phone", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const target = snapshot(2);
    const cacheReadDrops: CacheReadDropFeed = { status: "ready", items: [{ agentId: "primary", count: 1, occurrences: [{ id: "drop-2", observedAt: target.observedAt, previousCacheReadPercent: 90, cacheReadPercent: 5, gapMs: 1_000 }] }] };
    const { container } = renderPanel([snapshot(1), target], { cacheReadDrops });
    const marker = container.querySelector(".requestsActionsRefill.isInferred")!;
    expect(marker.querySelector("title")).toHaveTextContent("Possible refill · request #2");
    expect(marker.closest(".requestsActionsBar")).toHaveAttribute("aria-label", expect.stringContaining("Possible refill"));
    expect(container.querySelector(".requestsActionsMiniRefill")).toBeNull();
    fireEvent.click(marker);
    expect(screen.getByRole("heading", { name: "Request #2" })).toBeInTheDocument();
    const evidence = screen.getByRole("region", { name: "Request cache evidence" });
    expect(evidence).toHaveTextContent("Possible refill");
    expect(evidence).toHaveTextContent(/Inference/i);
    expect(evidence).toHaveTextContent("90% → 5%");
    await user.click(screen.getByRole("button", { name: "Full breakdown" }));
    expect(container.querySelector(".requestsActionsRefill.isInferred")).toBeInTheDocument();
  });

  it("renders compaction and refill markers together and refreshes selected evidence", () => {
    const first = snapshot(1);
    const target = snapshot(2);
    const event: CacheEvent = {
      id: "refill-refresh", agentId: "primary", kind: "refill", observedAt: target.observedAt,
      promptInputTokens: 5_000, cacheReadPercent: 5, cacheWriteTokens: 5_000,
      previousCacheReadPercent: 90, gapMs: 1_000, relatedEventId: null,
    };
    const props = { agents: [agent], requestSnapshots: requestFeed([first, target]), contextBoundaries: [{
      id: "compact", agentId: "primary", timestamp: "2026-08-09T12:01:30.000Z", kind: "automatic_compaction" as const, preTokens: null,
    }], cacheWriteAvailable: true, historical: false };
    const { container, rerender } = render(<RequestsActionsPanel {...props} />);
    fireEvent.click(container.querySelectorAll(".requestsActionsBar")[1]);
    expect(container.querySelector(".requestsActionsBar.isSelected .requestsActionsCompaction")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Request cache evidence" })).not.toBeInTheDocument();
    rerender(<RequestsActionsPanel {...props} cacheEvents={{ status: "ready", items: [event], possibleFullRefills: fullRefill("primary", target.observedAt) }} />);
    expect(container.querySelector(".requestsActionsBar.isSelected .requestsActionsCompaction")).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsBar.isSelected .requestsActionsRefill")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Request cache evidence" })).toHaveTextContent("Possible full refill");
  });

  it("keeps duplicate request timestamps visible in evidence without arbitrary interaction", () => {
    const observedAt = "2026-08-09T12:00:00.000Z";
    const event: CacheEvent = {
      id: "refill-duplicate", agentId: "primary", kind: "refill", observedAt,
      promptInputTokens: 5_000, cacheReadPercent: 5, cacheWriteTokens: 5_000,
      previousCacheReadPercent: 90, gapMs: 1_000, relatedEventId: null,
    };
    const duplicate = snapshot(1, "primary", { observedAt });
    const { container } = render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([duplicate, { ...duplicate, id: "request-duplicate" }])}
      contextBoundaries={[]} cacheWriteAvailable historical={false} cacheEvents={{ status: "ready", items: [event], possibleFullRefills: [] }} />);
    fireEvent.click(container.querySelector(".cacheEvidenceDisclosure summary")!);
    const evidenceList = screen.getByRole("list");
    const row = within(evidenceList).getByText("Cache refill").closest(".cacheEvidenceRow")!;
    expect(row).toBeInTheDocument();
    expect(row).not.toHaveClass("interactive");
    expect(row).not.toHaveAttribute("role");
    expect(row).not.toHaveAttribute("tabindex");
    expect(row).toHaveTextContent("5% read");
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
