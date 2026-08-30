import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { startMonitorServer } from "../monitor/server.mjs";
import { createNormalizedPollingObserver } from "../monitor/providers/normalized-polling-observer.mjs";
import { createPipelineFailureRecorder, normalizePipelineFailureDetails } from "../monitor/pipeline-operations-failures.mjs";
import { normalizeSchemaValidationSummary, summarizeSchemaValidationFailure } from "../monitor/pipeline-operations-validation.mjs";
import { createScopedNormalizedObservationPublisher, providerSessionEvidenceSchema } from "../monitor/providers/provider-contract.mjs";
import {
  createDurationSeries,
  createPipelineOperationsSnapshot,
  normalizePipelineOperationsSnapshot,
  PIPELINE_OPERATIONS_VERSION,
} from "../monitor/pipeline-operations.mjs";
import {
  pipelineOperationsEndpoint,
  startPipelineOperationsTransport,
} from "../monitor/pipeline-operations-transport.mjs";
import {
  formatPipelineOperationsSnapshot,
  parsePipelineOperationsArgs,
  pipelineOperationsHelp,
  runPipelineOperationsCli,
} from "../scripts/pipeline-ops.mjs";

async function availablePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test("bounded duration windows report operational percentiles without retaining identities", () => {
  const series = createDurationSeries({ windowSize: 4 });
  for (const value of [1, 5, 10, 50, 100]) series.record(value);
  series.record(-20);
  const snapshot = series.snapshot();

  assert.deepEqual(snapshot, {
    sampleCount: 6,
    windowCount: 4,
    lastMs: 0,
    averageMs: 40,
    p50Ms: 10,
    p95Ms: 100,
    maxMs: 100,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /session|path|prompt|provider/i);
});

test("pipeline operations snapshots expose only the fixed aggregate schema", () => {
  const timing = { sampleCount: 2, windowCount: 2, lastMs: 7, averageMs: 5, p50Ms: 3, p95Ms: 7, maxMs: 7, private: "PRIVATE_MUST_NOT_LEAK" };
  const snapshot = createPipelineOperationsSnapshot({
    coordinator: {
      sessionCandidates: 4,
      sessionCommits: 3,
      rejectedCandidates: 1,
      catalogStructuralFastPaths: 2,
      transcriptPath: "C:\\PRIVATE_TRANSCRIPT_MUST_NOT_LEAK",
      timings: {
        catalogCommitWait: timing,
        catalogProjectionCommit: timing,
        sessionCommitWait: timing,
        sessionDerivation: timing,
        sessionStoreCommit: timing,
        sessionCandidateToCommit: timing,
      },
      observers: {
        codex: {
          hydrationConcurrency: 2,
          activeHydrations: 1,
          pendingHydrations: 3,
          hydrationAttempts: 8,
          prompt: "PROMPT_MUST_NOT_LEAK",
          timings: {
            catalogDiscovery: timing,
            queueWait: timing,
            preparation: timing,
            acquisitionNormalization: timing,
          },
        },
        "INVALID PROVIDER": { private: true },
      },
    },
    providers: {
      codex: { observerHydrationFailures: 1, rawError: "RAW_ERROR_MUST_NOT_LEAK" },
    },
    responseRevisions: { catalog: 12, home: 4, usageLimits: 2, private: 999 },
  }, "2026-08-29T12:00:00.000Z");

  assert.equal(snapshot.version, PIPELINE_OPERATIONS_VERSION);
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0].id, "codex");
  assert.equal(snapshot.providers[0].workers.pending, 3);
  assert.equal(snapshot.providers[0].timings.queueWait.p95Ms, 7);
  assert.deepEqual(snapshot.revisions, { catalog: 12, home: 4, usageLimits: 2 });
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|PROMPT|RAW_ERROR|transcriptPath|rawError/i);

  const revalidated = normalizePipelineOperationsSnapshot({
    ...snapshot,
    private: "PRIVATE_MUST_NOT_LEAK",
    providers: snapshot.providers.map((provider) => ({ ...provider, raw: "RAW_MUST_NOT_LEAK" })),
  });
  assert.doesNotMatch(JSON.stringify(revalidated), /PRIVATE|RAW_MUST_NOT_LEAK/);
});

