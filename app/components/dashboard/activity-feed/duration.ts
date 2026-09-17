/** Wall time from a call to its recorded result, compacted for feeds and kind medians. */
export function activityDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Number((value / 1_000).toFixed(1))}s`;
  if (value < 3_600_000) return `${Number((value / 60_000).toFixed(1))}m`;
  return `${Number((value / 3_600_000).toFixed(1))}h`;
}
