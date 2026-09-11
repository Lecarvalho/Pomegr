import { createRequestHandler } from "./request-handler.mjs";
import { createPipelineRendererTraceBridge } from "./pipeline-renderer-trace.mjs";
import { createPipelineTraceRecorder } from "./pipeline-trace.mjs";
import { startPipelineTraceSampling } from "./pipeline-trace-sampling.mjs";
import { fileURLToPath } from "node:url";
import { createPipelineLogWriter } from "./pipeline-log-writer.mjs";
import { createPipelineLogStream } from "./pipeline-log-stream.mjs";
import { createPipelineOperationsSnapshot } from "./pipeline-operations.mjs";
import { createDevelopmentTraceScopeRegistry } from "./dev-trace-scopes.mjs";
import { normalizeRendererTracePayload } from "../shared/renderer-trace-contract.mjs";

const MAX_RENDERER_TRACE_BYTES = 8 * 1024;
const STAGES = Object.freeze([
  "source_notification", "catalog_discovery", "source_queue", "source_preparation", "acquisition_normalization",
  "catalog_commit_wait", "catalog_projection", "session_commit_wait", "session_derivation",
  "normalized_store_commit", "candidate_to_commit", "history_read", "history_publish", "history_contribution",
  "checkpoint", "revision_notify", "cache_serve", "renderer_event", "renderer_fetch", "renderer_react_commit", "renderer_next_frame",
]);

async function rendererTraceBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_RENDERER_TRACE_BYTES) return null;
  }
  try { return normalizeRendererTracePayload(JSON.parse(body)); } catch { return null; }
}

function internalRendererTraceRequest(request, response, bridge, authorizationToken) {
  const localAddress = request.socket?.localAddress;
  const localPort = request.socket?.localPort;
  const expectedHost = localAddress && localPort ? `${localAddress}:${localPort}` : "";
  let pathname = "";
  try { pathname = new URL(request.url || "/", "http://127.0.0.1").pathname; } catch { return false; }
  if (pathname !== "/internal/renderer-trace") return false;
  const authorized = request.method === "POST" && request.headers.host === expectedHost && request.headers.origin === undefined
    && (!authorizationToken || request.headers["x-pomegr-desktop-authorization"] === authorizationToken);
  if (!authorized || request.headers["content-type"] !== "application/json" || request.headers["transfer-encoding"] !== undefined
    || Number(request.headers["content-length"] || 0) > MAX_RENDERER_TRACE_BYTES) {
    response.writeHead(404, { "Cache-Control": "no-store" }); response.end(); return true;
  }
  void rendererTraceBody(request).then((payload) => {
    if (payload) {
      try { bridge.record(payload); } catch { /* Dev telemetry cannot affect monitor serving. */ }
    }
    response.writeHead(204, { "Cache-Control": "no-store" }); response.end();
  });
  return true;
}

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
  const bridge = createPipelineRendererTraceBridge({ recorder });
  return Object.freeze({
    recorder,
    logWriter: writer,
    traceScopeForSession: scopes.scopeForSession,
    createRequestHandler(options) {
      const handler = createRequestHandler({
        ...options,
        responseHeaders({ path, page, sessionId, kind }) {
          if (path !== "/api/session-history" || page?.status !== "ready" || page.kind !== kind) return {};
          const token = bridge.issueRevision(kind, scopes.scopeForSession(sessionId));
          return token ? { "X-Pomegr-Trace-Revision": token } : {};
        },
      });
      return (request, response) => {
        if (internalRendererTraceRequest(request, response, bridge, options.authorizationToken || "")) return;
        return handler(request, response);
      };
    },
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
