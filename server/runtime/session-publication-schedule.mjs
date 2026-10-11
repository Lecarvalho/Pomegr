// Decides when a session's pending candidate is derived and committed (C).
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
    fresh(id) { request(id, 0, true); },
    gathered(id) { request(id, spacingMs, false); },
    restored(id) { request(id, spacingMs, false, true); },
    // A failed derivation's retry, after its backoff.
    retry(id, delayMs) { request(id, delayMs, false); },
    // Records that a derivation of this session starts now.
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
