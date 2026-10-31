// Sessions started on each of the last days, for one repository: the bounded series the Repositories list draws as bars.
// A pure function of the committed catalog rows and a clock. It reads no provider, Git, or file and keeps nothing.

export const DAILY_SESSION_DAYS = 14;

const localMidnight = (nowMs, offsetDays) => {
  const now = new Date(nowMs);
  // Date arithmetic moves the local calendar day, so a day that gains or loses an hour in a clock change is still one bar.
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays).getTime();
};

/** The start of the next local day, which is when a series has to be built again. */
export const nextLocalDayMs = (nowMs) => localMidnight(nowMs, 1);

/**
 * `days` counts of the sessions started on each local day, the oldest day first and the current day last. A session is dated by its
 * `createdAt`, or by its `updatedAt` when the catalog has no start. A row with no valid date, or outside the window, counts nowhere.
 */
export function dailySessionCounts(sessions, nowMs, days = DAILY_SESSION_DAYS) {
  const starts = Array.from({ length: days + 1 }, (_, index) => localMidnight(nowMs, index - days + 1));
  const counts = new Array(days).fill(0);
  for (const session of sessions) {
    const at = Date.parse(session?.createdAt || session?.updatedAt || "");
    if (!Number.isFinite(at) || at < starts[0] || at >= starts[days]) continue;
    let day = days - 1;
    while (day > 0 && at < starts[day]) day -= 1;
    counts[day] += 1;
  }
  return counts;
}
