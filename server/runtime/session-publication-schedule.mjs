/**
 * Decides when a session's pending candidate is derived and committed (C).
 *
 * The spacing is between derivation starts of one session: two never begin less than
 * `spacingMs` apart, whatever the first one's outcome (committed, unchanged, rejected, failed,
 * or dropped because a newer candidate replaced it). A fresh candidate for a session with no
 * derivation start in the last `spacingMs` derives in the next scheduler turn. Otherwise it
 * derives `spacingMs` after the previous start, and the candidates that arrive meanwhile
 * coalesce into that one derivation.
 *
 * A publication follows its derivation, so publications are normally at least `spacingMs`
 * apart as well. They can land closer when a slow derivation is followed by a faster one, and
 * a derivation that outlasts the spacing can overlap the next. Neither is prevented here.
 *
 * Rederivations that carry no new provider evidence (a restored checkpoint, a downstream
 * dependency refresh) gather for the full `spacingMs` from the first pending one, so many of
 * them arriving together keep one deadline. A fresh candidate that arrives meanwhile absorbs a
 * pending refresh and derives at the next permitted time; one that arrives behind a pending
 * restore joins the restore's deadline, so a startup restore stays one batch.
 *
 * Each session has at most one timer. The owner keeps the pending candidates; this module holds
 * only session IDs and monotonic times.
 */
export function createSessionPublicationSchedule({ schedule, cancel, now, spacingMs, publish }) {
  const timers = new Map(); // session ID -> { dueAt, firm, timer }
  const startedAt = new Map(); // session ID -> time its last derivation started, oldest first

  function request(id, minimumDelayMs, advance, firm = false) {
    const at = now();
    const started = startedAt.get(id);
    const delay = Math.ceil(Math.max(0, minimumDelayMs, started === undefined ? 0 : started + spacingMs - at));
    const existing = timers.get(id);
    if (existing && !(advance && !existing.firm && existing.dueAt > at + delay)) return;
    if (existing) cancel(existing.timer);
    const entry = { dueAt: at + delay, firm, timer: null };
    entry.timer = schedule(() => {
      if (timers.get(id) !== entry) return;
      timers.delete(id);
      publish(id);
    }, delay);
    timers.set(id, entry);
  }

  return Object.freeze({
    /**
     * New provider evidence: derive at the next time the spacing permits, moving a later timer
     * (a gathered refresh or a failure retry, never a restore) forward. This is the only request
     * that moves a deadline, so only observer evidence may use it.
     */
    fresh(id) { request(id, 0, true); },
    /**
     * A rederivation after a downstream dependency changed, or a pending candidate found
     * without a timer: gather for the full spacing. An existing timer is kept.
     */
    gathered(id) { request(id, spacingMs, false); },
    /** A restored checkpoint's rederivation: gather for the full spacing and hold that deadline. */
    restored(id) { request(id, spacingMs, false, true); },
    /** A failed derivation's retry, after its backoff. An existing timer is kept. */
    retry(id, delayMs) { request(id, delayMs, false); },
    /**
     * Records that a derivation of this session starts now. The spacing counts from here. Only
     * sessions that started one within the spacing are retained.
     */
    started(id) {
      const at = now();
      startedAt.delete(id);
      for (const [other, time] of startedAt) {
        if (at - time < spacingMs) break;
        startedAt.delete(other);
      }
      if (spacingMs > 0) startedAt.set(id, at);
    },
    pending: () => timers.size > 0,
    retained: () => Object.freeze({ timers: timers.size, started: startedAt.size }),
    clear() {
      for (const entry of timers.values()) cancel(entry.timer);
      timers.clear();
      startedAt.clear();
    },
  });
}
