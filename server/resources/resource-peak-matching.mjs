// Deterministic, pure matching of a persisted resource peak sample to the execution
// tasks and session-history request that temporally overlap it. No I/O, no clocks:
// every input is supplied by the caller. See docs/METRICS.md ("Resource history") for
// the association rule in plain words and its stated limits.

export const MAX_MATCHED_TASK_IDS = 20;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * @param {{ fromMs: number, toMs: number,            // measurement interval of the peak sample, fromMs <= toMs
 *           tasks: Array<{ id: string, startedAtMs: number, finishedAtMs: number|null, requestNumber: number|null }>,
 *           latestObservationMs: number|null }} input
 * @returns {{ taskIds: string[], requestNumber: number|null }}
 */
export function matchResourcePeak(input) {
  const empty = { taskIds: [], requestNumber: null };
  if (!input || typeof input !== "object") return empty;

  const { fromMs, toMs, tasks, latestObservationMs } = input;
  if (!isFiniteNumber(fromMs) || !isFiniteNumber(toMs) || fromMs > toMs) return empty;
  if (!Array.isArray(tasks)) return empty;

  const latestMs = isFiniteNumber(latestObservationMs) ? latestObservationMs : null;

  const overlapping = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const { id, startedAtMs, finishedAtMs, requestNumber } = task;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!isFiniteNumber(startedAtMs)) continue;

    let endMs;
    if (finishedAtMs === null || finishedAtMs === undefined) {
      // Unfinished: the interval extends only to the latest observation. Without one,
      // or with one earlier than the start, the task has no evidenced end and does not match.
      if (latestMs === null || latestMs < startedAtMs) continue;
      endMs = latestMs;
    } else {
      if (!isFiniteNumber(finishedAtMs) || finishedAtMs < startedAtMs) continue;
      endMs = finishedAtMs;
    }

    if (startedAtMs <= toMs && endMs >= fromMs) {
      overlapping.push({ id, requestNumber });
    }
  }

  if (overlapping.length === 0) return empty;

  const taskIds = Array.from(new Set(overlapping.map((task) => task.id)))
    .sort()
    .slice(0, MAX_MATCHED_TASK_IDS);

  const [{ requestNumber: firstRequestNumber }] = overlapping;
  const requestNumber =
    isPositiveSafeInteger(firstRequestNumber) &&
    overlapping.every((task) => task.requestNumber === firstRequestNumber)
      ? firstRequestNumber
      : null;

  return { taskIds, requestNumber };
}
