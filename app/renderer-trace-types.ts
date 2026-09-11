export type RendererTraceInput = {
  domain: RendererTraceDomain;
  token: string;
  calibration: { requestStartedMs: number; responseReceivedMs: number };
};

export type RendererTraceDomain = "catalog" | "activity" | "requests";

export type RendererTrace = Readonly<{
  eventReceived(receivedAt: number): void;
  fetchCompleted(startedAt: number): void;
  reactCommitted(startedAt: number): void;
  nextFrame(startedAt: number): void;
  stop(): void;
}>;

export type RendererTraceCapture = Readonly<{ trace: RendererTrace; startedAt: number }>;
export type RendererTraceRequest = (response: Response) => RendererTraceCapture | null;
