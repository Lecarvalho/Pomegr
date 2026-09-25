// Presentation-only formatting for FileHistoryPanel.tsx. No fetching.
import type { ProviderSource } from "../../../shared/monitor-contract";
import type { FileHistoryProvider } from "../../../shared/repository-files-contract";
import { sessionListTime, timelineTime } from "../../dashboard-utils";

/** Repository-files provider identities are lowercase; evidence chips use the display source. */
export function providerSourceLabel(provider: FileHistoryProvider | null): ProviderSource | null {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  return null;
}

function startOfLocalDay(milliseconds: number): number {
  const date = new Date(milliseconds);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Day-relative, minute-precision entry timestamp (F11): "Today, 14:02", "Yesterday, 16:18",
 * else the shared month/day/time format ("Sep 6, 09:31").
 */
export function sessionTimeLabel(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const dayDiff = Math.round((startOfLocalDay(now) - startOfLocalDay(timestamp)) / 86_400_000);
  if (dayDiff === 0) return `Today, ${timelineTime(value)}`;
  if (dayDiff === 1) return `Yesterday, ${timelineTime(value)}`;
  return sessionListTime(value);
}
