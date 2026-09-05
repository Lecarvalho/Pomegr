import type { ContextHistoryBoundary, RequestSnapshot, RequestSnapshotFeed } from "../../../../shared/monitor-contract";

export type RequestScope = "all" | string;
export type ChartMode = "fresh" | "full";
export type LargestSort = "uncachedInput" | "output" | "cacheWrite" | "total";

export type RequestRow = RequestSnapshot & {
  /** 1-based position in the retained feed after applying the selected scope. */
  ordinal: number;
  /** The prompt represented by the bar outline. */
  promptTokens: number;
  /** The stacked fresh-token segments in the default chart mode. */
  freshTokens: number;
  /** Whether a recognized compaction occurred after the prior same-agent row. */
  compactionBefore: boolean;
};

const NICE_STEPS = [1.2, 1.5, 2, 3, 4.5, 6, 8] as const;

function timestampValue(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function hasCompactionBetween(
  boundaries: ContextHistoryBoundary[],
  agentId: string,
  previousObservedAt: string | undefined,
  observedAt: string,
): boolean {
  if (!previousObservedAt) return false;
  const previous = timestampValue(previousObservedAt);
  const current = timestampValue(observedAt);
  if (previous === null || current === null || current < previous) return false;

  return boundaries.some((boundary) => {
    if (boundary.agentId !== agentId || boundary.kind === "snapshot_drop") return false;
    const timestamp = timestampValue(boundary.timestamp);
    return timestamp !== null && timestamp > previous && timestamp <= current;
  });
}

/**
 * Projects the retained request feed into the rows consumed by the chart.
 * The monitor feed is chronological, so filtering preserves chronology and
 * ordinals remain stable positions in that retained feed.
 */
export function scopedRows(
  feed: RequestSnapshotFeed,
  boundaries: ContextHistoryBoundary[],
  scope: RequestScope,
): RequestRow[] {
  if (feed.status !== "ready") return [];

  const rows: RequestRow[] = [];
  const previousByAgent = new Map<string, RequestSnapshot>();
  for (const snapshot of feed.items) {
    if (scope !== "all" && snapshot.agentId !== scope) continue;

    const previous = previousByAgent.get(snapshot.agentId);
    rows.push({
      ...snapshot,
      // A monitor running across an app update may still serve the older feed.
      precedingWork: snapshot.precedingWork ?? [],
      precedingAssociation: snapshot.precedingAssociation ?? null,
      issuedWork: snapshot.issuedWork ?? [],
      issuedAssociation: snapshot.issuedAssociation ?? null,
      ordinal: rows.length + 1,
      promptTokens: snapshot.uncachedInputTokens + snapshot.cacheWriteTokens + snapshot.cacheReadTokens,
      freshTokens: snapshot.uncachedInputTokens + snapshot.cacheWriteTokens + snapshot.outputTokens,
      compactionBefore: hasCompactionBetween(boundaries, snapshot.agentId, previous?.observedAt, snapshot.observedAt),
    });
    previousByAgent.set(snapshot.agentId, snapshot);
  }
  return rows;
}

/** Returns a 1-based inclusive window, with an empty range for no rows. */
export function windowFor(
  rows: RequestRow[],
  selectedOrdinal: number | null,
  size = 60,
): { start: number; end: number } {
  if (rows.length === 0) return { start: 1, end: 0 };

  const requestedSize = Number.isFinite(size) ? Math.floor(size) : 60;
  const windowSize = Math.max(1, Math.min(rows.length, requestedSize));
  const selected = selectedOrdinal === null || !Number.isFinite(selectedOrdinal)
    ? rows.length
    : Math.max(1, Math.min(rows.length, Math.floor(selectedOrdinal)));
  const centeredStart = selected - Math.floor(windowSize / 2);
  const start = Math.max(1, Math.min(centeredStart, rows.length - windowSize + 1));
  return { start, end: start + windowSize - 1 };
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function plottedTotal(row: RequestRow, mode: ChartMode): number {
  if (mode === "full") {
    return nonNegativeFinite(
      row.uncachedInputTokens + row.cacheWriteTokens + row.cacheReadTokens + row.outputTokens,
    );
  }
  // Fresh mode still draws the prompt outline, so include both the outline
  // and the visible stack when choosing the fixed scale.
  return Math.max(nonNegativeFinite(row.promptTokens), nonNegativeFinite(row.freshTokens));
}

/** Computes a fixed, readable scale over the complete scoped feed. */
export function scaleMax(rows: RequestRow[], mode: ChartMode): number {
  const maximum = rows.reduce((current, row) => Math.max(current, plottedTotal(row, mode)), 0);
  if (maximum === 0) return 0;

  const exponent = Math.floor(Math.log10(maximum));
  const magnitude = 10 ** exponent;
  const normalized = maximum / magnitude;
  const step = NICE_STEPS.find((candidate) => normalized <= candidate * (1 + Number.EPSILON * 8));
  return (step ?? 1.2) * (step ? magnitude : magnitude * 10);
}

function sortValue(row: RequestRow, sort: LargestSort): number {
  switch (sort) {
    case "output": return nonNegativeFinite(row.outputTokens);
    case "cacheWrite": return nonNegativeFinite(row.cacheWriteTokens);
    case "total": return nonNegativeFinite(row.totalTokens);
    case "uncachedInput":
    default: return nonNegativeFinite(row.uncachedInputTokens);
  }
}

/** Returns the largest individual rows, preserving ordinal order for ties. */
export function largestRequests(rows: RequestRow[], sort: LargestSort, limit: number): RequestRow[] {
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (count === 0) return [];
  return rows
    .slice()
    .sort((left, right) => sortValue(right, sort) - sortValue(left, sort) || left.ordinal - right.ordinal)
    .slice(0, count);
}

export function snapshotEventKey(agentId: string, observedAt: string) {
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) return null;
  return `${agentId}\u0000${new Date(timestamp).toISOString()}`;
}