test("failure details retain only the latest bounded stage, reason and timestamp per category", () => {
  let time = Date.parse("2026-08-30T12:00:00.000Z");
  const recorder = createPipelineFailureRecorder({ now: () => time });
  const error = Object.assign(new Error("PRIVATE_PROMPT C:\\PRIVATE_TRANSCRIPT.jsonl"), {
    code: "EACCES", path: "PRIVATE_PATH", sessionId: "PRIVATE_SESSION", cause: "PRIVATE_CAUSE",
  });
  recorder.record("acquisitionFailures", error, "acquire_normalize");
  const first = recorder.snapshot();
  assert.deepEqual(first, { acquisitionFailures: {
    stage: "acquire_normalize", reason: "EACCES", observedAt: "2026-08-30T12:00:00.000Z",
  } });
  time += 1_000;
  recorder.record("acquisitionFailures", new SyntaxError("PRIVATE_JSON"), "source_preparation");
  recorder.record("PRIVATE_CATEGORY", error, "PRIVATE_STAGE");
  recorder.record("usageLimitReadFailures", error);
  recorder.record("sessionReadFailures", error, "PRIVATE_STAGE");
  assert.deepEqual(Object.keys(recorder.snapshot()), ["acquisitionFailures"]);
  assert.deepEqual(recorder.snapshot().acquisitionFailures, {
    stage: "source_preparation", reason: "SyntaxError", observedAt: "2026-08-30T12:00:01.000Z",
  });
  assert.equal(first.acquisitionFailures.reason, "EACCES", "prior snapshots stay immutable");
  assert.doesNotMatch(JSON.stringify(recorder.snapshot()), /PRIVATE|message|stack|path|sessionId|cause/);

  for (const [thrown, reason] of [
    [new TypeError("PRIVATE"), "TypeError"], [new RangeError("PRIVATE"), "RangeError"],
    [{ code: "ENOENT", message: "PRIVATE" }, "ENOENT"],
    [{ code: "PRIVATE_CODE", name: "TypeError" }, "unknown"],
    ["PRIVATE_STRING", "unknown"], [null, "unknown"],
    [{ get code() { throw new Error("PRIVATE_ACCESSOR"); } }, "unknown"],
  ]) {
    recorder.record("acquisitionFailures", thrown);
    assert.equal(recorder.snapshot().acquisitionFailures.reason, reason);
  }
});

test("failure details are re-allowlisted at both snapshot boundaries and accept older feeds", () => {
  const detail = { stage: "acquire_normalize", reason: "ENOENT", observedAt: "2026-08-30T12:00:00.000Z", message: "PRIVATE_MESSAGE", path: "PRIVATE_PATH" };
  const snapshot = createPipelineOperationsSnapshot({
    coordinator: { observers: { claude: { acquisitionFailures: 1, failureDetails: { acquisitionFailures: detail } } } },
    providers: { claude: {
      observerStartFailures: 1,
      failureDetails: { observerStartFailures: { ...detail, stage: "observer_start" }, PRIVATE_CATEGORY: detail },
    } },
  });
  assert.equal(snapshot.providers[0].failureDetails.acquisitionFailures.reason, "ENOENT");
  assert.equal(snapshot.providers[0].failureDetails.observerStartFailures.stage, "observer_start");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|message|path/);
  const revalidated = normalizePipelineOperationsSnapshot({ ...snapshot, providers: [{
    ...snapshot.providers[0], failureDetails: {
      acquisitionFailures: { ...detail, reason: "PRIVATE\u001b[2J", observedAt: "PRIVATE_TIME" },
      sessionReadFailures: { ...detail, stage: "PRIVATE_STAGE" }, PRIVATE_CATEGORY: detail,
    },
  }] });
  assert.deepEqual(revalidated.providers[0].failureDetails, { acquisitionFailures: {
    stage: "acquire_normalize", reason: "unknown", observedAt: null,
  } });
  assert.doesNotMatch(JSON.stringify(revalidated), /PRIVATE|message|path/);
  assert.deepEqual(normalizePipelineFailureDetails(null), {});
  assert.deepEqual(normalizePipelineOperationsSnapshot({ version: 1, providers: [{ id: "claude" }] })
    .providers[0].failureDetails, {});
});

