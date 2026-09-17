import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>() }));
vi.mock("../../app/live-events", () => ({
  subscribeLiveEvents: (listener: (event: unknown) => void) => {
    live.listeners.add(listener);
    listener({ type: "connection", state: "connected", epoch: 0 });
    return () => live.listeners.delete(listener);
  },
}));

import { useSessionRequestSelection, type RequestSelectionRoute } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import type { Agent } from "../../shared/monitor-contract";
import { agent } from "./dashboard-test-fixtures";
import { historyRequest, historyServer, type HistoryServerState } from "./activities-test-server";
import { requestFeed, setPhone } from "./requests-actions-test-fixtures";

const SESSION = "claude:selection";
const child: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder", role: "builder" };
const EMPTY: never[] = [];
const FEED = requestFeed([]);

function emitHistory(revision: number) {
  for (const listener of live.listeners) listener({ type: "revision", domain: "history", sessionId: SESSION, revision, epoch: 0 });
}

function emitConnected() {
  for (const listener of live.listeners) listener({ type: "connection", state: "connected", epoch: 1 });
}

function mount(server: ReturnType<typeof historyServer>, options: { route?: RequestSelectionRoute; historical?: boolean; strict?: boolean } = {}) {
  vi.stubGlobal("fetch", vi.fn(server.fetcher));
  // Like the router, a written route becomes the route of the next render.
  let current: RequestSelectionRoute = options.route ?? { agent: null, request: null };
  const onRouteChange = vi.fn((next: RequestSelectionRoute) => { current = next; });
  const view = renderHook(({ route }: { route?: RequestSelectionRoute }) => useSessionRequestSelection({
    agents: [agent, child], requestSnapshots: FEED, contextBoundaries: EMPTY, historical: options.historical ?? false,
    historyEnabled: true, sessionId: SESSION, route: route ?? current, onRouteChange,
  }), { initialProps: {} as { route?: RequestSelectionRoute }, reactStrictMode: options.strict ?? false });
  return { ...view, onRouteChange };
}

function requests(count: number, agentOf: (number: number) => string = () => "primary") {
  return Array.from({ length: count }, (_, index) => historyRequest(index + 1, agentOf(index + 1)));
}

beforeEach(() => { live.listeners.clear(); setPhone(false); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("shared request selection: live growth", () => {
  it("anchors a tracked selection instead of pushing it out while totals grow, without URL churn", async () => {
    const state = { requests: requests(100), calls: [], revision: "1" };
    const server = historyServer(state);
    const { result, onRouteChange } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(100));
    expect(result.current.mode).toBe("follow");

    act(() => result.current.select(result.current.rows.find((row) => row.number === 46)!));
    expect(result.current.mode).toBe("track");
    await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ agent: null, request: "46" }));
    const writes = onRouteChange.mock.calls.length;

    // Growth to 105 still keeps #46 inside the latest window.
    state.requests = requests(105); state.revision = "2";
    act(() => emitHistory(2));
    await waitFor(() => expect(result.current.history.total).toBe(105));
    expect(result.current.selectedNumber).toBe(46);
    expect(result.current.history.offset).toBe(45);
    expect(result.current.mode).toBe("track");

    // Growth to 120 would push #46 out: the viewport anchors with it at the left edge.
    state.requests = requests(120); state.revision = "3";
    act(() => emitHistory(3));
    await waitFor(() => expect(result.current.history.total).toBe(120));
    expect(result.current.history.offset).toBe(45);
    expect(result.current.selectedNumber).toBe(46);
    expect(result.current.selectedIndex).toBe(45);
    expect(result.current.mode).toBe("anchored");
    expect(result.current.rows.some((row) => row.id === result.current.selected?.id)).toBe(true);

    // Anchored windows reread their own offset; the selection never moves to a false position.
    state.requests = requests(300); state.revision = "4";
    act(() => emitHistory(4));
    await waitFor(() => expect(result.current.history.total).toBe(300));
    expect(server.of("requests").at(-1)?.get("offset")).toBe("45");
    expect(result.current.selectedNumber).toBe(46);
    expect(onRouteChange).toHaveBeenCalledTimes(writes);
  });

  it("follows the latest request on growth", async () => {
    const state = { requests: requests(30), calls: [], revision: "1" };
    const server = historyServer(state);
    const { result, onRouteChange } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(30));
    state.requests = requests(31); state.revision = "2";
    act(() => emitHistory(2));
    await waitFor(() => expect(result.current.selectedNumber).toBe(31));
    expect(result.current.mode).toBe("follow");
    expect(onRouteChange).not.toHaveBeenCalled();
  });

  it("relocates a selection whose position changed and jumps to latest when it left the scope", async () => {
    const state = { requests: requests(100), calls: [], revision: "1", overview: false };
    const server = historyServer(state);
    const { result, onRouteChange } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(100));
    act(() => result.current.history.moveWindow(1));
    await waitFor(() => expect(result.current.history.offset).toBe(0));
    expect(result.current.selectedNumber).toBe(60);
    await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ agent: null, request: "60" }));
    // A late request shifts positions: the anchored bar is verified by position and relocated by identity.
    state.requests = [historyRequest(500), ...requests(100)]; state.revision = "2";
    act(() => emitHistory(2));
    await waitFor(() => expect(result.current.history.revision).toBe("2"));
    expect(server.of("requests").at(-1)?.get("requestId")).toBe("request-60");
    expect(result.current.selectedNumber).toBe(60);
    expect(result.current.rows.some((row) => row.number === 60)).toBe(true);
    // The selected request is removed entirely: follow the latest request and clear the URL request.
    state.requests = [historyRequest(500), ...requests(100)].filter((item) => item.number !== 60); state.revision = "3";
    act(() => emitHistory(3));
    await waitFor(() => expect(result.current.selectedNumber).toBe(100));
    expect(result.current.mode).toBe("follow");
    expect(result.current.history.offset).toBe(40);
    await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ agent: null, request: null }));
  });
});

