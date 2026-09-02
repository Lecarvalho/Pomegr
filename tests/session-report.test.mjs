import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionReport, sessionReportFilename } from "../app/session-report.mjs";

const generatedAt = new Date("2026-08-31T02:22:54.162Z");
const snapshot = (id, agentId, observedAt, values = {}) => ({
  id,
  agentId,
  observedAt,
  uncachedInputTokens: 2,
  cacheWriteTokens: values.cacheWriteTokens ?? 100,
  cacheReadTokens: values.cacheReadTokens ?? 8_000,
  outputTokens: values.outputTokens ?? 3,
});
const baseEvidence = {
  version: 1,
  requestCount: 827,
  cache: {
    status: "ready", refills: 57, reuses: 51, possibleFullRefills: 10, missRefills: 2,
    transitions: [{
      id: "provider-cache-id", agentId: "primary", observedAt: "2026-08-28T00:17:12.681Z", promptInputTokens: 242_690,
      cacheWriteTokens: 242_688, cacheReadPercent: 0, previousCacheReadPercent: 98.86, gapMs: 3_359_619, previousCacheLifetime: "1h", reason: "tools_changed", providerStatus: null, messageChangeSequence: null,
      requests: {
        previous: snapshot("provider-request-previous", "primary", "2026-08-27T23:21:13.062Z", { cacheReadTokens: 236_478, cacheWriteTokens: 2_719, outputTokens: 2_181 }),
        current: snapshot("provider-request-current", "primary", "2026-08-28T00:17:12.681Z", { cacheReadTokens: 0, cacheWriteTokens: 242_688, outputTokens: 1_275 }),
        next: snapshot("provider-request-next", "primary", "2026-08-28T00:17:35.998Z", { cacheReadTokens: 242_688, cacheWriteTokens: 3_335, outputTokens: 1_910 }),
      },
    }],
  },
  context: {
    status: "ready", automaticCompactions: 1, manualCompactions: 1, snapshotDrops: 1,
    boundaries: [
      { id: "boundary-auto", agentId: "primary", timestamp: "2026-08-28T00:20:00.000Z", kind: "automatic_compaction", preTokens: 100_000, current: snapshot("ignored", "primary", "2026-08-28T00:20:00.000Z") },
      { id: "boundary-manual", agentId: "primary", timestamp: "2026-08-28T00:30:00.000Z", kind: "manual_compaction", preTokens: null, current: snapshot("ignored-2", "primary", "2026-08-28T00:30:00.000Z") },
      { id: "boundary-drop", agentId: "primary", timestamp: "2026-08-28T00:40:00.000Z", kind: "snapshot_drop", preTokens: 125_000, current: snapshot("provider-request-drop", "primary", "2026-08-28T00:40:00.000Z", { cacheReadTokens: 50_000 }) },
    ],
  },
  limits: { refillTransitions: 100, contextBoundaries: 100 },
};

function state(overrides = {}) {
  return {
    source: "Claude Code", capabilities: { cacheWriteUsage: true, cacheUsageClassification: true }, readiness: { contextEvidence: "ready" },
    session: { id: "session-1234", title: "Repair the parser", project: "pomegr", startedAt: "2026-08-27T22:57:09.818Z", updatedAt: "2026-08-28T03:27:45.709Z", durationMs: 16_235_891 },
    metrics: { agents: 2, tokens: { reportEvidence: structuredClone(baseEvidence) } },
    agents: [
      { id: "primary", parentId: null, role: "orchestrator", cacheLifetime: "1h", executionTasks: [{ id: "private-failed-task", status: "failed", workKind: "shell", startedAt: "2026-08-28T00:55:16.189Z", finishedAt: "2026-08-28T00:55:16.353Z", exitCode: null, failureCause: "not_found", label: "PRIVATE LABEL", command: "PRIVATE COMMAND" }] },
      { id: "agent-z", parentId: "primary", role: "general-purpose", cacheLifetime: "5m", executionTasks: [] },
    ], executionTasks: [], ...overrides,
  };
}

