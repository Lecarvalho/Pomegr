import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseActivityFeedPage, parseUnassociatedPage, targetBasename } from "../../app/components/dashboard/activity-feed/feed-model";
import { useActivityFeed, type ActivityFeedQuery } from "../../app/components/dashboard/activity-feed/useActivityFeed";
import type { HistoryActivity } from "../../shared/session-history-contract";
import { historyCall, historyRequest, historyServer, type HistoryServerState } from "./activities-test-server";

const SESSION = "claude:feed";

function requests(count: number) {
  return Array.from({ length: count }, (_, index) => historyRequest(index + 1));
}

function mount(server: ReturnType<typeof historyServer>, initial: Partial<ActivityFeedQuery> & { historyRevision?: string; enabled?: boolean } = {}) {
  vi.stubGlobal("fetch", vi.fn(server.fetcher));
  return renderHook((props: Partial<ActivityFeedQuery> & { historyRevision?: string; enabled?: boolean }) => useActivityFeed({
    enabled: props.enabled ?? true,
    query: { sessionId: SESSION, scope: props.scope ?? "all", selected: props.selected === undefined ? null : props.selected },
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

  it("keeps empty and unresolved associations explicit with noMatchingCalls", async () => {
    const all = requests(5);
    const calls = [historyCall("call-1", all[1], "read", 1), historyCall("call-2", all[1], "shell", 2), historyCall("call-orphan", null, "read", 3)];
    const server = historyServer({ requests: all, calls, revision: "1" });
    const { result } = mount(server, { selected: 3 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.groups.map((group) => [group.request.number, group.calls.map((call) => call.id), group.noMatchingCalls])).toEqual([
      [1, [], true], [2, ["call-1", "call-2"], false], [3, [], true], [4, [], true], [5, [], true],
    ]);
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
    const { result, rerender } = renderHook(({ revision }: { revision: string }) => useActivityFeed({ enabled: true, query: { sessionId: SESSION, scope: "all", selected: 1 }, historyRevision: revision }), { initialProps: { revision: "r1" } });
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

const pad = (index: number) => String(index).padStart(2, "0");

/**
 * Three retained requests. Twenty calls have no recorded request: a failed 74-scope FileChange, 18 more
 * and a late one. The exec wrapper that issued the patch and the calls after it are linked.
 */
function orphanFixture() {
  const all = requests(3);
  const orphan = (id: string, second: number, overrides: Partial<HistoryActivity> = {}) => historyCall(id, null, "write", second, { tool: "FileChange", ...overrides });
  const calls = [
    historyCall("call-wrapper", all[0], "shell", 1, { tool: "exec", detail: "Run the patch cell" }),
    orphan("call-patch-74", 2, { detail: "74 scopes", status: "failed" }),
    ...Array.from({ length: 18 }, (_, index) => orphan(`call-gap-${pad(index + 1)}`, 10 + index)),
    orphan("call-late", 100),
    historyCall("call-after-1", all[1], "read", 1),
    historyCall("call-after-2", all[2], "shell", 1),
  ];
  return { all, calls, ids: calls.filter((call) => call.requestId === null).map((call) => call.id) };
}

const flatReads = (server: ReturnType<typeof historyServer>) => server.calls.filter((params) => params.get("unassociated") === "1");
const ids = (result: { current: { unassociated: { calls: HistoryActivity[] } } }) => result.current.unassociated.calls.map((call) => call.id);

describe("unassociated activity", () => {
  async function opened(state: HistoryServerState, initial: Parameters<typeof mount>[1] = { selected: 3 }) {
    const server = historyServer(state);
    const view = mount(server, initial);
    await waitFor(() => expect(view.result.current.correlated).toBe(true));
    return { server, ...view };
  }

  it("counts from the feed page, reads nothing while closed, and pages every call exactly once", async () => {
    const { all, calls, ids: expected } = orphanFixture();
    const { server, result } = await opened({ requests: all, calls, revision: "1" });
    expect(result.current.unassociated).toMatchObject({ total: 20, status: "idle", calls: [], remaining: 20, open: false });
    expect(flatReads(server)).toHaveLength(0);
    act(() => result.current.unassociated.setOpen(true));
    expect(result.current.unassociated).toMatchObject({ open: true, status: "loading", calls: [] });
    await waitFor(() => expect(result.current.unassociated.status).toBe("ready"));
    // The newest page first: the aligned final page, without the feed's selected number.
    expect(Object.fromEntries(flatReads(server)[0])).toEqual({ sessionId: SESSION, kind: "activity", scope: "all", unassociated: "1", limit: "8", offset: "latest" });
    expect(ids(result)).toEqual(["call-gap-16", "call-gap-17", "call-gap-18", "call-late"]);
    expect(result.current.unassociated.remaining).toBe(16);
    act(() => result.current.unassociated.loadMore());
    expect(result.current.unassociated.status).toBe("loading");
    await waitFor(() => expect(result.current.unassociated.status).toBe("ready"));
    expect(result.current.unassociated.remaining).toBe(8);
    act(() => result.current.unassociated.loadMore());
    await waitFor(() => expect(result.current.unassociated.remaining).toBe(0));
    expect(flatReads(server).map((params) => params.get("offset"))).toEqual(["latest", "8", "0"]);
    expect(ids(result)).toEqual(expected);
    expect(result.current.unassociated.calls.find((call) => call.id === "call-patch-74")).toMatchObject({ status: "failed", requestId: null });
    // The wrapper and the later calls stay linked; the feed's groups are untouched.
    expect(ids(result)).not.toContain("call-wrapper");
    expect(result.current.groups.flatMap((group) => group.calls.map((call) => call.id)).sort()).toEqual(["call-after-1", "call-after-2", "call-wrapper"]);
    act(() => result.current.unassociated.loadMore());
    expect(flatReads(server)).toHaveLength(3);
    act(() => result.current.unassociated.setOpen(false));
    expect(result.current.unassociated).toMatchObject({ open: false, status: "idle" });
    act(() => result.current.unassociated.setOpen(true));
    expect(result.current.unassociated).toMatchObject({ status: "ready", remaining: 0 });
    expect(flatReads(server)).toHaveLength(3);
  });

  it("shows no section for an older monitor and never reads a feed without unassociated calls", async () => {
    const body = { kind: "activity", status: "ready", revision: "1", requestGroups: [], range: { from: 0, to: 0 }, requestTotal: 0, callTotal: 0, byKind: [], shellTasks: { total: 0, failed: 0 } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const old = renderHook(() => useActivityFeed({ enabled: true, query: { sessionId: SESSION, scope: "all", selected: 1 }, historyRevision: "r1" }));
    await waitFor(() => expect(old.result.current.status).toBe("ready"));
    act(() => old.result.current.unassociated.setOpen(true));
    expect(old.result.current.unassociated).toMatchObject({ total: 0, status: "idle", calls: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const all = requests(3);
    const { server, result } = await opened({ requests: all, calls: [historyCall("call-1", all[1], "read", 1)], revision: "1" });
    act(() => result.current.unassociated.setOpen(true));
    expect(result.current.unassociated).toMatchObject({ total: 0, status: "idle" });
    expect(flatReads(server)).toHaveLength(0);
  });

  it("replaces count and rows when the scope changes, and keeps them when only the selection changes", async () => {
    const all = [...requests(3), historyRequest(4, "worker-1")];
    const calls = [
      ...Array.from({ length: 10 }, (_, index) => historyCall(`call-main-${pad(index + 1)}`, null, "write", index + 1)),
      ...[1, 2, 3].map((second) => historyCall(`call-worker-${second}`, null, "write", 40 + second, { agentId: "worker-1" })),
    ];
    const { server, result, rerender } = await opened({ requests: all, calls, revision: "1" });
    expect(result.current.unassociated.total).toBe(13);
    act(() => result.current.unassociated.setOpen(true));
    await waitFor(() => expect(result.current.unassociated.status).toBe("ready"));
    const before = ids(result);
    expect(before).toHaveLength(5);
    // Selecting another request moves only the five-group window.
    rerender({ selected: 1 });
    expect(result.current.unassociated).toMatchObject({ status: "ready", total: 13 });
    await waitFor(() => expect(result.current.correlated).toBe(true));
    expect(ids(result)).toEqual(before);
    expect(flatReads(server)).toHaveLength(1);
    // Another scope drops the rows at once and counts and reads its own.
    rerender({ selected: 1, scope: "worker-1" });
    expect(result.current.unassociated).toMatchObject({ total: 0, calls: [], status: "idle" });
    await waitFor(() => expect(result.current.unassociated.status).toBe("ready"));
    expect(result.current.unassociated).toMatchObject({ total: 3, open: true, remaining: 0 });
    expect(ids(result)).toEqual(["call-worker-1", "call-worker-2", "call-worker-3"]);
    expect(Object.fromEntries(flatReads(server).at(-1)!)).toMatchObject({ scope: "worker-1", offset: "latest" });
  });

  it("lists a reply committed after the feed's page and refetches rows on a served revision change", async () => {
    const { all, calls } = orphanFixture();
    const state: HistoryServerState = { requests: all, calls, revision: "1" };
    const { server, result, rerender } = await opened(state);
    server.holdWhen((params) => params.get("unassociated") === "1");
    act(() => result.current.unassociated.setOpen(true));
    await waitFor(() => expect(server.deferred).toHaveLength(1));
    // The monitor moved on before the feed noticed: this reply names revision 2 while the feed shows 1.
    state.revision = "2";
    await act(async () => { server.deferred[0].resolve(); });
    // A recorded session's feed never follows, so the newer reply is listed instead of waited on.
    expect(result.current.unassociated.status).toBe("ready");
    expect(ids(result).length).toBeGreaterThan(0);
    server.holdWhen(null);
    state.calls = [...calls, historyCall("call-newest", null, "write", 200)];
    rerender({ selected: 3, historyRevision: "r2" });
    await waitFor(() => expect(result.current.unassociated).toMatchObject({ status: "ready", total: 21 }));
    expect(ids(result).at(-1)).toBe("call-newest");
    expect(flatReads(server)).toHaveLength(2);
    // Revision 3 drops what was loaded and reads again.
    state.revision = "3";
    rerender({ selected: 3, historyRevision: "r3" });
    await waitFor(() => expect(result.current.revision).toBe("3"));
    await waitFor(() => expect(flatReads(server)).toHaveLength(3));
  });

  it("recovers from a failed first read and a failed older page with retry, and aborts on unmount", async () => {
    const { all, calls, ids: expected } = orphanFixture();
    const state: HistoryServerState = { requests: all, calls, revision: "1", unassociatedStatus: 503 };
    const { server, result, unmount } = await opened(state);
    act(() => result.current.unassociated.setOpen(true));
    await waitFor(() => expect(result.current.unassociated.status).toBe("unavailable"));
    // The grouped feed does not share the failure.
    expect(result.current.status).toBe("ready");
    state.unassociatedStatus = undefined;
    act(() => result.current.unassociated.retry());
    expect(result.current.unassociated.status).toBe("loading");
    await waitFor(() => expect(result.current.unassociated.status).toBe("ready"));
    expect(flatReads(server).map((params) => params.get("offset"))).toEqual(["latest", "latest"]);
    state.unassociatedStatus = "network";
    act(() => result.current.unassociated.loadMore());
    await waitFor(() => expect(result.current.unassociated.status).toBe("unavailable"));
    expect(ids(result)).toHaveLength(4);
    expect(result.current.unassociated.remaining).toBe(16);
    state.unassociatedStatus = undefined;
    act(() => result.current.unassociated.retry());
    await waitFor(() => expect(result.current.unassociated.status).toBe("ready"));
    expect(ids(result)).toEqual(expected.slice(8));
    server.holdWhen((params) => params.get("unassociated") === "1");
    act(() => result.current.unassociated.loadMore());
    await waitFor(() => expect(server.deferred).toHaveLength(1));
    const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("feed model", () => {
  it("reads the optional unassociated total as 0 when absent or malformed and parses one flat page", () => {
    const ready = { kind: "activity", status: "ready", revision: "7", requestGroups: [], range: { from: 0, to: 0 }, requestTotal: 0, callTotal: 0, byKind: [], shellTasks: { total: 0, failed: 0 } };
    expect(parseActivityFeedPage(ready)).toMatchObject({ status: "ready", unassociatedTotal: 0 });
    expect(parseActivityFeedPage({ ...ready, unassociatedTotal: 12 })?.unassociatedTotal).toBe(12);
    for (const bad of [-1, 1.5, "3", null, Number.NaN, {}]) expect(parseActivityFeedPage({ ...ready, unassociatedTotal: bad })).toMatchObject({ status: "ready", unassociatedTotal: 0 });
    expect(parseActivityFeedPage({ kind: "activity", status: "loading", revision: "1" })?.unassociatedTotal).toBe(0);
    const call = historyCall("call-1", null, "write", 1);
    const flat = { kind: "activity", status: "ready", revision: "7", total: 9, offset: 8, linkedCount: 0, items: [call] };
    expect(parseUnassociatedPage(flat)).toEqual({ status: "ready", revision: "7", total: 9, offset: 8, calls: [call] });
    expect(parseUnassociatedPage({ ...flat, status: "loading" })).toEqual({ status: "loading", revision: "7", total: 0, offset: 0, calls: [] });
    for (const bad of [{ items: [{ id: "x" }] }, { items: "none" }, { total: -1 }, { offset: "0" }]) expect(parseUnassociatedPage({ ...flat, ...bad })?.status).toBe("unavailable");
    expect(parseUnassociatedPage({ ...flat, kind: "requests" })).toBeNull();
    expect(parseUnassociatedPage({ ...flat, status: "stale" })).toBeNull();
    expect(parseUnassociatedPage(null)).toBeNull();
  });

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
    // A Bash description that ends in a path is still prose: only a detail whose first segment
    // carries no whitespace is read as a path, so the description survives whole.
    expect(targetBasename("Run tests for app/foo.test.ts")).toBe("Run tests for app/foo.test.ts");
    expect(targetBasename("Update docs/README.md with the new flow")).toBe("Update docs/README.md with the new flow");
    expect(targetBasename("Read tests/ui/activity-feed.test.tsx")).toBe("Read tests/ui/activity-feed.test.tsx");
  });
});