test("schema diagnostics summarize real contract errors without exposing rejected values or unknown keys", () => {
  const parsed = providerSessionEvidenceSchema.pick({ session: true }).safeParse({
    session: {
      title: "PRIVATE_VALUE".repeat(100), project: "", cwd: "", startedAt: null, updatedAt: null,
      recordedGitBranch: "", cost: null, approvalMode: null, contextMachinery: null, summary: null,
      signal: null, progress: null, pomegrPlugin: null, PRIVATE_UNKNOWN_KEY: "PRIVATE_SECRET",
    },
  });
  assert.equal(parsed.success, false);
  const recorder = createPipelineFailureRecorder();
  recorder.record("acquisitionFailures", parsed.error, "session_publication");
  const detail = recorder.snapshot().acquisitionFailures;
  assert.equal(detail.reason, "schema_validation");
  assert.deepEqual(detail.validation, { issues: [
    { field: "session.title", rule: "too_big" },
    { field: "session", rule: "unrecognized_keys" },
  ], truncated: false });
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|"(?:message|stack|input|maximum|keys)":/);
  recorder.record("acquisitionFailures", { name: "ZodError", issues: parsed.error.issues });
  assert.equal(recorder.snapshot().acquisitionFailures.reason, "unknown");
  assert.equal(recorder.snapshot().acquisitionFailures.validation, undefined);
});

test("schema issue paths lose indices and unknown fields and never inspect private issue metadata", () => {
  const error = new z.ZodError([
    { code: "custom", path: ["agents", 934, "executionTasks", 625, "label"], message: "PRIVATE_MESSAGE" },
    { code: "custom", path: ["agents", 0, "executionTasks", 0, "label"], message: "PRIVATE_MESSAGE" },
    { code: "custom", path: ["agents", "PRIVATE_AGENT_ID", "label"], message: "PRIVATE_MESSAGE" },
    { code: "custom", path: ["session", "PRIVATE_KEY"], message: "PRIVATE_MESSAGE" },
    { code: "unrecognized_keys", path: [], keys: ["PRIVATE_KEY"], message: "PRIVATE_MESSAGE" },
  ]);
  for (const issue of error.issues) {
    Object.defineProperty(issue, "message", { get() { throw new Error("Private messages must not be inspected"); } });
  }
  Object.defineProperty(error, "stack", { get() { throw new Error("Stacks must not be inspected"); } });
  const summary = summarizeSchemaValidationFailure(error);
  assert.deepEqual(summary, { issues: [
    { field: "agents[].executionTasks[].label", rule: "custom" },
    { field: "unavailable", rule: "custom" },
    { field: "$", rule: "unrecognized_keys" },
  ], truncated: false });
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|934|625|message|stack/);
});

