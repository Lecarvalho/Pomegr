import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTreeView } from "../../app/components/dashboard/agent-tree/AgentTreeView";
import { LiveClockProvider } from "../../app/hooks/LiveClockContext";
import type { CacheEventFeed, CacheReadDropFeed, CacheRefillCount, CacheRefillOccurrence } from "../../shared/monitor-contract";
import { agent } from "./dashboard-test-fixtures";
import { RequestsActionsPanel, fullRefill, requestFeed, setPhone, snapshot } from "./requests-actions-test-fixtures";

afterEach(() => vi.unstubAllGlobals());

const diagnosed = (observedAt: string): CacheRefillOccurrence => ({
  observedAt, kind: "provider_diagnosed", reason: "tools_changed", providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null,
});

function diagnosedFeed(observedAt: string): CacheEventFeed {
  return { status: "ready", items: [], possibleFullRefills: [{ agentId: "primary", count: 0, providerDiagnosedCount: 1, occurrences: [diagnosed(observedAt)], reasons: [], toolChangeAttributions: [] }] };
}

function renderChart(cacheEvents: CacheEventFeed, cacheReadDrops?: CacheReadDropFeed) {
  return render(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([snapshot(1), snapshot(2), snapshot(3)])} contextBoundaries={[]} cacheWriteAvailable historical cacheEvents={cacheEvents} cacheReadDrops={cacheReadDrops} />);
}

describe("provider-diagnosed refill markers on the request chart", () => {
  it.each([false, true])("draws the minimap line as a recorded refill, not an inference (phone: %s)", (phone) => {
    setPhone(phone);
    const diagnosedAt = snapshot(2).observedAt;
    const possibleAt = snapshot(3).observedAt;
    const cacheReadDrops: CacheReadDropFeed = { status: "ready", items: [{ agentId: "primary", count: 1, occurrences: [{ id: "drop", observedAt: possibleAt, previousCacheReadPercent: 90, cacheReadPercent: 5, gapMs: 60_000 }] }] };
    const { container } = renderChart(diagnosedFeed(diagnosedAt), cacheReadDrops);
    const [recorded, inferred, ...rest] = Array.from(container.querySelectorAll(".requestsActionsMiniRefill"));
    expect(rest).toHaveLength(0);
    expect(recorded).not.toHaveClass("isInferred");
    expect(inferred).toHaveClass("isInferred");
  });

  it("names the kind in the legend with the recorded-refill glyph and never as inferred", () => {
    const { container, rerender } = renderChart(diagnosedFeed(snapshot(2).observedAt));
    const legend = container.querySelector(".requestsActionsLegend")!;
    const entry = Array.from(legend.querySelectorAll("span")).find((item) => item.textContent === "Provider-diagnosed refill dotted")!;
    expect(entry).toBeDefined();
    expect(entry.querySelector('path[fill="none"]')).toBeNull();
    expect(legend.textContent).not.toMatch(/Possible|infer/i);
    rerender(<RequestsActionsPanel agents={[agent]} requestSnapshots={requestFeed([snapshot(1), snapshot(2), snapshot(3)])} contextBoundaries={[]} cacheWriteAvailable historical cacheEvents={{ status: "ready", items: [], possibleFullRefills: fullRefill("primary", snapshot(2).observedAt) }} />);
    expect(container.querySelector(".requestsActionsLegend")!.textContent).toContain("Possible full refill dotted");
    expect(container.querySelector(".requestsActionsLegend")!.textContent).not.toContain("Provider-diagnosed");
  });
});

describe("agent tree item name", () => {
  const refills = (count: number, providerDiagnosedCount?: number): CacheRefillCount[] => [{ agentId: "primary", count, providerDiagnosedCount, occurrences: [], reasons: [], toolChangeAttributions: [] }];
  const itemName = (cacheRefills: CacheRefillCount[]) => {
    const { container } = render(<LiveClockProvider running={false}><AgentTreeView agents={[agent]} cacheRefills={cacheRefills} historical={false} workflows={[]} /></LiveClockProvider>);
    return container.querySelector('[data-agent-id="primary"]')!.getAttribute("aria-label")!;
  };

  it("mentions provider-diagnosed refills beside, and apart from, possible full refills", () => {
    expect(itemName(refills(0, 2))).toContain(", 2 provider-diagnosed cache refills,");
    expect(itemName(refills(0, 2))).not.toMatch(/possible full/);
    const both = itemName(refills(1, 1));
    expect(both).toContain(", 1 possible full cache refill, 1 provider-diagnosed cache refill,");
    expect(both).not.toMatch(/infer/i);
  });

  it("leaves the possible-full wording unchanged when nothing was diagnosed", () => {
    for (const cacheRefills of [refills(3), refills(3, 0), refills(3, undefined)]) {
      const name = itemName(cacheRefills);
      expect(name).toContain(", 3 possible full cache refills,");
      expect(name).not.toContain("provider-diagnosed");
    }
  });
});
