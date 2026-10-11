export type SelectionMode = "follow" | "track" | "anchored";

function latestOffset(total: number, size: number) {
  return Math.max(0, total - size);
}

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

export function transferOnViewportMove({ selectedIndex, offset, size }: { selectedIndex: number; offset: number; size: number }): number {
  if (selectedIndex < offset) return offset;
  if (selectedIndex >= offset + size) return offset + size - 1;
  return selectedIndex;
}

export function stepTarget({ selectedIndex, delta, total, offset, size }: {
  selectedIndex: number; delta: number; total: number; offset: number; size: number;
}): { index: number; offset: number | null } {
  const index = Math.max(0, Math.min(Math.max(0, total - 1), selectedIndex + delta));
  if (index >= offset && index < offset + size) return { index, offset: null };
  if (index < offset) return { index, offset: Math.max(0, index - size + 1) };
  return { index, offset: Math.min(index, latestOffset(total, size)) };
}

export function modeFor({ selectedIndex, offset, size, total, explicitLatest }: {
  selectedIndex: number; offset: number; size: number; total: number; explicitLatest: boolean;
}): SelectionMode {
  if (offset + size < total) return "anchored";
  return explicitLatest && selectedIndex >= total - 1 ? "follow" : "track";
}

export type SelectedRequest = { id: string; index: number };

export type CommitTarget = {
  select?: number | "latest";
  requestId?: string;
  pin?: boolean;
  keep?: SelectedRequest;
  absentToLatest?: boolean;
};

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
