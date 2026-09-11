import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPipelineTraceRecorder } from "../monitor/pipeline-trace.mjs";

function optionsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  const outputDirectory = values.get("--output-directory");
  const repeat = Number.parseInt(values.get("--repeat") || "10", 10);
  if (!outputDirectory || !Number.isSafeInteger(repeat) || repeat < 5 || repeat > 50) throw new TypeError("--output-directory is required; --repeat is 5 through 50");
  return { outputDirectory: path.resolve(outputDirectory), repeat };
}
function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3));
}
function sample(enabled) {
  const recorder = createPipelineTraceRecorder({ enabled });
  const beforeCpu = process.cpuUsage();
  const beforeMemory = process.memoryUsage().rss;
  const startedAt = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    recorder.recordDuration({ stage: "history_publish", domain: "activity", durationMs: index % 7 });
    recorder.recordCounter({ counter: "records", value: index });
  }
  const elapsedMs = performance.now() - startedAt;
  const afterCpu = process.cpuUsage(beforeCpu);
  const afterMemory = process.memoryUsage().rss;
  return Object.freeze({ elapsedMs: Number(elapsedMs.toFixed(3)), cpuMicros: afterCpu.user + afterCpu.system, rssDeltaBytes: afterMemory - beforeMemory,
    eventCount: recorder.snapshot().traceEvents.length });
}
const options = optionsFrom(process.argv.slice(2));
const disabled = Array.from({ length: options.repeat }, () => sample(false));
const enabled = Array.from({ length: options.repeat }, () => sample(true));
const summary = Object.freeze({ version: 1, kind: "synthetic_trace_recorder_overhead", workload: "1000 history_publish spans and 1000 records counters per sample",
  caveat: "Process-local synthetic recorder cost only; it is not a provider, browser, or production-session measurement.", samples: options.repeat,
  disabled: { p50ElapsedMs: percentile(disabled.map((item) => item.elapsedMs), .5), p95ElapsedMs: percentile(disabled.map((item) => item.elapsedMs), .95), samples: disabled },
  enabled: { p50ElapsedMs: percentile(enabled.map((item) => item.elapsedMs), .5), p95ElapsedMs: percentile(enabled.map((item) => item.elapsedMs), .95), samples: enabled },
});
await mkdir(options.outputDirectory, { recursive: true });
await writeFile(path.join(options.outputDirectory, "trace-overhead-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary));
