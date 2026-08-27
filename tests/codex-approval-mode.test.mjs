import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

test("hydrates and retains a live approval mode after it leaves the bounded rollout tail", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-live-approval-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions", "2026", "08", "12");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-live-approval-cache.jsonl");
  const session = {
    timestamp: "2026-08-12T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "live-approval-cache",
      session_id: "live-approval-cache",
      source: "cli",
      cwd: "C:\\synthetic\\approval-cache",
    },
  };
  const mode = {
    timestamp: "2026-08-12T12:00:01.000Z",
    type: "turn_context",
    payload: {
      approval_policy: "on-request",
      sandbox_policy: { writable_roots: ["PRIVATE_PATH_MUST_NOT_LEAK"] },
    },
  };
  const padding = (timestamp, length) => ({
    timestamp,
    type: "future_record",
    payload: { private: `TOOL_OUTPUT_MUST_NOT_LEAK${"x".repeat(length)}` },
  });
  const serialize = (records) => `${records.map(JSON.stringify).join("\n")}\n`;
  await writeFile(file, serialize([session, mode, padding("2026-08-12T12:00:02.000Z", 1_200)]), "utf8");

  const provider = createCodexProvider({
    codexHome: root,
    includeArchived: false,
    cacheMs: 0,
    maximumStateTailBytes: 256,
    maximumTaskHistoryBytes: 2_048,
  });
  const hydrated = await provider.readSession("live-approval-cache", { historical: false });
  assert.deepEqual(hydrated.session.approvalMode, {
    id: "on_request",
    label: "On request",
    observedAt: "2026-08-12T12:00:01.000Z",
    source: "provider",
  });
  assert.equal(provider.qaStats().liveApprovalModeEntries, 1);

  await appendFile(file, serialize([padding("2026-08-12T12:00:03.000Z", 4_000)]), "utf8");
  const retained = await provider.readSession("live-approval-cache", { historical: false });
  assert.deepEqual(retained.session.approvalMode, hydrated.session.approvalMode);
  assert.equal(provider.qaStats().liveApprovalModeEntries, 1);
  assertNoPrivateFixtureSentinels(retained, "cached live Codex approval mode");

  await appendFile(file, serialize([{
    timestamp: "2026-08-12T12:00:04.000Z",
    type: "turn_context",
    payload: { approval_policy: "never" },
  }, padding("2026-08-12T12:00:05.000Z", 1_000)]), "utf8");
  const changedOutsideTail = await provider.readSession("live-approval-cache", { historical: false });
  assert.equal(changedOutsideTail.session.approvalMode.id, "never");
  assert.equal(provider.qaStats().liveApprovalModeEntries, 1);

  await writeFile(file, serialize([session, padding("2026-08-12T12:01:00.000Z", 200)]), "utf8");
  const afterTruncate = await provider.readSession("live-approval-cache", { historical: false });
  assert.equal(afterTruncate.session.approvalMode, null);
  assert.equal(provider.qaStats().liveApprovalModeEntries, 1);
  const hydrationReadsAfterTruncate = provider.qaStats().approvalHydrationReads;
  const repeatedMissingMode = await provider.readSession("live-approval-cache", { historical: false });
  assert.equal(repeatedMissingMode.session.approvalMode, null);
  assert.equal(provider.qaStats().approvalHydrationReads, hydrationReadsAfterTruncate);

  await writeFile(file, serialize([session, {
    timestamp: "2026-08-12T12:02:00.000Z",
    type: "turn_context",
    payload: { approval_policy: { granular: { rules: true } } },
  }]), "utf8");
  const afterReplacement = await provider.readSession("live-approval-cache", { historical: false });
  assert.equal(afterReplacement.session.approvalMode.id, "granular");
  assert.equal(provider.qaStats().liveApprovalModeEntries, 1);

  await rm(file);
  assert.equal(await provider.readSession("live-approval-cache", { historical: false }), null);
  assert.equal(provider.qaStats().liveApprovalModeEntries, 0);
});

test("integrates only primary-rollout approval metadata and advertises the bounded capability", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-approval-"));
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
