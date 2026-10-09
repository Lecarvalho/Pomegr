// How a stored, unbound dispatch stands in time. A leaf module with no import, so the task record can read it for the
// queue order without depending on the dispatcher.

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
 * for a value that has run out or that no dispatch could have written. Only the queue reads this, to tell a start that
 * is still waiting for its session from one that never reported back.
 */
export function dispatchStanding(value, now) {
  if (value === null || value === undefined) return "none";
  return isLive(parseStoredDispatch(value), now) ? "live" : "expired";
}
