const sameLifecycle = (left, right) => Boolean(left.isLive) === Boolean(right.isLive)
  && Boolean(left.needsInput) === Boolean(right.needsInput) && left.activityStatus === right.activityStatus;

export function createRowEvidenceView({ store, memo, pendingEntry, isRestored }) {
  const behind = new Set();
  return Object.freeze({
    mark(id) { behind.add(id); },
    clear() { behind.clear(); },
    row(row) {
      if (!behind.has(row?.id)) return row;
      const snapshot = store.getByQualifiedId(row.id);
      const pending = snapshot ? pendingEntry(row) : null;
      if (!pending || !sameLifecycle(pending, row)) return row;
      const { currentActivity, activityFallback } = memo.preview(row, snapshot, isRestored(row.id));
      return { ...row, currentActivity, activityFallback };
    },
  });
}
