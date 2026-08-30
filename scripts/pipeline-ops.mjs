import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import {
  normalizePipelineOperationsSnapshot,
} from "../monitor/pipeline-operations.mjs";
import { pipelineOperationsEndpoint } from "../monitor/pipeline-operations-transport.mjs";

const DEFAULT_PORT = 4317;
const RETRY_MS = 1_000;
const MAX_LINE_BYTES = 256 * 1024;

function port(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("Pipeline operations port must be between 1 and 65535");
  }
  return parsed;
}

export function parsePipelineOperationsArgs(args = []) {
  const options = { port: port(process.env.SESSION_PULSE_PORT || DEFAULT_PORT), provider: "", json: false, once: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--once") options.once = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--port") options.port = port(args[index += 1]);
    else if (argument === "--provider") {
      const provider = String(args[index += 1] || "");
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider)) throw new TypeError("Pipeline operations provider is invalid");
      options.provider = provider;
    } else throw new TypeError("Unknown pipeline operations option");
  }
  return Object.freeze(options);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function duration(value, width = 7) {
  const milliseconds = count(value);
  const label = milliseconds >= 60_000
    ? `${(milliseconds / 60_000).toFixed(1)}m`
    : milliseconds >= 1_000 ? `${(milliseconds / 1_000).toFixed(2)}s` : `${milliseconds}ms`;
  return label.padStart(width);
}

function timingRow(label, timing) {
  if (!count(timing?.windowCount)) return `${label.padEnd(35)} ${"—".padStart(7)} ${"—".padStart(7)} ${"—".padStart(7)} ${"—".padStart(7)} ${"—".padStart(7)} ${"0".padStart(7)}`;
  return `${label.padEnd(35)} ${duration(timing.lastMs)} ${duration(timing.averageMs)} ${duration(timing.p50Ms)} ${duration(timing.p95Ms)} ${duration(timing.maxMs)} ${String(count(timing.windowCount)).padStart(7)}`;
}

function failureRows(providers) {
  const rows = [];
  for (const entry of providers) {
    const counts = { ...entry.failures, acquisitionFailures: entry.counters.acquisitionFailures };
    for (const [category, total] of Object.entries(counts)) {
      if (!count(total)) continue;
      const detail = entry.failureDetails[category];
      rows.push(`${entry.id} · ${category}: ${total}`);
      rows.push(detail
        ? `  ${detail.stage} · ${detail.reason} · ${detail.observedAt || "time unavailable"}`
        : "  Detail unavailable (not recorded by this monitor).");
      if (detail?.validation) {
        for (const issue of detail.validation.issues) rows.push(`    ${issue.field} · ${issue.rule}`);
        if (!detail.validation.issues.length) rows.push("    Validation fields unavailable.");
        if (detail.validation.truncated) rows.push("    Additional validation issues omitted.");
      }
    }
  }
  return rows.length ? ["", "FAILURES · cumulative counts; latest detail per category", ...rows] : [];
}

