import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemo, type ComponentProps } from "react";
import type { Activity, ActivityFeed, Agent, ContextHistoryBoundary, RequestSnapshot, RequestSnapshotFeed } from "../../shared/monitor-contract";
import { ActivityPanel } from "../../app/components/dashboard/ActivityPanel";
import { RequestsActionsPanel } from "../../app/components/dashboard/RequestsActionsPanel";
import { useSessionRequestSelection } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { agent } from "./dashboard-test-fixtures";

const childAgent: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder" };
const baseTime = Date.parse("2026-08-09T12:00:00.000Z");
const noBoundaries: ContextHistoryBoundary[] = [];

function snapshot(index: number, agentId = "primary"): RequestSnapshot {
  const uncachedInputTokens = 20_000 - index * 10;
  const cacheWriteTokens = 200;
  const cacheReadTokens = 300;
  const outputTokens = 400;
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
  };
}

function requestFeed(items: RequestSnapshot[]): RequestSnapshotFeed {
  return { status: "ready", items };
}

function activity(index: number, overrides: Partial<Activity> = {}): Activity {
  return {
    id: `activity-${index}`,
    timestamp: new Date(baseTime + index * 60_000).toISOString(),
    actor: "Primary agent",
    tool: `Tool ${index}`,
    workKind: "read",
    detail: `target-${index}`,
    status: null,
    durationMs: 1_200,
    requestId: `request-${index}`,
    ...overrides,
  };
}