test("schema summaries are bounded, deduplicated, and re-allowlisted in monitor and IPC payloads", () => {
  const issues = ["session", "session.title", "session.project", "session.cwd", "agents", "agents[].label",
    "agents[].executionTasks", "usageSnapshots", "planTasks"].map((field) => ({ field, rule: "invalid_type" }));
  const summary = normalizeSchemaValidationSummary({ issues: [...issues, ...issues], truncated: false });
  assert.equal(summary.issues.length, 8);
  assert.equal(summary.truncated, true);
  const recorder = createPipelineFailureRecorder();
  recorder.record("sessionEvidenceRejected", new z.ZodError(Array.from({ length: 1_000 }, () => ({
    code: "custom", path: ["session", "title"], message: "PRIVATE_MESSAGE",
  }))));
  assert.deepEqual(recorder.snapshot().sessionEvidenceRejected.validation, {
    issues: [{ field: "session.title", rule: "custom" }], truncated: true,
  });
  const detail = { stage: "session_publication", reason: "schema_validation", observedAt: null, validation: {
    issues: [...issues, { field: "PRIVATE_FIELD", rule: "PRIVATE_RULE", message: "PRIVATE_MESSAGE" }],
    truncated: false, private: "PRIVATE_METADATA",
  } };
  const snapshot = createPipelineOperationsSnapshot({ coordinator: { observers: { claude: {
    acquisitionFailures: 1, failureDetails: { acquisitionFailures: detail },
  } } } });
  assert.deepEqual(snapshot.providers[0].failureDetails.acquisitionFailures.validation, summary);
  const revalidated = normalizePipelineOperationsSnapshot({ ...snapshot, providers: [{
    ...snapshot.providers[0], failureDetails: { acquisitionFailures: { ...detail, validation: { issues: [
      { field: "agents[934].label", rule: "PRIVATE_RULE" },
      { field: "session.title", rule: "too_big", input: "PRIVATE_VALUE", maximum: 999 },
      { field: "session.PRIVATE\u001b[2J", rule: "custom" },
    ] } } },
  }] });
  assert.deepEqual(revalidated.providers[0].failureDetails.acquisitionFailures.validation, { issues: [
    { field: "unavailable", rule: "unknown" }, { field: "session.title", rule: "too_big" },
    { field: "unavailable", rule: "custom" },
  ], truncated: false });
  assert.doesNotMatch(JSON.stringify(revalidated), /PRIVATE|934|999|input|maximum/);
  assert.deepEqual(normalizePipelineFailureDetails({ acquisitionFailures: { ...detail, validation: undefined } })
    .acquisitionFailures.validation, { issues: [], truncated: false });
  assert.equal(normalizePipelineFailureDetails({ acquisitionFailures: { ...detail, reason: "unknown" } })
    .acquisitionFailures.validation, undefined);
  const rendered = formatPipelineOperationsSnapshot(snapshot);
  assert.match(rendered, /session_publication · schema_validation/);
  assert.match(rendered, /session.title · invalid_type/);
  assert.match(rendered, /Additional validation issues omitted/);
  assert.doesNotMatch(formatPipelineOperationsSnapshot(snapshot, { provider: "codex" }), /schema_validation/);
});

test("schema vocabulary follows nested optional and nullable contract fields but rejects invented paths", () => {
  const summary = summarizeSchemaValidationFailure(new z.ZodError([
    { code: "custom", path: ["session", "progress", "remainingMinutesMin"], message: "PRIVATE" },
    { code: "custom", path: ["session", "contextMachinery", "groups", 1, "items", 2, "tokens"], message: "PRIVATE" },
    { code: "custom", path: ["workflows", 3, "agentIds", 4], message: "PRIVATE" },
    { code: "custom", path: ["resourceOwner", "processStartIdentity"], message: "PRIVATE" },
    { code: "custom", path: ["agents", 1, "title"], message: "PRIVATE" },
    { code: "custom", path: Array(100).fill("session"), message: "PRIVATE" },
  ]));
  assert.deepEqual(summary.issues, [
    { field: "session.progress.remainingMinutesMin", rule: "custom" },
    { field: "session.contextMachinery.groups[].items[].tokens", rule: "custom" },
    { field: "workflows[].agentIds[]", rule: "custom" },
    { field: "resourceOwner.processStartIdentity", rule: "custom" },
    { field: "unavailable", rule: "custom" },
  ]);
});

test("a real scoped-publication schema rejection reaches diagnostics and preserves successful retry behavior", async (context) => {
  const candidate = providerSessionEvidenceSchema.parse({
    localId: "probe", historical: true,
    session: { title: "Synthetic", project: "", cwd: "", startedAt: null, updatedAt: null, recordedGitBranch: "",
      cost: null, approvalMode: null, contextMachinery: null, summary: null, signal: null, progress: null, pomegrPlugin: null },
    agents: [], workflows: [], usageSnapshots: [], toolCalls: [], activity: [], planTasks: [], compactions: [],
    efficiencyRuleEvidence: { repetition: false, concurrentMutation: false, unsharedContext: false,
      healthyFallback: false, cacheUsageClassification: false }, pullRequestCreations: [],
  });
  const published = [];
  const observer = createNormalizedPollingObserver({ list: async () => [], read: async () => candidate, intervalMs: 60_000 });
  context.after(() => observer.stop());
  await observer.start(createScopedNormalizedObservationPublisher("claude", {
    publishCatalog() {}, invalidateSession() {},
    publishSession(_provider, _id, evidence) { published.push(evidence); },
  }), new AbortController().signal);
  assert.equal(await observer.hydrate("probe"), true);
  await new Promise((resolve) => setImmediate(resolve));
  candidate.session.title = "PRIVATE_VALUE".repeat(100);
  assert.equal(await observer.hydrate("probe"), false);
  const failure = observer.diagnostics().failureDetails.acquisitionFailures;
  assert.equal(failure.stage, "session_publication");
  assert.equal(failure.reason, "schema_validation");
  assert.deepEqual(failure.validation.issues, [{ field: "session.title", rule: "too_big" }]);
  assert.equal(published.length, 1);
  assert.equal(published[0].session.title, "Synthetic");
  await new Promise((resolve) => setImmediate(resolve));
  candidate.session.title = "Recovered";
  assert.equal(await observer.hydrate("probe"), true);
  assert.equal(observer.diagnostics().acquisitionFailures, 1);
  assert.deepEqual(observer.diagnostics().failureDetails.acquisitionFailures, failure);
  assert.equal(published.length, 2);
  assert.equal(Object.hasOwn(published[1], "failureDetails"), false);
  assert.equal(Object.hasOwn(published[1], "validation"), false);
});

