// How a stored, unbound dispatch stands in time. A leaf module with no import, so the task record (board projection and
// queue order) and the queue advance can read it without depending on the dispatcher.

/** An unbound dispatch is live for this long after its mint; a bound one is never read again and never expires. */
export const TASK_DISPATCH_UNBOUND_TTL_MS = 10 * 60 * 1000;

const STORED_DISPATCH = /^([0-9a-f]{64}):(\d{1,16})$/u;

export function parseStoredDispatch(value) {
  const match = typeof value === "string" ? STORED_DISPATCH.exec(value) : null;
  return match ? { digest: match[1], mintedAt: Number(match[2]) } : null;
}

export const isLive = (stored, now) => stored !== null && now - stored.mintedAt < TASK_DISPATCH_UNBOUND_TTL_MS && now >= stored.mintedAt;

/**
 * How an unbound dispatch column value stands at `now`: `none` for no value, `live` inside its ten minutes, and `expired`
 * for a value that has run out or that no dispatch could have written. The board projection reads it to tell a start
 * that is still waiting for its session (in flight) from one that is not, and the queue advance reads it to tell that
 * start from one that never linked back.
 */
export function dispatchStanding(value, now) {
  if (value === null || value === undefined) return "none";
  return isLive(parseStoredDispatch(value), now) ? "live" : "expired";
}
