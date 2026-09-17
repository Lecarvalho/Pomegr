import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/live-events", () => ({
  subscribeLiveEvents: (listener: (event: unknown) => void) => {
    listener({ type: "connection", state: "connected", epoch: 0 });
    return () => {};
  },
}));

import { ActivitiesTab } from "../../app/components/dashboard/ActivitiesTab";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import type { Agent, MonitorState } from "../../shared/monitor-contract";
import { agent, repositorySession } from "./dashboard-test-fixtures";
import { compactNumber, shortTime } from "../../app/dashboard-utils";
import { historyCall, historyRequest, historyServer, type HistoryServerState } from "./activities-test-server";
import type { RequestSelectionRoute } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { setPhone } from "./requests-actions-test-fixtures";

const SESSION = "claude:activities";
const child: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder", role: "builder" };

function monitorState(cacheWriteAvailable = true): MonitorState {
  const state = createEmptyMonitorState({ connected: true });
  return {
    ...state,
    agents: [agent, child],
    capabilities: { ...state.capabilities, cacheWriteUsage: cacheWriteAvailable },
    session: { ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }), id: SESSION, title: "Session", project: "Pomegr" },
  };
}

function fixture({ extra, count = 40, overview = true, route = { agent: null, request: null }, strict = false, historical = false, requestsStatus, activity, cacheWriteAvailable = true, requestGroupOverrides }: {
  extra?: Record<string, unknown>; count?: number; overview?: boolean; route?: RequestSelectionRoute; strict?: boolean; historical?: boolean;
  requestsStatus?: HistoryServerState["requestsStatus"]; activity?: HistoryServerState["activity"]; cacheWriteAvailable?: boolean;
  requestGroupOverrides?: HistoryServerState["requestGroupOverrides"];
} = {}) {
  const requests = Array.from({ length: count }, (_, index) => historyRequest(index + 1, (index + 1) % 2 ? "child" : "primary"));
  const calls = requests.flatMap((request) => request.agentId === "child"
    ? [historyCall(`call-${request.number}-shell`, request, "shell", 1, { actor: "Builder" })]
    : [historyCall(`call-${request.number}-read`, request, "read", 1), historyCall(`call-${request.number}-edit`, request, "write", 2)]);
  const serverState: HistoryServerState = { requests, calls, revision: "1", extra, overview, requestsStatus, activity, requestGroupOverrides };
  const server = historyServer(serverState);
  const state = monitorState(cacheWriteAvailable);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("/api/state")
    ? Promise.resolve(new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } }))
    : server.fetcher(input, init)));
  const onRouteChange = vi.fn();
  const onOpenAgent = vi.fn();
  const view = render(<LiveClockProvider running={false}><ActivitiesTab sessionId={SESSION} historical={historical} paused={false} route={route} onRouteChange={onRouteChange} onOpenAgent={onOpenAgent} /></LiveClockProvider>, { reactStrictMode: strict });
  return { ...view, server, serverState, onRouteChange, onOpenAgent };
}

function feedCalls(server: ReturnType<typeof historyServer>) {
  return server.of("activity").filter((params) => params.get("limit") === "1");
}

async function ready(latest = 40) {
  await screen.findByRole("heading", { name: `Request #${latest}` });
  const feed = screen.getByRole("region", { name: "Activity feed" });
  await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
  return feed;
}

