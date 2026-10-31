import type { RepositoryProviderInventory, RepositorySummary } from "../../../shared/monitor-contract";
import { repositoryLastActivity, repositorySetupSummary } from "./repository-setup";

// The fixed rules behind a repository card: the setup badge and its fix line, the words of the activity line, the heights of the 14 bars, and the
// tint of the initial tile. Each reads the repository list entry and nothing else. [Repositories design](docs/internal/design/repositories.md) owns them.

export type SetupBadge = "Ready" | "Setup unverified" | "Reporting off";
export type SetupFix = { text: string; tab: "plugin" | "reporting" };
export type RepositorySetupCard = {
  badge: SetupBadge;
  /** The one word the whole card is named with: today's setup summary, which keeps the detail the badge folds away. */
  summary: string;
  tone: "positive" | "neutral" | "warning";
  /** What the owner can do about it, or null where nothing is asked of them. */
  fix: SetupFix | null;
};

// Today's setup summaries, mapped to the three badges the card draws. Only a summary that needs the owner, and the two that name something to
// confirm or configure, carry a fix line; "Checking setup" carries none, because it passes by itself and a line would appear and go.
const MAPPED: Record<string, Omit<RepositorySetupCard, "summary">> = {
  Ready: { badge: "Ready", tone: "positive", fix: null },
  "Plugin update available": { badge: "Ready", tone: "positive", fix: { text: "A newer Pomegr plugin is available here.", tab: "plugin" } },
  "Checking setup": { badge: "Setup unverified", tone: "neutral", fix: null },
  "Setup unverified": { badge: "Setup unverified", tone: "neutral", fix: { text: "Pomegr has not confirmed its plugin here yet.", tab: "plugin" } },
  "Plugin not installed": { badge: "Reporting off", tone: "warning", fix: { text: "The Pomegr plugin is not installed here, so agents do not report their state.", tab: "plugin" } },
  "Plugin disabled": { badge: "Reporting off", tone: "warning", fix: { text: "The Pomegr plugin is turned off here, so agents do not report their state.", tab: "plugin" } },
  "Reporting invalid": { badge: "Reporting off", tone: "warning", fix: { text: "The reporting policy here is not valid, so agents do not report their state.", tab: "reporting" } },
  "Reporting not configured": { badge: "Reporting off", tone: "warning", fix: { text: "Agents here do not report their state to Pomegr.", tab: "reporting" } },
};

export function repositorySetupCard(repository: RepositorySummary): RepositorySetupCard {
  const summary = repositorySetupSummary(repository);
  // A summary this table does not know is unverified, and asks for nothing.
  return { summary: summary.label, ...(MAPPED[summary.label] ?? { badge: "Setup unverified", tone: "neutral", fix: null }) };
}

/** The destination of the fix line: the tab of the repository where the setup is done. */
export const repositorySetupHref = (repositoryId: string, fix: SetupFix) => `/repositories/${repositoryId}?tab=${fix.tab}`;

/** "2 running now · active 3m ago" while a session runs, otherwise "last active 3h ago". A time that is not known is left out. */
export function repositoryActivityLine(repository: RepositorySummary): string {
  const time = repositoryLastActivity(repository);
  const known = time !== "—";
  if (repository.liveCount > 0) return `${repository.liveCount} running now${known ? ` · active ${time}` : ""}`;
  return known ? `last active ${time}` : "No activity time known";
}

// ---- Fourteen days of sessions ----

export const ACTIVITY_DAYS = 14;
/** The tallest bar, and the stub a day with no session keeps, in pixels. */
export const BAR_MAX_PX = 36;
export const BAR_STUB_PX = 3;
/** A day with a session is never drawn shorter than this, so a single session beside a busy day is still seen. */
export const BAR_MIN_PX = 6;

export type ActivityBar = { count: number; height: number; /** The last day, while a session runs: drawn in the live tone. */ live: boolean };

/**
 * One bar for each of the 14 days, the tallest day at the full height. Returns null where the list carries no usable series (older monitors send
 * none), and then no bars are drawn. A series is 14 counts that are whole numbers, never negative.
 */
export function activityBars(dailySessions: unknown, live: boolean): ActivityBar[] | null {
  if (!Array.isArray(dailySessions) || dailySessions.length !== ACTIVITY_DAYS) return null;
  if (!dailySessions.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return null;
  const counts = dailySessions as number[];
  const busiest = Math.max(...counts, 1);
  return counts.map((count, index) => ({
    count,
    height: count === 0 ? BAR_STUB_PX : Math.max(BAR_MIN_PX, Math.round((count / busiest) * BAR_MAX_PX)),
    live: live && count > 0 && index === counts.length - 1,
  }));
}

/** The words of the bars for assistive technology, the oldest day first. */
export function activityLabel(bars: readonly ActivityBar[]): string {
  const total = bars.reduce((sum, bar) => sum + bar.count, 0);
  return `${total} ${total === 1 ? "session" : "sessions"} started in the last ${bars.length} days, one count for each day, oldest first: ${bars.map((bar) => bar.count).join(", ")}`;
}

// ---- Providers ----

const MARKS: Record<RepositoryProviderInventory["provider"], string> = { claude: "C", codex: "X" };

/** The providers that have a session here, each with its letter and its name. */
export function providerMarks(repository: Pick<RepositorySummary, "providers">): { provider: RepositoryProviderInventory["provider"]; letter: string; name: string }[] {
  return repository.providers.filter((provider) => provider.sessionCount > 0).map((provider) => ({ provider: provider.provider, letter: MARKS[provider.provider] ?? provider.source.charAt(0).toUpperCase(), name: provider.source }));
}

// ---- The initial tile ----

export const TILE_TINTS = 4;

/** A tint for the tile, from the repository's identity, so it never changes when the list is filtered, sorted, or grows. */
export function tileTint(repositoryId: string): number {
  // FNV-1a over the identity; the high bits are the well mixed ones.
  let hash = 2166136261;
  for (const char of repositoryId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 16) % TILE_TINTS;
}

export const repositoryInitial = (displayName: string) => (Array.from(displayName.trim())[0] ?? "?").toUpperCase();
