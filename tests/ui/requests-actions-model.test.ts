import { describe, expect, it } from "vitest";
import type { CacheEvent, CacheEventFeed, CacheReadDropFeed, ContextHistoryBoundary, RequestSnapshot, RequestSnapshotFeed } from "../../shared/monitor-contract";
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

function cacheEvent(id: string, agentId: string, observedAt: string, kind: CacheEvent["kind"] = "refill", overrides: Partial<CacheEvent> = {}): CacheEvent {
  return {
    id,
    agentId,
    kind,
    observedAt,
    promptInputTokens: 500,
    cacheReadPercent: 5,
    cacheWriteTokens: 500,
    previousCacheReadPercent: 90,
    gapMs: 1_000,
    relatedEventId: null,
    ...overrides,
  };
}

function cacheFeed(items: CacheEvent[], possibleFullRefills: CacheEventFeed["possibleFullRefills"] = [], status: CacheEventFeed["status"] = "ready"): CacheEventFeed {
  return { status, items, possibleFullRefills };
}

function fullRefill(agentId: string, observedAt: string): CacheEventFeed["possibleFullRefills"] {
  return [{ agentId, count: 1, occurrences: [{ observedAt, reason: null, providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null }], reasons: [], toolChangeAttributions: [] }];
}

function readDropFeed(agentId: string, observedAt: string, status: CacheReadDropFeed["status"] = "ready"): CacheReadDropFeed {
  return { status, items: [{ agentId, count: 1, occurrences: [{ id: "drop-1", observedAt, previousCacheReadPercent: 90, cacheReadPercent: 5, gapMs: 1_000 }] }] };
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

  it("excludes cached input from the fresh scale while retaining full prompt values", () => {
    const result = scopedRows(feed([request("cached", "primary", "2026-08-01T12:00:00Z", {
      uncachedInputTokens: 2_000, cacheWriteTokens: 500, cacheReadTokens: 90_000,
      outputTokens: 500, totalTokens: 93_000,
    })]), [], "all");
    expect(scaleMax(result, "fresh")).toBe(3_000);
    expect(scaleMax(result, "full")).toBe(120_000);
    expect(result[0].promptTokens).toBe(92_500);

    const cachedOnly = scopedRows(feed([request("cached-only", "primary", "2026-08-01T12:00:00Z", {
      uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 90_000,
      outputTokens: 0, totalTokens: 90_000,
    })]), [], "all");
    expect(scaleMax(cachedOnly, "fresh")).toBe(0);
    expect(scaleMax(cachedOnly, "full")).toBe(120_000);
  });

  it("fits only supported token categories when cache-write presentation is unavailable", () => {
    const result = scopedRows(feed([request("hidden-write", "primary", "2026-08-01T12:00:00Z", {
      uncachedInputTokens: 2_000, cacheWriteTokens: 90_000, cacheReadTokens: 1_000,
      outputTokens: 1_000, totalTokens: 94_000,
    })]), [], "all");
    expect(scaleMax(result, "fresh", false)).toBe(3_000);
    expect(scaleMax(result, "full", false)).toBe(4_500);
    expect(result[0].promptTokens).toBe(93_000);
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


  it("does not mark ordinary cache growth, initial creation, or unqualified detail events", () => {
    const requests = [
      request("growth", "primary", "2026-08-01T12:00:00Z", { cacheWriteTokens: 8222, cacheReadTokens: 82535 }),
      request("initial", "child", "2026-08-01T12:01:00Z", { cacheWriteTokens: 40415, cacheReadTokens: 0 }),
      request("detail-only", "primary", "2026-08-01T12:02:00Z", { cacheWriteTokens: 40000, cacheReadTokens: 0 }),
    ];
    const events = requests.map((row, i) => cacheEvent("event-" + i, row.agentId, row.observedAt, i === 2 ? "miss_refill" : "refill", { cacheWriteTokens: row.cacheWriteTokens }));
    const result = scopedRows(feed(requests), [], "all", cacheFeed(events));
    expect(result.every((row) => row.cacheEvidence === undefined)).toBe(true);
    expect(result.map((row) => row.cacheWriteTokens)).toEqual([8222, 40415, 40000]);
  });

  it("joins recorded refill evidence by normalized agent and timestamp", () => {
    const observedAt = "2026-08-01T12:00:00.000Z";
    const result = scopedRows(feed([request("one", "primary", observedAt)]), [], "all", cacheFeed([
      cacheEvent("refill-1", "primary", "2026-08-01T08:00:00.000-04:00"),
    ], fullRefill("primary", observedAt)));

    expect(result[0].cacheEvidence).toMatchObject({ kind: "refill", event: { id: "refill-1" } });
  });

  it("keeps scopes isolated, ignores reuse and skips ambiguous evidence timestamps", () => {
    const observedAt = "2026-08-01T12:00:00.000Z";
    const result = scopedRows(feed([
      request("primary", "primary", observedAt),
      request("child", "child", observedAt),
    ]), [], "primary", cacheFeed([
      cacheEvent("reuse", "primary", observedAt, "reuse"),
      cacheEvent("ambiguous-a", "primary", observedAt),
      cacheEvent("ambiguous-b", "primary", observedAt),
      cacheEvent("child-refill", "child", observedAt),
    ], [...fullRefill("primary", observedAt), ...fullRefill("child", observedAt)]));

    expect(result).toHaveLength(1);
    expect(result[0].cacheEvidence).toBeUndefined();
  });

  it("prefers recorded refill evidence over a read-drop and ignores unavailable feeds", () => {
    const observedAt = "2026-08-01T12:00:00.000Z";
    const event = cacheEvent("refill-1", "primary", observedAt);
    const result = scopedRows(feed([request("one", "primary", observedAt)]), [], "all", cacheFeed([event], fullRefill("primary", observedAt)), readDropFeed("primary", observedAt));
    expect(result[0].cacheEvidence).toMatchObject({ kind: "refill", event });

    expect(scopedRows(feed([request("two", "primary", observedAt)]), [], "all", cacheFeed([], [], "unavailable"), readDropFeed("primary", observedAt, "unavailable"))[0].cacheEvidence).toBeUndefined();
  });

  it("retains possible-full-refill occurrences beyond the presentation detail cap", () => {
    const occurrences = Array.from({ length: 8 }, (_, index) => ({
      observedAt: new Date(Date.parse("2026-08-01T12:00:00.000Z") + index * 60_000).toISOString(),
      reason: null,
      providerStatus: "previous_cache_entry_unavailable" as const,
      cacheLifetimeInference: null,
      messageChangeSequence: null,
      toolChangeAttribution: null,
    }));
    const result = scopedRows(feed([request("last", "primary", occurrences[7].observedAt)]), [], "all", cacheFeed([], [{
      agentId: "primary", count: occurrences.length, occurrences, reasons: [], toolChangeAttributions: [],
    }]));

    expect(result[0].cacheEvidence).toMatchObject({ kind: "refill", occurrence: occurrences[7] });
  });

  it("joins a read-drop as an inferred possible refill", () => {
    const observedAt = "2026-08-01T12:00:00.000Z";
    const result = scopedRows(feed([request("one", "primary", observedAt)]), [], "all", undefined, readDropFeed("primary", observedAt));
    expect(result[0].cacheEvidence).toMatchObject({ kind: "possible_refill", readDrop: { id: "drop-1" } });
  });

  it("preserves a monitor-recorded model-change drop without classifying a refill", () => {
    const observedAt = "2026-08-01T12:00:00.000Z";
    const drops = readDropFeed("primary", observedAt);
    drops.items[0].occurrences[0].kind = "model_change";
    const result = scopedRows(feed([request("one", "primary", observedAt)]), [], "all", undefined, drops);
    expect(result[0].cacheEvidence).toMatchObject({ kind: "model_change", readDrop: { kind: "model_change" } });
    expect(scopedRows(feed([request("child", "child", observedAt)]), [], "all", undefined, drops)[0].cacheEvidence).toBeUndefined();
  });
});
