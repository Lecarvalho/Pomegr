import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseDiagnosticsCaptureArgs, runDiagnosticsCapture } from "./diagnostics-capture.mjs";

/** Export the recent development buffer; never start, clear, or stop recording. */
export function parseDiagnosticsSaveArgs(args = [], { now = () => new Date(), nonce = () => randomUUID().slice(0, 8) } = {}) {
  const captureArgs = [];
  let windowMs = 300_000;
  let sessionKey;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--last", "--session"].includes(argument)) {
      const value = args[++index];
      if (typeof value !== "string" || value.startsWith("--")) throw new TypeError("Save option requires a value");
      if (argument === "--last") {
        const match = /^(\d+)(s|m)$/u.exec(value);
        if (!match) throw new TypeError("Save window must use seconds or minutes");
        windowMs = Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000);
        if (!Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 300_000) throw new TypeError("Save window must be 1s through 5m");
      } else {
        if (!/^(?:claude|codex):[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(value)) throw new TypeError("Invalid normalized session selector");
        sessionKey = value;
      }
    } else if (["--port", "--descriptor", "--output", "--out"].includes(argument)) {
      captureArgs.push(argument, args[++index]);
    } else if (["--help", "-h"].includes(argument)) captureArgs.push(argument);
    else throw new TypeError("Unknown diagnostics save option");
  }
  if (!captureArgs.some((value) => ["--output", "--out"].includes(value))) {
    const filename = `${now().toISOString().replace(/[:.]/gu, "-")}-${nonce()}.trace.json`;
    captureArgs.push("--output", path.join("outputs", "pipeline-traces", filename));
  }
  return Object.freeze({ ...parseDiagnosticsCaptureArgs(captureArgs), mode: "save", durationSeconds: 1, windowMs,
    ...(sessionKey ? { sessionKey } : {}) });
}

export function diagnosticsSaveHelp() {
  return ["Usage: npm run diagnostics:save -- [--last 5m] [--session <normalized-id>] [--output <local-file>] [--port <port>]",
    "Saves retained development history immediately; recording continues.",
    "Default: up to five minutes, all sessions, timestamped JSON under outputs/pipeline-traces/.",
    "Existing output files are never overwritten. Requires npm run dev; unavailable in desktop/production."].join("\n");
}

async function main() {
  let options;
  try { options = parseDiagnosticsSaveArgs(process.argv.slice(2)); }
  catch { process.stderr.write("[pomegr] Invalid diagnostics save options. Use --help.\n"); process.exitCode = 1; return; }
  if (options.help) { process.stdout.write(`${diagnosticsSaveHelp()}\n`); return; }
  try {
    const result = await runDiagnosticsCapture(options);
    process.stdout.write(`[pomegr] Saved ${result.eventCount} events to ${result.outputPath}\n`);
    if (result.rolling) process.stdout.write(`[pomegr] Retained ${result.rolling.retainedMs} ms; capacity-limited: ${result.rolling.capacityLimited}. Recording continues.\n`);
    if (result.rolling?.selection === "session" && result.rolling.matchedEvents === 0) {
      process.stdout.write("[pomegr] No retained events matched the selected session; export contains shared work only.\n");
    }
  } catch (error) {
    process.stderr.write(`[pomegr] Diagnostics save failed: ${error.message}.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