beforeEach(() => setPhone(false));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Activities tab", () => {
  it("applies one agent scope to the chart, Largest requests, feed groups and kind aggregates", async () => {
    const user = userEvent.setup();
    const { container, server } = fixture();
    let feed = await ready();
    expect(within(feed).getAllByRole("article").map((group) => group.getAttribute("aria-label"))).toEqual(["Request #36", "Request #37", "Request #38", "Request #39", "Request #40"]);

    await user.selectOptions(screen.getByLabelText("Agent scope"), "child");
    await screen.findByRole("heading", { name: "Request #39" });
    feed = screen.getByRole("region", { name: "Activity feed" });
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    expect(server.of("requests").at(-1)?.get("scope")).toBe("child");
    expect(feedCalls(server).at(-1)?.get("scope")).toBe("child");
    const bars = Array.from(container.querySelectorAll(".requestsActionsBar"), (bar) => Number(/#(\d+)/u.exec(bar.getAttribute("aria-label") || "")?.[1]));
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((number) => number % 2 === 1)).toBe(true);
    expect(screen.getByRole("region", { name: "Largest requests" })).toHaveTextContent("Builder");
    const groups = within(feed).getAllByRole("article");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Request #31", "Request #33", "Request #35", "Request #37", "Request #39"]);
    for (const group of groups) expect(group).toHaveTextContent("Builder");
    const kinds = within(within(feed).getByRole("group", { name: "Filter calls by kind" })).getAllByRole("button");
    expect(kinds.map((button) => button.textContent)).toEqual([expect.stringContaining("Shell")]);
    expect(feed).toHaveTextContent("Shell tasks20");
  });

  it("filters nested calls by kind without losing the selected request header", async () => {
    const user = userEvent.setup();
    const { server } = fixture();
    const feed = await ready();
    await user.click(within(feed).getByRole("button", { name: /Request #38/u }));
    await waitFor(() => expect(within(feed).getByRole("button", { name: /Request #38/u })).toHaveAttribute("aria-pressed", "true"));
    await user.click(within(feed).getByRole("button", { name: /^Reading/u }));
    await waitFor(() => expect(feedCalls(server).at(-1)?.get("workKind")).toBe("read"));
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    expect(within(feed).getByRole("button", { name: /^Reading/u })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Request #38" })).toBeInTheDocument();
    expect(within(feed).getByRole("button", { name: /Request #38/u })).toHaveAttribute("aria-pressed", "true");
    expect(within(feed).getByRole("article", { name: "Request #37" })).toHaveTextContent("No reading calls for this request.");
    expect(within(feed).getByRole("article", { name: "Request #38" })).not.toHaveTextContent("Editing");
  });

  it("moves the request range with Previous and Next and returns with Jump to latest", async () => {
    const user = userEvent.setup();
    fixture();
    const feed = await ready();
    const range = within(feed).getByRole("navigation", { name: "Request range" });
    expect(within(range).getByRole("button", { name: "Jump to latest" })).toBeDisabled();
    await user.click(within(range).getByRole("button", { name: "Previous" }));
    expect(await screen.findByRole("heading", { name: "Request #35" })).toBeInTheDocument();
    await waitFor(() => expect(within(feed).getAllByRole("article").map((group) => group.getAttribute("aria-label"))).toEqual(["Request #33", "Request #34", "Request #35", "Request #36", "Request #37"]));
    await user.click(within(range).getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Request #40" })).toBeInTheDocument();
    await user.click(within(range).getByRole("button", { name: "Previous" }));
    await screen.findByRole("heading", { name: "Request #35" });
    await user.click(within(range).getByRole("button", { name: "Jump to latest" }));
    expect(await screen.findByRole("heading", { name: "Request #40" })).toBeInTheDocument();
    await waitFor(() => expect(within(range).getByRole("button", { name: "Jump to latest" })).toBeDisabled());
  });

  it("keeps the previous correlated chart and veils the feed during a range fetch", async () => {
    const user = userEvent.setup();
    const { container, server } = fixture({ count: 130, overview: false });
    const feed = await ready(130);
    await user.click(screen.getByRole("button", { name: /^Request #71,/u }));
    await screen.findByRole("heading", { name: "Request #71" });
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    server.holdWhen((params) => params.get("kind") === "requests" && params.get("offset") === "6");
    await user.click(within(within(feed).getByRole("navigation", { name: "Request range" })).getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(server.deferred).toHaveLength(1));
    expect(feed).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { name: "Request #71" })).toBeInTheDocument();
    expect(container.querySelector(".requestsActionsBar.isSelected")?.getAttribute("aria-label")).toMatch(/^Request #71,/u);
    server.holdWhen(null);
    server.deferred[0].resolve();
    expect(await screen.findByRole("heading", { name: "Request #66" })).toBeInTheDocument();
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    expect(container.querySelector(".requestsActionsBar.isSelected")?.getAttribute("aria-label")).toMatch(/^Request #66,/u);
    expect(within(feed).getAllByRole("article").map((group) => group.getAttribute("aria-label"))).toEqual(["Request #64", "Request #65", "Request #66", "Request #67", "Request #68"]);
  });

  it.each([
    { name: "request number", request: "12" },
    { name: "opaque request id", request: "request-12" },
  ])("resolves a $name deep link under StrictMode with a settled feed", async ({ request }) => {
    const { server } = fixture({ count: 130, route: { agent: null, request }, strict: true });
    expect(await screen.findByRole("heading", { name: "Request #12" })).toBeInTheDocument();
    const feed = screen.getByRole("region", { name: "Activity feed" });
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    expect(within(feed).getByRole("button", { name: /Request #12/u })).toHaveAttribute("aria-pressed", "true");
    expect(feedCalls(server).at(-1)?.get("selected")).toBe("12");
  });

  it("offers Retry beside retained groups when a feed query fails, and retries that query", async () => {
    const user = userEvent.setup();
    const { serverState } = fixture();
    const feed = await ready();
    serverState.activity = 503;
    await user.click(within(within(feed).getByRole("navigation", { name: "Request range" })).getByRole("button", { name: "Previous" }));
    await screen.findByRole("heading", { name: "Request #35" });
    expect(await within(feed).findByText(/could not update\. Showing the previous requests\./u)).toBeInTheDocument();
    expect(within(feed).getAllByRole("article").map((group) => group.getAttribute("aria-label"))).toEqual(["Request #36", "Request #37", "Request #38", "Request #39", "Request #40"]);
    expect(feed).toHaveAttribute("aria-busy", "true");
    serverState.activity = undefined;
    await user.click(within(feed).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    expect(within(feed).getAllByRole("article").map((group) => group.getAttribute("aria-label"))).toEqual(["Request #33", "Request #34", "Request #35", "Request #36", "Request #37"]);
    expect(within(feed).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("fetches the grouped feed once per query in a historical session", async () => {
    const user = userEvent.setup();
    const { server } = fixture({ historical: true });
    const feed = await ready();
    expect(feedCalls(server)).toHaveLength(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(feedCalls(server)).toHaveLength(1);
    await user.click(within(within(feed).getByRole("navigation", { name: "Request range" })).getByRole("button", { name: "Previous" }));
    await screen.findByRole("heading", { name: "Request #35" });
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(feedCalls(server)).toHaveLength(2);
  });

  it("never renders request ids, provider ids, commands or outputs in text or attributes", async () => {
    const { container } = fixture({ extra: { command: "rm -rf SECRET_COMMAND", stdout: "SECRET_OUTPUT", stderr: "SECRET_ERROR", providerMessageId: "msg_SECRET_PROVIDER" } });
    const feed = await ready();
    expect(within(feed).getAllByText("file.tsx").length).toBeGreaterThan(0);
    expect(feed.innerHTML).not.toContain("app/components/dashboard/deep");
    const html = container.innerHTML;
    for (const forbidden of ["request-", "call-", "SECRET_COMMAND", "SECRET_OUTPUT", "SECRET_ERROR", "msg_SECRET_PROVIDER"]) expect(html).not.toContain(forbidden);
  });

  it("puts the request groups before Actions by kind and Shell tasks on phone", async () => {
    setPhone(true);
    fixture();
    const feed = await ready();
    const layout = feed.querySelector(".activityLayout")!;
    expect(layout).toHaveClass("isPhone");
    const [first, second] = Array.from(layout.children);
    expect(first).toHaveClass("activityFeed");
    expect(second).toHaveClass("activityBreakdown");
    expect(within(first as HTMLElement).getAllByRole("article").length).toBeGreaterThan(0);
    expect(within(second as HTMLElement).getByRole("heading", { name: "Actions by kind" })).toBeInTheDocument();
  });

  it("shows a phone request line with agent, role, uncached input and time that selects the request", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const { container } = fixture();
    const feed = await ready();

    const group = within(feed).getByRole("article", { name: "Request #38" });
    const line = within(group).getByRole("button", { name: `Request #38, Primary agent, orchestrator, uncached input 1,962,000, ${shortTime(historyRequest(38).observedAt)}, 2 calls` });
    expect(line).toHaveTextContent(`#38Primary agent orchestrator${compactNumber(1_962_000)} in · ${shortTime(historyRequest(38).observedAt)}`);
    // The line names the agent itself, so the desktop agent link is not repeated under it.
    expect(within(group).queryByRole("button", { name: "Primary agent" })).toBeNull();

    await user.click(line);
    await screen.findByRole("heading", { name: "Request #38" });
    expect(container.querySelector(".requestsActionsBar.isSelected")).toHaveAttribute("aria-label", expect.stringMatching(/^Request #38, Primary agent,/u));
    const selected = Array.from(feed.querySelectorAll(".activityTableFrame.isSelectedRequest"));
    expect(selected).toEqual([group]);
    expect(group).toHaveAttribute("data-request", "38");
  });

  it("keeps the shown request window when a tap selects a group already in it", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const { server } = fixture();
    const feed = await ready();
    const shown = () => Array.from(feed.querySelectorAll(".activityTableFrame"), (group) => group.getAttribute("data-request"));
    const before = shown();
    const fetches = feedCalls(server).length;

    await user.click(within(feed).getByRole("button", { name: /^Request #38, Primary agent,/u }));
    await screen.findByRole("heading", { name: "Request #38" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });

    // Re-anchoring the served window on every selection would slide all five lines under the finger.
    expect(shown()).toEqual(before);
    expect(feedCalls(server)).toHaveLength(fetches);
  });

  it("replaces the desktop counts caveat with the phone tap caveat and its popover", async () => {
    setPhone(true);
    const user = userEvent.setup();
    fixture();
    const feed = await ready();

    expect(within(feed).queryByText("Local counts only.")).toBeNull();
    expect(feed.querySelector(".activityFeedCaveat")).toHaveTextContent("Requests with their tool calls · tap a call for details · how to read this");
    await user.click(within(feed).getByRole("button", { name: "How to read this feed" }));
    expect(screen.getByRole("dialog", { name: "How to read this feed" })).toHaveTextContent("Request line: agent, role, uncached input, time. Tap it for the four request-local counts.");
  });

  it("keeps Previous, Next and Jump to latest as phone touch targets", async () => {
    setPhone(true);
    fixture();
    const feed = await ready();
    const nav = within(feed).getByRole("navigation", { name: "Request range" });
    for (const name of ["Previous", "Next", "Jump to latest"]) expect(within(nav).getByRole("button", { name })).toHaveClass("commandSecondaryAction");
  });

  it("keeps Actions by kind before the request groups on desktop", async () => {
    fixture();
    const feed = await ready();
    const layout = feed.querySelector(".activityLayout")!;
    expect(layout).not.toHaveClass("isPhone");
    const [first, second] = Array.from(layout.children);
    expect(first).toHaveClass("activityBreakdown");
    expect(second).toHaveClass("activityFeed");
  });

  it("shows a group's token counts matching the fixture's snapshot values", async () => {
    fixture();
    const feed = await ready();
    expect(within(feed).getByRole("button", { name: "Request #40, uncached input 1,960,000, cache write 2,000, output 4,000, 2 calls" })).toBeInTheDocument();
  });

  it("opens an agent from a group's agent-name link without toggling its selection", async () => {
    const user = userEvent.setup();
    const { onOpenAgent } = fixture();
    const feed = await ready();
    const group = within(feed).getByRole("article", { name: "Request #38" });
    await user.click(within(group).getByRole("button", { name: "Primary agent" }));
    expect(onOpenAgent).toHaveBeenCalledWith("primary");
    expect(within(group).getByRole("button", { name: /^Request #38,/u })).toHaveAttribute("aria-pressed", "false");
  });

  it("renders the rail and request-row caveats as short text that expand via DottedInfoPopover", async () => {
    const user = userEvent.setup();
    fixture();
    const feed = await ready();
    expect(within(feed).getByText("Counts, not effort or cost.")).toBeInTheDocument();
    expect(within(feed).getByText("Local counts only.")).toBeInTheDocument();
    await user.click(within(feed).getByRole("button", { name: "About these counts" }));
    expect(screen.getByRole("dialog", { name: "About these counts" })).toHaveTextContent("Counts describe recorded tool calls, not effort or quality.");
    await user.keyboard("{Escape}");
    await user.click(within(feed).getByRole("button", { name: "About request rows" }));
    expect(screen.getByRole("dialog", { name: "About request rows" })).toHaveTextContent("Targets show Bash descriptions and file names only.");
  });

  it("shows an explicit unavailable state instead of the request feed while the session view is paused", async () => {
    const { rerender, onRouteChange, onOpenAgent } = fixture();
    await ready();
    rerender(<LiveClockProvider running={false}><ActivitiesTab sessionId={SESSION} historical={false} paused route={{ agent: null, request: null }} onRouteChange={onRouteChange} onOpenAgent={onOpenAgent} /></LiveClockProvider>);
    const region = await screen.findByRole("region", { name: "Activity feed" });
    await waitFor(() => expect(region).toHaveTextContent("Activity history is unavailable while this session view is paused."));
    expect(within(region).queryByRole("article")).not.toBeInTheDocument();
  });

  function expectNoInventedZeros(region: HTMLElement) {
    expect(region).not.toHaveTextContent("0 requests in this scope");
    expect(region).not.toHaveTextContent("Shell tasks");
    expect(region).not.toHaveTextContent("Failed shell runs");
    expect(within(region).queryByRole("navigation", { name: "Request range" })).not.toBeInTheDocument();
  }

  it("shows a loading state, not invented zero counts, while the chart's first page is still loading", async () => {
    fixture({ requestsStatus: "loading" });
    const region = await screen.findByRole("region", { name: "Activity feed" });
    await waitFor(() => expect(within(region).getByRole("status")).toHaveTextContent("Loading activity…"));
    expectNoInventedZeros(region);
  });

  it("shows a chart-unavailable state, not invented zero counts, when the chart's first page fails", async () => {
    fixture({ requestsStatus: 503 });
    const region = await screen.findByRole("region", { name: "Activity feed" });
    await waitFor(() => expect(within(region).getByRole("status")).toHaveTextContent("Activity history is unavailable; retrying…"));
    expectNoInventedZeros(region);
  });

  it("shows the unavailable state with Retry, not invented zero counts, when the first feed query fails", async () => {
    fixture({ activity: 503 });
    await screen.findByRole("heading", { name: "Request #40" });
    const region = await screen.findByRole("region", { name: "Activity feed" });
    await waitFor(() => expect(within(region).getByText(/Activity feed is unavailable\./u)).toBeInTheDocument());
    expectNoInventedZeros(region);
    expect(within(region).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("omits a group's token counts when its request record's fields are not truly present", async () => {
    fixture({ requestGroupOverrides: { 40: { cacheWriteTokens: -1 } } });
    const feed = await ready();
    const group = within(feed).getByRole("article", { name: "Request #40" });
    expect(within(group).getByRole("button", { name: "Request #40 2 calls" })).toBeInTheDocument();
    expect(group).not.toHaveTextContent("1,960,000");
    expect(group).not.toHaveTextContent("4,000");
    expect(group.querySelector(".requestsActionsSwatch")).not.toBeInTheDocument();
  });

  it("hides the cache-write swatch and its aria-label text when cache-write usage is unavailable", async () => {
    fixture({ cacheWriteAvailable: false });
    const feed = await ready();
    expect(within(feed).getByRole("button", { name: "Request #40, uncached input 1,960,000, output 4,000, 2 calls" })).toBeInTheDocument();
    expect(feed.querySelector(".requestsActionsSwatch.write")).not.toBeInTheDocument();
  });
});
