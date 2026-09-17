/**
 * Pure viewport/selection rules shared by the request chart, request details and the grouped
 * Activities feed. Indexes and offsets are 0-based absolute positions within the scoped history.
 */

/**
 * follow: the latest request is selected and the viewport shows the latest window.
 * track: another request is selected while the viewport stays at the latest edge.
 * anchored: the viewport is not at the latest edge; appends never move it.
 */
export type SelectionMode = "follow" | "track" | "anchored";

function latestOffset(total: number, size: number) {
  return Math.max(0, total - size);
}

/**
 * Apply history growth without pushing the selected bar out of the viewport.
 * `offset: null` keeps the current viewport offset.
 */
export function advanceOnGrowth({ total, size, selectedIndex, mode }: {
  total: number; size: number; selectedIndex: number; mode: SelectionMode;
}): { mode: SelectionMode; offset: number | null; selectedIndex: number } {
  const latest = latestOffset(total, size);
  if (mode === "follow") return { mode, offset: latest, selectedIndex: Math.max(0, total - 1) };
  if (mode === "anchored") return { mode, offset: null, selectedIndex };
  // Advancing further would push the selection out: anchor it at the left edge instead.
  if (latest > selectedIndex) return { mode: "anchored", offset: selectedIndex, selectedIndex };
  return { mode: "track", offset: latest, selectedIndex };
}

/** Keep a visible selection; otherwise transfer it to the nearest visible bar. */
export function transferOnViewportMove({ selectedIndex, offset, size }: { selectedIndex: number; offset: number; size: number }): number {
  // The window moved right (newer): the left-edge bar is nearest.
  if (selectedIndex < offset) return offset;
  // The window moved left (older): the right-edge bar is nearest.
  if (selectedIndex >= offset + size) return offset + size - 1;
  return selectedIndex;
}

/**
 * Clamp a keyboard or range step. `offset` is null while the target stays inside the viewport;
 * otherwise it is the new viewport offset (backward: target at the right edge; forward: target at
 * the left edge, capped at the latest window).
 */
export function stepTarget({ selectedIndex, delta, total, offset, size }: {
  selectedIndex: number; delta: number; total: number; offset: number; size: number;
}): { index: number; offset: number | null } {
  const index = Math.max(0, Math.min(Math.max(0, total - 1), selectedIndex + delta));
  if (index >= offset && index < offset + size) return { index, offset: null };
  if (index < offset) return { index, offset: Math.max(0, index - size + 1) };
  return { index, offset: Math.min(index, latestOffset(total, size)) };
}

/** Derive the mode of a committed selection; only an explicit latest selection follows. */
export function modeFor({ selectedIndex, offset, size, total, explicitLatest }: {
  selectedIndex: number; offset: number; size: number; total: number; explicitLatest: boolean;
}): SelectionMode {
  if (offset + size < total) return "anchored";
  return explicitLatest && selectedIndex >= total - 1 ? "follow" : "track";
}

/** A selected request by opaque id and absolute scoped index. */
export type SelectedRequest = { id: string; index: number };

/** What a committed page was fetched for: an explicit transfer/step/jump, a lookup, or a verified refresh. */
export type CommitTarget = {
  select?: number | "latest";
  requestId?: string;
  /** Present only for user or route lookups; a pinned lookup never follows appends. */
  pin?: boolean;
  keep?: SelectedRequest;
  /** An absent lookup target resolves to the newest request of the page. */
  absentToLatest?: boolean;
};

/**
 * The selection a committed request page produces, computed when the page commits so a queued
 * refresh never reads the mode of the previous page. Explicit targets win, then a verified or
 * retained selection, else the newest request of the page (the chart's own fallback).
 */
export function selectionAfterCommit({ ids, offset, total, size, historical, target, previous }: {
  ids: string[]; offset: number; total: number; size: number; historical: boolean; target: CommitTarget;
  previous: { mode: SelectionMode; keep: SelectedRequest | null };
}): { mode: SelectionMode; keep: SelectedRequest | null; offset: number } {
  const at = (index: number): SelectedRequest | null => index >= offset && index < offset + ids.length ? { id: ids[index - offset], index } : null;
  const newest = ids.length ? at(offset + ids.length - 1) : null;
  const located = target.requestId ? ids.indexOf(target.requestId) : -1;
  let keep: SelectedRequest | null = null;
  let explicitLatest = true;
  if (target.select === "latest") keep = newest;
  else if (typeof target.select === "number") keep = at(target.select);
  else if (target.requestId && located >= 0) {
    keep = { id: target.requestId, index: offset + located };
    explicitLatest = target.pin === undefined ? previous.mode === "follow" : !target.pin;
  } else if (target.requestId && target.absentToLatest) keep = newest;
  else if (target.keep && at(target.keep.index)?.id === target.keep.id) {
    keep = target.keep;
    explicitLatest = previous.mode === "follow";
  }
  if (!keep) {
    const retained = previous.mode === "follow" || !previous.keep ? -1 : ids.indexOf(previous.keep.id);
    if (retained >= 0 && previous.keep) {
      keep = { id: previous.keep.id, index: offset + retained };
      explicitLatest = false;
    } else keep = newest;
  }
  if (!keep) return { mode: "follow", keep: null, offset };
  const mode = modeFor({ selectedIndex: keep.index, offset, size, total, explicitLatest: historical ? keep.index >= total - 1 : explicitLatest });
  return { mode, keep, offset };
}