describe("shared request selection: navigation", () => {
  it("transfers selection to the nearest visible bar when dragging in both directions", async () => {
    const server = historyServer({ requests: requests(180), calls: [], revision: "1" });
    const { result, onRouteChange } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(180));
    act(() => result.current.history.moveWindow(1));
    await waitFor(() => expect(result.current.history.offset).toBe(0));
    expect(result.current.selectedNumber).toBe(60);
    expect(result.current.mode).toBe("anchored");
    await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ agent: null, request: "60" }));
    act(() => result.current.history.moveWindow(62));
    await waitFor(() => expect(result.current.history.offset).toBe(61));
    expect(result.current.selectedNumber).toBe(62);
  });

  it("pages with keyboard steps and ranges, and jumps to latest", async () => {
    const server = historyServer({ requests: requests(130), calls: [], revision: "1" });
    const { result } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(130));
    act(() => result.current.select(result.current.rows[0]));
    expect(result.current.selectedNumber).toBe(71);
    act(() => result.current.step(-1));
    await waitFor(() => expect(result.current.selectedNumber).toBe(70));
    expect(result.current.history.offset).toBe(10);
    act(() => result.current.previousRange());
    expect(result.current.selectedNumber).toBe(65);
    act(() => result.current.nextRange());
    expect(result.current.selectedNumber).toBe(70);
    act(() => result.current.nextRange());
    await waitFor(() => expect(result.current.selectedNumber).toBe(75));
    expect(result.current.history.offset).toBe(70);
    act(() => result.current.jumpToLatest());
    expect(result.current.selectedNumber).toBe(130);
    expect(result.current.mode).toBe("follow");
  });

  it("changes the kind filter without changing selection or viewport", async () => {
    const server = historyServer({ requests: requests(100), calls: [], revision: "1" });
    const { result } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(100));
    act(() => result.current.select(result.current.rows[10]));
    const before = { number: result.current.selectedNumber, offset: result.current.history.offset, mode: result.current.mode };
    const fetches = server.calls.length;
    act(() => result.current.setWorkKind("read"));
    expect(result.current.workKind).toBe("read");
    expect({ number: result.current.selectedNumber, offset: result.current.history.offset, mode: result.current.mode }).toEqual(before);
    expect(server.calls.length).toBe(fetches);
  });

  it("cancels rapid navigation, ignores stale responses and retains the previous view while pending", async () => {
    const server = historyServer({ requests: requests(300), calls: [], revision: "1", overview: false });
    const { result } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(300));
    server.holdWhen((params) => params.get("offset") === "0");
    act(() => result.current.history.moveWindow(1));
    expect(result.current.pending).toBe(true);
    expect(result.current.selectedNumber).toBe(300);
    expect(result.current.history.offset).toBe(240);
    server.holdWhen(null);
    act(() => result.current.history.moveWindow(101));
    await waitFor(() => expect(result.current.history.offset).toBe(100));
    expect(result.current.selectedNumber).toBe(160);
    await act(async () => { server.deferred[0]?.resolve(); });
    expect(result.current.history.offset).toBe(100);
    expect(result.current.selectedNumber).toBe(160);
    expect(result.current.pending).toBe(false);
  });

  it("locates a selected request in a new agent scope, or follows latest when it is not in that scope", async () => {
    const server = historyServer({ requests: requests(100, (number) => number % 2 ? "child" : "primary"), calls: [], revision: "1" });
    const { result, onRouteChange } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(100));
    act(() => result.current.select(result.current.rows.find((row) => row.number === 81)!));
    act(() => result.current.setScope("child"));
    await waitFor(() => expect(result.current.scope).toBe("child"));
    await waitFor(() => expect(result.current.selectedNumber).toBe(81));
    expect(result.current.historyScope).toBe("child");
    await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ agent: "child", request: "81" }));
    act(() => result.current.setScope("primary"));
    await waitFor(() => expect(result.current.selectedNumber).toBe(100));
    expect(result.current.historyScope).toBe("primary");
  });
});

