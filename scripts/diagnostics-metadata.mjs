import { open } from "node:fs/promises";
import { validRollingMetadata } from "./diagnostics-capture.mjs";

const MAX_BYTES = 4 * 1024 * 1024;
export const CONTROLLED_SCENARIOS = ["progressive_activity_withheld_correlation", "synthetic_cold_start_history",
  "synthetic_restored_history", "synthetic_warm_append_history", "synthetic_continuous_burst_history"];
const SCENARIOS = new Set(["live_observation", "synthetic_benchmark", ...CONTROLLED_SCENARIOS]);
const CLOCKS = new Set(["backend_monotonic_renderer_unaligned", "backend_monotonic_renderer_interval_bound", "performance.now"]);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Read only bounded Pomegr JSON metadata; never echo arbitrary trace arguments. */
export async function readDiagnosticMetadata(path, stages) {
  const missing = { capture: null, rolling: null, rendererClock: null, enabledStages: null, provenance: { scenario: null, build: null, clockQuality: null } };
  if (!path.toLowerCase().endsWith(".json")) return missing;
  let file;
  try {
    file = await open(path, "r");
    const size = (await file.stat()).size;
    if (size > MAX_BYTES) return missing;
    const bytes = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== size) return missing;
    const metadata = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))?.metadata;
    if (metadata?.version !== 1) return missing;
    const source = metadata.provenance || metadata;
    const provenance = {
      scenario: SCENARIOS.has(source.scenario) ? source.scenario : null,
      build: typeof source.buildVersion === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(source.buildVersion) ? source.buildVersion : null,
      clockQuality: CLOCKS.has(source.clockQuality || source.clock) ? (source.clockQuality || source.clock) : null,
    };
    const capture = metadata.capture;
    const clock = metadata.rendererClock;
    const enabled = metadata.coverage?.enabledStages;
    return {
      provenance,
      rolling: validRollingMetadata(metadata.rolling) ? { ...metadata.rolling } : null,
      rendererClock: clock && ["unavailable", "bounded"].includes(clock.status) ? {
        status: clock.status, calibratedSpans: count(clock.calibratedSpans),
        rejectedCalibrations: count(clock.rejectedCalibrations), maxErrorUs: count(clock.maxErrorUs),
      } : null,
      capture: capture && typeof capture.incomplete === "boolean" && typeof capture.active === "boolean" ? {
        incomplete: capture.incomplete, active: capture.active,
        droppedEvents: count(capture.droppedEvents), droppedSpans: count(capture.droppedSpans),
        droppedHandles: count(capture.droppedHandles),
        eventCount: count(capture.eventCount), openSpanCount: count(capture.openSpanCount),
      } : null,
      enabledStages: Array.isArray(enabled) && enabled.length <= stages.length && enabled.every((stage) => stages.includes(stage))
        ? [...new Set(enabled)] : null,
    };
  } catch { return missing; }
  finally { await file?.close(); }
}
