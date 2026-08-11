import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexApprovalModeFromRecord,
  latestCodexApprovalMode,
} from "../monitor/providers/codex-approval-plan.mjs";
import { createCodexProvider } from "../monitor/providers/codex.mjs";
import {
  assertNoPrivateFixtureSentinels,
  readProviderFixture,
} from "./helpers/provider-fixtures.mjs";

test("normalizes every recognized Codex approval policy without retaining policy details", () => {
  const policies = [
    ["untrusted", "untrusted", "Untrusted"],
    ["on-request", "on_request", "On request"],
    [{ granular: { sandbox_approval: true, rules: false, private: "PERMISSION_RULE_MUST_NOT_LEAK" } }, "granular", "Granular"],
    ["never", "never", "Never"],
  ];

  for (const [approvalPolicy, id, label] of policies) {
    const mode = codexApprovalModeFromRecord({
      timestamp: "2026-08-11T12:00:00.000Z",
      type: "turn_context",
      payload: {
        approval_policy: approvalPolicy,
        sandbox_policy: { writable_roots: ["PRIVATE_PATH_MUST_NOT_LEAK"] },
        command: "COMMAND_MUST_NOT_LEAK",
        reason: "APPROVAL_REASON_MUST_NOT_LEAK",
      },
    });
    assert.deepEqual(mode, { id, label, observedAt: "2026-08-11T12:00:00.000Z", source: "provider" });
    assertNoPrivateFixtureSentinels(mode, `Codex ${id} approval mode`);
  }
});

test("uses the latest recognized Codex mode across rollout and app-server settings records", () => {
  const mode = latestCodexApprovalMode([
    { timestamp: "2026-08-11T12:00:00.000Z", type: "turn_context", payload: { approval_policy: "untrusted" } },
    { timestamp: "2026-08-11T12:00:01.000Z", method: "thread/settings/updated", params: { threadSettings: { approvalPolicy: "on-request", sandboxPolicy: { writableRoots: ["PRIVATE_PATH_MUST_NOT_LEAK"] } } } },
    { timestamp: "invalid", type: "thread_settings_updated", payload: { settings: { approval_policy: { granular: { rules: true } } } } },
    { timestamp: "2026-08-11T12:00:03.000Z", type: "turn_context", payload: { approval_policy: "PRIVATE_UNKNOWN_POLICY" } },
  ]);

  assert.deepEqual(mode, { id: "granular", label: "Granular", observedAt: null, source: "provider" });
  assert.equal(codexApprovalModeFromRecord({ type: "event_msg", payload: { approval_policy: "never" } }), null);
});

test("integrates only primary-rollout approval metadata and advertises the bounded capability", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-codex-approval-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "11");
  await mkdir(directory, { recursive: true });
  const fixture = await readProviderFixture("codex/approval-plan.jsonl");
  await writeFile(path.join(directory, "rollout-approval-plan.jsonl"), fixture, "utf8");
  await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id: "codex-approval-plan", thread_name: "Approval fixture", updated_at: "2026-08-11T12:00:08.000Z" })}\n`, "utf8");

  const provider = createCodexProvider({ codexHome: root, cacheMs: 0, scanLimit: 10 });
  const evidence = await provider.readSession("codex-approval-plan", { historical: true });
  assert.equal(provider.capabilities.approvalMode, true);
  assert.deepEqual(evidence.session.approvalMode, {
    id: "granular",
    label: "Granular",
    observedAt: "2026-08-11T12:00:03.000Z",
    source: "provider",
  });
  assertNoPrivateFixtureSentinels(evidence.session.approvalMode, "Codex integrated approval mode");
});