test("worker failures record their stage without losing the last good publication or blocking retries", async (context) => {
  for (const stage of ["worker_yield", "source_preparation", "acquire_normalize", "session_publication"]) {
    let fail = false;
    let time = Date.parse("2026-08-30T12:00:00.000Z");
    const error = Object.assign(new Error("PRIVATE_PAYLOAD"), { code: "EIO", path: "PRIVATE_PATH" });
    const published = [];
    const observer = createNormalizedPollingObserver({
      list: async () => [], intervalMs: 60_000, now: () => time,
      yieldControl: async () => { if (fail && stage === "worker_yield") throw error; },
      prepare: async () => { if (fail && stage === "source_preparation") throw error; },
      ingest: async () => { if (fail && stage === "acquire_normalize") throw error; return { ready: true }; },
    });
    context.after(() => observer.stop());
    await observer.start({
      publishCatalog() {}, invalidateSession() {},
      publishSession(_id, candidate) {
        if (fail && stage === "session_publication") throw error;
        published.push(candidate);
      },
    }, new AbortController().signal);
    assert.equal(await observer.hydrate("PRIVATE_SESSION"), true);
    // Let the completed worker release its slot before requesting another pass.
    await new Promise((resolve) => setImmediate(resolve));
    fail = true;
    assert.equal(await observer.hydrate("PRIVATE_SESSION"), false);
    assert.equal(published.length, 1);
    const failure = observer.diagnostics();
    assert.equal(failure.acquisitionFailures, 1);
    assert.deepEqual(failure.failureDetails.acquisitionFailures, {
      stage, reason: "EIO", observedAt: "2026-08-30T12:00:00.000Z",
    });
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|message|stack|path/);
    await new Promise((resolve) => setImmediate(resolve));
    fail = false;
    time += 1_000;
    assert.equal(await observer.hydrate("PRIVATE_SESSION"), true);
    assert.equal(published.length, 2);
    assert.equal(observer.diagnostics().acquisitionFailures, 1);
    assert.deepEqual(observer.diagnostics().failureDetails, failure.failureDetails);
    assert.deepEqual(createNormalizedPollingObserver({ list: async () => [], read: async () => null })
      .diagnostics().failureDetails, {});
  }
});

test("failed eager source preparation records detail without starting acquisition", async (context) => {
  let acquired = false;
  const observer = createNormalizedPollingObserver({
    list: async () => [{ localId: "PRIVATE_SESSION", isLive: true }],
    prepare: async () => { throw Object.assign(new Error("PRIVATE"), { code: "EBUSY" }); },
    read: async () => { acquired = true; },
    intervalMs: 60_000,
  });
  context.after(() => observer.stop());
  await observer.start({ publishCatalog() {}, publishSession() {}, invalidateSession() {} }, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observer.diagnostics().acquisitionFailures, 1);
  assert.equal(observer.diagnostics().failureDetails.acquisitionFailures.stage, "source_preparation");
  assert.equal(observer.diagnostics().failureDetails.acquisitionFailures.reason, "EBUSY");
  assert.equal(acquired, false);
});

