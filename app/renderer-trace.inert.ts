import type { RendererTrace, RendererTraceDomain, RendererTraceInput, RendererTraceRequest } from "./renderer-trace-types";

/** Production builds have no browser trace instrumentation. */
export function beginRendererTrace(_input: RendererTraceInput): RendererTrace | null {
  void _input;
  return null;
}

export function rendererTraceReceiptTime(): number | undefined {
  return undefined;
}

export function startRendererTraceRequest(_domain: RendererTraceDomain): RendererTraceRequest {
  void _domain;
  return () => null;
}
