import { createConnection } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipelineTraceCaptureDescriptor, pipelineTraceCaptureEndpoint } from "../monitor/pipeline-trace-transport.mjs";
import {
  PIPELINE_TRACE_COUNTERS,
  PIPELINE_TRACE_DOMAINS,
  PIPELINE_TRACE_OUTCOMES,
  PIPELINE_TRACE_STAGES,
} from "../monitor/pipeline-trace.mjs";

const DEFAULT_PORT = 4317;
const DEFAULT_DURATION_SECONDS = 30;
const MAX_DURATION_SECONDS = 600;
const MAX_TRACE_BYTES = 4 * 1024 * 1024;

function port(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new TypeError("Capture port is invalid");
  return parsed;
}

function duration(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DURATION_SECONDS) {
    throw new TypeError("Capture duration must be between 1 and 600 seconds");
  }
  return parsed;
}

export function parseDiagnosticsCaptureArgs(args = []) {
  const options = {
    port: port(process.env.SESSION_PULSE_PORT || DEFAULT_PORT),
    durationSeconds: DEFAULT_DURATION_SECONDS,
    descriptorPath: "",
    outputPath: path.resolve(process.cwd(), "outputs", "pipeline-traces", "capture.json"),
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--port", "--duration", "--descriptor", "--output", "--out"].includes(argument)
      && (!args[index + 1] || args[index + 1].startsWith("--"))) throw new TypeError("Capture option requires a value");
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--port") options.port = port(args[index += 1]);
    else if (argument === "--duration") options.durationSeconds = duration(args[index += 1]);
    else if (argument === "--descriptor") options.descriptorPath = String(args[index += 1] || "");
    else if (argument === "--output" || argument === "--out") options.outputPath = path.resolve(String(args[index += 1] || ""));
    else throw new TypeError("Unknown diagnostics capture option");
  }
  if (!options.descriptorPath) options.descriptorPath = pipelineTraceCaptureDescriptor(options.port);
  if (!options.outputPath) throw new TypeError("Capture output path is invalid");
  return Object.freeze(options);
}

export function diagnosticsCaptureHelp() {
  return [
    "Usage: npm run diagnostics:capture -- [options]",
    "",
    "Options:",
    "  --duration <seconds>  Capture duration, from 1 to 600 (default: 30)",
    "  --output <path>       Write Chrome Trace JSON here",
    "  --out <path>          Alias for --output",
    "  --descriptor <path>   Read the private local capture descriptor",
    "  --port <port>         Use the descriptor for a monitor port",
    "Development rolling captures export at most the latest five minutes, even for longer waits.",
  ].join("\n");
}

function validDescriptor(value, expectedEndpoint) {
  return value && value.version === 1 && value.endpoint === expectedEndpoint
    && typeof value.token === "string" && value.token.length >= 32 && value.token.length <= 256;
}

const stages = new Set(PIPELINE_TRACE_STAGES);
const domains = new Set(PIPELINE_TRACE_DOMAINS);
const outcomes = new Set(PIPELINE_TRACE_OUTCOMES);
const counters = new Set(PIPELINE_TRACE_COUNTERS);

function ownKeys(value, keys) {
  return value && typeof value === "object" && Object.keys(value).every((key) => keys.has(key));
}

function validTraceEvent(event) {
  if (!event || typeof event !== "object" || !Number.isSafeInteger(event.ts) || event.ts < 0
    || event.ts > 86_400_000_000
    || !ownKeys(event, new Set(["name", "cat", "ph", "ts", "dur", "pid", "tid", "id", "args"]))
    || event.pid !== 1 || !Number.isInteger(event.tid) || event.tid < 1 || event.tid > 1_024) return false;
  if (event.ph === "C") return event.id === undefined && event.dur === undefined
    && counters.has(event.name) && event.cat === "runtime"
    && ownKeys(event.args, new Set(["value"])) && Number.isSafeInteger(event.args.value) && event.args.value >= 0;
  if (event.ph !== "X" && event.ph !== "s" && event.ph !== "t" && event.ph !== "f") return false;
  if (!ownKeys(event.args, new Set(["outcome", "revision", "clock", "clockErrorUs", "surface"])) || !outcomes.has(event.args?.outcome)) return false;
  if (event.args.surface !== undefined && (event.ph !== "X" || !["catalog", "activity", "requests"].includes(event.args.surface))) return false;
  if (event.args.clock !== undefined || event.args.clockErrorUs !== undefined) {
    if (event.ph !== "X" || event.cat !== "presentation" || event.args.clock !== "request_interval_bound"
      || !Number.isSafeInteger(event.args.clockErrorUs) || event.args.clockErrorUs < 1_000 || event.args.clockErrorUs > 1_001_000) return false;
  }
  if (event.args.revision !== undefined && (!Number.isSafeInteger(event.args.revision)
    || event.args.revision < 1)) return false;
  if (event.ph === "X") return event.id === undefined && stages.has(event.name) && domains.has(event.cat)
    && Number.isSafeInteger(event.dur) && event.dur >= 0 && event.dur <= 86_400_000_000;
  if (event.dur !== undefined || event.name !== "pipeline_flow" || event.cat !== "runtime"
    || !Number.isSafeInteger(event.id) || event.id < 1) return false;
  return event.args.revision === undefined || (Number.isSafeInteger(event.args.revision)
    && event.args.revision >= 1);
}

