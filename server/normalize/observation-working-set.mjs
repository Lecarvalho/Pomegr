export const OBSERVATION_WORKING_SET_MS = 7 * 24 * 60 * 60_000;

export function isObservationWorkingSetEntry(
  entry,
  nowMs = Date.now(),
  horizonMs = OBSERVATION_WORKING_SET_MS,
) {
  if (entry?.isLive || entry?.needsInput) return true;
  const updatedAt = Date.parse(entry?.updatedAt || "");
  return Number.isFinite(updatedAt) && updatedAt >= nowMs - horizonMs;
}