describe("shared request selection: URL scope", () => {
  it("resolves a request number through one grouped lookup and keeps the URL number", async () => {
    const server = historyServer({ requests: requests(100, (number) => number > 90 ? "child" : "primary"), calls: [], revision: "1" });
    const { result, onRouteChange } = mount(server, { route: { agent: "child", request: "93" } });
    await waitFor(() => expect(result.current.selectedNumber).toBe(93));
    expect(result.current.scope).toBe("child");
    const lookup = server.of("activity");
    expect(lookup).toHaveLength(1);
    expect(Object.fromEntries(lookup[0])).toMatchObject({ kind: "activity", limit: "1", offset: "latest", selected: "93", scope: "child" });
    expect(result.current.mode).not.toBe("follow");
    expect(onRouteChange).not.toHaveBeenCalled();
  });

  it("locates an opaque request id and rewrites the URL to its number without re-resolving", async () => {
    const server = historyServer({ requests: requests(200), calls: [], revision: "1" });
    const { result, onRouteChange, rerender } = mount(server, { route: { agent: null, request: "request-20" } });
    await waitFor(() => expect(result.current.selectedNumber).toBe(20));
    await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ agent: null, request: "20" }));
    const fetches = server.calls.length;
    rerender({ route: { agent: null, request: "20" } });
    await act(async () => {});
    expect(server.calls.length).toBe(fetches);
    expect(result.current.selectedNumber).toBe(20);
  });

  it("falls back to all agents for an unknown agent and to the latest request for an unknown request", async () => {
    const server = historyServer({ requests: requests(50), calls: [], revision: "1" });
    const { result, onRouteChange } = mount(server, { route: { agent: "ghost", request: "999" } });
    expect(onRouteChange).toHaveBeenCalledWith({ agent: null, request: "999" });
    await waitFor(() => expect(onRouteChange).toHaveBeenLastCalledWith({ agent: null, request: null }));
    expect(result.current.scope).toBe("all");
    expect(result.current.selectedNumber).toBe(50);
    expect(result.current.mode).toBe("follow");
  });
});

describe("shared request selection: StrictMode route mounts", () => {
  const scoped = () => requests(200, (number) => number % 2 ? "child" : "primary");
  it.each([
    { name: "no route", route: { agent: null, request: null }, scope: "all", number: 200, mode: "follow" },
    { name: "agent only", route: { agent: "child", request: null }, scope: "child", number: 199, mode: "follow" },
    { name: "request number", route: { agent: "child", request: "21" }, scope: "child", number: 21, mode: "anchored" },
    { name: "opaque request id", route: { agent: null, request: "request-24" }, scope: "all", number: 24, mode: "anchored" },
    { name: "scoped opaque request id", route: { agent: "child", request: "request-23" }, scope: "child", number: 23, mode: "anchored" },
  ])("resolves $name under StrictMode", async ({ route, scope, number, mode }) => {
    const server = historyServer({ requests: scoped(), calls: [], revision: "1" });
    const { result } = mount(server, { route, strict: true });
    await waitFor(() => expect(result.current.selectedNumber).toBe(number));
    expect(result.current.scope).toBe(scope);
    expect(result.current.mode).toBe(mode);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.history.status).toBe("ready");
    expect(result.current.rows.some((row) => row.number === number)).toBe(true);
  });
});

