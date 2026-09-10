import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { ComponentProps } from "react";
import type { Agent, CacheEventFeed, CacheReadDropFeed, ContextHistoryBoundary, RequestSnapshot, RequestSnapshotFeed } from "../../shared/monitor-contract";
import type { RequestOverviewPoint } from "../../shared/session-history-contract";
import { useSessionRequestSelection } from "../../app/components/dashboard/requests-actions/useSessionRequestSelection";
import { RequestsActionsPanel as ControlledRequestsActionsPanel } from "../../app/components/dashboard/RequestsActionsPanel";
import { agent } from "./dashboard-test-fixtures";
export function RequestsActionsPanel(props: Omit<ComponentProps<typeof ControlledRequestsActionsPanel>, "selection">) {
  const selection = useSessionRequestSelection(props);
  return <ControlledRequestsActionsPanel {...props} selection={selection} />;
}


const baseTime = Date.parse("2026-08-09T12:00:00.000Z");
const EMPTY_BOUNDARIES: ContextHistoryBoundary[] = [];

export function snapshot(index: number, agentId = "primary", overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  const uncachedInputTokens = overrides.uncachedInputTokens ?? 2_000_000 - index * 1_000;
  const cacheWriteTokens = overrides.cacheWriteTokens ?? 2_000;
  const cacheReadTokens = overrides.cacheReadTokens ?? 3_000;
  const outputTokens = overrides.outputTokens ?? 4_000;
  return {
    id: `request-${index}`,
    agentId,
    observedAt: new Date(baseTime + index * 60_000).toISOString(),
    cacheLifetime: "1h",
    uncachedInputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: uncachedInputTokens + cacheWriteTokens + cacheReadTokens + outputTokens,
    precedingWork: [],
    precedingAssociation: null,
    issuedWork: [],
    issuedAssociation: null,
    ...overrides,
  };
}

export function requestFeed(items: RequestSnapshot[], status: RequestSnapshotFeed["status"] = "ready"): RequestSnapshotFeed {
  return { status, items };
}

export function overviewPoint(item: RequestSnapshot): RequestOverviewPoint {
  return [item.uncachedInputTokens, item.cacheWriteTokens, item.cacheReadTokens, item.outputTokens];
}

export function fullRefill(agentId: string, observedAt: string): CacheEventFeed["possibleFullRefills"] {
  return [{ agentId, count: 1, occurrences: [{ observedAt, reason: null, providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null }], reasons: [], toolChangeAttributions: [] }];
}

export function renderPanel(items: RequestSnapshot[], options: { agents?: Agent[]; cacheWriteAvailable?: boolean; historical?: boolean; cacheReadDrops?: CacheReadDropFeed } = {}) {
  return render(<RequestsActionsPanel
    agents={options.agents ?? [agent]}
    requestSnapshots={requestFeed(items)}
    contextBoundaries={[]}
    cacheWriteAvailable={options.cacheWriteAvailable ?? true}
    historical={options.historical ?? false}
    cacheReadDrops={options.cacheReadDrops}
  />);
}

export function HistoryLocateHarness({ sessionId, requests }: { sessionId: string; requests: RequestSnapshot[] }) {
  const selection = useSessionRequestSelection({ agents: [agent], requestSnapshots: requestFeed(requests), contextBoundaries: EMPTY_BOUNDARIES, historical: false, sessionId, historyEnabled: true });
  return <><button type="button" onClick={() => selection.locate("request-10")}>Locate absent request</button><ControlledRequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed(requests)} contextBoundaries={EMPTY_BOUNDARIES} cacheWriteAvailable historical={false} selection={selection} /></>;
}

export function chart(container: HTMLElement): SVGSVGElement {
  return container.querySelector("svg.requestsActionsChart") as SVGSVGElement;
}

export function axisLabels(container: HTMLElement): string[] {
  const svg = chart(container);
  const labels = Array.from(svg.querySelectorAll(".requestsActionsAxis:last-child text")).map((node) => node.textContent || "");
  return labels.length > 2 ? [labels[0], labels.at(-1) || ""] : labels;
}

export function setPhone(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}
