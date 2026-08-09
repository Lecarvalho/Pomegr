import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionReport, sessionReportFilename } from "../app/session-report.mjs";

const generatedAt = new Date("2026-08-05T18:00:00.000Z");
const state = {
  source: "Claude Code",
  view: "live",
  score: 84,
  session: {
    id: "session-1234-abcd",
    title: "Repair the parser",
    project: "threadlight",
    cwd: "C:\\Users\\private-machine\\threadlight",
    startedAt: "2026-08-05T17:00:00.000Z",
    updatedAt: "2026-08-05T17:30:00.000Z",
    durationMs: 1_800_000,
    cost: { amount: 1.2345, currency: "USD", type: "estimated", observedAt: "2026-08-05T17:30:00.000Z" },
    repository: { available: true, branch: "main", files: [{ status: " M", path: "monitor/server.mjs" }], historical: false },
  },
  metrics: {
    agents: 2,
    activeAgents: 1,
    toolCalls: 9,
    repeatedCalls: 3,
    tokens: { allAgents: 2_500 },
  },
  agents: [{
    id: "primary",
    parentId: null,
    label: "Primary agent",
    kind: "orchestrator",
    model: "test-model",
    effort: "medium",
    status: "idle",
    startedAt: "2026-08-05T17:00:00.000Z",
    durationMs: 1_800_000,
    toolCalls: 9,
    skills: [{ name: "github:gh-fix-ci", calls: 2, lastUsed: "2026-08-05T17:25:00.000Z" }],
    tokens: { total: 1_000 },
  }],
  toolPatterns: [{ agent: "Primary agent", tool: "Read", calls: 9 }],
  loops: [{ agent: "Primary agent", tool: "Read", detail: "server.mjs", calls: 4, repeats: 3 }],
  insights: [{ title: "Primary agent repeated Read 4 times", detail: "The same target keeps recurring." }],
  activity: [{ detail: "RAW PROMPT MUST NOT APPEAR" }],
  executionTasks: [{ id: "toolu_1", label: "PRIVATE EXECUTION LABEL MUST NOT APPEAR", status: "running", command: "PRIVATE COMMAND", output: "PRIVATE OUTPUT" }],
  planTasks: [{ id: "1", subject: "PRIVATE PLAN SUBJECT MUST NOT APPEAR", status: "pending", blocks: [], blockedBy: [] }],
  usageLimits: { available: true, limits: [{ window: "5 hours", label: "Current session", percent: 40, resetsAt: "2026-08-05T20:00:00.000Z" }] },
};

test("builds a deterministic retrospective without private raw state", () => {
  const report = buildSessionReport(state, generatedAt);

  assert.match(report, /^# Threadlight Session Report/m);
  assert.match(report, /Session ID:\*\* `session-1234-abcd`/);
  assert.match(report, /Repair the parser/);
  assert.match(report, /Primary agent.*30m 0s/);
  assert.match(report, /All-agent context.*2,500 tokens/);
  assert.match(report, /Estimated API cost.*\$1\.23/);
  assert.match(report, /Primary agent.*1,000/);
  assert.match(report, /## Skill usage/);
  assert.match(report, /github:gh-fix-ci.*2/);
  assert.doesNotMatch(report, /Repeated calls|Repeated call patterns/);
  assert.match(report, /Retrospective questions/);
  assert.doesNotMatch(report, /private-machine|RAW PROMPT MUST NOT APPEAR|PRIVATE EXECUTION LABEL MUST NOT APPEAR|PRIVATE PLAN SUBJECT MUST NOT APPEAR|PRIVATE COMMAND|PRIVATE OUTPUT/);
  assert.doesNotMatch(report, /Cumulative|Primary current context|token spend/i);
  assert.equal(sessionReportFilename(state, generatedAt), "threadlight-repair-the-parser-2026-08-05.md");
});

test("omits live-only data from historical reports", () => {
  const historical = structuredClone(state);
  historical.view = "history";
  historical.session.repository = { available: true, branch: "feature/history", files: [], historical: true };
  const report = buildSessionReport(historical, generatedAt);

  assert.match(report, /Recorded branch.*feature\/history/);
  assert.match(report, /Historical uncommitted-file state was not recorded/);
  assert.doesNotMatch(report, /Plan usage|Current session|5 hours/);
});

test("renders needs-input status as a human-readable report label", () => {
  const needsInput = structuredClone(state);
  needsInput.agents[0].status = "needs_input";

  const report = buildSessionReport(needsInput, generatedAt);

  assert.match(report, /Primary agent.*needs input/);
  assert.doesNotMatch(report, /needs_input/);
});