describe("shared request selection: races with live refreshes", () => {
  it("keeps a drag when a history event arrives while its window fetch is held", async () => {
    const state = { requests: requests(300), calls: [], revision: "1", overview: false };
    const server = historyServer(state);
    const { result } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(300));
    expect(result.current.mode).toBe("follow");
    server.holdWhen((params) => params.get("kind") === "requests" && params.get("offset") === "0");
    act(() => result.current.history.moveWindow(1));
    await waitFor(() => expect(server.deferred).toHaveLength(1));
    state.requests = requests(301); state.revision = "2";
    act(() => emitHistory(2));
    server.holdWhen(null);
    await act(async () => { server.deferred[0].resolve(); });
    await waitFor(() => expect(result.current.history.total).toBe(301));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.selectedNumber).toBe(60);
    expect(result.current.history.offset).toBe(0);
    expect(result.current.mode).toBe("anchored");
    expect(server.of("requests").at(-1)?.get("offset")).toBe("0");
  });

  it("lets a user selection supersede an in-flight tracking refresh", async () => {
    const state = { requests: requests(100), calls: [], revision: "1", overview: false };
    const server = historyServer(state);
    const { result } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(100));
    act(() => result.current.select(result.current.rows.find((row) => row.number === 50)!));
    expect(result.current.mode).toBe("track");
    server.holdWhen((params) => params.get("kind") === "requests" && params.get("offset") === "latest");
    state.requests = requests(110); state.revision = "2";
    act(() => emitHistory(2));
    await waitFor(() => expect(server.deferred).toHaveLength(1));
    server.holdWhen(null);
    act(() => result.current.select(result.current.rows.find((row) => row.number === 42)!));
    await act(async () => { server.deferred[0].resolve(); });
    await waitFor(() => expect(result.current.history.total).toBe(110));
    await waitFor(() => expect(result.current.history.status).toBe("ready"));
    expect(result.current.selectedNumber).toBe(42);
    expect(result.current.rows.some((row) => row.number === 42)).toBe(true);
    expect(result.current.history.offset).toBe(41);
    expect(result.current.mode).toBe("anchored");
  });
});

describe("shared request selection: URL write-back and route retries", () => {
  it("writes the route once after a multi-step drag and once after repeated key steps", async () => {
    const server = historyServer({ requests: requests(180), calls: [], revision: "1" });
    const { result, onRouteChange } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(180));
    // Wait for the committed overview preload so every drag step is a cached window.
    await waitFor(() => expect(server.calls.filter((params) => params.get("overview") === "0")).toHaveLength(2));
    for (const start of [1, 20, 40, 61]) act(() => result.current.history.moveWindow(start));
    expect(result.current.history.offset).toBe(60);
    expect(result.current.selectedNumber).toBe(61);
    await waitFor(() => expect(onRouteChange).toHaveBeenCalledTimes(1));
    expect(onRouteChange).toHaveBeenLastCalledWith({ agent: null, request: "61" });
    for (let index = 0; index < 3; index += 1) act(() => result.current.step(1));
    expect(result.current.selectedNumber).toBe(64);
    await waitFor(() => expect(onRouteChange).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(onRouteChange).toHaveBeenCalledTimes(2);
    expect(onRouteChange).toHaveBeenLastCalledWith({ agent: null, request: "64" });
  });

  it("clears the kind filter when the agent scope changes", async () => {
    const server = historyServer({ requests: requests(40, (number) => number % 2 ? "child" : "primary"), calls: [], revision: "1" });
    const { result } = mount(server);
    await waitFor(() => expect(result.current.selectedNumber).toBe(40));
    act(() => result.current.setWorkKind("shell"));
    act(() => result.current.setScope("child"));
    await waitFor(() => expect(result.current.scope).toBe("child"));
    expect(result.current.workKind).toBeNull();
  });

  it("waits for the next request-page revision after a number lookup answers loading", async () => {
    const state: HistoryServerState = { requests: requests(200), calls: [], revision: "1", activity: "loading" };
    const server = historyServer(state);
    const { result, onRouteChange } = mount(server, { route: { agent: null, request: "21" } });
    await waitFor(() => expect(result.current.history.status).toBe("ready"));
    await waitFor(() => expect(result.current.pending).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    const lookups = server.of("activity").length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(server.of("activity")).toHaveLength(lookups);
    expect(onRouteChange).not.toHaveBeenCalled();
    state.activity = undefined; state.requests = requests(201); state.revision = "2";
    act(() => emitHistory(2));
    await waitFor(() => expect(result.current.selectedNumber).toBe(21));
    expect(server.of("activity")).toHaveLength(lookups + 1);
    expect(onRouteChange).not.toHaveBeenCalled();
  });

  it.each(["network", 503] as const)("keeps a number deep link through a %s lookup failure and retries on reconnect", async (failure) => {
    const state: HistoryServerState = { requests: requests(200), calls: [], revision: "1", activity: failure };
    const server = historyServer(state);
    const { result, onRouteChange } = mount(server, { route: { agent: null, request: "21" } });
    await waitFor(() => expect(result.current.history.status).toBe("ready"));
    await waitFor(() => expect(result.current.pending).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(onRouteChange).not.toHaveBeenCalled();
    expect(result.current.selectedNumber).toBe(200);
    const lookups = server.of("activity").length;
    state.activity = undefined;
    act(() => emitConnected());
    await waitFor(() => expect(result.current.selectedNumber).toBe(21));
    expect(server.of("activity")).toHaveLength(lookups + 1);
    expect(onRouteChange).not.toHaveBeenCalled();
  });
});
