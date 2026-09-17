import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseActivityFeedPage, targetBasename } from "../../app/components/dashboard/activity-feed/feed-model";
import { useActivityFeed, type ActivityFeedQuery } from "../../app/components/dashboard/activity-feed/useActivityFeed";
import { historyCall, historyRequest, historyServer, type HistoryServerState } from "./activities-test-server";

const SESSION = "claude:feed";

function requests(count: number) {
  return Array.from({ length: count }, (_, index) => historyRequest(index + 1));
}

function mount(server: ReturnType<typeof historyServer>, initial: Partial<ActivityFeedQuery> & { historyRevision?: string; enabled?: boolean } = {}) {
  vi.stubGlobal("fetch", vi.fn(server.fetcher));
  return renderHook((props: Partial<ActivityFeedQuery> & { historyRevision?: string; enabled?: boolean }) => useActivityFeed({
    enabled: props.enabled ?? true,
    query: { sessionId: SESSION, scope: props.scope ?? "all", selected: props.selected === undefined ? null : props.selected, workKind: props.workKind ?? null },
    historyRevision: props.historyRevision ?? "r1",
  }), { initialProps: initial });
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("grouped activity feed", () => {
  it.each([
    { total: 20, selected: 1, numbers: [1, 2, 3, 4, 5] },
    { total: 20, selected: 10, numbers: [8, 9, 10, 11, 12] },
    { total: 20, selected: 20, numbers: [16, 17, 18, 19, 20] },
    { total: 3, selected: 2, numbers: [1, 2, 3] },
  ])("returns up to five groups around the selection at range edges (selected $selected of $total)", async ({ total, selected, numbers }) => {
    const server = historyServer({ requests: requests(total), calls: [], revision: "1" });
    const { result } = mount(server, { selected });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.correlated).toBe(true);
    expect(result.current.groups.map((group) => group.request.number)).toEqual(numbers);
    expect(Object.fromEntries(server.calls[0])).toEqual({ sessionId: SESSION, kind: "activity", scope: "all", offset: "latest", limit: "1", selected: String(selected) });
  });

  it("keeps empty and unresolved associations explicit, and filtered headers with noMatchingCalls", async () => {
    const all = requests(5);
    const calls = [historyCall("call-1", all[1], "read", 1), historyCall("call-2", all[1], "shell", 2), historyCall("call-orphan", null, "read", 3)];
    const server = historyServer({ requests: all, calls, revision: "1" });
    const { result, rerender } = mount(server, { selected: 3 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.groups.map((group) => [group.request.number, group.calls.map((call) => call.id), group.noMatchingCalls])).toEqual([
      [1, [], true], [2, ["call-1", "call-2"], false], [3, [], true], [4, [], true], [5, [], true],
    ]);
    rerender({ selected: 3, workKind: "shell" });
    await waitFor(() => expect(result.current.correlated).toBe(true));
    expect(server.calls.at(-1)?.get("workKind")).toBe("shell");
    expect(result.current.groups.map((group) => group.request.number)).toEqual([1, 2, 3, 4, 5]);
    expect(result.current.groups[1].calls.map((call) => call.id)).toEqual(["call-2"]);
    expect(result.current.groups[2].noMatchingCalls).toBe(true);
  });

  it("merges continuation calls and discards them when the served revision changes", async () => {
    const all = requests(3);
    const state = { requests: all, calls: [3, 1, 2, 4, 5].map((second) => historyCall(`call-${second}`, all[2], "read", second)), revision: "1", callLimit: 2 };
    const server = historyServer(state);
    const { result, rerender } = mount(server, { selected: 3 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.groups[2].calls.map((call) => call.id)).toEqual(["call-1", "call-2"]);
    expect(result.current.groups[2].continuation?.remaining).toBe(3);
    act(() => result.current.loadMore(3));
    expect(result.current.loadingMore).toBe(3);
    await waitFor(() => expect(result.current.loadingMore).toBeNull());
    expect(server.calls.at(-1)?.get("continuation")).toBe("3:2");
    expect(result.current.groups[2].calls.map((call) => call.id)).toEqual(["call-1", "call-2", "call-3", "call-4"]);
    act(() => result.current.loadMore(3));
    await waitFor(() => expect(result.current.groups[2].continuation).toBeNull());
    expect(result.current.groups[2].calls.map((call) => call.id)).toEqual(["call-1", "call-2", "call-3", "call-4", "call-5"]);

    state.revision = "2";
    rerender({ selected: 3, historyRevision: "r2" });
    await waitFor(() => expect(result.current.revision).toBe("2"));
    expect(result.current.groups[2].calls.map((call) => call.id)).toEqual(["call-1", "call-2"]);
  });

  it("revalidates on a request-page revision change and retains the body on 204", async () => {
    const server = historyServer({ requests: requests(8), calls: [], revision: "1" });
    const { result, rerender } = mount(server, { selected: 8 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const groups = result.current.groups;
    rerender({ selected: 8, historyRevision: "r2" });
    expect(result.current.correlated).toBe(false);
    expect(result.current.groups).toEqual(groups);
    await waitFor(() => expect(result.current.correlated).toBe(true));
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1].get("revision")).toBe("1");
    expect(result.current.groups).toEqual(groups);
  });

  it("keeps the previous groups uncorrelated while a new query loads, and drops stale responses", async () => {
    const server = historyServer({ requests: requests(30), calls: [], revision: "1" });
    const { result, rerender } = mount(server, { selected: 30 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    server.holdWhen((params) => params.get("selected") === "10");
    rerender({ selected: 10 });
    expect(result.current.status).toBe("loading");
    expect(result.current.correlated).toBe(false);
    expect(result.current.groups.map((group) => group.request.number)).toEqual([26, 27, 28, 29, 30]);
    server.holdWhen(null);
    rerender({ selected: 20 });
    await waitFor(() => expect(result.current.correlated).toBe(true));
    await act(async () => { server.deferred[0]?.resolve(); });
    expect(result.current.groups.map((group) => group.request.number)).toEqual([18, 19, 20, 21, 22]);
    expect(server.calls.at(-1)?.has("revision")).toBe(false);
  });

  it("uses no timers: fake time and an unchanged request-page revision never refetch the same query", async () => {
    vi.useFakeTimers();
    const server = historyServer({ requests: requests(8), calls: [], revision: "1" });
    const { result, rerender } = mount(server, { selected: 4 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.status).toBe("ready");
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    rerender({ selected: 4 });
    rerender({ selected: 4 });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(server.calls).toHaveLength(1);
  });

  it("shows retained groups as unavailable after a failed query and retries exactly the current query", async () => {
    const state: HistoryServerState = { requests: requests(30), calls: [], revision: "1" };
    const server = historyServer(state);
    const { result, rerender } = mount(server, { selected: 30 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    state.activity = 503;
    rerender({ selected: 10 });
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.correlated).toBe(false);
    expect(result.current.groups.map((group) => group.request.number)).toEqual([26, 27, 28, 29, 30]);
    state.activity = undefined;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.correlated).toBe(true));
    expect(server.calls.at(-1)?.get("selected")).toBe("10");
    expect(result.current.status).toBe("ready");
    expect(result.current.groups.map((group) => group.request.number)).toEqual([8, 9, 10, 11, 12]);
  });

  it("waits for the next revision after a loading response and reports unavailable bodies", async () => {
    let body: unknown = { kind: "activity", status: "loading", revision: "0", items: [] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const { result, rerender } = renderHook(({ revision }: { revision: string }) => useActivityFeed({ enabled: true, query: { sessionId: SESSION, scope: "all", selected: 1, workKind: null }, historyRevision: revision }), { initialProps: { revision: "r1" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    rerender({ revision: "r1" });
    expect(result.current.status).toBe("loading");
    expect(fetch).toHaveBeenCalledTimes(1);
    // A ready body from an older index without grouped fields is unavailable, never a partial feed.
    body = { kind: "activity", status: "ready", revision: "1", items: [], total: 0, offset: 0, linkedCount: 0 };
    rerender({ revision: "r2" });
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.groups).toEqual([]);
  });
});

describe("feed model", () => {
  it("rejects malformed grouped fields and keeps target basenames", () => {
    expect(parseActivityFeedPage({ kind: "requests", status: "ready" })).toBeNull();
    expect(parseActivityFeedPage({ kind: "activity", status: "ready", revision: "1", requestGroups: [{ request: { id: "x", number: 0 } }] })?.status).toBe("unavailable");
    expect(targetBasename("app/components/deep/file.tsx")).toBe("file.tsx");
    expect(targetBasename("C:\\Workspace\\repo\\notes.md")).toBe("notes.md");
    expect(targetBasename("Run the focused tests")).toBe("Run the focused tests");
    expect(targetBasename("docs/My Notes/meeting notes.md")).toBe("meeting notes.md");
    expect(targetBasename("./scripts/run all.ps1")).toBe("run all.ps1");
    expect(targetBasename("Run tests in tests/ui")).toBe("Run tests in tests/ui");
    expect(targetBasename("Bump version to v1.2 and tag release/2026")).toBe("Bump version to v1.2 and tag release/2026");
  });
});
