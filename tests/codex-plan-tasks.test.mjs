import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

test("extracts current Codex plans nested in exec without evaluating source or accepting decoys", () => {
  const records = [{
    timestamp: "2026-08-12T13:53:24.908Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec-plan-current",
      input: `
        const stringDecoy = "tools.update_plan({plan:[{step:'STRING_MUST_NOT_LEAK',status:'completed'}]})";
        // tools.update_plan({plan:[{step:"COMMENT_MUST_NOT_LEAK",status:"completed"}]})
        const result = await tools.update_plan({
          explanation: "EXPLANATION_MUST_NOT_LEAK",
          plan: [
            { step: "Reproduce live plan", status: "completed", description: "DESCRIPTION_MUST_NOT_LEAK" },
            { step: "Normalize nested metadata", status: "in_progress" },
            { step: "Verify the checklist", status: "pending" },
          ],
        });
        text(result);
      `,
    },
  }, {
    timestamp: "2026-08-12T13:53:25.908Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      input: "const result = await tools.update_plan(dynamicPlan); text(result);",
    },
  }];

  const planTasks = parseCodexPlanRecords(records);
  assert.deepEqual(planTasks.map(({ subject, status }) => ({ subject, status })), [
    { subject: "Reproduce live plan", status: "completed" },
    { subject: "Normalize nested metadata", status: "in_progress" },
    { subject: "Verify the checklist", status: "pending" },
  ]);
  assertNoPrivateFixtureSentinels(planTasks, "nested Codex exec plan");
  assert.doesNotMatch(JSON.stringify(planTasks), /explanation|description|dynamicPlan/i);
});

test("retains the latest sanitized live plan after its exec record leaves the rollout tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-live-plan-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "12");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-plan-cache.jsonl");
  const session = {
    timestamp: "2026-08-12T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "live-plan-cache",
      session_id: "live-plan-cache",
      source: "cli",
      cwd: "C:\\synthetic\\plan-cache",
    },
  };
  const plan = {
    timestamp: "2026-08-12T12:00:01.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "exec-live-plan",
      input: `const result = await tools.update_plan({plan:[
        {step:"Retain bounded plan",status:"in_progress"},
        {step:"Verify rollover",status:"pending"}
      ]}); text(result);`,
    },
  };
  const serialize = (records) => `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(file, serialize([session, plan]), "utf8");

  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    maximumStateTailBytes: 1024,
  });
  const first = await provider.readSession("live-plan-cache", { historical: false });
  assert.deepEqual(first.planTasks.map(({ subject }) => subject), ["Retain bounded plan", "Verify rollover"]);

  await appendFile(file, serialize([{
    timestamp: "2026-08-12T12:00:02.000Z",
    type: "future_record",
    payload: { private: `TOOL_OUTPUT_MUST_NOT_LEAK${"x".repeat(4_000)}` },
  }]), "utf8");
  const afterRollover = await provider.readSession("live-plan-cache", { historical: false });
  assert.deepEqual(afterRollover.planTasks, first.planTasks);
  assert.equal(provider.qaStats().livePlanTaskEntries, 1);
  assertNoPrivateFixtureSentinels(afterRollover, "cached live Codex plan");

  await writeFile(file, serialize([session, {
    timestamp: "2026-08-12T12:01:00.000Z",
    type: "future_record",
    payload: { safe: true },
  }]), "utf8");
  const afterTruncate = await provider.readSession("live-plan-cache", { historical: false });
  assert.deepEqual(afterTruncate.planTasks, []);
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
