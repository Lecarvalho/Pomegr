import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseCodexPlanRecords,
  readCodexApprovalPlanRollout,
} from "../monitor/providers/codex-approval-plan.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import {
  assertNoPrivateFixtureSentinels,
  monitorStateFromProviderEvidence,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

const EXPECTED_PLAN = [
  { id: "codex-plan-1", subject: "Inspect bounded metadata", status: "completed", blocks: [], blockedBy: [] },
  { id: "codex-plan-2", subject: "Normalize structured fields", status: "in_progress", blocks: [], blockedBy: [] },
  { id: "codex-plan-3", subject: "Verify privacy boundary", status: "pending", blocks: [], blockedBy: [] },
];

test("keeps the latest valid structured Codex plan and discards explanations and unsupported fields", async () => {
  const fixtureUrl = new URL("./fixtures/providers/codex/approval-plan.jsonl", import.meta.url);
  const { planTasks } = readCodexApprovalPlanRollout(fixtureUrl);

  assert.deepEqual(planTasks, EXPECTED_PLAN);
  assertNoPrivateFixtureSentinels(planTasks, "Codex structured plan");
  assert.doesNotMatch(JSON.stringify(planTasks), /explanation|description|activeForm|dependency/i);
});

test("returns no tasks for missing, free-form-only, and malformed plan updates", () => {
  assert.deepEqual(readCodexApprovalPlanRollout(new URL("./fixtures/providers/codex/plan-missing.jsonl", import.meta.url)).planTasks, []);
  assert.deepEqual(readCodexApprovalPlanRollout(new URL("./fixtures/providers/codex/plan-malformed.jsonl", import.meta.url)).planTasks, []);
  assert.deepEqual(readCodexApprovalPlanRollout(new URL("./fixtures/providers/codex/does-not-exist.jsonl", import.meta.url)).planTasks, []);
});

test("accepts documented app-server plan notifications without inferring dependencies", () => {
  const planTasks = parseCodexPlanRecords([{
    method: "turn/plan/updated",
    params: {
      turnId: "turn-private",
      explanation: "PLAN_EXPLANATION_MUST_NOT_LEAK",
      plan: [
        { step: "Pending step", status: "pending", dependsOn: ["PRIVATE_DEPENDENCY"] },
        { step: "Active step", status: "inProgress", blocks: ["PRIVATE_DEPENDENCY"] },
        { step: "Completed step", status: "completed" },
      ],
    },
  }]);

  assert.deepEqual(planTasks.map(({ status, blocks, blockedBy }) => ({ status, blocks, blockedBy })), [
    { status: "pending", blocks: [], blockedBy: [] },
    { status: "in_progress", blocks: [], blockedBy: [] },
    { status: "completed", blocks: [], blockedBy: [] },
  ]);
  assertNoPrivateFixtureSentinels(planTasks, "Codex app-server plan");
  assert.doesNotMatch(JSON.stringify(planTasks), /PRIVATE_DEPENDENCY/);
});

test("integrates the latest primary plan snapshot through provider evidence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-plan-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const fixture = await readProviderFixture("codex/approval-plan.jsonl");
  await writeFile(path.join(directory, "rollout-approval-plan.jsonl"), fixture, "utf8");
  await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id: "codex-approval-plan", thread_name: "Plan fixture", updated_at: "2026-08-11T12:00:08.000Z" })}\n`, "utf8");

  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, scanLimit: 10 });
  const evidence = await provider.readSession("codex-approval-plan", { historical: true });
  assert.equal(provider.capabilities.planTasks, true);
  assert.deepEqual(evidence.planTasks, EXPECTED_PLAN);
  assertNoPrivateFixtureSentinels(evidence, "Codex provider plan evidence");
  const state = monitorStateFromProviderEvidence("codex", evidence);
  assert.deepEqual(state.planTasks, EXPECTED_PLAN);
  assert.equal(state.session.approvalMode.id, "granular");
  assertNoPrivateFixtureSentinels(state, "Codex approval and plan browser state");
});