export function validRollingMetadata(value) {
  return ownKeys(value, new Set(["retentionMs", "windowStartMs", "windowEndMs", "retainedMs", "evictedEvents", "capacityLimited", "selection", "matchedEvents"]))
    && ["retentionMs", "windowStartMs", "windowEndMs", "retainedMs", "evictedEvents", "matchedEvents"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && value.retentionMs > 0 && value.retentionMs <= 300_000 && value.windowEndMs >= value.windowStartMs
    && value.retainedMs === value.windowEndMs - value.windowStartMs && value.retainedMs <= value.retentionMs
    && typeof value.capacityLimited === "boolean" && ["all", "session"].includes(value.selection) && value.matchedEvents <= 16_384;
}

export function validTrace(value) {
  const capture = value?.metadata?.capture;
  const coverage = value?.metadata?.coverage;
  const provenance = value?.metadata?.provenance;
  const clock = value?.metadata?.rendererClock;
  const rolling = value?.metadata?.rolling;
  return Array.isArray(value?.traceEvents) && value.traceEvents.length <= (rolling ? 16_384 : 4_096)
    && ownKeys(value, new Set(["traceEvents", "metadata"]))
    && value?.metadata?.version === 1 && capture && coverage && provenance
    && ownKeys(value.metadata, new Set(["version", "capture", "coverage", "provenance", "rendererClock", "rolling"]))
    && (rolling === undefined || validRollingMetadata(rolling))
    && (clock === undefined || (ownKeys(clock, new Set(["status", "calibratedSpans", "rejectedCalibrations", "maxErrorUs"]))
      && ["unavailable", "bounded"].includes(clock.status)
      && ["calibratedSpans", "rejectedCalibrations", "maxErrorUs"].every((key) => Number.isSafeInteger(clock[key]) && clock[key] >= 0)
      && clock.calibratedSpans <= 16_384 && clock.maxErrorUs <= 1_001_000))
    && ownKeys(capture, new Set(["active", "incomplete", "eventCount", "droppedEvents", "droppedSpans", "droppedHandles", "openSpanCount", "flowCount", "revisionCount"]))
    && typeof capture.active === "boolean" && typeof capture.incomplete === "boolean"
    && ["eventCount", "droppedEvents", "droppedSpans", "droppedHandles", "openSpanCount", "flowCount", "revisionCount"]
      .every((key) => Number.isSafeInteger(capture[key]) && capture[key] >= 0)
    && capture.eventCount === value.traceEvents.length
    && ownKeys(coverage, new Set(["enabledStages", "observedStages"]))
    && Array.isArray(coverage.enabledStages) && Array.isArray(coverage.observedStages)
    && coverage.enabledStages.length <= stages.size && coverage.observedStages.length <= stages.size
    && coverage.enabledStages.every((stage) => stages.has(stage)) && coverage.observedStages.every((stage) => stages.has(stage))
    && ownKeys(provenance, new Set(["buildVersion", "clockQuality", "scenario"]))
    && provenance.buildVersion === "0.4.0" && ["backend_monotonic_renderer_unaligned", "backend_monotonic_renderer_interval_bound", "performance.now"].includes(provenance.clockQuality)
    && ["live_observation", "synthetic_benchmark", "progressive_activity_withheld_correlation", "synthetic_cold_start_history",
      "synthetic_restored_history", "synthetic_warm_append_history", "synthetic_continuous_burst_history"].includes(provenance.scenario)
    && value.traceEvents.every(validTraceEvent);
}

/** Connects to the local authenticated capture socket; the descriptor token is never printed. */
export async function runDiagnosticsCapture(options, {
  read = readFile,
  connect = createConnection,
  write = writeFile,
  makeDirectory = mkdir,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  // The exported API has the same boundary as the CLI, including direct callers.
  options = { ...options, port: port(options?.port), durationSeconds: duration(options?.durationSeconds) };
  const saving = options.mode === "save";
  if (options.mode !== undefined && !["save", "capture"].includes(options.mode)) throw new Error("CAPTURE_MODE_INVALID");
  if (saving && (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1 || options.windowMs > 300_000
    || (options.sessionKey !== undefined && (typeof options.sessionKey !== "string"
      || !/^(?:claude|codex):[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(options.sessionKey))))) throw new Error("CAPTURE_SELECTION_INVALID");
  for (const key of ["descriptorPath", "outputPath"]) {
    const value = options[key];
    if (typeof value !== "string" || !value.trim() || value.length > 4_096 || /[\u0000\r\n]/u.test(value)
      || value.startsWith("\\\\") || value.startsWith("//")) throw new Error("CAPTURE_PATH_INVALID");
    options[key] = path.resolve(value);
  }
  let descriptor;
  try { descriptor = JSON.parse(await read(options.descriptorPath, "utf8")); } catch { throw new Error("CAPTURE_DESCRIPTOR_UNAVAILABLE"); }
  if (!validDescriptor(descriptor, pipelineTraceCaptureEndpoint(options.port))) throw new Error("CAPTURE_DESCRIPTOR_INVALID");
  return new Promise((resolve, reject) => {
    const socket = connect(descriptor.endpoint);
    let received = "";
    let timer = null;
    let deadline = null;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) cancel(timer);
      if (deadline) cancel(deadline);
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    deadline = schedule(() => fail(new Error("CAPTURE_TIMEOUT")), saving ? 5_000 : options.durationSeconds * 1_000 + 5_000);
    socket.once("error", () => fail(new Error("CAPTURE_CONNECTION_FAILED")));
    socket.on("data", (chunk) => {
      received += chunk;
      if (Buffer.byteLength(received, "utf8") > MAX_TRACE_BYTES) {
        fail(new Error("CAPTURE_RESPONSE_TOO_LARGE"));
        return;
      }
      const newline = received.indexOf("\n");
      if (newline >= 0 && received.slice(0, newline) === '{"type":"capturing"}') {
        received = received.slice(newline + 1);
        if (!timer) timer = schedule(() => socket.write('{"type":"complete"}\n'), options.durationSeconds * 1_000);
      }
    });
    socket.once("close", async () => {
      if (settled) return;
      if (timer) cancel(timer);
      if (deadline) cancel(deadline);
      let trace;
      try { trace = JSON.parse(received); } catch { fail(new Error("CAPTURE_INCOMPLETE")); return; }
      if (!validTrace(trace)) {
        fail(new Error("CAPTURE_INVALID"));
        return;
      }
      if (saving && !trace.metadata.rolling) { fail(new Error("CAPTURE_ROLLING_UNAVAILABLE")); return; }
      try {
        await makeDirectory(path.dirname(options.outputPath), { recursive: true });
        await write(options.outputPath, `${JSON.stringify(trace)}\n`, saving ? { encoding: "utf8", flag: "wx" } : "utf8");
      } catch { fail(new Error("CAPTURE_WRITE_FAILED")); return; }
      settled = true;
      resolve(Object.freeze({ outputPath: options.outputPath, eventCount: trace.traceEvents.length,
        ...(trace.metadata.rolling ? { rolling: trace.metadata.rolling } : {}) }));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "authenticate", token: descriptor.token,
      ...(saving ? { action: "save", windowMs: options.windowMs, ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}) }
        : { durationMs: options.durationSeconds * 1_000 }) })}\n`));
  });
}

async function main() {
  let options;
  try { options = parseDiagnosticsCaptureArgs(process.argv.slice(2)); } catch {
    process.stderr.write("[pomegr] Invalid diagnostics capture options. Use --help.\n");
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${diagnosticsCaptureHelp()}\n`);
    return;
  }
  try {
    const result = await runDiagnosticsCapture(options);
    process.stdout.write(`[pomegr] Wrote ${result.eventCount} trace events.\n`);
  } catch (error) {
    process.stderr.write(`[pomegr] Diagnostics capture failed: ${error.message}.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
