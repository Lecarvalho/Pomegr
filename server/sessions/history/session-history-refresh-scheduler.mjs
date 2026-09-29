const FOREGROUND = 0;

/** Bounded replay lanes. Tasks must yield cooperatively for the foreground lane to preempt CPU-heavy maintenance. */
export function createSessionHistoryRefreshScheduler({ run, foregroundConcurrency = 1, backgroundConcurrency = 1 } = {}) {
  if (typeof run !== "function") throw new TypeError("History refresh scheduler requires a runner");
  for (const [name, value] of [["foreground", foregroundConcurrency], ["background", backgroundConcurrency]]) {
    if (!Number.isInteger(value) || value < 1 || value > 4) throw new TypeError(`History ${name} concurrency must be between 1 and 4`);
  }
  const pending = new Map();
  const running = new Map();
  let sequence = 0;
  let stopped = false;

  function activeCounts() {
    let foreground = 0;
    let background = 0;
    for (const item of running.values()) {
      if (item.priority === FOREGROUND) foreground += 1;
      else background += 1;
    }
    return { foreground, background };
  }

  function next(allowForeground, allowBackground) {
    let selected = null;
    for (const item of pending.values()) {
      const foreground = item.priority === FOREGROUND;
      if (foreground ? !allowForeground : !allowBackground) continue;
      if (!selected || item.priority < selected.priority
        || item.priority === selected.priority && item.sequence < selected.sequence) selected = item;
    }
    return selected;
  }

  function drain() {
    if (stopped) return;
    while (running.size < foregroundConcurrency + backgroundConcurrency) {
      const counts = activeCounts();
      const item = next(counts.foreground < foregroundConcurrency, counts.background < backgroundConcurrency);
      if (!item) return;
      pending.delete(item.sessionId);
      const active = { priority: item.priority, rerunPriority: null, promoted: item.priority === FOREGROUND };
      running.set(item.sessionId, active);
      void Promise.resolve().then(() => run(item.sessionId, item.priority)).catch(() => {}).finally(() => {
        running.delete(item.sessionId);
        if (!stopped && active.rerunPriority !== null) enqueue(item.sessionId, {
          priority: active.rerunPriority,
          rerunIfActive: false,
        });
        drain();
      });
    }
  }

  function enqueue(sessionId, { priority = 1, rerunIfActive = true } = {}) {
    if (stopped || typeof sessionId !== "string" || !sessionId) return false;
    const normalizedPriority = priority === FOREGROUND ? FOREGROUND : Math.max(1, Number.isSafeInteger(priority) ? priority : 1);
    const queued = pending.get(sessionId);
    if (queued) {
      queued.priority = Math.min(queued.priority, normalizedPriority);
      drain();
      return true;
    }
    const active = running.get(sessionId);
    if (active) {
      if (rerunIfActive) {
        const rerunPriority = active.promoted ? FOREGROUND : normalizedPriority;
        active.rerunPriority = Math.min(active.rerunPriority ?? rerunPriority, rerunPriority);
      }
      return false;
    }
    pending.set(sessionId, { sessionId, priority: normalizedPriority, sequence: sequence += 1 });
    drain();
    return true;
  }

  return Object.freeze({
    enqueue,
    promote(sessionId) {
      const queued = pending.get(sessionId);
      if (!queued) {
        const active = running.get(sessionId);
        if (active) {
          active.promoted = true;
          if (active.rerunPriority !== null) active.rerunPriority = FOREGROUND;
        }
        return Boolean(active);
      }
      queued.priority = FOREGROUND;
      drain();
      return true;
    },
    start() { stopped = false; drain(); },
    stop() { stopped = true; pending.clear(); },
    diagnostics() {
      const counts = activeCounts();
      return Object.freeze({ active: running.size, pending: pending.size,
        activeForeground: counts.foreground, activeBackground: counts.background });
    },
  });
}
