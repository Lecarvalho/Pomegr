import { WORK_KINDS } from "./work-kind.mjs";

const KINDS = new Set(WORK_KINDS);

/** Retain only bounded request-local counts; discard all other tool evidence. */
export function normalizedRequestWork(value) {
  const counts = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    if (!KINDS.has(item?.kind) || !Number.isSafeInteger(item.count) || item.count < 1) continue;
    counts.set(item.kind, Math.min(999, (counts.get(item.kind) || 0) + Math.min(999, item.count)));
  }
  return [...counts].map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind))
    .slice(0, 8);
}
