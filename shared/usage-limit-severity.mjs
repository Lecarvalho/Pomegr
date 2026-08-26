export function clampUsageLimitPercent(value) {
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

export function usageLimitSeverity(value) {
  const percent = clampUsageLimitPercent(value);
  if (percent >= 85) return "critical";
  if (percent >= 75) return "warning";
  return "normal";
}
