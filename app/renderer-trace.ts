import {
  RENDERER_TRACE_DOMAINS,
  RENDERER_TRACE_MAX_CALIBRATION_RTT_MS,
  RENDERER_TRACE_MAX_MONOTONIC_MS,
  RENDERER_TRACE_STAGES,
} from "../shared/renderer-trace-contract.mjs";
import type { RendererTrace, RendererTraceCapture, RendererTraceDomain, RendererTraceInput, RendererTraceRequest } from "./renderer-trace-types";

type Domain = (typeof RENDERER_TRACE_DOMAINS)[number];
type Stage = (typeof RENDERER_TRACE_STAGES)[number];

const MAX_PENDING = 16;
const MAX_LIFETIME_MS = 5_000;
const stages = new Set<string>(RENDERER_TRACE_STAGES);
const domains = new Set<string>(RENDERER_TRACE_DOMAINS);

type Calibration = { requestStartedMs: number; responseReceivedMs: number };
type Record = { stage: Stage; domain: Domain; token: string; durationMs: number; startedAtMs: number; endedAtMs: number };

function now() { return typeof performance === "undefined" ? 0 : performance.now(); }
export function rendererTraceReceiptTime(): number | undefined {
  const receivedAt = now();
  return Number.isFinite(receivedAt) && receivedAt >= 0 ? receivedAt : undefined;
}
/** Starts a fixed trace interval. Response-token handling stays in the dev-only module. */
export function startRendererTraceRequest(domain: RendererTraceDomain): RendererTraceRequest {
  const startedAt = now();
  return (response: Response): RendererTraceCapture | null => {
    const responseReceivedAt = now();
    const token = response.headers?.get("x-pomegr-trace-revision");
    const trace = token ? beginRendererTrace({ domain, token,
      calibration: { requestStartedMs: startedAt, responseReceivedMs: responseReceivedAt } }) : null;
    trace?.fetchCompleted(startedAt);
    return trace ? { trace, startedAt } : null;
  };
}
function validCalibration(value: Calibration) {
  return Number.isFinite(value.requestStartedMs) && Number.isFinite(value.responseReceivedMs)
    && value.requestStartedMs >= 0 && value.responseReceivedMs >= value.requestStartedMs
    && value.responseReceivedMs <= RENDERER_TRACE_MAX_MONOTONIC_MS
    && value.responseReceivedMs - value.requestStartedMs <= RENDERER_TRACE_MAX_CALIBRATION_RTT_MS;
}

/** Fixed, opt-in request-interval timings; the monitor alone derives backend correlation. */
export function beginRendererTrace({ domain, token, calibration }: RendererTraceInput): RendererTrace | null {
  if (typeof window === "undefined" || document.hidden || !domains.has(domain)
    || !/^r[a-f0-9]{16}_[1-9][0-9]{0,15}$/.test(token) || !validCalibration(calibration)) return null;
  let stopped = false;
  let pending: Record[] = [];
  let flushScheduled = false;
  let inFlight: AbortController | null = null;
  let frameId: number | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  const clearMark = (name: string) => {
    try { performance.clearMarks(name); } catch { /* Browser performance APIs are optional. */ }
  };
  const scheduleFlush = () => {
    if (stopped || flushScheduled || inFlight || !pending.length) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      if (stopped || inFlight || !pending.length) return;
      const records = pending.splice(0, MAX_PENDING);
      const controller = new AbortController();
      inFlight = controller;
      void fetch("/api/renderer-trace", {
        method: "POST", cache: "no-store", credentials: "same-origin", keepalive: true, signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ calibration, records }),
      }).then((response) => { if (!response.ok) stop(); }, () => { stop(); })
        .finally(() => {
          if (inFlight === controller) inFlight = null;
          if (!stopped) scheduleFlush();
        });
    });
  };
  const mark = (stage: Stage, startedAt: number) => {
    if (stopped || !stages.has(stage) || !Number.isFinite(startedAt)) return;
    const name = `pomegr:${stage}`;
    try { performance.mark(name); } catch { return; }
    clearMark(name);
    const endedAtMs = now();
    if (!Number.isFinite(endedAtMs) || endedAtMs < startedAt || endedAtMs > RENDERER_TRACE_MAX_MONOTONIC_MS
      || endedAtMs - startedAt > 60_000) return;
    pending.push({ stage, domain, token, durationMs: Math.round(endedAtMs - startedAt), startedAtMs: startedAt, endedAtMs });
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    scheduleFlush();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; pending = []; inFlight?.abort(); inFlight = null;
    if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
    lifetimeTimer = null;
    if (frameId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
    frameId = null;
    document.removeEventListener("visibilitychange", stopWhenHidden);
    window.removeEventListener("pagehide", stop);
    for (const stage of RENDERER_TRACE_STAGES) clearMark(`pomegr:${stage}`);
  };
  const stopWhenHidden = () => { if (document.hidden) stop(); };
  document.addEventListener("visibilitychange", stopWhenHidden, { once: false });
  window.addEventListener("pagehide", stop, { once: true });
  lifetimeTimer = setTimeout(stop, MAX_LIFETIME_MS);
  return Object.freeze({
    eventReceived: (receivedAt: number) => mark("renderer_event", receivedAt),
    fetchCompleted: (startedAt: number) => mark("renderer_fetch", startedAt),
    reactCommitted: (startedAt: number) => mark("renderer_react_commit", startedAt),
    nextFrame: (startedAt: number) => {
      if (stopped || document.hidden || typeof requestAnimationFrame !== "function") return;
      frameId = requestAnimationFrame(() => { frameId = null; mark("renderer_next_frame", startedAt); });
    },
    stop,
  });
}
