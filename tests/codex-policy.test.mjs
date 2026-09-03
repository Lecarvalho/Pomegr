import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  POLICY_MAX_BYTES,
  POLICY_VERSION,
  delegationPlan,
  readPolicy,
  transcriptReportsDelegatedSignal,
  validatePolicyText,
} from "../plugins/pomegr/scripts/policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "pomegr");
const policyScript = path.join(pluginRoot, "scripts", "policy.mjs");
const codexTemplatePath = path.join(pluginRoot, "skills", "init", "references", "policy-template.md");
const claudeTemplatePath = path.join(repositoryRoot, "plugins", "claude-code", "skills", "init", "references", "policy-template.md");

async function withTemporaryRepository(run) {
  const repository = await mkdtemp(path.join(os.tmpdir(), "pomegr-codex-policy-"));
  try {
    await mkdir(path.join(repository, ".git"));
    await mkdir(path.join(repository, ".pomegr"));
    return await run(repository);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

function runHook(command, repository, payload) {
  return spawnSync(process.execPath, [policyScript, command], {
    cwd: repository,
    encoding: "utf8",
    input: payload === undefined ? "" : JSON.stringify(payload),
  });
}

function withWorkerTaskDelegation(template) {
  return template.replace(
    "_No delegated agent types configured._",
    "| Agent type | Owns |\n| --- | --- |\n| worker | task |",
  );
}

test("Codex and Claude adapters validate one provider-neutral policy schema", async () => {
  const codexTemplate = await readFile(codexTemplatePath, "utf8");
  const claudeTemplate = await readFile(claudeTemplatePath, "utf8");

  assert.equal(POLICY_VERSION, 7);
  assert.equal(codexTemplate.replace(/\r\n?/g, "\n"), claudeTemplate.replace(/\r\n?/g, "\n"));
  for (const candidate of [codexTemplate, codexTemplate.replace(/\r\n?/g, "\n").replaceAll("\n", "\r\n")]) {
    const result = validatePolicyText(candidate);
    assert.equal(result.status, "valid");
    assert.deepEqual(result.errors, []);
    assert.equal(result.signals["Task signals"][0].label, "Checks passed");
  }

  const legacy = codexTemplate.replace("Policy version: 7", "Policy version: 6").replace(/\n## Session progress\n\n- Enabled: no\n/, "\n");
  const legacyResult = validatePolicyText(legacy);
  assert.equal(legacyResult.status, "valid");
  assert.equal(legacyResult.progressEnabled, false);

  const wrongVersion = validatePolicyText(codexTemplate.replace("Policy version: 7", "Policy version: 5"));
  assert.equal(wrongVersion.status, "invalid");
  assert.ok(wrongVersion.errors.some((error) => error.includes("Policy version must be 7")));

  const oversized = validatePolicyText(codexTemplate + "\n" + "x".repeat(POLICY_MAX_BYTES));
  assert.equal(oversized.status, "invalid");
  assert.ok(oversized.errors.some((error) => error.includes("byte limit")));
});

test("Codex policy discovery stays repository-scoped and rejects invalid policy content", async () => {
  const template = await readFile(codexTemplatePath, "utf8");
  await withTemporaryRepository(async (repository) => {
    const nested = path.join(repository, "src", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(repository, ".pomegr", "signals.md"), template);

    const valid = readPolicy(nested);
    assert.equal(valid.status, "valid");
    assert.equal(valid.repositoryRoot, repository);

    await writeFile(path.join(repository, ".pomegr", "signals.md"), template.replace("Policy version: 7", "Policy version: invalid"));
    const invalid = readPolicy(nested);
    assert.equal(invalid.status, "invalid");
    assert.doesNotMatch(JSON.stringify(invalid.errors), /Ready for review/);
  });
});

test("SessionStart reports plugin metadata for valid, missing, and invalid policies", async () => {
  const template = await readFile(codexTemplatePath, "utf8");
  await withTemporaryRepository(async (repository) => {
    const policyPath = path.join(repository, ".pomegr", "signals.md");
    await writeFile(policyPath, template);
    const valid = runHook("session-start", repository, { hook_event_name: "SessionStart", cwd: repository });
    assert.equal(valid.status, 0);
    const output = JSON.parse(valid.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, /\[Pomegr plugin metadata\].*"pluginVersion":"[^"]+".*"policyStatus":"valid".*"policyVersion":7/);
    assert.match(output.hookSpecificOutput.additionalContext, /\[Pomegr reporting policy loaded\]/);
    assert.match(output.hookSpecificOutput.additionalContext, /read tools are decision-triggered observations/i);
    assert.match(output.hookSpecificOutput.additionalContext, /do not poll routinely or infer causation/i);
    assert.match(output.hookSpecificOutput.additionalContext, /Policy version: 7/);

    await rm(policyPath);
    const missing = runHook("session-start", repository, { hook_event_name: "SessionStart", cwd: repository });
    assert.equal(missing.status, 0);
    assert.match(JSON.parse(missing.stdout).hookSpecificOutput.additionalContext, /"policyStatus":"missing".*"policyVersion":null/);

    await writeFile(policyPath, template.replace("Policy version: 7", "Policy version: invalid"));
    const invalid = runHook("session-start", repository, { hook_event_name: "SessionStart", cwd: repository });
    assert.equal(invalid.status, 0);
    const invalidOutput = JSON.parse(invalid.stdout);
    assert.match(invalidOutput.systemMessage, /\$pomegr:doctor/);
    assert.match(invalidOutput.hookSpecificOutput.additionalContext, /"policyStatus":"invalid".*"policyVersion":null/);
    assert.doesNotMatch(invalid.stdout, /Ready for review/);
  });
});

test("SubagentStart supplies only declared signal rows to a matching Codex agent type", async () => {
  const template = withWorkerTaskDelegation(await readFile(codexTemplatePath, "utf8"));
  await withTemporaryRepository(async (repository) => {
    await writeFile(path.join(repository, ".pomegr", "signals.md"), template);
    const policy = readPolicy(repository);
    const plan = delegationPlan(policy, "worker");
    assert.deepEqual(plan.labels, ["Checks passed"]);
    assert.match(plan.block, /\[Pomegr delegated reporting policy\]/);
    assert.doesNotMatch(plan.block, /Ready for review/);

    const worker = runHook("subagent-start", repository, {
      hook_event_name: "SubagentStart",
      cwd: repository,
      agent_type: "worker",
    });
    const output = JSON.parse(worker.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /Checks passed/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Ready for review/);

    const explorer = runHook("subagent-start", repository, {
      hook_event_name: "SubagentStart",
      cwd: repository,
      agent_type: "explorer",
    });
    assert.deepEqual(JSON.parse(explorer.stdout), {});
  });
});

test("SubagentStop detects exact Pomegr report calls and never exposes transcript content or paths", async () => {
  const template = withWorkerTaskDelegation(await readFile(codexTemplatePath, "utf8"));
  await withTemporaryRepository(async (repository) => {
    await writeFile(path.join(repository, ".pomegr", "signals.md"), template);
    const transcript = path.join(repository, "worker.jsonl");
    const sensitive = "SECRET transcript text that must never be returned";
    await writeFile(transcript, JSON.stringify({ type: "event_msg", payload: { message: sensitive } }) + "\n");
    assert.equal(transcriptReportsDelegatedSignal(transcript), false);
    const parentTranscript = path.join(repository, "parent.jsonl");
    await writeFile(parentTranscript, JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "mcp__plugin_pomegr_pomegr__report_task_signal" },
    }) + "\n");

    const missing = runHook("subagent-stop", repository, {
      hook_event_name: "SubagentStop",
      cwd: repository,
      agent_type: "worker",
      transcript_path: parentTranscript,
      agent_transcript_path: transcript,
    });
    const warning = JSON.parse(missing.stdout).systemMessage;
    assert.match(warning, /Checks passed/);
    assert.doesNotMatch(warning, /SECRET|worker\.jsonl/);

    await writeFile(transcript, JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "mcp__plugin_pomegr_pomegr__report_task_signal" },
    }) + "\n");
    assert.equal(transcriptReportsDelegatedSignal(transcript), true);
    const reported = runHook("subagent-stop", repository, {
      hook_event_name: "SubagentStop",
      cwd: repository,
      agent_type: "worker",
      transcript_path: parentTranscript,
      agent_transcript_path: transcript,
    });
    assert.deepEqual(JSON.parse(reported.stdout), {});
  });
});