test("CLI renders latest failure details, unavailable legacy details, and provider filtering", () => {
  const snapshot = createPipelineOperationsSnapshot({
    coordinator: { observers: { claude: { acquisitionFailures: 2, failureDetails: { acquisitionFailures: {
      stage: "acquire_normalize", reason: "EACCES", observedAt: "2026-08-30T12:00:00.000Z",
    } } } } },
    providers: { claude: { observerStartFailures: 1 }, codex: {} },
  });
  const rendered = formatPipelineOperationsSnapshot(snapshot);
  assert.match(rendered, /FAILURES · cumulative counts; latest detail per category/);
  assert.match(rendered, /claude · acquisitionFailures: 2\n  acquire_normalize · EACCES · 2026-08-30T12:00:00.000Z/);
  assert.match(rendered, /observerStartFailures: 1\n  Detail unavailable/);
  assert.ok(rendered.indexOf("FAILURES ·") < rendered.indexOf("PIPELINE TIMINGS"));
  assert.doesNotMatch(formatPipelineOperationsSnapshot(snapshot, { provider: "codex" }), /claude|FAILURES ·/);
});

test("the operations transport streams bounded NDJSON over local IPC and closes cleanly", async (context) => {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pomegr-pipeline-test-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `pomegr-pipeline-test-${process.pid}-${Date.now()}.sock`);
  const expected = createPipelineOperationsSnapshot({
    coordinator: { observers: { claude: { acquisitionFailures: 1, failureDetails: { acquisitionFailures: {
      stage: "acquire_normalize", reason: "EIO", observedAt: "2026-08-29T12:00:00.000Z",
    } } } } },
  }, "2026-08-29T12:00:00.000Z");
  const transport = await startPipelineOperationsTransport({
    port: 4317,
    endpoint,
    snapshot: () => expected,
    intervalMs: 100,
  });
  context.after(() => transport.close());

  const socket = createConnection(transport.endpoint);
  context.after(() => socket.destroy());
  const [chunk] = await once(socket, "data");
  const received = JSON.parse(String(chunk).split("\n")[0]);

  assert.deepEqual(received, expected);
  assert.doesNotMatch(JSON.stringify(received), /prompt|response|command|credential|transcript/i);
});

test("the operations transport bounds clients and refuses to delete a regular Unix-path collision", async (context) => {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pomegr-pipeline-limit-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `pomegr-pipeline-limit-${process.pid}-${Date.now()}.sock`);
  const transport = await startPipelineOperationsTransport({
    port: 4317,
    endpoint,
    snapshot: () => createPipelineOperationsSnapshot({}),
    intervalMs: 100,
    maxClients: 1,
  });
  context.after(() => transport.close());
  const first = createConnection(endpoint);
  context.after(() => first.destroy());
  await once(first, "data");
  const excess = createConnection(endpoint);
  excess.on("error", () => {});
  await once(excess, "close");

  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-pipeline-collision-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const collision = path.join(directory, "pipeline.sock");
  await writeFile(collision, "DO_NOT_DELETE", "utf8");
  await assert.rejects(
    startPipelineOperationsTransport({
      port: 4317,
      endpoint: collision,
      platform: "linux",
      snapshot: () => createPipelineOperationsSnapshot({}),
    }),
    /ENDPOINT_COLLISION/,
  );
  assert.equal(await readFile(collision, "utf8"), "DO_NOT_DELETE");
});

test("the operations transport fails closed when Unix socket permissions cannot be hardened", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-pipeline-permissions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = path.join(directory, "pipeline.sock");
  const fakeServer = new EventEmitter();
  fakeServer.listen = () => queueMicrotask(() => fakeServer.emit("listening"));
  fakeServer.unref = () => {};
  fakeServer.close = (callback) => queueMicrotask(callback);

  await assert.rejects(
    startPipelineOperationsTransport({
      port: 4317,
      endpoint,
      platform: "linux",
      snapshot: () => createPipelineOperationsSnapshot({}),
      serverFactory: () => fakeServer,
      chmodSocket: async () => { throw new Error("simulated permission failure"); },
    }),
    /PERMISSION_FAILED/,
  );
  await assert.rejects(lstat(endpoint), { code: "ENOENT" });
});

