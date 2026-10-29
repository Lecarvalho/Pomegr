// Measures how long the monitor's event loop stalls while it observes this machine's real
// sessions, and how long /api/sessions takes meanwhile. It starts its own monitor on a
// loopback port with a fresh temporary data folder, so the running app and its stores are
// untouched; observation stays read-only. With --profile it also samples the CPU and names
// the monitor code that ran during each long stall. It prints numbers and code locations
// only: no session, path, or provider content.
//
//   node scripts/measure-monitor-event-loop.mjs [--seconds 300] [--port 4399] [--profile out.cpuprofile]
//
// With --spawn-burst <count> it starts no monitor: it runs `git status` in this repository
// <count> times at once, first with `execFile` on this thread and then through the monitor's
// command runner, and prints the longest event-loop stall of each.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  seconds: { type: "string", default: "300" },
  port: { type: "string", default: "4399" },
  profile: { type: "string" },
  "stall-ms": { type: "string", default: "500" },
  "spawn-burst": { type: "string" },
} });
const seconds = Number(values.seconds);
const port = Number(values.port);
const stallMs = Number(values["stall-ms"]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (values["spawn-burst"]) {
  const count = Number(values["spawn-burst"]);
  const { runExecFile } = await import(pathToFileURL(path.join(root, "server/normalize/exec-file-runner.mjs")).href);
  const args = ["-C", root, "status", "--porcelain=v1"];
  const burst = async (label, start) => {
    let last = performance.now(); let longest = 0;
    const tick = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last - 5); last = now; }, 5);
    const started = performance.now();
    await Promise.all(Array.from({ length: count }, () => new Promise((resolve) => start(resolve))));
    clearInterval(tick);
    console.log(`${label}: ${count} commands in ${Math.round(performance.now() - started)} ms, longest stall ${Math.round(longest)} ms`);
  };
  await burst("execFile on this thread", (resolve) => execFile("git", args, { windowsHide: true }, resolve));
  await burst("monitor command runner", (resolve) => runExecFile("git", args, { windowsHide: true }, resolve));
  process.exit(0);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-event-loop-"));
process.env.POMEGR_DATA_DIR = dataDir;
process.env.POMEGR_COST_SNAPSHOTS_DIR = path.join(dataDir, "cost-snapshots");

let session = null;
if (values.profile) {
  const { Session } = await import("node:inspector/promises");
  session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 1000 });
  await session.post("Profiler.start");
}
const origin = performance.now();
const { startMonitorServer } = await import(pathToFileURL(path.join(root, "server/server.mjs")).href);
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const handle = await startMonitorServer({ host: "127.0.0.1", port, logger: quiet, pipelineOperations: false });

// A 20 ms tick that arrives late measures the stall that held it.
const stalls = [];
let last = performance.now();
const tick = setInterval(() => {
  const now = performance.now();
  if (now - last - 20 >= 100) stalls.push({ atMs: last - origin, ms: Math.round(now - last - 20) });
  last = now;
}, 20);
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

// The client runs on its own thread, so a stall delays its answer, never its request.
const poller = new Worker(`
  const { parentPort, workerData } = require("node:worker_threads");
  const latencies = [];
  let stopped = false;
  parentPort.on("message", () => { stopped = true; });
  (async () => {
    while (!stopped) {
      const started = performance.now();
      try {
        const response = await fetch(workerData.url, { signal: AbortSignal.timeout(30000) });
        await response.arrayBuffer();
        if (response.ok) latencies.push(performance.now() - started);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    parentPort.postMessage(latencies);
  })();
`, { eval: true, workerData: { url: `http://127.0.0.1:${port}/api/sessions?mode=directory&pageSize=50` } });

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
clearInterval(tick);
histogram.disable();
const latencies = await new Promise((resolve) => { poller.once("message", resolve); poller.postMessage("stop"); });
await poller.terminate();
const profile = session ? (await session.post("Profiler.stop")).profile : null;
await handle.close();
fs.rmSync(dataDir, { recursive: true, force: true });

const quantile = (sorted, q) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : null;
const gaps = stalls.map((stall) => stall.ms).sort((a, b) => a - b);
const answers = [...latencies].sort((a, b) => a - b);
console.log(JSON.stringify({
  seconds,
  eventLoopDelayMs: { p50: Math.round(histogram.percentile(50) / 1e6), p99: Math.round(histogram.percentile(99) / 1e6), max: Math.round(histogram.max / 1e6) },
  stalls: { over100ms: gaps.length, over500ms: gaps.filter((ms) => ms >= 500).length, over1000ms: gaps.filter((ms) => ms >= 1000).length, blockedMs: gaps.reduce((sum, ms) => sum + ms, 0), largestMs: gaps.slice(-5).reverse() },
  apiSessionsMs: { requests: answers.length, p50: quantile(answers, 0.5), p90: quantile(answers, 0.9), p99: quantile(answers, 0.99), max: answers.length ? Math.round(answers.at(-1)) : null },
}, null, 2));

if (profile) {
  fs.writeFileSync(values.profile, JSON.stringify(profile));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);
  const monitorFrame = (node) => /[\\/](server|shared)[\\/]/u.test(node.callFrame.url || "");
  const label = (node) => `${node.callFrame.functionName || "(anonymous)"} ${(node.callFrame.url || "").replace(/^.*?[\\/](?=(server|shared)[\\/])/u, "")}:${node.callFrame.lineNumber + 1}`;
  const stack = (id) => { const frames = []; for (let at = id; at !== undefined; at = parent.get(at)) frames.push(nodes.get(at)); return frames; };
  // Stall times are relative to `origin`, read just after the profiler started.
  const sampleTimes = [];
  let at = profile.startTime;
  for (const delta of profile.timeDeltas) { at += delta; sampleTimes.push(at); }
  const callers = new Map(); const leaves = new Map(); let samples = 0;
  for (const stall of stalls.filter((entry) => entry.ms >= stallMs)) {
    const from = profile.startTime + stall.atMs * 1000; const to = from + (stall.ms + 20) * 1000;
    sampleTimes.forEach((time, index) => {
      if (time < from || time > to) return;
      const frames = stack(profile.samples[index]);
      const own = frames.filter(monitorFrame);
      const caller = own.length ? own.slice(-2).map(label).join(" < ") : "(outside monitor code)";
      const leaf = own.length ? `${label(own[0])} > ${label(frames[0])}` : label(frames[0]);
      callers.set(caller, (callers.get(caller) || 0) + 1);
      leaves.set(leaf, (leaves.get(leaf) || 0) + 1);
      samples += 1;
    });
  }
  const top = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, count]) => `${String(Math.round(100 * count / samples)).padStart(4)}%  ${key}`).join("\n");
  console.log(`\nCPU samples during stalls of ${stallMs} ms or more: ${samples}`);
  console.log(`\nOutermost monitor frames:\n${top(callers)}\n\nInnermost monitor frame > running frame:\n${top(leaves)}`);
}
process.exit(0);
