import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validTrace } from "./diagnostics-capture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/providers/codex/expected-session-evidence.json");
const scenarios = Object.freeze([
  { name: "synthetic_cold_start_history", retained: 0, append: 1, hold: 50, disk: false },
  { name: "synthetic_restored_history", retained: 1000, append: 0, hold: 0, restored: true },
  { name: "synthetic_warm_append_history", retained: 1000, append: 1, hold: 500 },
  { name: "synthetic_continuous_burst_history", retained: 1000, append: 16, hold: 500, burst: true },
]);
const replayDelayMs = 30;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const importFrom = (folder, relative) => import(pathToFileURL(path.join(folder, relative)).href);
const p = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return Number(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)].toFixed(3)); };
function args(argv) {
  const values = new Map(); for (let i = 0; i < argv.length; i += 2) values.set(argv[i], argv[i + 1]);
  const repeat = Number.parseInt(values.get("--repeat") || "5", 10);
  if (!values.get("--baseline-root") || !values.get("--output-directory") || !Number.isSafeInteger(repeat) || repeat < 5 || repeat > 10) throw new TypeError("--baseline-root and --output-directory are required; --repeat must be 5 through 10");
  return { baseline: path.resolve(values.get("--baseline-root")), output: path.resolve(values.get("--output-directory")), repeat };
}
function row(id, timestamp) { return { id, timestamp, actor: "Primary agent", tool: "Read", workKind: "read", detail: "Synthetic activity", status: null, durationMs: null, requestId: null, agentId: "primary" }; }
function rows(evidence, count, prefix, offset = 0) { const start = Date.parse(evidence.session.startedAt); return Array.from({ length: count }, (_, i) => row(`${prefix}-${i + 1}`, new Date(start + (offset + i) * 1000).toISOString())); }
async function versionAndDigest(folder) {
  const packageJson = JSON.parse(await readFile(path.join(folder, "package.json"), "utf8"));
  const files = ["monitor/server.mjs", "monitor/observation-runtime.mjs", "monitor/session-history-store.mjs", "monitor/session-observation-coordinator.mjs"];
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(await readFile(path.join(folder, file)));
  return { packageVersion: packageJson.version, buildDigestSha256: hash.digest("hex") };
}
async function run(folder, scenario) {
  const [{ createMonitorRuntime }, { SessionHistoryStore }, { createEmptyProviderCapabilities, createEmptyUsageLimits }] = await Promise.all([importFrom(folder, "monitor/server.mjs"), importFrom(folder, "monitor/session-history-store.mjs"), importFrom(folder, "shared/monitor-state.mjs")]);
  const evidence = JSON.parse(await readFile(fixture, "utf8")); const directory = scenario.disk === false ? null : await mkdtemp(path.join(os.tmpdir(), "pomegr-benchmark-")); const sessionId = `codex:${evidence.localId}`;
  const retained = rows(evidence, scenario.retained, "retained"); const appended = scenario.name === "synthetic_cold_start_history" ? [row("synthetic-call-1", evidence.session.startedAt)] : rows(evidence, scenario.append, "append", scenario.retained); const all = scenario.restored ? retained : [...retained, ...appended];
  const store = new SessionHistoryStore({ directory, maxResident: scenario.disk === false ? 1 : 0 }); if (retained.length) await store.publish(sessionId, { complete: true, requests: [], activity: retained });
  let releaseGate; const gate = new Promise((resolve) => { releaseGate = resolve; }); let sourceAt; let releasedAt; let released = false; let releaseTimer; let reads = 0; let publications = 0; let gets = 0;
  const cpu = process.cpuUsage(); const rss = process.memoryUsage().rss; const release = () => { if (!released) { released = true; releasedAt = performance.now(); releaseGate(); } };
  const provider = { id: "codex", source: "Codex", capabilities: createEmptyProviderCapabilities(), homePolicy: { requestModelObservations: false, modelSelection: false, usageLimitActivity: { enabled: false } }, async readSessionHistory() { reads += 1; await pause(replayDelayMs); return { complete: true, requests: [], activity: all }; } };
  const inventory = { ready: Promise.resolve(), async reconcile() {}, startPluginObservation() {}, async stopPluginObservation() {}, subscribe() { return () => {}; }, readRepositories() { return null; }, async associateSession() { await gate; return {}; }, readRevision() { return null; }, capture() { return null; }, refreshPluginSetup() { return null; }, readPluginSetup() { return null; }, preparePluginAction() { return null; } };
  const registry = { providers: [provider], defaultProvider: provider, providerForSessionId: () => provider, async resolveCapabilities() { return provider.capabilities; }, async readUsageLimits() { return createEmptyUsageLimits(); }, async inspectSessions() { return { sessions: [], resourceTargets: [] }; }, unavailableMessage: () => "Unavailable", async startObservers(publisher) {
    sourceAt = performance.now(); releaseTimer = setTimeout(release, scenario.hold); publisher.publishCatalog("codex", [{ localId: evidence.localId, title: evidence.session.title, project: evidence.session.project, updatedAt: evidence.session.updatedAt, isLive: true, needsInput: false, activityStatus: "working" }]);
    if (!scenario.restored && typeof publisher.publishHistoryContribution === "function") for (let i = 0; i < appended.length; i += 1) { publications += 1; publisher.publishHistoryContribution("codex", evidence.localId, { epoch: 1, sequence: i + 1, activity: [appended[i]] }); if (scenario.burst) { const next = structuredClone(evidence); next.session.updatedAt = new Date(Date.parse(evidence.session.updatedAt) + i + 1).toISOString(); publisher.publishSession("codex", evidence.localId, next); } }
    publisher.publishSession("codex", evidence.localId, evidence); return { async hydrate() { return true; }, async stop() {} };
  } };
  const runtime = createMonitorRuntime({ providerRegistry: registry, checkpointStore: false, historyStore: store, repositoryInventory: inventory, observationCommitDelayMs: 0, scheduleObservation: (task) => setTimeout(task, 0), resourceUsageSampler: { async sample() {}, get() { return null; } } });
  try {
    await runtime.startObservation(); let first; let lastStatus = "unknown"; const deadline = performance.now() + 1000;
    while (performance.now() < deadline) { gets += 1; const page = await runtime.serveSessionHistory(sessionId, { kind: "activity", limit: "8" }); lastStatus = page.status; if (page.status === "ready" && page.total === all.length) { first = performance.now(); break; } await pause(1); }
    if (!first) { const direct = await store.read(sessionId, { kind: "activity", limit: "8" }); throw new Error(`${scenario.name}: Activity readiness timeout (${lastStatus}, direct=${direct.status}, reads=${reads})`); } while (!released) await pause(1); let complete; const convergence = performance.now() + 1000;
    while (performance.now() < convergence) { gets += 2; const requestPage = await runtime.serveSessionHistory(sessionId, { kind: "requests" }); const activityPage = await runtime.serveSessionHistory(sessionId, { kind: "activity", limit: "8" }); if (requestPage.status === "ready" && activityPage.status === "ready" && activityPage.total === all.length) { complete = performance.now(); break; } await pause(1); }
    if (!complete) throw new Error(`${scenario.name}: convergence timeout`); const verified = await runtime.serveSessionHistory(sessionId, { kind: "activity", limit: "8" }); assert.equal(verified.total, all.length); assert.ok(verified.items.every((item) => item.agentId === "primary" && item.requestId === null && item.durationMs === null)); const used = process.cpuUsage(cpu);
    return { firstReadyMs: +(first - sourceAt).toFixed(3), releaseMs: +(releasedAt - sourceAt).toFixed(3), convergedMs: +(complete - sourceAt).toFixed(3), cpuMs: +((used.user + used.system) / 1000).toFixed(3), rssDeltaBytes: process.memoryUsage().rss - rss, historyReads: reads, historyGets: gets, contributionPublications: publications, expectedActivityRows: all.length };
  } finally { clearTimeout(releaseTimer); release(); await runtime.stopObservation(); if (directory) try { await rm(directory, { recursive: true, force: true }); } catch { await pause(25); try { await rm(directory, { recursive: true, force: true }); } catch {} } }
}
function trace(scenario, samples) {
  const traceEvents = samples.flatMap((sample, i) => [{ name: "benchmark_source", cat: "activity", ph: "X", ts: i * 2000000, dur: 0, pid: 1, tid: 1, args: { outcome: "observed" } }, { name: "history_publish", cat: "activity", ph: "X", ts: i * 2000000, dur: Math.round(sample.firstReadyMs * 1000), pid: 1, tid: 1, args: { outcome: "completed" } }]);
  const output = { traceEvents, metadata: { version: 1, provenance: { buildVersion: "0.4.0", scenario: scenario.name, clockQuality: "performance.now" }, capture: { active: false, incomplete: false, eventCount: traceEvents.length, droppedEvents: 0, droppedSpans: 0, droppedHandles: 0, openSpanCount: 0, flowCount: 0, revisionCount: 0 }, coverage: { enabledStages: ["benchmark_source", "history_publish"], observedStages: ["benchmark_source", "history_publish"] } } }; assert.equal(validTrace(output), true); return output;
}
function statistics(samples) { return { firstReady: { p50Ms: p(samples.map((x) => x.firstReadyMs), .5), p95Ms: p(samples.map((x) => x.firstReadyMs), .95) }, convergence: { p50Ms: p(samples.map((x) => x.convergedMs), .5), p95Ms: p(samples.map((x) => x.convergedMs), .95) }, cpuMs: { p50: p(samples.map((x) => x.cpuMs), .5), p95: p(samples.map((x) => x.cpuMs), .95) }, rssDeltaBytes: { p50: p(samples.map((x) => x.rssDeltaBytes), .5), p95: p(samples.map((x) => x.rssDeltaBytes), .95) }, samples }; }
const options = args(process.argv.slice(2)); await mkdir(options.output, { recursive: true }); const reproducibility = { node: process.version, platform: process.platform, arch: process.arch, pairedSameProcess: true, baseline: await versionAndDigest(options.baseline), current: await versionAndDigest(root), workload: { retainedRows: 1000, burstCount: 16, historyReplayGateMs: replayDelayMs, heldDerivationMsByScenario: Object.fromEntries(scenarios.map((scenario) => [scenario.name, scenario.hold])), observationCommitDelayMs: 0, maxResident: 0 } }; const summaries = [];
for (const scenario of scenarios) { const baseline = []; const current = []; for (let i = 0; i < options.repeat; i += 1) { baseline.push(await run(options.baseline, scenario)); current.push(await run(root, scenario)); } const b = statistics(baseline); const c = statistics(current); const held = scenario.hold > 0; const acceptance = { expectedRows: current.every((x) => x.expectedActivityRows === scenario.retained + scenario.append), firstReadyBeforeRelease: !held || current.every((x) => x.firstReadyMs < x.releaseMs), p95BelowHalfHeldBaseline: !held || c.firstReady.p95Ms < b.firstReady.p95Ms * .5, finalCompleteWithinOneSecond: current.every((x) => x.convergedMs < 1000), burstDoesNotStarveHistory: !scenario.burst || current.every((x) => x.contributionPublications === scenario.append && x.firstReadyMs < x.releaseMs) }; const summary = { version: 1, kind: "synthetic_progressive_history_benchmark", scenario: scenario.name, samples: options.repeat, clock: "performance.now", requestedDelaysMs: { heldSessionDerivationMs: scenario.hold, historyReplayMs: replayDelayMs }, reproducibility, baseline: b, current: c, acceptance, note: "Controlled fixture measurement only: history publication/cache serving/convergence. It does not measure provider I/O, whole-app resource use, browser paint, or renderer clock correlation." }; summaries.push(summary); await Promise.all([writeFile(path.join(options.output, `${scenario.name}-before.trace.json`), `${JSON.stringify(trace(scenario, baseline), null, 2)}\n`), writeFile(path.join(options.output, `${scenario.name}-after.trace.json`), `${JSON.stringify(trace(scenario, current), null, 2)}\n`), writeFile(path.join(options.output, `${scenario.name}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`)]); }
const output = { version: 1, kind: "synthetic_progressive_history_benchmarks", samples: options.repeat, reproducibility, scenarios: summaries }; await writeFile(path.join(options.output, "progressive-history-summary.json"), `${JSON.stringify(output, null, 2)}\n`); console.log(JSON.stringify(output)); if (!summaries.every((x) => Object.values(x.acceptance).every(Boolean))) process.exitCode = 1;