test("renders the approved focused evidence sections and report-local aliases", () => {
  const report = buildSessionReport(state(), generatedAt);
  assert.match(report, /^# Pomegr Session Observation Report/);
  assert.match(report, /## Coverage and counts/); assert.match(report, /827/); assert.match(report, /57 \/ 51/);
  assert.match(report, /## Agents referenced by the detailed events/); assert.match(report, /\| Primary \|/);
  assert.match(report, /## Cache refill transitions/); assert.match(report, /F01/); assert.match(report, /2026-08-28T00:17:12\.681Z/);
  assert.match(report, /## Compactions and context drops/); assert.match(report, /Automatic compaction/); assert.match(report, /Manual compaction/); assert.match(report, /Context drop without a recorded compaction/);
  assert.match(report, /## Failed tasks in retained feeds/); assert.match(report, /\| T01 \| Primary \|/);
  assert.match(report, /## Supporting request measurements/); assert.match(report, /R001/); assert.match(report, /## Definitions and limits/);
  assert.doesNotMatch(report, /Executive metrics|Flow score|Skill usage|Deterministic signals|Repository|Plan usage|Retrospective questions|session-1234-abcd/);
  assert.doesNotMatch(report, /PRIVATE LABEL|PRIVATE COMMAND|provider-cache-id|provider-request-current/);
  assert.equal(sessionReportFilename(state(), generatedAt), "pomegr-repair-the-parser-2026-08-31.md");
});

test("formats a normalized cache minimum without presenting it as an exact TTL", () => {
  const observed = state();
  observed.agents[0].cacheLifetime = "30m+";
  observed.metrics.tokens.reportEvidence.cache.transitions[0].previousCacheLifetime = "30m+";
  const report = buildSessionReport(observed, generatedAt);
  assert.equal(report.match(/≥30m/g)?.length, 2);
  assert.doesNotMatch(report, /30m\+/);
});

test("keeps compaction current values unavailable and preserves only exact snapshot drops", () => {
  const report = buildSessionReport(state(), generatedAt);
  assert.match(report, /Automatic compaction.*100,000.*Unavailable/); assert.match(report, /Manual compaction.*Unavailable/);
  assert.match(report, /Context drop without a recorded compaction.*125,000.*50,105.*R004/);
});

test("does not join legacy feeds when report evidence is absent or not ready", () => {
  const absent = state({ metrics: { tokens: { requestSnapshots: { status: "ready", items: [snapshot("legacy", "primary", "2026-08-28T01:00:00.000Z")] } } }, executionTasks: [{ id: "legacy-failure", status: "failed", workKind: "shell" }] });
  const absentReport = buildSessionReport(absent, generatedAt);
  assert.match(absentReport, /Valid request observations \| Unavailable/); assert.match(absentReport, /No cache transitions available/); assert.match(absentReport, /Context boundary evidence was unavailable/); assert.doesNotMatch(absentReport, /legacy-failure|R001/);
  const loadingReport = buildSessionReport(state({ readiness: { contextEvidence: "loading" } }), generatedAt);
  assert.match(loadingReport, /Large cache writes \/ tracked reuse events \| Unavailable/); assert.doesNotMatch(loadingReport, /57 \/ 51|F01|100,000/);
});

test("omits unsupported cache-write evidence for Codex without converting it to zero", () => {
  const report = buildSessionReport(state({ source: "Codex", capabilities: { cacheWriteUsage: false, cacheUsageClassification: false } }), generatedAt);
  assert.match(report, /\| Primary \| — \| orchestrator \| Unavailable \| Unavailable \| 1 \|/);
  assert.match(report, /Large cache writes \/ tracked reuse events \| Unavailable/); assert.doesNotMatch(report, /\| Ref \| Position \| Request \| Time \(UTC\) \| Uncached input \| Cache read \| Cache write \|/); assert.match(report, /Supporting request measurements/);
});

test("dedupes per-agent tasks, falls back to primary feed, and caps newest failures", () => {
  const failures = Array.from({ length: 103 }, (_, index) => { const minute = String(index % 60).padStart(2, "0"); return { id: `failed-${index}`, status: "failed", workKind: index % 2 ? "search" : "shell", startedAt: `2026-08-28T00:${minute}:00.000Z`, finishedAt: `2026-08-28T00:${minute}:01.000Z`, exitCode: null, failureCause: "provider_error" }; });
  const withFailures = state({ agents: [{ id: "primary", parentId: null, role: "orchestrator", cacheLifetime: "1h", executionTasks: null }, { id: "agent-z", parentId: "primary", role: "general-purpose", cacheLifetime: "5m", executionTasks: [failures[0], failures[0]] }], executionTasks: failures });
  const report = buildSessionReport(withFailures, generatedAt);
  assert.match(report, /Retained completed \/ failed tasks \| 0 \/ 104/); assert.match(report, /100 newest failures shown; 4 retained failures omitted/); assert.match(report, /T100/); assert.doesNotMatch(report, /T101/); assert.match(report, /Per-agent counts describe the retained normalized selection/);
});

test("does not convert unresolved task evidence into zero failures", () => {
  const report = buildSessionReport(state({ readiness: { contextEvidence: "ready", agentEvidence: "loading" } }), generatedAt);
  assert.match(report, /Retained completed \/ failed tasks \| Unavailable/);
  assert.match(report, /Task evidence unavailable/);
  assert.match(report, /\| Primary \| — \| orchestrator \| 1h \| 1 \| Unavailable \|/);
  assert.doesNotMatch(report, /\| T01 \|/);
});

test("reports dropped detail counts and keeps structural matches separate from recorded diagnostics", () => {
  const input = state();
  input.revision = 42;
  input.metrics.tokens.reportEvidence.cache.transitions[0].messageChangeSequence = "post_tool_task_notification_resume";
  const report = buildSessionReport(input, generatedAt);
  assert.match(report, /Committed revision:\*\* 42/);
  assert.match(report, /9 retained transitions omitted/);
  assert.match(report, /Structural sequence matched for F01/);
  const eventRow = report.split("\n").find((line) => line.startsWith("| F01 |") && line.includes("tools_changed"));
  assert.doesNotMatch(eventRow, /post_tool_task_notification_resume/);
});

test("hostile free text and raw fields never enter the focused report", () => {
  const input = state();
  input.session.id = "<script>PRIVATE</script>";
  input.session.summary = { text: "PRIVATE" };
  input.agents[0].model = "PRIVATE";
  input.agents[0].signal = { label: "PRIVATE" };
  input.metrics.tokens.reportEvidence.cache.transitions[0].reason = "<script>PRIVATE</script>";
  input.metrics.tokens.reportEvidence.cache.transitions[0].requests.current.raw = "PRIVATE";
  const report = buildSessionReport(input, generatedAt);
  assert.doesNotMatch(report, /PRIVATE|<script>/);
  assert.match(report, /Session:\*\* Unavailable/);
});