test("a concrete-port monitor owns and closes the operations transport lifecycle", async (context) => {
  const port = await availablePort();
  let diagnosticReads = 0;
  const monitor = await startMonitorServer({
    port,
    runtime: {
      observationDiagnostics() { diagnosticReads += 1; return {}; },
      async startObservation() {},
      async stopObservation() {},
    },
    providerRegistry: { async watchTargets() {} },
    logger: { log() {}, warn() {} },
  });
  context.after(() => monitor.close());
  assert.equal(monitor.operationsEndpoint, pipelineOperationsEndpoint(port));
  const socket = createConnection(monitor.operationsEndpoint);
  context.after(() => socket.destroy());
  const [chunk] = await once(socket, "data");
  assert.equal(JSON.parse(String(chunk).split("\n")[0]).version, PIPELINE_OPERATIONS_VERSION);
  assert.equal(diagnosticReads, 1);
});

test("pipeline endpoint names are deterministic per concrete monitor port", () => {
  assert.equal(
    pipelineOperationsEndpoint(4317, { platform: "win32" }),
    "\\\\.\\pipe\\pomegr-pipeline-4317",
  );
  assert.match(
    pipelineOperationsEndpoint(4317, { platform: "linux", temporaryDirectory: "/tmp", userId: 42 }),
    /pomegr-pipeline-42-4317\.sock$/,
  );
  assert.throws(() => pipelineOperationsEndpoint(0), /concrete monitor port/);
});

test("the terminal formatter and options stay bounded and provider-filterable", () => {
  const snapshot = createPipelineOperationsSnapshot({
    coordinator: {
      observers: {
        claude: { hydrationConcurrency: 2, activeHydrations: 1, pendingHydrations: 0 },
        codex: { hydrationConcurrency: 2, activeHydrations: 2, pendingHydrations: 1 },
      },
    },
    providers: { claude: {}, codex: {} },
    responseRevisions: { catalog: 3, home: 2, usageLimits: 1 },
  }, "2026-08-29T12:00:00.000Z");
  const rendered = formatPipelineOperationsSnapshot(snapshot, { provider: "codex" });

  assert.match(rendered, /Pomegr pipeline operations/);
  assert.match(rendered, /codex\s+2\s+2\s+1/);
  assert.doesNotMatch(rendered, /claude/);
  assert.match(rendered, /acquire \+ normalize/);
  assert.match(pipelineOperationsHelp(), /npm run ops:pipeline/);
  assert.deepEqual(parsePipelineOperationsArgs(["--provider", "codex", "--port", "5000", "--json", "--once"]), {
    port: 5000,
    provider: "codex",
    json: true,
    once: true,
    help: false,
  });
  assert.throws(() => parsePipelineOperationsArgs(["--provider", "PRIVATE PROVIDER"]), /provider is invalid/);
  assert.throws(() => parsePipelineOperationsArgs(["--unknown"]), /Unknown/);
});

test("the continuous CLI reconnects and once mode consumes only one buffered snapshot", async (context) => {
  const port = await availablePort();
  let resolveOutput;
  const output = new Promise((resolve) => { resolveOutput = resolve; });
  const cli = runPipelineOperationsCli({ port, provider: "", json: true, once: false }, {
    stdout: { isTTY: false, write(value) { resolveOutput(value); } },
    stderr: { write() {} },
    schedule(task) { return setTimeout(task, 10); },
  });
  context.after(() => cli.close());
  await new Promise((resolve) => setTimeout(resolve, 25));
  const transport = await startPipelineOperationsTransport({
    port,
    snapshot: () => createPipelineOperationsSnapshot({}, "2026-08-29T12:00:00.000Z"),
    intervalMs: 100,
  });
  context.after(() => transport.close());
  assert.match(await output, /"version":1/);

  class FakeSocket extends EventEmitter {
    setEncoding() {}
    end() { this.emit("close"); }
    destroy() { this.emit("close"); }
  }
  const socket = new FakeSocket();
  const writes = [];
  runPipelineOperationsCli({ port, provider: "", json: true, once: true }, {
    connect: () => socket,
    stdout: { isTTY: false, write(value) { writes.push(value); } },
    stderr: { write() {} },
  });
  const line = JSON.stringify(createPipelineOperationsSnapshot({}));
  socket.emit("data", `${line}\n${line}\n`);
  assert.equal(writes.length, 1);
});
