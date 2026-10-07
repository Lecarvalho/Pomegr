// The lifecycle a row's activity is derived under, plus the one other lifecycle field a session
// projection reads from the row.
const sameLifecycle = (left, right) => Boolean(left.isLive) === Boolean(right.isLive)
  && Boolean(left.needsInput) === Boolean(right.needsInput) && left.activityStatus === right.activityStatus;

/**
 * The catalog row a session's domains project against between a session commit and the catalog
 * commit that the session commit schedules.
 *
 * A session event is announced before that catalog commit has rebuilt the session's row, so the
 * committed row still carries the activity of the previous evidence revision. For a session in
 * that gap, `row` returns the committed row with `currentActivity` and `activityFallback` derived
 * from the committed evidence, through the same activity memo the catalog commit reads, so the
 * catalog commit reuses the walk and finds the session's projection inputs unchanged.
 *
 * The view never shows a state the catalog commit would withdraw. When the provider's accepted
 * row for the session differs from the committed row in `isLive`, `needsInput`, or
 * `activityStatus`, or the session is leaving the catalog, the committed row is returned
 * unchanged and that catalog commit delivers the lifecycle and the activity together.
 *
 * `pendingEntry(row)` returns the provider's accepted row as the next catalog commit will
 * project it, or null. Only session IDs are retained, and only until the next catalog commit.
 */
export function createRowEvidenceView({ store, memo, pendingEntry, isRestored }) {
  const behind = new Set();
  return Object.freeze({
    /** The session's evidence committed, and a catalog commit is scheduled. */
    mark(id) { behind.add(id); },
    /** A catalog commit rebuilt every row, or the owner stopped. */
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
