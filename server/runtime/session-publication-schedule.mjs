/**
 * Decides when a session's pending candidate is derived and committed (C).
 *
 * A fresh candidate for a session that has not published within `spacingMs` publishes in the
 * next scheduler turn. Otherwise it waits until `spacingMs` after that session's previous
 * publication, so the candidates that arrive meanwhile coalesce into one publication and a
 * session never publishes more often than once per `spacingMs`. Rederivations that carry no new
 * provider evidence (a restored checkpoint, a downstream dependency refresh) gather for the full
 * `spacingMs` instead, so many of them arriving together keep the timing they always had. A
 * fresh candidate that arrives meanwhile absorbs a pending refresh and publishes at the next
 * permitted time; one that arrives behind a pending restore joins the restore's deadline, so a
 * startup restore stays one batch.
 *
 * Each session has at most one timer. The owner keeps the pending candidates; this module holds
 * only session IDs and monotonic times.
 */
export function createSessionPublicationSchedule({ schedule, cancel, now, spacingMs, publish }) {
  const timers = new Map(); // session ID -> { dueAt, firm, timer }
  const settledAt = new Map(); // session ID -> time of its last publication attempt, oldest first
  const deriving = new Map(); // session ID -> derivations in flight
  let epoch = 0;

  function request(id, minimumDelayMs, advance, firm = false) {
    const at = now();
    const settled = settledAt.get(id);
    const delay = Math.ceil(Math.max(0, minimumDelayMs, settled === undefined ? 0 : settled + spacingMs - at));
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
     * New provider evidence, or the newer candidate left pending by a superseded derivation:
     * publish at the next time the spacing permits, moving a later timer (a gathered refresh or
     * a failure retry, never a restore) forward. While an older candidate of the same session is
     * still deriving, the newer one keeps the full spacing as its deadline, so this starts no
     * overlapping derivation; the owner calls it again when that derivation ends superseded.
     */
    fresh(id) { request(id, deriving.has(id) ? spacingMs : 0, true); },
    /** A rederivation after a downstream dependency changed: gather for the full spacing. */
    gathered(id) { request(id, spacingMs, false); },
    /** A restored checkpoint's rederivation: gather for the full spacing and hold that deadline. */
    restored(id) { request(id, spacingMs, false, true); },
    /** A failed derivation's retry, after its backoff. */
    retry(id, delayMs) { request(id, delayMs, false); },
    /** Marks one derivation in flight; call the returned function when it ends. */
    derivationStarted(id) {
      const startedIn = epoch;
      deriving.set(id, (deriving.get(id) || 0) + 1);
      return () => {
        if (startedIn !== epoch) return;
        const remaining = (deriving.get(id) || 1) - 1;
        if (remaining > 0) deriving.set(id, remaining);
        else deriving.delete(id);
      };
    },
    /**
     * Records a publication attempt of the current candidate: one that reached the store, or
     * failed. The spacing counts from here. Only sessions that settled within the spacing are
     * retained.
     */
    settled(id) {
      const at = now();
      settledAt.delete(id);
      for (const [other, time] of settledAt) {
        if (at - time < spacingMs) break;
        settledAt.delete(other);
      }
      if (spacingMs > 0) settledAt.set(id, at);
    },
    pending: () => timers.size > 0,
    retained: () => Object.freeze({ timers: timers.size, settled: settledAt.size, deriving: deriving.size }),
    clear() {
      for (const entry of timers.values()) cancel(entry.timer);
      timers.clear();
      settledAt.clear();
      deriving.clear();
      epoch += 1;
    },
  });
}
