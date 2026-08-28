import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { providerSource, qualifyProviderSessionId } from "../../monitor/providers/provider-contract.mjs";
import { projectProviderSessionEvidence } from "../../monitor/session-projection.mjs";
import { createEmptyProviderCapabilities, createEmptyUsageLimits } from "../../shared/monitor-state.mjs";

export const PROVIDER_FIXTURE_ROOT = new URL("../fixtures/providers/", import.meta.url);

export const PRIVATE_FIXTURE_SENTINELS = Object.freeze([
  "PROMPT_MUST_NOT_LEAK",
  "ANSWER_MUST_NOT_LEAK",
  "RESPONSE_MUST_NOT_LEAK",
  "REASONING_MUST_NOT_LEAK",
  "DEVELOPER_INSTRUCTIONS_MUST_NOT_LEAK",
  "COMMAND_MUST_NOT_LEAK",
  "PATCH_MUST_NOT_LEAK",
  "STDOUT_MUST_NOT_LEAK",
  "STDERR_MUST_NOT_LEAK",
  "TOOL_OUTPUT_MUST_NOT_LEAK",
  "MCP_ARGUMENT_MUST_NOT_LEAK",
  "OAUTH_TOKEN_MUST_NOT_LEAK",
  "ENV_SECRET_MUST_NOT_LEAK",
  "PRIVATE_PATH_MUST_NOT_LEAK",
  "APPROVAL_REASON_MUST_NOT_LEAK",
  "PERMISSION_RULE_MUST_NOT_LEAK",
  "PLAN_EXPLANATION_MUST_NOT_LEAK",
  "PLAN_PROSE_MUST_NOT_LEAK",
  "PLAN_DESCRIPTION_MUST_NOT_LEAK",
  "ACTIVE_FORM_MUST_NOT_LEAK",
  "WORKFLOW_SCRIPT_MUST_NOT_LEAK",
  "WORKFLOW_AGENT_PROMPT_MUST_NOT_LEAK",
  "WORKFLOW_JOURNAL_RESULT_MUST_NOT_LEAK",
  "WORKFLOW_PATH_MUST_NOT_LEAK",
]);

export async function readProviderFixture(relativePath) {
  return readFile(new URL(relativePath, PROVIDER_FIXTURE_ROOT), "utf8");
}

export async function readProviderJsonFixture(relativePath) {
  return JSON.parse(await readProviderFixture(relativePath));
}

export async function readProviderJsonlFixture(relativePath) {
  const text = await readProviderFixture(relativePath);
  const records = [];
  const rejectedLines = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      rejectedLines.push({ lineNumber: index + 1, byteLength: Buffer.byteLength(line) });
    }
  }
  return { records, rejectedLines };
}

export function assertNoPrivateFixtureSentinels(value, label = "serialized provider output") {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of PRIVATE_FIXTURE_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, `${label} leaked ${sentinel}`);
  }
}

/**
 * @param {"claude" | "codex"} providerId
 * @param {import("../../monitor/providers/provider-contract.mjs").ProviderSessionEvidence} evidence
 * @returns {import("../../shared/monitor-contract").MonitorState}
 */
export function monitorStateFromProviderEvidence(providerId, evidence) {
  const source = providerSource(providerId);
  return projectProviderSessionEvidence({
    evidence,
    sessionId: qualifyProviderSessionId(providerId, evidence.localId),
    source,
    capabilities: createEmptyProviderCapabilities(),
    repository: {
      available: Boolean(evidence.session.recordedGitBranch),
      branch: evidence.session.recordedGitBranch,
      files: [],
      historical: evidence.historical,
      isMain: false,
      comparison: null,
      commits: [],
      remote: { status: "unavailable", checkedAt: null },
    },
    pullRequests: { status: "ready", checkedAt: null, items: [] },
    usageLimits: createEmptyUsageLimits(),
    resources: null,
  });
}
