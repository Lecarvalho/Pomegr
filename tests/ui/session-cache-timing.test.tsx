import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionsView } from "../../app/components/command-center/CommandViews";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import type { SessionCacheTiming, SessionSummary } from "../../shared/monitor-contract";

const NOW = Date.parse("2026-08-29T12:10:00.000Z");

function minutesAgo(minutes: number) {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function session(id: string, cacheTiming: SessionCacheTiming | null, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: `claude:${id}`,
    provider: "claude",
    source: "Claude Code",
    title: `Session ${id}`,
    project: "Pomegr",
    updatedAt: minutesAgo(12),
    isLive: true,
    needsInput: false,
    activityStatus: "idle",
    summaryReadiness: "ready",
    agentCount: 1,
    activeAgentCount: 0,
    latestContextTotal: 8_000,
    progress: null,
    currentActivity: null,
    activityFallback: null,
    cacheTiming,
    ...overrides,
  };
}

function updatedCell(title: string) {
  const row = screen.getByRole("link", { name: title }).closest("tr")!;
  return within(row).getAllByRole("cell").find((cell) => cell.classList.contains("commandTableUpdated"))!;
}

describe("sessions page cache timing", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it("shows a coarse countdown while the primary agent's cache lifetime is nearing its threshold", () => {
    render(<SessionCatalogProvider sessions={[
      session("five", { lastCacheTouchAt: minutesAgo(4.5), cacheLifetime: "5m" }),
      session("hour", { lastCacheTouchAt: minutesAgo(57), cacheLifetime: "1h" }),
    ]}><SessionsView /></SessionCatalogProvider>);
    const five = within(updatedCell("Session five")).getByRole("button", { name: "Cache ~1m left for the primary agent; show cache timing" });
    expect(five).toHaveTextContent("");
    expect(five.querySelector("svg.commandIcon")).not.toBeNull();
    expect(five.closest(".commandSessionCacheTiming")).toHaveClass("cacheTimingNear");
    expect(within(updatedCell("Session hour")).getByRole("button", { name: /^Cache ~3m left/ })).toBeInTheDocument();
  });

  it("reports an elapsed lifetime, live or historical, without claiming the cache was dropped", () => {
    render(<SessionCatalogProvider sessions={[
      session("elapsed", { lastCacheTouchAt: minutesAgo(6), cacheLifetime: "5m" }, { isLive: false, activityStatus: "idle" }),
      session("old", { lastCacheTouchAt: minutesAgo(3 * 24 * 60), cacheLifetime: "1h" }, { isLive: false, activityStatus: "idle" }),
    ]}><SessionsView /></SessionCatalogProvider>);
    for (const title of ["Session elapsed", "Session old"]) {
      const trigger = within(updatedCell(title)).getByRole("button", { name: "Cache lifetime elapsed for the primary agent; show cache timing" });
      expect(trigger.closest(".commandSessionCacheTiming")).toHaveClass("cacheTimingElapsed");
      expect(trigger.closest(".commandSessionCacheTiming")).not.toHaveClass("cacheTimingNear");
      expect(trigger).toHaveTextContent("");
    }
  });

  it("stays silent for neutral, minimum-only, mixed, and missing evidence", () => {
    render(<SessionCatalogProvider sessions={[
      session("fresh", { lastCacheTouchAt: minutesAgo(1), cacheLifetime: "5m" }),
      session("minimum", { lastCacheTouchAt: minutesAgo(45), cacheLifetime: "30m+" }),
      session("mixed", { lastCacheTouchAt: minutesAgo(6), cacheLifetime: "mixed" }),
      session("unknown", { lastCacheTouchAt: minutesAgo(6), cacheLifetime: null }),
      session("missing", null),
      session("legacy", undefined as unknown as null),
    ]}><SessionsView /></SessionCatalogProvider>);
    expect(document.querySelector(".commandSessionCacheTiming")).toBeNull();
    expect(screen.queryByText(/Cache/)).toBeNull();
  });
});