export function formatPipelineOperationsSnapshot(snapshot, { provider = "" } = {}) {
  snapshot = normalizePipelineOperationsSnapshot(snapshot);
  const providers = snapshot.providers.filter((entry) => !provider || entry?.id === provider);
  const lines = [
    `Pomegr pipeline operations  ·  ${snapshot.observedAt || "time unavailable"}`,
    `Revisions: catalog ${count(snapshot.revisions?.catalog)}  home ${count(snapshot.revisions?.home)}  usage ${count(snapshot.revisions?.usageLimits)}`,
    "",
    "WORKERS",
    `${"Provider".padEnd(12)} ${"Active".padStart(7)} ${"Capacity".padStart(9)} ${"Queued".padStart(7)} ${"Coalesced".padStart(10)} ${"Dirty".padStart(7)} ${"Failures".padStart(9)}`,
  ];
  if (!providers.length) lines.push("No matching provider diagnostics.");
  for (const entry of providers) {
    const failures = Object.values(entry.failures || {}).reduce((sum, value) => sum + count(value), 0)
      + count(entry.counters?.acquisitionFailures);
    lines.push(`${String(entry.id).padEnd(12)} ${String(count(entry.workers?.active)).padStart(7)} ${String(count(entry.workers?.capacity)).padStart(9)} ${String(count(entry.workers?.pending)).padStart(7)} ${String(count(entry.counters?.hydrationsCoalesced)).padStart(10)} ${String(count(entry.counters?.hydrationDirtyAgain)).padStart(7)} ${String(failures).padStart(9)}`);
  }
  lines.push(
    ...failureRows(providers),
    "",
    "PIPELINE TIMINGS",
    `${"Stage".padEnd(35)} ${"Last".padStart(7)} ${"Avg".padStart(7)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"Max".padStart(7)} ${"Window".padStart(7)}`,
  );
  for (const entry of providers) {
    lines.push(
      timingRow(`${entry.id} · catalog discovery`, entry.timings?.catalogDiscovery),
      timingRow(`${entry.id} · source queue`, entry.timings?.queueWait),
      timingRow(`${entry.id} · source preparation`, entry.timings?.preparation),
      timingRow(`${entry.id} · acquire + normalize`, entry.timings?.acquisitionNormalization),
    );
  }
  lines.push(
    timingRow("shared · catalog commit wait", snapshot.catalog?.timings?.commitWait),
    timingRow("shared · catalog projection", snapshot.catalog?.timings?.projectionCommit),
    timingRow("shared · session commit wait", snapshot.session?.timings?.commitWait),
    timingRow("shared · session derivation", snapshot.session?.timings?.derivation),
    timingRow("shared · normalized store commit", snapshot.session?.timings?.storeCommit),
    timingRow("shared · candidate to commit", snapshot.session?.timings?.candidateToCommit),
    "",
    "V1 combines provider acquisition and normalization. Browser render timing is a future milestone.",
    "Press Ctrl+C to stop.",
  );
  return lines.join("\n");
}

export function pipelineOperationsHelp() {
  return [
    "Usage: npm run ops:pipeline -- [options]",
    "",
    "Options:",
    "  --provider <id>  Show one provider",
    "  --port <port>     Connect to a non-default monitor port",
    "  --json            Print bounded NDJSON snapshots",
    "  --once            Print one snapshot and exit",
    "  --help, -h        Show this help",
  ].join("\n");
}

export function runPipelineOperationsCli(options, {
  connect = createConnection,
  stdout = process.stdout,
  stderr = process.stderr,
  schedule = setTimeout,
  cancel = clearTimeout,
  setExitCode = (value) => { process.exitCode = value; },
} = {}) {
  const endpoint = pipelineOperationsEndpoint(options.port);
  let stopped = false;
  let warned = false;
  let socket = null;
  let retryTimer = null;

  const connectOnce = () => {
    if (stopped) return;
    retryTimer = null;
    let buffer = "";
    socket = connect(endpoint);
    socket.setEncoding?.("utf8");
    socket.on("connect", () => { warned = false; });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        buffer = "";
        socket.destroy();
        return;
      }
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        try {
          const snapshot = normalizePipelineOperationsSnapshot(JSON.parse(line));
          const rendered = options.json
            ? JSON.stringify(snapshot)
            : formatPipelineOperationsSnapshot(snapshot, options);
          stdout.write(options.json || !stdout.isTTY ? `${rendered}\n` : `\u001b[2J\u001b[H${rendered}\n`);
          if (options.once) {
            stopped = true;
            socket.end();
            return;
          }
        } catch {
          if (!warned) stderr.write("[pomegr] Pipeline operations snapshot rejected.\n");
          warned = true;
        }
      }
    });
    socket.on("error", () => {
      if (!warned) stderr.write("[pomegr] Waiting for the local pipeline operations feed. Start Pomegr with npm run dev.\n");
      warned = true;
    });
    socket.on("close", () => {
      socket = null;
      if (stopped) return;
      if (options.once) {
        stopped = true;
        setExitCode(1);
        return;
      }
      retryTimer = schedule(connectOnce, RETRY_MS);
    });
  };

  connectOnce();
  return Object.freeze({
    close() {
      stopped = true;
      if (retryTimer !== null) cancel(retryTimer);
      retryTimer = null;
      socket?.destroy();
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parsePipelineOperationsArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(`${pipelineOperationsHelp()}\n`);
    else runPipelineOperationsCli(options);
  } catch {
    process.stderr.write("[pomegr] Invalid pipeline operations options. Use --help.\n");
    process.exitCode = 1;
  }
}
