import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { beginRendererTrace } from "../../app/renderer-trace";

afterEach(() => vi.unstubAllGlobals());

it("does not create a trace for an invalid request interval or a hidden page", () => {
  expect(beginRendererTrace({ domain: "activity", token: "r0123456789abcdef_1", calibration: { requestStartedMs: 10, responseReceivedMs: 1_011 } })).toBeNull();
  const descriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  try {
    expect(beginRendererTrace({ domain: "activity", token: "r0123456789abcdef_1", calibration: { requestStartedMs: 10, responseReceivedMs: 10 } })).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(document, "hidden", descriptor);
    else delete (document as { hidden?: boolean }).hidden;
  }
});

it("clears fixed marks and keeps one bounded telemetry POST in flight", async () => {
  const mark = vi.fn();
  const clearMarks = vi.fn();
  let resolvePost!: (value: { ok: boolean }) => void;
  const fetcher = vi.fn((url: string, options: RequestInit) => {
    void url; void options;
    return new Promise<{ ok: boolean }>((resolve) => { resolvePost = resolve; });
  });
  vi.stubGlobal("performance", { now: () => 10, mark, clearMarks });
  vi.stubGlobal("fetch", fetcher);
  const trace = beginRendererTrace({ domain: "activity", token: "r0123456789abcdef_1", calibration: { requestStartedMs: 10, responseReceivedMs: 10 } });
  expect(trace).not.toBeNull();
  for (let index = 0; index < 20; index += 1) trace!.fetchCompleted(10);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const [, options] = fetcher.mock.calls[0]!;
  const payload = JSON.parse(String(options.body));
  expect(payload.calibration).toEqual({ requestStartedMs: 10, responseReceivedMs: 10 });
  expect(payload.records).toHaveLength(16);
  expect(payload.records).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: "renderer_fetch", domain: "activity", token: "r0123456789abcdef_1", durationMs: 0, startedAtMs: 10, endedAtMs: 10 }),
  ]));
  expect(mark).toHaveBeenCalledTimes(20);
  expect(clearMarks).toHaveBeenCalledTimes(20);
  const signal = options.signal as AbortSignal;
  trace!.stop();
  expect(signal.aborted).toBe(true);
  resolvePost({ ok: true });
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("expires a stalled telemetry trace and cancels its pending frame", async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const mark = vi.fn();
  const clearMarks = vi.fn();
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("performance", { now: () => 10, mark, clearMarks });
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => {
    options.signal?.addEventListener("abort", abort);
    return new Promise(() => {});
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 7; });
  const cancelFrame = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const trace = beginRendererTrace({ domain: "activity", token: "r0123456789abcdef_1", calibration: { requestStartedMs: 10, responseReceivedMs: 10 } });
  trace!.fetchCompleted(10);
  trace!.nextFrame(10);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(abort).toHaveBeenCalledTimes(1);
  expect(cancelFrame).toHaveBeenCalledWith(7);
  frame?.(10);
  expect(mark).toHaveBeenCalledTimes(1);
});
