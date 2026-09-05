import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../shared/monitor-contract";
import { RequestSnapshotsPanel, monotonePath, snapshotEventKey } from "../../app/components/dashboard/RequestSnapshotsPanel";
import { agent } from "./dashboard-test-fixtures";

describe("request snapshots and cache evidence", () => {
  const childAgent: Agent = { ...agent, id: "child", parentId: "primary", label: "Builder", tokens: { ...agent.tokens, total: 5_000 } };
  const snapshots = [
    { id: "snapshot-write", agentId: "primary", observedAt: "2026-08-09T12:03:00.000Z", cacheLifetime: "1h" as const, uncachedInputTokens: 1_000, cacheWriteTokens: 146_282, cacheReadTokens: 0, outputTokens: 2_000, totalTokens: 149_282, precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null },
    { id: "snapshot-read", agentId: "primary", observedAt: "2026-08-09T12:04:00.000Z", cacheLifetime: null, uncachedInputTokens: 1_000, cacheWriteTokens: 759, cacheReadTokens: 146_282, outputTokens: 2_000, totalTokens: 150_041, precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null },
    { id: "snapshot-child", agentId: "child", observedAt: "2026-08-09T12:05:00.000Z", cacheLifetime: null, uncachedInputTokens: 4_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1_000, totalTokens: 5_000, precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null },
  ];
  const cacheEvent = (index: number) => ({
    id: `cache-${index}`,
    agentId: "primary",
    kind: index === 0 ? "miss_refill" as const : index === 1 ? "reuse" as const : "refill" as const,
    observedAt: index === 1
      ? "2026-08-09T08:04:00.000-04:00"
      : new Date(Date.parse("2026-08-09T12:03:00.000Z") + index * 60_000).toISOString(),
    promptInputTokens: 147_282 + index,
    cacheReadPercent: index === 0 ? 5 : 90,
    cacheWriteTokens: index === 0 ? 146_282 : index === 1 ? 759 : 8_500,
    previousCacheReadPercent: index === 0 ? 90 : null,
    gapMs: index <= 1 ? 30 * 60_000 : null,
    relatedEventId: index === 1 ? "cache-0" : null,
  });
  const requestSnapshots = { status: "ready" as const, items: snapshots };
  const cacheEvents = {
    status: "ready" as const,
    items: Array.from({ length: 7 }, (_, index) => cacheEvent(index)),
    possibleFullRefills: [{ agentId: "primary", count: 1, occurrences: [{ observedAt: "2026-08-09T12:03:00.000Z", reason: null, providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null }], reasons: [], toolChangeAttributions: [] }],
  };

  it("canonicalizes equivalent timestamp offsets and rejects invalid join keys", () => {
    expect(snapshotEventKey("primary", "2026-08-09T08:04:00.000-04:00")).toBe(
      snapshotEventKey("primary", "2026-08-09T12:04:00.000Z"),
    );
    expect(snapshotEventKey("primary", "not-a-timestamp")).toBeNull();
    expect(snapshotEventKey("primary", "not-a-timestamp")).not.toBe(
      snapshotEventKey("primary", "2026-08-09T12:04:00.000Z"),
    );
  });

  it("keeps monotone request curves inside each pair of recorded values", () => {
    const recorded = [120, 10, 115, 15];
    const path = monotonePath(recorded.map((y, index) => ({ x: index * 100, y })));
    const segments = [...path.matchAll(/C [-\d.]+ ([-\d.]+), [-\d.]+ ([-\d.]+), [-\d.]+ ([-\d.]+)/g)];

    expect(segments).toHaveLength(recorded.length - 1);
    segments.forEach((segment, index) => {
      const lower = Math.min(recorded[index], recorded[index + 1]);
      const upper = Math.max(recorded[index], recorded[index + 1]);
      expect(Number(segment[1])).toBeGreaterThanOrEqual(lower);
      expect(Number(segment[1])).toBeLessThanOrEqual(upper);
      expect(Number(segment[2])).toBeGreaterThanOrEqual(lower);
      expect(Number(segment[2])).toBeLessThanOrEqual(upper);
      expect(Number(segment[3])).toBe(recorded[index + 1]);
    });
  });

  it("renders independent equal-spaced request waves with exact non-cumulative values and a fixed scale", async () => {
    const user = userEvent.setup();
    const { container } = render(<RequestSnapshotsPanel agents={[agent, childAgent]} requestSnapshots={requestSnapshots} cacheEvents={cacheEvents} cacheWriteAvailable historical={false} />);

    expect(screen.getByText("Each point is one provider usage snapshot. Equal spacing; curves only connect recorded points. Not cumulative.")).toBeInTheDocument();
    expect(container.querySelectorAll(".contextArea")).toHaveLength(4);
    expect(container.querySelectorAll(".contextSeriesLine")).toHaveLength(4);
    for (const line of container.querySelectorAll(".contextSeriesLine")) {
      expect(line.getAttribute("d")).toContain(" C ");
      expect(line.getAttribute("d")).not.toContain("NaN");
    }
    expect(container.querySelectorAll(".requestSnapshotPointColumn")).toHaveLength(2);
    expect(container.querySelectorAll(".contextChartPoint")).toHaveLength(8);
    expect(container.querySelector(".requestSnapshotBar")).not.toBeInTheDocument();
    expect(container.querySelector(".requestSnapshotStack")).not.toBeInTheDocument();
    expect(container.querySelector(".requestSnapshotScale span")).toHaveTextContent("200K");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("150,041 total");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("146,282");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("759");
    expect(container.querySelector(".requestSnapshotLegend")).toHaveTextContent("Uncached inputCache writeCache readOutput");
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    const cacheReadSwitch = screen.getByRole("switch", { name: "Cache read" });
    expect(cacheReadSwitch).toHaveAttribute("aria-checked", "true");
    cacheReadSwitch.focus();
    await user.keyboard(" ");
    expect(cacheReadSwitch).toHaveAttribute("aria-checked", "false");
    expect(container.querySelector(".cacheReadLine")).toHaveClass("isHidden");
    expect(container.querySelectorAll(".cacheReadChartPoint.isHidden")).toHaveLength(2);
    expect(container.querySelector(".requestSnapshotScale span")).toHaveTextContent("200K");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("146,282");
    await user.click(screen.getByRole("switch", { name: "Uncached input" }));
    await user.click(screen.getByRole("switch", { name: "Cache write" }));
    await user.click(screen.getByRole("switch", { name: "Output" }));
    expect(screen.getByText("All series hidden. Use the legend to show a metric.")).toBeInTheDocument();
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("150,041 total");

    await user.selectOptions(screen.getByLabelText("Request scope"), "child");
    expect(container.querySelectorAll(".requestSnapshotPointColumn")).toHaveLength(1);
    expect(container.querySelectorAll(".contextChartPoint")).toHaveLength(4);
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("Builder");
    expect(container.querySelector(".requestSnapshotReadout")).toHaveTextContent("5,000 total");
    expect(container.querySelector(".requestSnapshotScale span")).toHaveTextContent("200K");

    await user.selectOptions(screen.getByLabelText("Request scope"), "all-agents");
    expect(container.querySelectorAll(".requestSnapshotPointColumn")).toHaveLength(3);
    expect(container.querySelectorAll(".contextChartPoint")).toHaveLength(12);
  });

  it("links chart inspection and exact agent-timestamp cache evidence in both directions", async () => {
    const user = userEvent.setup();
    const { container } = render(<RequestSnapshotsPanel agents={[agent, childAgent]} requestSnapshots={requestSnapshots} cacheEvents={cacheEvents} cacheWriteAvailable historical={false} />);
    const chart = screen.getByRole("group", { name: /Primary agent request snapshots/ });

    expect(chart).toHaveAttribute("tabindex", "0");
    expect(container.querySelectorAll('.requestSnapshotChart [tabindex="0"]')).toHaveLength(0);
    expect(container.querySelector(".requestSnapshotEventMarker")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show 2 earlier events" }));
    const missRow = screen.getByRole("button", { name: /Locate Possible cache miss/ });
    const reuseRow = screen.getByRole("button", { name: /Locate Cache reuse/ });
    expect(reuseRow).toHaveClass("active");
    expect(missRow).not.toHaveClass("active");

    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({ left: 0, right: 200, top: 0, bottom: 156, width: 200, height: 156, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(chart, { clientX: 0 });
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("146,282 cache write, 0 cache read");
    expect(missRow).toHaveClass("active");
    expect(reuseRow).not.toHaveClass("active");
    fireEvent.pointerMove(chart, { clientX: 200 });
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("759 cache write, 146,282 cache read");
    expect(reuseRow).toHaveClass("active");

    fireEvent.pointerEnter(missRow);
    expect(container.querySelector('[data-snapshot-id="snapshot-write"]')).toHaveClass("active");
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent(/Possible cache miss.*refill/);
    fireEvent.pointerLeave(missRow);
    expect(container.querySelector('[data-snapshot-id="snapshot-read"]')).toHaveClass("active");

    fireEvent.focus(missRow);
    fireEvent.keyDown(missRow, { key: "Enter" });
    fireEvent.blur(missRow);
    expect(missRow).toHaveAttribute("aria-pressed", "true");
    expect(missRow).toHaveClass("active");
    expect(container.querySelector('[data-snapshot-id="snapshot-write"]')).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Latest" })).toBeInTheDocument();

    fireEvent.pointerMove(chart, { clientX: 200 });
    fireEvent.click(chart, { clientX: 200 });
    fireEvent.pointerLeave(chart);
    expect(reuseRow).toHaveAttribute("aria-pressed", "true");
    expect(reuseRow).toHaveClass("active");
    expect(screen.queryByRole("button", { name: "Latest" })).not.toBeInTheDocument();

    fireEvent.keyDown(chart, { key: "Home" });
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("146,282 cache write, 0 cache read");
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("Possible cache miss · refill");
    expect(screen.getByRole("button", { name: "Latest" })).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "End" });
    expect(container.querySelector(".instrumentAnnouncement")).toHaveTextContent("759 cache write, 146,282 cache read");
    expect(screen.queryByRole("button", { name: "Latest" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Request scope"), "all-agents");
    expect(container.querySelectorAll(".requestSnapshotPointColumn")).toHaveLength(3);
    expect(container.querySelector(".requestSnapshotEventMarker")).not.toBeInTheDocument();
  });

  it("keeps cache evidence rows compact without repeating chart values", async () => {
    const user = userEvent.setup();
    render(<RequestSnapshotsPanel agents={[agent, childAgent]} requestSnapshots={requestSnapshots} cacheEvents={cacheEvents} cacheWriteAvailable historical={false} />);

    const list = screen.getByRole("list");
    expect(screen.getByRole("heading", { name: "Cache evidence" })).toBeInTheDocument();
    expect(screen.getByText("Transitions from provider-reported token counts. Not cost.")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: "Show 2 earlier events" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    const evidenceRows = within(list).getAllByRole("button");
    expect(evidenceRows[0]).toHaveTextContent("5% read");
    expect(evidenceRows[1]).toHaveTextContent("90% read");
    expect(list.querySelector("time")).not.toBeInTheDocument();
    expect(within(list).queryByText("Cache read")).not.toBeInTheDocument();
    expect(within(list).queryByText("Cache write")).not.toBeInTheDocument();
    expect(within(list).queryByText("Prompt input")).not.toBeInTheDocument();
    expect(within(list).queryByText(/Pomegr/)).not.toBeInTheDocument();
    expect(within(list).queryByText(/large cache/i)).not.toBeInTheDocument();
    expect(within(list).queryByText("Primary agent")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show recent 5" })).toHaveAttribute("aria-expanded", "true");

    await user.selectOptions(screen.getByLabelText("Request scope"), "all-agents");
    expect(within(screen.getByRole("list")).getAllByText("Primary agent").length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByLabelText("Request scope"), "child");
    expect(screen.getByText("Watching for meaningful cache transitions for Builder…")).toBeInTheDocument();
  });

  it("omits unsupported cache-write metrics and classifications for Codex", () => {
    const { container } = render(<RequestSnapshotsPanel
      agents={[agent, childAgent]}
      requestSnapshots={requestSnapshots}
      cacheEvents={cacheEvents}
      cacheWriteAvailable={false}
      historical={false}
    />);

    expect(container.querySelectorAll(".contextSeriesLine")).toHaveLength(3);
    expect(container.querySelectorAll(".contextChartPoint")).toHaveLength(6);
    expect(container.querySelector(".requestSnapshotLegend")).toHaveTextContent("Uncached inputCache readOutput");
    expect(screen.queryByRole("switch", { name: "Cache write" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cache evidence" })).not.toBeInTheDocument();
    expect(container.querySelector(".instrumentAnnouncement")).not.toHaveTextContent("cache write");
  });

  it("uses factual request and cache empty states in live and recorded views", () => {
    const emptySnapshots = { status: "unavailable" as const, items: [] };
    const emptyEvents = { status: "unavailable" as const, items: [], possibleFullRefills: [] };
    const { rerender } = render(<RequestSnapshotsPanel agents={[agent]} requestSnapshots={emptySnapshots} cacheEvents={emptyEvents} cacheWriteAvailable historical={false} />);
    expect(screen.getByText("Independent request snapshots are not available yet for this session.")).toBeInTheDocument();
    expect(screen.getByText("Comparable cache snapshots are not available yet for this session.")).toBeInTheDocument();

    rerender(<RequestSnapshotsPanel agents={[agent]} requestSnapshots={emptySnapshots} cacheEvents={emptyEvents} cacheWriteAvailable historical />);
    expect(screen.getByText("No independent request snapshots were recorded for this session.")).toBeInTheDocument();
    expect(screen.getByText("No comparable cache snapshots were recorded for this session.")).toBeInTheDocument();
  });
});
