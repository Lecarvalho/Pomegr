import { describe, expect, it } from "vitest";
import type { ContextHistoryBoundary, RequestSnapshot, RequestSnapshotFeed } from "../../shared/monitor-contract";
import { largestRequests, scaleMax, scopedRows, windowFor } from "../../app/components/dashboard/requests-actions/model";

function request(
  id: string,
  agentId: string,
  observedAt: string,
  overrides: Partial<RequestSnapshot> = {},
): RequestSnapshot {
  const snapshot: RequestSnapshot = {
    id,
    agentId,
    observedAt,
    cacheLifetime: "5m",
    uncachedInputTokens: 100,
    cacheWriteTokens: 20,
    cacheReadTokens: 30,
    outputTokens: 40,
    totalTokens: 190,
    precedingWork: [],
    precedingAssociation: null,
    issuedWork: [],
    issuedAssociation: null,
    ...overrides,
  };
  return snapshot;
}

function feed(items: RequestSnapshot[], status: RequestSnapshotFeed["status"] = "ready"): RequestSnapshotFeed {
  return { status, items };
}

function boundary(agentId: string, timestamp: string, kind: ContextHistoryBoundary["kind"] = "automatic_compaction"): ContextHistoryBoundary {
  return { id: `${agentId}-${timestamp}-${kind}`, agentId, timestamp, kind, preTokens: null };
}

function rows(count: number) {
  return scopedRows(feed(Array.from({ length: count }, (_, index) => request(
    `request-${index + 1}`,
    "primary",
    `2026-08-01T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    { uncachedInputTokens: index + 1, totalTokens: index + 191 },
  ))), [], "all");
}

describe("requests and actions model", () => {
  it("assigns scoped ordinals and derives prompt and fresh token sizes", () => {
    const result = scopedRows(feed([
      request("one", "primary", "2026-08-01T12:00:00.000Z"),
      request("two", "child", "2026-08-01T12:01:00.000Z"),
      request("three", "primary", "2026-08-01T12:02:00.000Z", { outputTokens: 50 }),
    ]), [], "primary");

    expect(result.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(result[0]).toMatchObject({ id: "one", promptTokens: 150, freshTokens: 160, compactionBefore: false });
    expect(result[1]).toMatchObject({ id: "three", promptTokens: 150, freshTokens: 170, compactionBefore: false });
  });

  it("matches compactions to the prior scoped row for the same agent", () => {
    const result = scopedRows(feed([
      request("primary-1", "primary", "2026-08-01T12:00:00.000Z"),
      request("child-1", "child", "2026-08-01T12:01:00.000Z"),
      request("primary-2", "primary", "2026-08-01T12:02:00.000Z"),
      request("child-2", "child", "2026-08-01T12:03:00.000Z"),
    ]), [
      boundary("primary", "2026-08-01T12:01:30.000Z"),
      boundary("child", "2026-08-01T12:02:00.000Z", "manual_compaction"),
      boundary("child", "2026-08-01T12:02:30.000Z", "snapshot_drop"),
    ], "all");

    expect(result.map((row) => row.compactionBefore)).toEqual([false, false, true, true]);
  });

  it("returns an empty range and clamps desktop and phone windows at both edges", () => {
    expect(windowFor([], null, 20)).toEqual({ start: 1, end: 0 });
    const result = rows(100);
    expect(windowFor(result, 2, 60)).toEqual({ start: 1, end: 60 });
    expect(windowFor(result, 99, 60)).toEqual({ start: 41, end: 100 });
    expect(windowFor(result, 3, 20)).toEqual({ start: 1, end: 20 });
    expect(windowFor(result, 99, 20)).toEqual({ start: 81, end: 100 });
  });

  it("uses readable upward rounding and includes every plotted segment", () => {
    const result = scopedRows(feed([
      request("small", "primary", "2026-08-01T12:00:00.000Z", {
        uncachedInputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 200,
        totalTokens: 300,
      }),
      request("large", "primary", "2026-08-01T12:01:00.000Z", {
        uncachedInputTokens: 1_000,
        cacheWriteTokens: 200,
        cacheReadTokens: 100,
        outputTokens: 50,
        totalTokens: 1_350,
      }),
    ]), [], "all");

    expect(scaleMax(result, "fresh")).toBe(1_500);
    expect(scaleMax(result, "full")).toBe(1_500);
    expect(scaleMax(scopedRows(feed([request("output", "primary", "2026-08-01T12:00:00.000Z", {
      uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 200, totalTokens: 300,
    })]), [], "all"), "fresh")).toBe(300);
    expect(scaleMax([], "fresh")).toBe(0);
  });

  it("sorts largest requests descending with stable ordinal tie breaks", () => {
    const result = scopedRows(feed([
      request("first", "primary", "2026-08-01T12:00:00.000Z", { uncachedInputTokens: 200, outputTokens: 4 }),
      request("second", "primary", "2026-08-01T12:01:00.000Z", { uncachedInputTokens: 500, outputTokens: 4 }),
      request("third", "primary", "2026-08-01T12:02:00.000Z", { uncachedInputTokens: 500, outputTokens: 9 }),
    ]), [], "all");

    expect(largestRequests(result, "uncachedInput", 3).map((row) => row.id)).toEqual(["second", "third", "first"]);
    expect(largestRequests(result, "output", 2).map((row) => row.id)).toEqual(["third", "first"]);
    expect(largestRequests(result, "uncachedInput", 0)).toEqual([]);
  });

  it("handles a large retained feed without losing ordinals or rows", () => {
    const result = rows(1_000);
    expect(result).toHaveLength(1_000);
    expect(result[0].ordinal).toBe(1);
    expect(result.at(-1)?.ordinal).toBe(1_000);
    expect(largestRequests(result, "uncachedInput", 20)).toHaveLength(20);
  });

  it("does not project unavailable observations", () => {
    expect(scopedRows(feed([request("hidden", "primary", "2026-08-01T12:00:00.000Z")], "unavailable"), [], "all")).toEqual([]);
  });
});
