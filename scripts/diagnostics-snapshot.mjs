import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { normalizePipelineOperationsSnapshot } from "../monitor/pipeline-operations.mjs";
import { pipelineOperationsEndpoint } from "../monitor/pipeline-operations-transport.mjs";

const DEFAULT_PORT = 4317;
const MAX_LINE_BYTES = 256 * 1024;
const SNAPSHOT_TIMEOUT_MS = 5_000;

function port(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("Diagnostics snapshot port must be between 1 and 65535");
  }
  return parsed;
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
  if (!count(timing?.windowCount)) return `| ${label} | — | — | — | — | — | 0 |`;
  return `| ${label} | ${duration(timing.lastMs).trim()} | ${duration(timing.averageMs).trim()} | ${duration(timing.p50Ms).trim()} | ${duration(timing.p95Ms).trim()} | ${duration(timing.maxMs).trim()} | ${count(timing.windowCount)} |`;
}

function failureRows(providers) {
  const rows = [];
  for (const entry of providers) {
    const counts = { ...entry.failures, acquisitionFailures: entry.counters.acquisitionFailures };
    for (const [category, total] of Object.entries(counts)) {
      if (!count(total)) continue;
      const detail = entry.failureDetails[category];
      rows.push(`- **${entry.id} · ${category}**: ${total}`);
      rows.push(detail
        ? `  - ${detail.stage} · ${detail.reason} · ${detail.observedAt || "time unavailable"}`
        : "  - Detail unavailable (not recorded by this monitor).");
      if (detail?.validation) {
        for (const issue of detail.validation.issues) rows.push(`    - ${issue.field} · ${issue.rule}`);
        if (!detail.validation.issues.length) rows.push("    - Validation fields unavailable.");
        if (detail.validation.truncated) rows.push("    - Additional validation issues omitted.");
      }
    }
  }
  return rows;
}

export function parseDiagnosticsSnapshotArgs(args = []) {
  const options = { port: port(process.env.SESSION_PULSE_PORT || DEFAULT_PORT), provider: "", json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--markdown") options.json = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--port") options.port = port(args[index += 1]);
    else if (argument === "--provider") {
      const provider = String(args[index += 1] || "");
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider)) throw new TypeError("Diagnostics snapshot provider is invalid");
      options.provider = provider;
    } else throw new TypeError("Unknown diagnostics snapshot option");
  }
  return Object.freeze(options);
}

export function formatDiagnosticsSnapshot(value, { provider = "" } = {}) {
  const snapshot = normalizePipelineOperationsSnapshot(value);
  const providers = snapshot.providers.filter((entry) => !provider || entry?.id === provider);
  const lines = [
    "# Pomegr diagnostics snapshot",
    "",
    `Observed at: ${snapshot.observedAt || "time unavailable"}`,
    `Revisions: catalog ${count(snapshot.revisions?.catalog)}, home ${count(snapshot.revisions?.home)}, usage ${count(snapshot.revisions?.usageLimits)}`,
    "",
    "## Workers",
    "",
    "| Provider | Active | Capacity | Queued | Coalesced | Dirty | Failures |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  if (!providers.length) lines.push("| No matching provider diagnostics. |  |  |  |  |  |  |");
  for (const entry of providers) {
    const failures = Object.values(entry.failures || {}).reduce((sum, value) => sum + count(value), 0)
      + count(entry.counters?.acquisitionFailures);
    lines.push(`| ${entry.id} | ${count(entry.workers?.active)} | ${count(entry.workers?.capacity)} | ${count(entry.workers?.pending)} | ${count(entry.counters?.hydrationsCoalesced)} | ${count(entry.counters?.hydrationDirtyAgain)} | ${failures} |`);
  }
  const failures = failureRows(providers);
  if (failures.length) lines.push("", "## Failures", "", ...failures);
  lines.push(
    "",
    "## Pipeline timings",
    "",
    "| Stage | Last | Average | p50 | p95 | Max | Samples |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
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
  );
  return lines.join("\n");
}

export function diagnosticsSnapshotHelp() {
  return [
    "Usage: npm run diagnostics:snapshot -- [options]",
    "",
    "Options:",
    "  --provider <id>  Show one provider",
    "  --port <port>    Read a non-default monitor port",
    "  --json           Print one bounded JSON snapshot",
    "  --markdown       Print one Markdown snapshot (default)",
    "  --help, -h       Show this help",
  ].join("\n");
}

export function runDiagnosticsSnapshot(options, {
  connect = createConnection,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const endpoint = pipelineOperationsEndpoint(options.port);
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let timer;
    let socket;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) cancel(timer);
      socket?.destroy();
      reject(error);
    };
    const finish = (snapshot) => {
      if (settled) return;
      settled = true;
      if (timer) cancel(timer);
      socket?.end();
      resolve(Object.freeze({ snapshot, output: options.json ? JSON.stringify(snapshot) : formatDiagnosticsSnapshot(snapshot, options) }));
    };
    timer = schedule(() => fail(new Error("DIAGNOSTICS_SNAPSHOT_TIMEOUT")), SNAPSHOT_TIMEOUT_MS);
    try { socket = connect(endpoint); } catch { fail(new Error("DIAGNOSTICS_SNAPSHOT_CONNECTION_FAILED")); return; }
    socket.setEncoding?.("utf8");
    socket.once("error", () => fail(new Error("DIAGNOSTICS_SNAPSHOT_CONNECTION_FAILED")));
    socket.once("close", () => { if (!settled) fail(new Error("DIAGNOSTICS_SNAPSHOT_EMPTY")); });
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) { fail(new Error("DIAGNOSTICS_SNAPSHOT_TOO_LARGE")); return; }
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      const line = buffer.slice(0, boundary);
      try { finish(normalizePipelineOperationsSnapshot(JSON.parse(line))); }
      catch { fail(new Error("DIAGNOSTICS_SNAPSHOT_INVALID")); }
    });
  });
}

async function main() {
  let options;
  try { options = parseDiagnosticsSnapshotArgs(process.argv.slice(2)); } catch {
    process.stderr.write("[pomegr] Invalid diagnostics snapshot options. Use --help.\n");
    process.exitCode = 1;
    return;
  }
  if (options.help) { process.stdout.write(`${diagnosticsSnapshotHelp()}\n`); return; }
  try {
    const result = await runDiagnosticsSnapshot(options);
    process.stdout.write(`${result.output}\n`);
  } catch (error) {
    process.stderr.write(`[pomegr] Diagnostics snapshot failed: ${error.message}.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
