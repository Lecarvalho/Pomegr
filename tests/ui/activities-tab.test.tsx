import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/live-events", () => ({
  subscribeLiveEvents: (listener: (event: unknown) => void) => {
    listener({ type: "connection", state: "connected", epoch: 0 });
    return () => {};
  },
}));

import { ActivitiesTab } from "../../app/components/dashboard/ActivitiesTab";
import { ActivityFeedPanel } from "../../app/components/dashboard/activity-feed/ActivityFeedPanel";
import type { ActivityFeedView } from "../../app/components/dashboard/activity-feed/useActivityFeed";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import { createEmptyMonitorState } from "../../shared/monitor-state.mjs";
import type { Agent, ExecutionTask, MonitorState } from "../../shared/monitor-contract";
import { agent, repositorySession, task } from "./dashboard-test-fixtures";
import { compactNumber, shortTime } from "../../app/dashboard-utils";
import { historyCall, historyRequest, historyServer, type HistoryServerState } from "./activities-test-server";
import type { HistoryActivity } from "../../shared/session-history-contract";
import type { RequestSelectionRoute, SessionRequestSelection } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { setPhone } from "./requests-actions-test-fixtures";

const SESSION = "claude:activities";
const child: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder", role: "builder", executionTasks: [] };

function monitorState(cacheWriteAvailable = true, primaryTasks?: ExecutionTask[]): MonitorState {
  const state = createEmptyMonitorState({ connected: true });
  return {
    ...state,
    agents: [primaryTasks ? { ...agent, executionTasks: primaryTasks } : agent, child],
    capabilities: { ...state.capabilities, cacheWriteUsage: cacheWriteAvailable },
    session: { ...repositorySession({ available: false, branch: "", files: [], historical: false, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }), id: SESSION, title: "Session", project: "Pomegr" },
  };
}

