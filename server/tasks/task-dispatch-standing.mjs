// How a stored, unbound dispatch stands in time.

// Ordinary unbound dispatches expire. An autonomous claim survives restart and uncertainty until binding or owner resolution.
export const TASK_DISPATCH_UNBOUND_TTL_MS = 10 * 60 * 1000;

const STORED_DISPATCH = /^([0-9a-f]{64}):(\d{1,16})(:autonomous)?$/u;

export function parseStoredDispatch(value) {
  const match = typeof value === "string" ? STORED_DISPATCH.exec(value) : null;
  return match ? { digest: match[1], mintedAt: Number(match[2]), ...(match[3] ? { autonomous: true } : {}) } : null;
}

export const isLive = (stored, now) => stored !== null && (stored.autonomous === true || (now - stored.mintedAt < TASK_DISPATCH_UNBOUND_TTL_MS && now >= stored.mintedAt));

export function dispatchStanding(value, now) {
  if (value === null || value === undefined) return "none";
  return isLive(parseStoredDispatch(value), now) ? "live" : "expired";
}
