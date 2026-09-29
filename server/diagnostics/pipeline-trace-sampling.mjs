import { monitorEventLoopDelay } from "node:perf_hooks";

/** Sample process/queue cost only during explicit recording; never acquire evidence. */
export function startPipelineTraceSampling({ recorder, diagnostics, intervalMs = 250,
  cpuUsage = process.cpuUsage, memoryUsage = process.memoryUsage,
  histogram = monitorEventLoopDelay({ resolution: 20 }), schedule = setInterval, cancel = clearInterval } = {}) {
  let previousCpu = null;
  let observing = false;
  const sample = () => {
    try {
      if (!recorder.isActive()) {
        if (observing) histogram.disable();
        observing = false;
        previousCpu = null;
        return;
      }
      if (!observing) { histogram.reset(); histogram.enable(); observing = true; }
      const cpu = cpuUsage();
      if (previousCpu) recorder.recordCounter({ counter: "cpu", value: Math.max(0, cpu.user + cpu.system - previousCpu.user - previousCpu.system) });
      previousCpu = cpu;
      recorder.recordCounter({ counter: "memory", value: memoryUsage().rss });
      if (Number.isFinite(histogram.max) && histogram.max > 0) {
        recorder.recordCounter({ counter: "event_loop_ms", value: histogram.max / 1_000_000 });
      }
      histogram.reset();
      const observers = Object.values(diagnostics?.()?.coordinator?.observers || {}).slice(0, 16);
      if (observers.length) {
        for (const [counter, key] of [["queue_depth", "pendingHydrations"], ["active", "activeHydrations"], ["capacity", "hydrationConcurrency"]]) {
          recorder.recordCounter({ counter, value: observers.reduce((sum, item) => sum + (Number.isFinite(item?.[key]) ? item[key] : 0), 0) });
        }
        const ages = observers.map((item) => item.oldestPendingMs).filter(Number.isFinite);
        if (ages.length) recorder.recordCounter({ counter: "oldest_pending_ms", value: Math.max(...ages) });
      }
    } catch { /* Diagnostic collection must not interrupt product work. */ }
  };
  const timer = schedule(sample, Math.max(100, Math.min(5_000, intervalMs)));
  timer?.unref?.();
  return Object.freeze({ close() { cancel(timer); histogram.disable(); }, sample });
}
