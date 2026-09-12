import { createPipelineTraceRecorder } from "./pipeline-trace.mjs";
import { startPipelineTraceSampling } from "./pipeline-trace-sampling.mjs";
import { fileURLToPath } from "node:url";
import { createPipelineLogWriter } from "./pipeline-log-writer.mjs";
import { createPipelineLogStream } from "./pipeline-log-stream.mjs";
import { createPipelineOperationsSnapshot } from "./pipeline-operations.mjs";
import { createDevelopmentTraceScopeRegistry } from "./dev-trace-scopes.mjs";
const STAGES = Object.freeze([
  "source_notification", "catalog_discovery", "source_queue", "source_preparation", "acquisition_normalization",
  "catalog_commit_wait", "catalog_projection", "session_commit_wait", "session_derivation", "session_projection", "session_capabilities", "session_state_projection",
  "normalized_store_commit", "candidate_to_commit", "history_read", "history_publish", "history_contribution",
  "checkpoint", "checkpoint_validation", "checkpoint_privacy", "checkpoint_collection", "checkpoint_candidate", "checkpoint_size", "checkpoint_storage", "revision_notify", "cache_serve",
]);

/** Automatic development-only file logging. Production imports none of this composition. */
export function createDevelopmentDiagnostics({
  recorder = null,
  logWriter = null,
  createWriter = createPipelineLogWriter,
  directory = fileURLToPath(new URL("../outputs/pipeline-logs/", import.meta.url)),
  startSampling = startPipelineTraceSampling,
  logger = console,
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  let writer = logWriter;
  let initializationWarned = false;
  try { writer ||= createWriter({ directory }); } catch {
    logger?.warn?.("[pomegr] Local diagnostic log unavailable.");
    initializationWarned = true;
    writer = { write: () => false, stats: () => ({ failed: true }), close: async () => {} };
  }
  const stream = createPipelineLogStream({ writer });
  recorder ||= createPipelineTraceRecorder({ rolling: true, stages: STAGES, retainEvents: false, onEvent: stream.event });
  stream.record({ kind: "lifecycle", event: "started" });
  const scopes = createDevelopmentTraceScopeRegistry({ createScope: () => recorder.createScope() });
  return Object.freeze({
    recorder,
    logWriter: writer,
    traceScopeForSession: scopes.scopeForSession,
    async start({ runtime }) {
      let sampling = null;
      let warned = initializationWarned;
      let previousRejected = 0;
      const health = () => {
        try {
          stream.reportLoss();
          const instrumentation = recorder.statistics?.();
          const rejected = (instrumentation?.droppedSpans || 0) + (instrumentation?.droppedHandles || 0);
          if (rejected > previousRejected && stream.record({ kind: "gap", reason: "instrumentation_limit",
            droppedRecords: 0, rejectedRecords: rejected - previousRejected })) previousRejected = rejected;
          stream.record({ kind: "health", snapshot: createPipelineOperationsSnapshot(runtime.observationDiagnostics?.()) });
          if (writer.stats().failed && !warned) { warned = true; logger?.warn?.("[pomegr] Local diagnostic log unavailable."); }
        } catch { /* Diagnostic collection cannot affect observation. */ }
      };
      health();
      const timer = schedule(health, 1_000);
      timer?.unref?.();
      try {
        sampling = startSampling({ recorder, diagnostics: runtime.observationDiagnostics });
      } catch {
        logger?.warn?.("[pomegr] Local diagnostic sampling unavailable.");
      }
      let closePromise = null;
      return Object.freeze({
        close() {
          if (closePromise) return closePromise;
          closePromise = (async () => {
            cancel(timer);
            try { sampling?.close?.(); } catch { /* Diagnostic cleanup cannot affect monitor shutdown. */ }
            recorder.deactivate({ captureIncomplete: true });
            health();
            stream.record({ kind: "lifecycle", event: "stopped" });
            try { await writer.close(); } catch { /* Diagnostic cleanup cannot affect monitor shutdown. */ }
          })();
          return closePromise;
        },
      });
    },
  });
}
