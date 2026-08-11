import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionReport, sessionReportFilename } from "../app/session-report.mjs";

const generatedAt = new Date("2026-08-05T18:00:00.000Z");
const state = {
  source: "Claude Code",
  capabilities: {
    approvalMode: true,
    automaticCompactions: true,
    contextMachinery: true,
    estimatedCost: true,
    liveSessions: true,
    needsInput: true,
    planTasks: true,
    sessionSummary: true,
    signals: true,
    usageLimits: true,
  },
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
    repository: {
      available: true,
      branch: "main",
      files: [{ status: " M", path: "monitor/server.mjs" }],
      historical: false,
      isMain: true,
      comparison: { branch: "origin/main", kind: "upstream", ahead: 1, behind: 0, integrated: false },
      commits: [{ hash: "abc1234", subject: "Add repository summary", committedAt: "2026-08-05T17:20:00.000Z" }],
      remote: { status: "ready", checkedAt: "2026-08-05T17:29:00.000Z" },
    },
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
  assert.match(report, /Compared with `origin\/main`.*1 ahead, 0 behind/);
  assert.match(report, /Recent commits/);
  assert.match(report, /abc1234.*Add repository summary/);
  assert.doesNotMatch(report, /Repeated calls|Repeated call patterns/);
  assert.match(report, /Retrospective questions/);
  assert.doesNotMatch(report, /private-machine|RAW PROMPT MUST NOT APPEAR|PRIVATE EXECUTION LABEL MUST NOT APPEAR|PRIVATE PLAN SUBJECT MUST NOT APPEAR|PRIVATE COMMAND|PRIVATE OUTPUT/);
  assert.doesNotMatch(report, /Cumulative|Primary current context|token spend/i);
  assert.equal(sessionReportFilename(state, generatedAt), "threadlight-repair-the-parser-2026-08-05.md");
});

test("omits live-only data from historical reports", () => {
  const historical = structuredClone(state);
  historical.view = "history";
  historical.session.repository = { available: true, branch: "feature/history", files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } };
  const report = buildSessionReport(historical, generatedAt);

  assert.match(report, /Recorded branch.*feature\/history/);
  assert.match(report, /Historical uncommitted-file state was not recorded/);
  assert.doesNotMatch(report, /Plan usage|Current session|5 hours/);
});

test("omits provider-unsupported cost and usage-limit sections instead of reporting zero or unavailable", () => {
  const unsupported = structuredClone(state);
  unsupported.source = "Codex";
  unsupported.capabilities.estimatedCost = false;
  unsupported.capabilities.usageLimits = false;
  unsupported.session.cost = { amount: 0, currency: "USD", type: "estimated", observedAt: "2026-08-05T17:30:00.000Z" };

  const report = buildSessionReport(unsupported, generatedAt);

  assert.doesNotMatch(report, /Estimated API cost|Claude|status-line|Plan usage|Current session|5 hours/i);
  assert.match(report, /All-agent context.*2,500 tokens/);
});

test("keeps a supplied zero estimate distinct from an unsupported estimate", () => {
  const zeroCost = structuredClone(state);
  zeroCost.session.cost.amount = 0;

  const report = buildSessionReport(zeroCost, generatedAt);

  assert.match(report, /Estimated API cost.*\$0\.00/);
});

test("renders needs-input status as a human-readable report label", () => {
  const needsInput = structuredClone(state);
  needsInput.agents[0].status = "needs_input";

  const report = buildSessionReport(needsInput, generatedAt);

  assert.match(report, /Primary agent.*needs input/);
  assert.doesNotMatch(report, /needs_input/);
});

test("reports squash-integrated changes without an ahead count", () => {
  const integrated = structuredClone(state);
  integrated.session.repository.branch = "feature/squash-merged";
  integrated.session.repository.isMain = false;
  integrated.session.repository.comparison = { branch: "origin/main", kind: "base", ahead: 0, behind: 1, integrated: true };
  integrated.session.repository.commits = [];

  const report = buildSessionReport(integrated, generatedAt);

  assert.match(report, /Branch changes are already integrated/);
  assert.match(report, /rewritten history remains 1 graph commit behind/);
  assert.doesNotMatch(report, /0 ahead/);
});

test("bounds report filenames for native desktop save dialogs", () => {
  const title = `A very long session ${"with repeated words ".repeat(20)}`;
  const filename = sessionReportFilename({ session: { title } }, new Date("2026-08-11T12:00:00.000Z"));
  assert.match(filename, /^threadlight-[a-z0-9-]+-2026-08-11\.md$/);
  assert.ok(filename.length <= 111);
});
