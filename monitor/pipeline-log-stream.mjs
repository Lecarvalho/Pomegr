import { randomUUID } from "node:crypto";
import { normalizePipelineLogRecord } from "./pipeline-log-schema.mjs";

/** Translate instrumented events into ordinary, identity-free JSONL records. */
export function createPipelineLogStream({ writer, run = randomUUID(), now = () => new Date().toISOString() } = {}) {
  const scopes = new WeakMap();
  let nextScope = 0, rejected = 0, failed = false, lastDropped = 0, lastRejected = 0;
  function record(fields) {
    const normalized = normalizePipelineLogRecord({ version: 1, run, at: now(), ...fields });
    if (!normalized) { rejected += 1; return false; }
    try { return writer.write(normalized); } catch { failed = true; return false; }
  }
  function scopeId(scope) {
    if (!scope || typeof scope !== "object") return undefined;
    if (!scopes.has(scope)) scopes.set(scope, ++nextScope);
    return scopes.get(scope);
  }
  return Object.freeze({
    record,
    event(event, context = {}) {
      if (!event || !Number.isFinite(event.ts)) return false;
      const scope = scopeId(context.scope);
      const ids = { ...(scope ? { scope } : {}), ...(context.flow ? { flow: context.flow } : {}),
        ...(event.args?.revision ? { revision: event.args.revision } : {}) };
      const startMs = event.ts / 1_000;
      if (event.ph === "B" || event.ph === "X") return record({
        kind: event.ph === "B" ? "span_start" : "span", stage: event.name, domain: event.cat,
        startMs, lane: event.tid, ...ids,
        ...(event.ph === "X" ? { durationMs: event.dur / 1_000, outcome: event.args?.outcome,
          ...(event.args?.surface ? { surface: event.args.surface } : {}),
          ...(event.args?.clockErrorUs !== undefined ? { clockErrorMs: event.args.clockErrorUs / 1_000 } : {}) } : {}),
      });
      if (["s", "t", "f"].includes(event.ph)) return record({ kind: "flow",
        phase: { s: "start", t: "step", f: "end" }[event.ph], flow: event.id, startMs,
        lane: event.tid, outcome: event.args?.outcome, ...(scope ? { scope } : {}) });
      if (event.ph === "C") return record({ kind: "counter", counter: event.name, value: event.args?.value, startMs });
      return false;
    },
    reportLoss() {
      const stats = writer.stats();
      const droppedRecords = Math.max(0, stats.droppedRecords || 0);
      const rejectedRecords = Math.max(0, stats.rejectedRecords || 0) + rejected;
      if (droppedRecords === lastDropped && rejectedRecords === lastRejected && !failed && !stats.failed) return;
      if (record({ kind: "gap", droppedRecords: droppedRecords - lastDropped,
        rejectedRecords: rejectedRecords - lastRejected, reason: failed || stats.failed ? "disk_error" : "backpressure" })) {
        lastDropped = droppedRecords; lastRejected = rejectedRecords;
      }
    },
  });
}