function fixture({ extra, count = 40, overview = true, route = { agent: null, request: null }, strict = false, historical = false, requestsStatus, activity, cacheWriteAvailable = true, requestGroupOverrides, callOverrides, primaryTasks }: {
  extra?: Record<string, unknown>; count?: number; overview?: boolean; route?: RequestSelectionRoute; strict?: boolean; historical?: boolean;
  requestsStatus?: HistoryServerState["requestsStatus"]; activity?: HistoryServerState["activity"]; cacheWriteAvailable?: boolean;
  requestGroupOverrides?: HistoryServerState["requestGroupOverrides"];
  /** Per-call-id field overrides, for a recorded failure or a call with no target or result. */
  callOverrides?: Record<string, Partial<HistoryActivity>>;
  /** Shell tasks retained for the primary agent, which the rail lists for the matching scope. */
  primaryTasks?: ExecutionTask[];
} = {}) {
  const requests = Array.from({ length: count }, (_, index) => historyRequest(index + 1, (index + 1) % 2 ? "child" : "primary"));
  const calls = requests.flatMap((request) => request.agentId === "child"
    ? [historyCall(`call-${request.number}-shell`, request, "shell", 1, { actor: "Builder" })]
    : [historyCall(`call-${request.number}-read`, request, "read", 1), historyCall(`call-${request.number}-edit`, request, "write", 2)])
    .map((call) => ({ ...call, ...(callOverrides?.[call.id] || {}) }));
  const serverState: HistoryServerState = { requests, calls, revision: "1", extra, overview, requestsStatus, activity, requestGroupOverrides };
  const server = historyServer(serverState);
  const state = monitorState(cacheWriteAvailable, primaryTasks);
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
    expect(kinds.map((button) => button.textContent)).toEqual([expect.stringMatching(/^Shell.*20/u)]);
    expect(feed).toHaveTextContent("Failed shell runs");
  });

  it("names the scope's tool call total, the selected request and the request order in the feed header", async () => {
    const user = userEvent.setup();
    const { container } = fixture();
    const feed = await ready();
    const meta = () => container.querySelector(".activityPanelHeader p")!.textContent;
    expect(meta()).toBe("60 tool calls in this scope · request #40 selected · oldest first");

    await user.click(within(feed).getByRole("button", { name: /Request #38/u }));
    await waitFor(() => expect(meta()).toContain("request #38 selected"));
    // The total describes the scope, so an agent selection narrows it with everything else.
    await user.selectOptions(screen.getByLabelText("Agent scope"), "child");
    await waitFor(() => expect(meta()).toMatch(/^20 tool calls in this scope/u));
  });

  it("lists the latest retained shell tasks beside the scope count and says when a scope has none", async () => {
    const user = userEvent.setup();
    const tasks: ExecutionTask[] = [
      { ...task, id: "task-build", label: "Build the desktop bundle", status: "running", startedAt: "2026-08-08T12:00:30.000Z", finishedAt: null, exitCode: null },
      { ...task, id: "task-verify", label: "Run verification", startedAt: "2026-08-08T12:00:20.000Z", finishedAt: "2026-08-08T12:00:26.000Z", exitCode: 0 },
      { ...task, id: "task-arch", label: "Check architecture boundaries", status: "failed", startedAt: "2026-08-08T12:00:10.000Z", finishedAt: "2026-08-08T12:00:13.000Z", exitCode: 1, failureCause: "non_zero_exit" },
      { ...task, id: "task-lint", label: "Lint the styles", startedAt: "2026-08-08T12:00:05.000Z" },
      { ...task, id: "task-old", label: "Install dependencies", startedAt: "2026-08-08T11:59:00.000Z" },
    ];
    const { container } = fixture({ primaryTasks: tasks });
    const feed = await ready();
    const section = container.querySelector(".activityShellTasks")!;
    // The header counts retained tasks; the recorded shell calls stay on the Shell kind row.
    expect(within(section as HTMLElement).getByRole("heading", { name: "Shell tasks" }).parentElement).toHaveTextContent("5 tasks · 1 running");
    const rows = within(section as HTMLElement).getByRole("group", { name: "Latest shell tasks" }).children;
    expect(Array.from(rows, (row) => row.textContent)).toEqual([
      expect.stringContaining("Build the desktop bundle"),
      expect.stringContaining("Run verification"),
      expect.stringContaining("Check architecture boundaries"),
      expect.stringContaining("Lint the styles"),
    ]);
    expect(section).toHaveTextContent("Latest 4 shown");
    expect(rows[0]).toHaveTextContent("running");
    expect(rows[1]).toHaveTextContent("exit 0");
    expect(rows[2]).toHaveTextContent("exit 1");
    expect(within(section as HTMLElement).queryByText("No shell task details in this scope.")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Agent scope"), "child");
    await waitFor(() => expect(container.querySelector(".activityShellTasks")).toHaveTextContent("No shell task details in this scope."));
    expect(within(container.querySelector(".activityShellTasks") as HTMLElement).queryByRole("group", { name: "Latest shell tasks" })).toBeNull();
    expect(feed).toHaveTextContent("Failed shell runs");
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
    const pagination = feed.querySelector(".activityPagination")!;
    expect(pagination).toHaveTextContent("#36–#40 · window #1–#40");
    expect(Array.from(pagination.children, (child) => child.tagName)).toEqual(["SPAN", "NAV"]);
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
    // The phone line names the agent as text; the desktop inspector link is not rendered at all.
    expect(within(group).queryByRole("button", { name: "Open Primary agent in the Agents inspector" })).toBeNull();

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

  it("stacks one kind row per kind with a share bar scaled against the busiest kind", async () => {
    fixture();
    const feed = await ready();
    const rail = feed.querySelector(".activityBreakdown")!;
    const group = within(rail as HTMLElement).getByRole("group", { name: "Filter calls by kind" });
    expect(group).toHaveClass("activityKindRows");
    const rows = Array.from(group.children) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(1);
    const counts = rows.map((row) => Number(row.querySelector("strong")!.textContent!.replace(/,/gu, "")));
    const busiest = Math.max(...counts);
    expect(counts).toEqual([...counts].sort((left, right) => right - left));
    rows.forEach((row, index) => {
      expect(row).toHaveClass("activityKindRow");
      expect(row.querySelectorAll("span")).toHaveLength(4);
      expect((row.querySelector(".activityKindBar > i") as HTMLElement).style.width)
        .toBe(`${Math.max(2, Math.round(counts[index] / busiest * 100))}%`);
    });
    const fills = rows.map((row) => Number.parseInt((row.querySelector(".activityKindBar > i") as HTMLElement).style.width, 10));
    expect(Math.max(...fills)).toBe(100);
    expect(fills.filter((fill) => fill === 100)).toHaveLength(counts.filter((count) => count === busiest).length);
    const header = rail!.querySelector("header")!;
    expect([...header.querySelectorAll("span")].map((label) => label.textContent)).toEqual(["count", "share", "median"]);
    expect(rail!.querySelector(".activityKindCaveat")).toHaveTextContent("Counts, not effort or cost.");
  });

  it("shows a group's token counts matching the fixture's snapshot values", async () => {
    fixture();
    const feed = await ready();
    expect(within(feed).getByRole("button", { name: "Request #40, Primary agent, orchestrator, uncached input 1,960,000, cache write 2,000, output 4,000, 2 calls" })).toBeInTheDocument();
  });

  it("opens an agent from a group's agent-name link without toggling its selection", async () => {
    const user = userEvent.setup();
    const { onOpenAgent } = fixture();
    const feed = await ready();
    const group = within(feed).getByRole("article", { name: "Request #38" });
    await user.click(within(group).getByRole("button", { name: "Open Primary agent in the Agents inspector" }));
    expect(onOpenAgent).toHaveBeenCalledWith("primary");
    expect(within(group).getByRole("button", { name: /^Request #38,/u })).toHaveAttribute("aria-pressed", "false");
  });

  it("names the agent and its role on the desktop request line itself, with no separate agent row", async () => {
    fixture();
    const feed = await ready();

    const group = within(feed).getByRole("article", { name: "Request #38" });
    const row = group.querySelector(".activityRequestRow");
    expect(row).toHaveTextContent("Request #38Primary agentorchestrator");
    // The link lives on the request line, not in a row of its own beneath it.
    expect(row).toContainElement(within(group).getByRole("button", { name: "Open Primary agent in the Agents inspector" }));
    expect(group.querySelector(".activityRequestRow + .commandTextLink")).toBeNull();

    // A subagent's request names the subagent, never the session's primary agent.
    const childGroup = within(feed).getByRole("article", { name: "Request #37" });
    expect(childGroup.querySelector(".activityRequestRow")).toHaveTextContent("Request #37Builderbuilder");
    expect(within(childGroup).getByRole("button", { name: "Open Builder in the Agents inspector" })).toBeInTheDocument();
  });

  it.each([
    { cacheWriteAvailable: true, expectedTokens: "1,960,000 2,000 4,000" },
    { cacheWriteAvailable: false, expectedTokens: "1,960,000 4,000" },
  ])("keeps the desktop request row's four cells aligned when cache-write availability is $cacheWriteAvailable", async ({ cacheWriteAvailable, expectedTokens }) => {
    fixture({ cacheWriteAvailable });
    const feed = await ready();
    const row = within(feed).getByRole("article", { name: "Request #40" }).querySelector(".activityRequestRow.activityRow")!;

    expect(Array.from(row.children)).toHaveLength(4);
    expect(row.children[0]).toHaveTextContent("Request #40");
    expect(row.children[1]).toHaveTextContent("Primary agentorchestrator");
    expect(row.children[2]).toHaveTextContent(expectedTokens);
    expect(row.children[3]).toHaveTextContent("2 calls");
    expect(Boolean(row.querySelector(".requestsActionsSwatch.write"))).toBe(cacheWriteAvailable);
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
    expect(region).not.toHaveTextContent("0 tool calls in this scope");
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

  it("drops the previous scope's groups instead of showing them without a status when history fails", async () => {
    const user = userEvent.setup();
    const { serverState } = fixture();
    const feed = await ready();
    expect(within(feed).getAllByRole("article")).toHaveLength(5);
    // The chart page fails for the new scope, so the feed is disabled while the chart previews.
    // The groups it last read belong to the old scope and must not stand in for the new one.
    serverState.requestsStatus = 503;
    await user.selectOptions(screen.getByLabelText("Agent scope"), "child");
    const region = await screen.findByRole("region", { name: "Activity feed" });
    await waitFor(() => expect(within(region).getByRole("status")).toHaveTextContent("Activity history is unavailable; retrying…"));
    expect(within(region).queryByRole("article")).not.toBeInTheDocument();
    expectNoInventedZeros(region);
  });

  it("keeps a group's request-local counts when its request sits outside the loaded chart page", async () => {
    const { container } = fixture({ count: 130 });
    const feed = await ready(130);
    const minimap = screen.getByRole("slider", { name: "Request window" });
    fireEvent.keyDown(minimap, { key: "Home" });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuetext", "Request positions 1 to 60 of 130"));
    await waitFor(() => expect(feed).not.toHaveAttribute("aria-busy"));
    const number = (element: Element) => Number(/#(\d+)/u.exec(element.getAttribute("aria-label") || "")?.[1]);
    const charted = new Set(Array.from(container.querySelectorAll(".requestsActionsBar"), number));
    const outside = within(feed).getAllByRole("article").filter((group) => !charted.has(number(group)));
    expect(outside.length).toBeGreaterThan(0);
    for (const group of outside) {
      const line = within(group).getByRole("button", { name: new RegExp(`^Request #${number(group)},`, "u") });
      expect(line.getAttribute("aria-label")).toMatch(/^Request #\d+, (?:Primary agent, orchestrator|Builder, builder), uncached input [\d,]+, cache write [\d,]+, output [\d,]+, \d+ calls?$/u);
    }
  });

  it("omits a group's token counts when its request record's fields are not truly present", async () => {
    fixture({ requestGroupOverrides: { 40: { cacheWriteTokens: -1 } } });
    const feed = await ready();
    const group = within(feed).getByRole("article", { name: "Request #40" });
    expect(within(group).getByRole("button", { name: "Request #40, Primary agent, orchestrator, 2 calls" })).toBeInTheDocument();
    expect(group).not.toHaveTextContent("1,960,000");
    expect(group).not.toHaveTextContent("4,000");
    expect(group.querySelector(".requestsActionsSwatch")).not.toBeInTheDocument();
  });

  it("hides the cache-write swatch and its aria-label text when cache-write usage is unavailable", async () => {
    fixture({ cacheWriteAvailable: false });
    const feed = await ready();
    expect(within(feed).getByRole("button", { name: "Request #40, Primary agent, orchestrator, uncached input 1,960,000, output 4,000, 2 calls" })).toBeInTheDocument();
    expect(feed.querySelector(".requestsActionsSwatch.write")).not.toBeInTheDocument();
  });
  it("tints only the duration text of a failed phone call line", async () => {
    setPhone(true);
    const { container } = fixture({ callOverrides: { "call-40-edit": { status: "failed" } } });
    const feed = await ready();
    const group = within(feed).getByRole("article", { name: "Request #40" });

    const line = within(group).getByRole("button", { name: "Editing, file.tsx, 1.5s" });
    expect(line).toHaveClass("activityCallLine");
    expect(line.querySelector(".workKindIcon")).toHaveAttribute("data-work-kind", "write");
    expect(line.querySelector(".activityCallTarget")).toHaveTextContent("file.tsx");
    expect(line.querySelector(".activityCallDuration")).toHaveClass("attention");
    // The row itself keeps the neutral feed tone, and the desktop grid never reaches a call line.
    expect(line.closest("li")).not.toHaveClass("failed");
    expect(container.querySelector(".activityCallLine.activityRow")).toBeNull();
    expect(within(group).getByRole("button", { name: "Reading, file.tsx, 1.5s" }).querySelector(".activityCallDuration")).not.toHaveClass("attention");
  });

  it("names the tool on a phone call line the provider recorded without a target", async () => {
    setPhone(true);
    fixture({ callOverrides: { "call-40-read": { detail: "", durationMs: null } } });
    const feed = await ready();
    const group = within(feed).getByRole("article", { name: "Request #40" });

    // A detail-less call would otherwise leave the line blank; the tool name is what desktop prints.
    const line = within(group).getByRole("button", { name: "Reading, Read, —" });
    expect(line.querySelector(".activityCallTarget")).toHaveTextContent("Read");
    expect(line.querySelector(".activityCallDuration")).toHaveClass("unavailable");
  });

  it("expands one phone call in place, selecting its request and chart bar", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const { container } = fixture();
    const feed = await ready();
    const group = within(feed).getByRole("article", { name: "Request #38" });
    const read = within(group).getByRole("button", { name: "Reading, file.tsx, 1.5s" });
    const edit = within(group).getByRole("button", { name: "Editing, file.tsx, 1.5s" });

    await user.click(read);
    await waitFor(() => expect(read).toHaveAttribute("aria-expanded", "true"));
    expect(document.getElementById(read.getAttribute("aria-controls") || "")).toHaveClass("activityCallDetail");
    // Tapping a call still moves the shared selection exactly as its request line does.
    expect(within(group).getByRole("button", { name: /^Request #38,/u })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(container.querySelector(".requestsActionsBar.isSelected")?.getAttribute("aria-label")).toMatch(/^Request #38,/u));

    await user.click(edit);
    await waitFor(() => expect(edit).toHaveAttribute("aria-expanded", "true"));
    expect(read).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll(".activityCallDetail")).toHaveLength(1);

    await user.click(edit);
    expect(edit).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".activityCallDetail")).toBeNull();
  });

  it("collapses the expanded phone call with Escape and adds no route parameter", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const { onRouteChange } = fixture();
    const feed = await ready();
    const line = within(within(feed).getByRole("article", { name: "Request #38" })).getByRole("button", { name: "Reading, file.tsx, 1.5s" });

    await user.click(line);
    await waitFor(() => expect(line).toHaveAttribute("aria-expanded", "true"));
    await user.keyboard("{Escape}");

    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".activityCallDetail")).toBeNull();
    // The disclosure is view state: the route keeps the agent and request keys it always had.
    for (const [route] of onRouteChange.mock.calls) expect(Object.keys(route).sort()).toEqual(["agent", "request"]);
  });

  it("shows only the allowed rows and recorded chips in an expanded phone call", async () => {
    setPhone(true);
    const user = userEvent.setup();
    const { serverState } = fixture();
    const feed = await ready();
    const group = within(feed).getByRole("article", { name: "Request #39" });

    await user.click(within(group).getByRole("button", { name: "Shell, Run the focused tests, 1.5s" }));
    const detail = document.getElementById("call-detail-call-39-shell");
    expect(detail).not.toBeNull();
    expect(Array.from(detail!.querySelectorAll(".activityCallRow > span:first-child"), (cell) => cell.textContent)).toEqual(["Kind", "Wall duration", "Called", "Result", "Agent"]);
    expect(Array.from(detail!.querySelectorAll(".commandChip"), (chip) => chip.textContent)).toEqual(["Shell", "Completed"]);
    expect(detail).toHaveTextContent("Shell · Bash");
    expect(detail).toHaveTextContent("Builder");
    // Result is the recorded call time plus its own call-to-result duration, never a provider field.
    const values = Array.from(detail!.querySelectorAll(".activityCallRow > span:last-child"), (cell) => cell.textContent);
    const call = serverState.calls.find((item) => item.id === "call-39-shell")!;
    expect(values.slice(2, 4)).toEqual([shortTime(call.timestamp), shortTime(new Date(Date.parse(call.timestamp) + 1_500).toISOString())]);
    expect(within(detail!).queryByRole("link")).toBeNull();
    expect(within(detail!).queryByRole("button")).toBeNull();
  });

  it("keeps desktop call rows as plain rows with no disclosure", async () => {
    const { container, serverState } = fixture();
    const feed = await ready();
    const rows = Array.from(within(feed).getByRole("article", { name: "Request #40" }).querySelectorAll(".activityTable .activityRow"));
    const call = serverState.calls.find((item) => item.id === "call-40-read")!;

    expect(container.querySelector(".activityCallLine")).toBeNull();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.querySelector("[aria-expanded]")).toBeNull();
    const row = rows[0];
    expect(row).toHaveClass("activityDesktopCallRow", "activityRow");
    expect(row.querySelector("time")).toHaveAttribute("dateTime", call.timestamp);
    expect(row.querySelector("time")).toHaveTextContent(shortTime(call.timestamp));
    expect(Array.from(row.children, (cell) => cell.tagName)).toEqual(["TIME", "SPAN", "SPAN", "SPAN"]);
    expect(row.children[1]).toHaveTextContent("Read");
    expect(row.children[2]).toHaveTextContent("file.tsx");
    expect(row.children[3]).toHaveTextContent("1.5s");
  });
});

/** The feed's no-body branch reads only these fields, so a stub drives the status text directly. */
function statusPanel(status: "loading" | "ready" | "unavailable") {
  const selection = { phone: false, history: { preview: true, status } } as unknown as SessionRequestSelection;
  const feed: ActivityFeedView = {
    status: "idle", correlated: false, groups: [], byKind: [], shellTasks: { total: 0, failed: 0 },
    requestTotal: 0, callTotal: 0, revision: "", loadMore: () => {}, loadingMore: null, retry: () => {},
  };
  return <ActivityFeedPanel selection={selection} feed={feed} agents={[]} busy cacheWriteAvailable onOpenAgent={() => {}} />;
}

describe("Activity feed status", () => {
  it("keeps one stable status while history retries instead of re-announcing it every 5 s", () => {
    const { rerender } = render(statusPanel("loading"));
    expect(screen.getByRole("status")).toHaveTextContent("Loading activity…");
    rerender(statusPanel("unavailable"));
    expect(screen.getByRole("status")).toHaveTextContent("Activity history is unavailable; retrying…");
    // Every 5 s retry passes through "loading" before failing again. The announced text must not
    // follow that swing, or a screen reader reads the same state out every five seconds.
    rerender(statusPanel("loading"));
    expect(screen.getByRole("status")).toHaveTextContent("Activity history is unavailable; retrying…");
    rerender(statusPanel("unavailable"));
    expect(screen.getByRole("status")).toHaveTextContent("Activity history is unavailable; retrying…");
    // A page that finally arrives clears it, so the next first load announces loading again.
    rerender(statusPanel("ready"));
    rerender(statusPanel("loading"));
    expect(screen.getByRole("status")).toHaveTextContent("Loading activity…");
  });
});