function activityFeed(items: Activity[], overrides: Partial<ActivityFeed> = {}): ActivityFeed {
  const toolItems = items.filter((item) => item.requestId !== null);
  const byKind = [...new Set(toolItems.map((item) => item.workKind))].map((kind) => {
    const durations = toolItems.filter((item) => item.workKind === kind).map((item) => item.durationMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
    return { kind, count: toolItems.filter((item) => item.workKind === kind).length, medianDurationMs: durations[Math.floor(durations.length / 2)] ?? null };
  });
  return { items, total: items.length, toolCalls: toolItems.length, byKind, messages: items.length - toolItems.length, failed: items.filter((item) => item.status === "failed").length, ...overrides };
}

function activityItems(count: number): Activity[] {
  return Array.from({ length: count }, (_, index) => activity(index + 1)).reverse();
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

type HarnessProps = {
  activity: ActivityFeed;
  requests: RequestSnapshot[];
  agents?: Agent[];
  historical?: boolean;
  sessionId?: string;
  historyEnabled?: boolean;
};

function ActivityHarness({ activity: feed, requests, agents = [agent], historical = false, sessionId = "activity-test", historyEnabled = false }: HarnessProps) {
  const snapshots = useMemo(() => requestFeed(requests), [requests]);
  const selection = useSessionRequestSelection({
    sessionId,
    agents,
    requestSnapshots: snapshots,
    contextBoundaries: noBoundaries,
    historical,
    historyEnabled,
  });
  const requestProps: ComponentProps<typeof RequestsActionsPanel> = {
    agents,
    requestSnapshots: snapshots,
    contextBoundaries: noBoundaries,
    cacheWriteAvailable: true,
    historical,
    selection,
  };
  return <>
    <RequestsActionsPanel {...requestProps} />
    <ActivityPanel activity={feed} sessionId={sessionId} selection={selection} historical={historical} loading={false} onRefresh={() => {}} historyEnabled={historyEnabled} />
  </>;
}

function renderActivity(feed: ActivityFeed, requests: RequestSnapshot[], options: Omit<HarnessProps, "activity" | "requests"> & { phone?: boolean } = {}) {
  const { phone = false, ...rest } = options;
  setPhone(phone);
  return render(<ActivityHarness activity={feed} requests={requests} {...rest} />);
}

function panel(container: HTMLElement): HTMLElement {
  return container.querySelector("section.activityPanel") as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem("pomegr-activity-breakdown-activity-test");
});

describe("ActivityPanel", () => {
  it("pages all available events in pages of eight", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 200 }, (_, index) => snapshot(index + 1));
    const view = renderActivity(activityFeed(activityItems(200)), requests);
    const activityPanel = panel(view.container);

    expect(activityPanel.querySelectorAll(".activityRow")).toHaveLength(8);
    expect(within(activityPanel).queryByRole("button", { name: "Show only this request" })).not.toBeInTheDocument();
    expect(activityPanel.querySelector(".activityLinkNote")).not.toBeInTheDocument();
    expect(within(activityPanel).getByText("Showing 193–200 of 200")).toBeInTheDocument();
    const initialRows = activityPanel.querySelectorAll(".activityRow");
    expect(initialRows[0]).toHaveTextContent("Tool 193");
    expect(initialRows[7]).toHaveTextContent("Tool 200");
    const pages = within(activityPanel).getByRole("navigation", { name: "Activity pages" });
    await user.click(within(pages).getByRole("button", { name: "1" }));

    expect(within(activityPanel).getByText("Showing 1–8 of 200")).toBeInTheDocument();
    expect(activityPanel.querySelectorAll(".activityRow")).toHaveLength(8);
    expect(within(pages).getByRole("button", { name: "1" })).toHaveAttribute("aria-current", "page");
    expect(within(activityPanel).getByRole("button", { name: /Tool 1, Primary agent, request #1/ })).toBeInTheDocument();
    await user.click(within(pages).getByRole("button", { name: "2" }));
    expect(within(activityPanel).getByText("Showing 9–16 of 200")).toBeInTheDocument();
    expect(within(activityPanel).getByRole("button", { name: /Tool 9, Primary agent, request #9/ })).toBeInTheDocument();
  });

  it("anchors a later live page to its first visible row when new events arrive", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 60 }, (_, index) => snapshot(index + 1));
    const initialActivity = activityItems(60);
    const view = renderActivity(activityFeed(initialActivity), requests);
    const activityPanel = panel(view.container);
    const pages = within(activityPanel).getByRole("navigation", { name: "Activity pages" });
    await user.click(within(pages).getByRole("button", { name: "7" }));
    expect(activityPanel.querySelector(".activityRow")!).toHaveTextContent("Tool 49");

    view.rerender(<ActivityHarness
      activity={activityFeed([activity(61), ...initialActivity])}
      requests={[...requests, snapshot(61)]}
    />);

    expect(within(panel(view.container)).getByText("Showing 49–56 of 61")).toBeInTheDocument();
    expect(panel(view.container).querySelector(".activityRow")!).toHaveTextContent("Tool 49");
    expect(within(panel(view.container)).queryByRole("button", { name: /Tool 61, Primary agent/ })).not.toBeInTheDocument();
  });

  it("highlights activity rows when a request bar is selected", async () => {
    const user = userEvent.setup();
    const requests = [snapshot(1), snapshot(2), snapshot(3)];
    const view = renderActivity(activityFeed(activityItems(3)), requests);
    const activityPanel = panel(view.container);
    const requestBar = view.container.querySelector('[aria-label^="Request #1,"]') as HTMLElement;
    expect(requestBar).toHaveAttribute("aria-pressed", "false");

    await user.click(requestBar);

    expect(requestBar).toHaveAttribute("aria-pressed", "true");
    expect(within(panel(view.container)).getByRole("button", { name: /Tool 1, Primary agent, request #1/ })).toHaveClass("selected");
    expect(activityPanel.querySelector(".activityPanelHeader p")).toHaveTextContent(/request #1 highlighted/i);
  });

  it("selects a row and rewindows the sibling chart around its request", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const view = renderActivity(activityFeed(activityItems(100)), requests);
    const activityPanel = panel(view.container);
    const pages = within(activityPanel).getByRole("navigation", { name: "Activity pages" });
    await user.click(within(pages).getByRole("button", { name: "1" }));
    await user.click(within(activityPanel).getByRole("button", { name: /Tool 3, Primary agent, request #3/ }));

    expect(view.container.querySelector(".requestsActionsChart")).toHaveAttribute("aria-label", "Model requests, positions 1 to 60");
    expect(view.container.querySelector('[aria-label^="Request #3,"]')).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an off-page notice for a selected request and links to its page", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const view = renderActivity(activityFeed(activityItems(100)), requests);
    const activityPanel = panel(view.container);
    const pages = within(activityPanel).getByRole("navigation", { name: "Activity pages" });
    await user.click(within(pages).getByRole("button", { name: "1" }));
    await user.click(within(activityPanel).getByRole("button", { name: /Tool 3, Primary agent, request #3/ }));
    await user.click(within(pages).getByRole("button", { name: "13" }));

    const pageLink = within(activityPanel).getByRole("button", { name: "page 1" });
    expect(activityPanel.querySelector(".activityPanelHeader p")).toHaveTextContent(/on page 1/);
    await user.click(pageLink);
    expect(within(activityPanel).getByRole("button", { name: /Tool 3, Primary agent, request #3/ })).toHaveClass("selected");
  });

  it("does not claim to highlight a request with no linked activity", () => {
    const view = renderActivity(activityFeed([activity(1, { requestId: null, tool: "Assistant replied" })]), [snapshot(1)]);
    const header = panel(view.container).querySelector(".activityPanelHeader p");
    expect(header).toHaveTextContent("request #1 · no linked activity in retained feed");
    expect(header).not.toHaveTextContent("highlighted");
    expect(panel(view.container).querySelectorAll(".activityRow.selected")).toHaveLength(0);
  });

  it("follows live requests after the newest histogram bar is selected", async () => {
    const user = userEvent.setup();
    const requests = [snapshot(1), snapshot(2), snapshot(3)];
    const view = renderActivity(activityFeed(activityItems(3)), requests);
    await user.click(view.container.querySelector('[aria-label^="Request #3,"]') as HTMLElement);

    view.rerender(<ActivityHarness
      activity={activityFeed([activity(4), ...activityItems(3)])}
      requests={[...requests, snapshot(4)]}
    />);

    expect(view.container.querySelector('[aria-label^="Request #3,"]')).toHaveAttribute("aria-pressed", "false");
    expect(view.container.querySelector('[aria-label^="Request #4,"]')).toHaveAttribute("aria-pressed", "true");
    expect(panel(view.container).querySelector(".activityPanelHeader p")).toHaveTextContent(/request #4 highlighted/i);
  });

  it.each([false, true])("resumes following live requests after selecting the latest Activity row (phone: %s)", async (phone) => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 8 }, (_, index) => snapshot(index + 1));
    const initial = activityItems(8);
    const view = renderActivity(activityFeed(initial), requests, { phone });
    const activityPanel = panel(view.container);

    // An older Activity link deliberately pins the chart; selecting the newest
    // link must put it back into the same following mode as the newest bar.
    await user.click(within(activityPanel).getByRole("button", { name: /Tool 7, Primary agent, request #7/ }));
    await user.click(within(activityPanel).getByRole("button", { name: /Tool 8, Primary agent, request #8/ }));
    view.rerender(<ActivityHarness
      activity={activityFeed([activity(9), ...initial])}
      requests={[...requests, snapshot(9)]}
    />);

    expect(view.container.querySelector('[aria-label^="Request #8,"]')).toHaveAttribute("aria-pressed", "false");
    expect(view.container.querySelector('[aria-label^="Request #9,"]')).toHaveAttribute("aria-pressed", "true");
    expect(within(panel(view.container)).getByRole("button", { name: /Tool 9, Primary agent, request #9/ })).toHaveClass("selected");
    expect(panel(view.container)).toHaveTextContent(phone ? "Page 2 of 2" : "Showing 9–9 of 9");
  });

  it("refreshes the latest Activity history page after returning to its newest row", async () => {
    const events = activityItems(8).map((event) => ({ ...event, agentId: "primary", requestNumber: Number(event.requestId?.split("-")[1]) }));
    const requests = Array.from({ length: 8 }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }));
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const kind = params.get("kind");
      const offset = params.get("offset") === "latest" ? 0 : Number(params.get("offset"));
      return { ok: true, json: async () => ({
        kind,
        status: "ready",
        revision: "1",
        total: 8,
        offset,
        linkedCount: params.has("requestId") ? 1 : 0,
        items: (kind === "requests" ? requests : [...events].reverse()).slice(offset, offset + (kind === "requests" ? 60 : 8)),
        ...(kind === "requests" ? { overview: requests.map((row) => [row.uncachedInputTokens, row.cacheWriteTokens, row.cacheReadTokens, row.outputTokens]) } : {}),
      }) };
    });
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", fetcher);
      const view = render(<ActivityHarness activity={activityFeed(events)} requests={[]} historyEnabled />);
      const activityPanel = panel(view.container);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(within(activityPanel).getByRole("button", { name: /Tool 8, Primary agent, request #8/ })).toBeInTheDocument();

      // Pin an older row first so the subsequent latest-row click is what resumes
      // Activity's live polling mode.
      fireEvent.click(within(activityPanel).getByRole("button", { name: /Tool 7, Primary agent, request #7/ }));
      fireEvent.click(within(activityPanel).getByRole("button", { name: /Tool 8, Primary agent, request #8/ }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(view.container.querySelector('[aria-label^="Request #8,"]')).toHaveAttribute("aria-pressed", "true");
      fetcher.mockClear();

      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(fetcher.mock.calls.some(([url]) => url.includes("kind=activity") && url.includes("offset=latest") && !url.includes("requestId="))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("automatically reveals all linked rows when selecting or reselecting an off-page request bar", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 60 }, (_, index) => snapshot(index + 1));
    const items = [...Array.from({ length: 8 }, (_, index) => activity(index + 1)), ...[61, 62, 63].map((index, position) => activity(index, { requestId: "request-9", timestamp: new Date(baseTime + 8 * 60_000 + (position + 1) * 1_000).toISOString() })), ...Array.from({ length: 52 }, (_, index) => activity(index + 9))].reverse();
    const view = renderActivity(activityFeed(items), requests);
    const activityPanel = panel(view.container);
    const pages = within(activityPanel).getByRole("navigation", { name: "Activity pages" });
    const bar = view.container.querySelector('[aria-label^="Request #9,"]') as HTMLElement;

    await user.click(bar);
    expect(within(pages).getByRole("button", { name: "2" })).toHaveAttribute("aria-current", "page");
    expect(activityPanel.querySelectorAll(".activityRow.selected")).toHaveLength(4);

    await user.click(within(pages).getByRole("button", { name: "1" }));
    expect(activityPanel.querySelectorAll(".activityRow.selected")).toHaveLength(0);
    await user.click(bar);
    expect(within(pages).getByRole("button", { name: "2" })).toHaveAttribute("aria-current", "page");
    expect(activityPanel.querySelectorAll(".activityRow.selected")).toHaveLength(4);
  });

  it("reveals a selected request hidden by the Activity agent scope", async () => {
    const user = userEvent.setup();
    const view = renderActivity(activityFeed([activity(2, { actor: "Builder" }), activity(1)]), [snapshot(1), snapshot(2, "child")], { agents: [agent, childAgent] });
    const activityPanel = panel(view.container);
    const scope = within(activityPanel).getByRole("group", { name: "Activity agent scope" });
    await user.click(within(scope).getByRole("button", { name: "Subagents" }));
    await user.click(view.container.querySelector('[aria-label^="Request #1,"]') as HTMLElement);

    expect(within(scope).getByRole("button", { name: "All agents" })).toHaveAttribute("aria-pressed", "true");
    expect(within(activityPanel).getByRole("button", { name: /Tool 1, Primary agent, request #1/ })).toHaveClass("selected");
  });

  it("shows #73 on its assistant reply and reveals that row when selecting its request bar", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 100 }, (_, index) => snapshot(index + 1));
    const items = activityItems(100).map((event) => event.requestId === "request-73"
      ? { ...event, tool: "Assistant replied", workKind: "report" as const, durationMs: null } : event);
    const view = renderActivity(activityFeed(items), requests);
    const activityPanel = panel(view.container);
    expect(within(activityPanel).queryByRole("button", { name: "Assistant replied, Primary agent, request #73" })).not.toBeInTheDocument();

    await user.click(view.container.querySelector('[aria-label^="Request #73,"]') as HTMLElement);

    const reply = within(activityPanel).getByRole("button", { name: "Assistant replied, Primary agent, request #73" });
    expect(reply).toHaveClass("selected");
    expect(reply.querySelector(".activityRequest")).toHaveTextContent("#73");
    expect(within(activityPanel).getByText("Showing 73–80 of 100")).toBeInTheDocument();
  });

  it("automatically reveals linked activity from the phone chart", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 60 }, (_, index) => snapshot(index + 1));
    const view = renderActivity(activityFeed(activityItems(60)), requests, { phone: true });
    const activityPanel = panel(view.container);
    await user.click(within(activityPanel).getByRole("button", { name: "Previous" }));
    expect(activityPanel).toHaveTextContent("Page 7 of 8");
    await user.click(view.container.querySelector('[aria-label^="Request #45,"]') as HTMLElement);

    expect(activityPanel).toHaveTextContent("Page 6 of 8");
    expect(within(activityPanel).getByRole("button", { name: /Tool 45, Primary agent, request #45/ })).toHaveClass("selected");
  });

  it.each([{ gesture: "swipe", resident: true }, { gesture: "minimap", resident: true }, { gesture: "swipe", resident: false }])("reveals activity after $gesture navigation (cached: $resident), then preserves manual paging", async ({ gesture, resident }) => {
    setPhone(true);
    const user = userEvent.setup();
    const requests = Array.from({ length: 100 }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }));
    const events = activityItems(100).map((event) => ({ ...event, agentId: "primary", requestNumber: Number(event.requestId?.split("-")[1]) }));
    let finishWindow: (() => void) | undefined;
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const kind = params.get("kind");
      const limit = Number(params.get("limit"));
      const target = Number(params.get("requestId")?.split("-")[1]);
      const offset = kind === "activity" && target ? Math.floor((target - 1) / 8) * 8
        : params.get("offset") === "latest" ? kind === "activity" ? Math.floor((100 - 1) / 8) * 8 : 100 - limit : Number(params.get("offset"));
      const response = { ok: true, json: async () => ({ kind, status: "ready", revision: "1", total: 100, offset, linkedCount: target ? 1 : 0,
        items: (kind === "requests" ? requests : [...events].reverse()).slice(offset, offset + limit),
        ...(kind === "requests" ? { overview: requests.map((row) => [row.uncachedInputTokens, row.cacheWriteTokens, row.cacheReadTokens, row.outputTokens]) } : {}),
      }) };
      if (!resident && kind === "requests") {
        if (params.get("overview") === "0") return new Promise(() => {});
        if (offset === 60) return new Promise((resolve) => { finishWindow = () => resolve(response); });
      }
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const props = { activity: activityFeed(events), requests: [], historyEnabled: true };
    const view = render(<ActivityHarness {...props} />);
    const activityPanel = panel(view.container);
    await waitFor(() => expect(view.container.querySelector('[aria-label^="Request #100,"]')).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(activityPanel).toHaveTextContent("Tool 100"));
    const lookups = () => fetcher.mock.calls.filter(([url]) => url.includes("kind=activity") && url.includes("requestId="));
    const control = gesture === "swipe" ? view.container.querySelector(".requestsActionsChart")!
      : within(view.container).getByRole("slider", { name: "Request window" });
    vi.spyOn(control, "getBoundingClientRect").mockReturnValue({ left: 0, right: 334, top: 0, bottom: 196, width: 334, height: 196, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(control, { button: 0, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: gesture === "swipe" ? 34 : 334 * .7, clientY: 100 });
    if (gesture === "swipe") fireEvent.pointerMove(control, { pointerId: 1, pointerType: "touch", clientX: 333, clientY: 100 });
    fireEvent.pointerUp(control, { pointerId: 1 });
    if (!resident) {
      expect(finishWindow).toBeDefined();
      expect(view.container.querySelector('[aria-label^="Request #100,"]')).toHaveAttribute("aria-pressed", "true");
      expect(lookups()).toHaveLength(0);
      expect(activityPanel.querySelector(".activityTable")).toHaveAttribute("aria-busy", "true");
      expect(within(activityPanel).getByRole("status")).toHaveTextContent("Loading activity…");
      expect(within(activityPanel).getByRole("button", { name: /Tool 100, Primary agent, request #100/ })).toHaveAttribute("aria-disabled", "true");
      finishWindow!();
    }
    await waitFor(() => expect(view.container.querySelector('[aria-label^="Request #80,"]')).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(within(activityPanel).getByRole("button", { name: /Tool 80, Primary agent, request #80/ })).toHaveClass("selected"));
    expect(activityPanel).toHaveTextContent("1 linked event");
    expect(activityPanel.querySelector(".activityTable")).toHaveAttribute("aria-busy", "false");
    expect(within(activityPanel).queryByText("Loading activity…")).not.toBeInTheDocument();
    expect(lookups()).toHaveLength(1);
    await user.click(within(activityPanel).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(activityPanel).toHaveTextContent("Page 11 of 13"));
    view.rerender(<ActivityHarness {...props} />);
    await user.click(within(activityPanel).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(within(activityPanel).getByRole("button", { name: "Refresh" })).not.toBeDisabled());
    expect(activityPanel).toHaveTextContent("Page 11 of 13");
    expect(lookups()).toHaveLength(1);
  });

  it.each([false, true])("selects another visible Activity row without veiling or reloading the feed (request cached: %s)", async (resident) => {
    setPhone(false);
    const requests = Array.from({ length: 180 }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }));
    const events = activityItems(8).map((event) => ({ ...event, agentId: "primary", requestNumber: Number(event.requestId?.split("-")[1]) }));
    const finishes = new Map<string, () => void>();
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      const kind = params.get("kind");
      const target = params.get("requestId");
      const offset = target ? 0 : params.get("offset") === "latest" ? 120 : Number(params.get("offset"));
      const response = { ok: true, json: async () => ({ kind, status: "ready", revision: "1", total: kind === "requests" ? 180 : 8, offset: kind === "requests" ? offset : 0, linkedCount: 0,
        items: kind === "requests" ? requests.slice(offset, offset + 60) : [...events].reverse(),
        ...(kind === "requests" && params.get("overview") !== "0" ? { overview: requests.map((row) => [row.uncachedInputTokens, row.cacheWriteTokens, row.cacheReadTokens, row.outputTokens]) } : {}),
      }) };
      if (!resident && kind === "requests" && params.get("overview") === "0") return new Promise(() => {});
      if (!resident && kind === "requests" && target) return new Promise((resolve) => { finishes.set(target, () => resolve(response)); });
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<ActivityHarness activity={activityFeed(events)} requests={[]} historyEnabled historical />);
    const activityPanel = panel(view.container);
    await waitFor(() => expect(view.container.querySelector('[aria-label^="Request #180,"]')).toHaveAttribute("aria-pressed", "true"));
    if (resident) await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes("offset=60") && url.includes("overview=0"))).toBe(true));
    const activityCalls = () => fetcher.mock.calls.filter(([url]) => url.includes("kind=activity"));
    const before = activityCalls().length;
    fireEvent.click(within(activityPanel).getByRole("button", { name: /Tool 8, Primary agent, request #8/ }));
    expect(activityPanel.querySelector(".activityTable")).toHaveAttribute("aria-busy", "false");
    expect(activityPanel.querySelector(".activityLoadingVeil")).not.toBeInTheDocument();
    fireEvent.click(within(activityPanel).getByRole("button", { name: /Tool 7, Primary agent, request #7/ }));
    if (resident) {
      expect(fetcher.mock.calls.filter(([url]) => url.includes("kind=requests") && url.includes("requestId="))).toHaveLength(0);
    } else {
      expect(finishes.has("request-7")).toBe(true);
      finishes.get("request-7")!();
      finishes.get("request-8")!();
    }
    await waitFor(() => expect(view.container.querySelector('[aria-label^="Request #7,"]')).toHaveAttribute("aria-pressed", "true"));
    expect(activityCalls()).toHaveLength(before);
  });

  it.each([false, true])("keeps rows visible through foreground loading and exposes failure recovery (phone: %s)", async (phone) => {
    setPhone(phone);
    const user = userEvent.setup();
    const events = activityItems(8).map((event) => ({ ...event, agentId: "primary", requestNumber: Number(event.requestId?.split("-")[1]) }));
    let delay = false;
    let finish!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const kind = new URL(url, "http://localhost").searchParams.get("kind");
      if (kind === "activity" && delay) return new Promise((resolve) => { finish = () => resolve({ ok: false }); });
      return { ok: true, json: async () => ({ kind, status: "ready", revision: "1", total: kind === "activity" ? 8 : 0, offset: 0, linkedCount: 0, items: kind === "activity" ? [...events].reverse() : [] }) };
    }));
    const view = render(<ActivityHarness activity={activityFeed(events)} requests={[]} historyEnabled historical />);
    const activityPanel = panel(view.container);
    await waitFor(() => expect(within(activityPanel).getByRole("button", { name: /Tool 8, Primary agent, request #8/ })).toBeInTheDocument());
    delay = true;
    await user.click(within(activityPanel).getByRole("button", { name: "Refresh" }));
    expect(within(activityPanel).getByRole("status")).toHaveTextContent("Loading activity…");
    expect(activityPanel.querySelector(".activityTable")).toHaveAttribute("aria-busy", "true");
    expect(activityPanel.querySelectorAll(".activityRow")).toHaveLength(8);
    const row = within(activityPanel).getByRole("button", { name: /Tool 8, Primary agent, request #8/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    await user.click(row);
    expect(row).toHaveAttribute("aria-pressed", "false");
    finish();
    await waitFor(() => expect(activityPanel).toHaveTextContent("Activity could not update. Showing the previous page. Try Refresh."));
    expect(activityPanel.querySelector(".activityLoadingVeil")).not.toBeInTheDocument();
    expect(activityPanel.querySelectorAll(".activityRow")).toHaveLength(8);
    expect(row).not.toHaveAttribute("aria-disabled");
  });

  it("does not follow a newer request when viewing a historical session", () => {
    const requests = [snapshot(1), snapshot(2), snapshot(3)];
    const view = renderActivity(activityFeed(activityItems(3)), requests, { historical: true });

    view.rerender(<ActivityHarness
      activity={activityFeed([activity(4), ...activityItems(3)])}
      requests={[...requests, snapshot(4)]}
      historical
    />);

    expect(view.container.querySelector('[aria-label^="Request #3,"]')).toHaveAttribute("aria-pressed", "true");
    expect(view.container.querySelector('[aria-label^="Request #4,"]')).toHaveAttribute("aria-pressed", "false");
  });

  it("filters the feed by primary agent or subagents without changing the retained totals", async () => {
    const user = userEvent.setup();
    const requests = [snapshot(1), snapshot(2, "child"), snapshot(3), snapshot(4, "child")];
    const items = [
      activity(1),
      activity(2, { actor: "Builder" }),
      activity(3),
      activity(4, { actor: "Builder" }),
      activity(5, { actor: "System", tool: "System note", detail: "", requestId: null }),
      activity(6, { actor: "User", tool: "User input", detail: "", requestId: null }),
    ].reverse();
    const view = renderActivity(activityFeed(items), requests, { agents: [agent, childAgent] });
    const activityPanel = panel(view.container);
    const scope = within(activityPanel).getByRole("group", { name: "Activity agent scope" });

    await user.click(within(scope).getByRole("button", { name: "Subagents" }));

    expect(within(scope).getByRole("button", { name: "Subagents" })).toHaveAttribute("aria-pressed", "true");
    expect(activityPanel.querySelectorAll(".activityRow")).toHaveLength(2);
    expect(activityPanel).toHaveTextContent("Tool 2");
    expect(activityPanel).toHaveTextContent("Tool 4");
    expect(activityPanel).not.toHaveTextContent("Tool 1");
    expect(activityPanel).not.toHaveTextContent("System note");
    expect(activityPanel).not.toHaveTextContent("User input");
    expect(activityPanel).toHaveTextContent("of 2 in this scope");
  });

  it("uses the phone disclosure and omits absent metadata and separators", async () => {
    const user = userEvent.setup();
    const requests = [snapshot(1)];
    const items = [activity(1), activity(2, { actor: "System", tool: "Message", detail: "", durationMs: null, requestId: null })].reverse();
    const view = renderActivity(activityFeed(items), requests, { phone: true });
    const activityPanel = panel(view.container);
    const disclosure = activityPanel.querySelector("details.activityBreakdownDisclosure") as HTMLDetailsElement;
    const unmatched = activityPanel.querySelectorAll(".activityRow")[1];

    expect(disclosure).toBeInTheDocument();
    expect(disclosure).not.toHaveAttribute("open");
    expect(activityPanel.querySelector(".activityHead")).not.toBeInTheDocument();
    expect(unmatched).toHaveClass("activityRowPhone");
    expect(unmatched.querySelector(".activityDuration")).not.toBeInTheDocument();
    expect(unmatched.querySelector(".activityRequest")).not.toBeInTheDocument();
    expect(unmatched.querySelector(".target")).not.toBeInTheDocument();
    expect(unmatched).not.toHaveTextContent(/[—·]/);
    const linked = activityPanel.querySelectorAll(".activityRow")[0];
    expect(linked.querySelector(".activityRowMetadata")).toHaveTextContent(/·1.2s#1/);
    expect(linked.querySelector(".activityRowContext")).toHaveTextContent("Primary agent·target-1");
    expect(within(activityPanel).getByRole("button", { name: "Previous" })).toHaveClass("commandSecondaryAction");
    expect(within(activityPanel).getByRole("button", { name: "Next" })).toHaveClass("commandSecondaryAction");

    await user.click(disclosure.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    expect(disclosure.querySelector(".activityBreakdown h3")).toHaveTextContent("Actions by kind");
  });
});
