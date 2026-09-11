import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HistoryLocateHarness, setPhone, snapshot } from "./requests-actions-test-fixtures";
import { useSessionRequestSelection } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { agent } from "./dashboard-test-fixtures";

afterEach(() => vi.unstubAllGlobals());

it("submits only fixed request timings from a committed capture token", async () => {
  setPhone(false);
  const mark = vi.fn();
  const clearMarks = vi.fn();
  const posts: unknown[] = [];
  vi.stubGlobal("performance", { now: () => 10, mark, clearMarks });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(10);
    return 1;
  });
  const requests = [snapshot(1), snapshot(2), snapshot(3)];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/renderer-trace") {
      posts.push(JSON.parse(String(options?.body)));
      return { ok: true };
    }
    return { ok: true, headers: { get: () => "r0123456789abcdef_2" }, json: async () => ({
      kind: "requests", status: "ready", revision: "2", total: requests.length, offset: 0, linkedCount: 0, items: requests,
    }) };
  }));
  renderHook(() => useSessionRequestSelection({
    agents: [agent], requestSnapshots: { status: "ready", items: requests }, contextBoundaries: [], historical: false,
    historyEnabled: true, sessionId: "request-trace",
  }));
  await waitFor(() => expect(posts.length).toBeGreaterThan(0));
  const records = posts.flatMap((payload) => (payload as { records: unknown[] }).records);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: "renderer_fetch", domain: "requests", token: "r0123456789abcdef_2" }),
    expect.objectContaining({ stage: "renderer_react_commit", domain: "requests", token: "r0123456789abcdef_2" }),
    expect.objectContaining({ stage: "renderer_next_frame", domain: "requests", token: "r0123456789abcdef_2" }),
  ]));
  expect(mark).toHaveBeenCalled();
  expect(clearMarks).toHaveBeenCalled();
});

it.each([
  { action: "bar", total: 3 }, { action: "row", total: 3 },
  { action: "bar", total: 100 }, { action: "row", total: 100 },
])("resolves preview $action selection against committed history before following (total: $total)", async ({ action, total }) => {
  setPhone(false);
  const requests = Array.from({ length: total }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }));
  let finish!: () => void;
  const fetcher = vi.fn(async (url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    if (params.has("requestId")) return new Promise((resolve) => {
      finish = () => resolve({ ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total, offset: 0, linkedCount: 1, items: requests.slice(0, 60) }) });
    });
    return new Promise(() => {});
  });
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useSessionRequestSelection({
    agents: [agent], requestSnapshots: { status: "ready", items: requests.slice(0, 3) },
    contextBoundaries: [], historical: false, historyEnabled: true, sessionId: "preview-selection",
  }));
  expect(result.current.history.preview).toBe(true);
  act(() => {
    if (action === "bar") result.current.select(result.current.rows[2]);
    else result.current.locate(requests[2].id);
  });
  expect(result.current.navigation).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => new URL(url, "http://localhost").searchParams.get("requestId") === requests[2].id)).toBe(true);
  await act(async () => { finish(); });
  expect(result.current.history.preview).toBe(false);
  expect(result.current.selected?.id).toBe(requests[2].id);
  expect(result.current.pinned).toBe(total !== 3);
  expect(result.current.navigation).toEqual({ id: requests[2].id, followLatest: total === 3 });
});

it.each(["bar", "step"])("keeps a newer loaded %s selection when an older request lookup finishes", async (action) => {
  setPhone(false);
  const requests = Array.from({ length: 180 }, (_, index) => ({ ...snapshot(index + 1), number: index + 1 }));
  let finish!: () => void;
  const fetchPage = vi.fn(async (url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    const locating = params.has("requestId");
    const offset = locating ? 0 : 120;
    const response = { ok: true, json: async () => ({ kind: "requests", status: "ready", revision: "1", total: 180, offset, linkedCount: 0, items: requests.slice(offset, offset + 60) }) };
    return locating ? new Promise((resolve) => { finish = () => resolve(response); }) : response;
  });
  vi.stubGlobal("fetch", fetchPage);
  render(<HistoryLocateHarness sessionId="replace-lookup" requests={[]} />);
  await screen.findByRole("heading", { name: "Request #180" });
  fireEvent.click(screen.getByRole("button", { name: "Locate absent request" }));
  if (action === "bar") fireEvent.click(screen.getByRole("button", { name: /^Request #175,/ }));
  else fireEvent.click(screen.getByRole("button", { name: "Prev" }));
  await act(async () => { finish(); });
  expect(screen.getByRole("heading", { name: `Request #${action === "bar" ? 175 : 179}` })).toBeInTheDocument();
  expect(fetchPage).toHaveBeenCalledTimes(2);
});
