import { render, within } from "@testing-library/react";
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
};

function ActivityHarness({ activity: feed, requests, agents = [agent], historical = false, sessionId = "activity-test" }: HarnessProps) {
  const snapshots = useMemo(() => requestFeed(requests), [requests]);
  const selection = useSessionRequestSelection({
    sessionId,
    agents,
    requestSnapshots: snapshots,
    contextBoundaries: noBoundaries,
    historical,
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
    <ActivityPanel activity={feed} sessionId={sessionId} selection={selection} historical={historical} loading={false} onRefresh={() => {}} />
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
    expect(within(activityPanel).getByText("Showing 1–8 of 200")).toBeInTheDocument();
    const pages = within(activityPanel).getByRole("navigation", { name: "Activity pages" });
    await user.click(within(pages).getByRole("button", { name: "25" }));

    expect(within(activityPanel).getByText("Showing 193–200 of 200")).toBeInTheDocument();
    expect(activityPanel.querySelectorAll(".activityRow")).toHaveLength(8);
    expect(within(pages).getByRole("button", { name: "25" })).toHaveAttribute("aria-current", "page");
    expect(within(activityPanel).getByRole("button", { name: /Tool 8, Primary agent, request #8/ })).toBeInTheDocument();
  });

  it("anchors a later live page to its first visible row when new events arrive", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 60 }, (_, index) => snapshot(index + 1));
    const initialActivity = activityItems(60);
    const view = renderActivity(activityFeed(initialActivity), requests);
    const activityPanel = panel(view.container);
    const pages = within(activityPanel).getByRole("navigation", { name: "Activity pages" });
    await user.click(within(pages).getByRole("button", { name: "2" }));
    expect(activityPanel.querySelector(".activityRow")!).toHaveTextContent("Tool 52");

    view.rerender(<ActivityHarness
      activity={activityFeed([activity(61), ...initialActivity])}
      requests={[...requests, snapshot(61)]}
    />);

    expect(within(panel(view.container)).getByText("Showing 10–17 of 61")).toBeInTheDocument();
    expect(panel(view.container).querySelector(".activityRow")!).toHaveTextContent("Tool 52");
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
    await user.click(within(pages).getByRole("button", { name: "13" }));
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
    await user.click(within(pages).getByRole("button", { name: "13" }));
    await user.click(within(activityPanel).getByRole("button", { name: /Tool 3, Primary agent, request #3/ }));
    await user.click(within(pages).getByRole("button", { name: "1" }));

    const pageLink = within(activityPanel).getByRole("button", { name: "page 13" });
    expect(activityPanel.querySelector(".activityPanelHeader p")).toHaveTextContent(/on page 13/);
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

  it("keeps an explicitly selected newest request pinned when a live request arrives", async () => {
    const user = userEvent.setup();
    const requests = [snapshot(1), snapshot(2), snapshot(3)];
    const view = renderActivity(activityFeed(activityItems(3)), requests);
    await user.click(view.container.querySelector('[aria-label^="Request #3,"]') as HTMLElement);

    view.rerender(<ActivityHarness
      activity={activityFeed([activity(4), ...activityItems(3)])}
      requests={[...requests, snapshot(4)]}
    />);

    expect(view.container.querySelector('[aria-label^="Request #3,"]')).toHaveAttribute("aria-pressed", "true");
    expect(view.container.querySelector('[aria-label^="Request #4,"]')).toHaveAttribute("aria-pressed", "false");
    expect(panel(view.container).querySelector(".activityPanelHeader p")).toHaveTextContent(/request #3 highlighted/i);
  });

  it("automatically reveals all linked rows when selecting or reselecting an off-page request bar", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 60 }, (_, index) => snapshot(index + 1));
    const items = activityItems(60);
    items.splice(52, 0, ...[61, 62, 63].map((index) => activity(index, { requestId: "request-9" })));
    const view = renderActivity(activityFeed(items), requests);
    const activityPanel = panel(view.container);
    const pages = within(activityPanel).getByRole("navigation", { name: "Activity pages" });
    const bar = view.container.querySelector('[aria-label^="Request #9,"]') as HTMLElement;

    await user.click(bar);
    expect(within(pages).getByRole("button", { name: "7" })).toHaveAttribute("aria-current", "page");
    expect(activityPanel.querySelectorAll(".activityRow.selected")).toHaveLength(4);

    await user.click(within(pages).getByRole("button", { name: "1" }));
    expect(activityPanel.querySelectorAll(".activityRow.selected")).toHaveLength(0);
    await user.click(bar);
    expect(within(pages).getByRole("button", { name: "7" })).toHaveAttribute("aria-current", "page");
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
    expect(within(activityPanel).getByText("Showing 25–32 of 100")).toBeInTheDocument();
  });

  it("automatically reveals linked activity from the phone chart", async () => {
    const user = userEvent.setup();
    const requests = Array.from({ length: 60 }, (_, index) => snapshot(index + 1));
    const view = renderActivity(activityFeed(activityItems(60)), requests, { phone: true });
    const activityPanel = panel(view.container);
    await user.click(within(activityPanel).getByRole("button", { name: "Next" }));
    expect(activityPanel).toHaveTextContent("Page 2 of 8");
    await user.click(view.container.querySelector('[aria-label^="Request #45,"]') as HTMLElement);

    expect(activityPanel).toHaveTextContent("Page 2 of 8");
    expect(within(activityPanel).getByRole("button", { name: /Tool 45, Primary agent, request #45/ })).toHaveClass("selected");
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

  it("uses the phone disclosure and renders null request and duration values as dashes", async () => {
    const user = userEvent.setup();
    const requests = [snapshot(1)];
    const items = [activity(1), activity(2, { actor: "System", tool: "Message", detail: "", durationMs: null, requestId: null })].reverse();
    const view = renderActivity(activityFeed(items), requests, { phone: true });
    const activityPanel = panel(view.container);
    const disclosure = activityPanel.querySelector("details.activityBreakdownDisclosure") as HTMLDetailsElement;
    const unmatched = activityPanel.querySelector(".activityRow")!;

    expect(disclosure).toBeInTheDocument();
    expect(disclosure).not.toHaveAttribute("open");
    expect(activityPanel.querySelector(".activityHead")).not.toBeInTheDocument();
    expect(unmatched).toHaveClass("activityRowPhone");
    expect(unmatched.querySelector(".activityDuration")).toHaveTextContent("—");
    expect(unmatched.querySelector(".activityRequest")).toHaveTextContent("—");
    expect(unmatched.querySelector(".activityRequest")).toHaveAttribute("title", "No recorded request link");
    expect(unmatched.querySelector(".activityRequest")).not.toHaveClass("commandTextLink");
    expect(within(activityPanel).getByRole("button", { name: "Previous" })).toHaveClass("commandSecondaryAction");
    expect(within(activityPanel).getByRole("button", { name: "Next" })).toHaveClass("commandSecondaryAction");

    await user.click(disclosure.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    expect(disclosure.querySelector(".activityBreakdown h3")).toHaveTextContent("Actions by kind");
  });
});
