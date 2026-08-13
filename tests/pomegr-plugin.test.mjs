import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPomegrMcpServer } from "../plugins/claude-code/mcp/server.mjs";
import {
  findPolicy,
  POLICY_MAX_BYTES,
  readPolicy,
  validatePolicyText,
} from "../plugins/claude-code/scripts/policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "claude-code");
const policyScript = path.join(pluginRoot, "scripts", "policy.mjs");
const policyTemplatePath = path.join(pluginRoot, "skills", "init", "references", "policy-template.md");
const restartSkillRoot = path.join(repositoryRoot, ".codex", "skills", "restart-pomegr");

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-plugin-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writePolicy(repository, text) {
  const directory = path.join(repository, ".pomegr");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "signals.md"), text, "utf8");
}

function runPolicyHook(cwd) {
  return spawnSync(process.execPath, [policyScript, "hook", "--cwd", cwd], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

test("validates the repository policy template and extracts bounded signal rows", async () => {
  const template = await readFile(policyTemplatePath, "utf8");
  const result = validatePolicyText(template);

  assert.equal(result.status, "valid");
  assert.deepEqual(result.errors, []);
  assert.equal(result.signals["Session signals"][0].label, "Ready for review");
  assert.equal(result.signals["Agent signals"].length, 0);
  assert.equal(result.signals["Task signals"][0].label, "Checks passed");
});

test("rejects malformed and oversized policies without interpreting their content", async () => {
  const template = await readFile(policyTemplatePath, "utf8");
  const malformed = validatePolicyText(template.replace("Policy version: 1", "Policy version: 2"));
  assert.equal(malformed.status, "invalid");
  assert.ok(malformed.errors.includes("Policy version must be 1."));

  const oversized = validatePolicyText(`${template}\n${"x".repeat(POLICY_MAX_BYTES)}`);
  assert.equal(oversized.status, "invalid");
  assert.ok(oversized.errors.some((error) => error.includes("byte limit")));
});

test("rejects policies that contradict naming, privacy, and signal-lifetime invariants", async () => {
  const template = await readFile(policyTemplatePath, "utf8");
  const badNaming = validatePolicyText(template.replace(
    "- Never ask the user to name the session and never report a title through Pomegr MCP.",
    "- Always ask the user to run /rename and report the title.",
  ));
  assert.equal(badNaming.status, "invalid");
  assert.ok(badNaming.errors.includes("Session naming must match the canonical native-title policy."));

  const badPrivacy = validatePolicyText(template.replace(
    "- Never include prompts, responses, secrets, commands, stdout, stderr, tool results, credential values, or sensitive repository content.",
    "- Include prompts, secrets, raw commands, and tool output.",
  ));
  assert.equal(badPrivacy.status, "invalid");
  assert.ok(badPrivacy.errors.includes("Privacy and semantics must match the canonical Pomegr safety policy."));

  const permanentSession = validatePolicyText(template.replace(
    "Replace if review finds new work; clear when the session moves to unrelated work.",
    "Keep this signal forever.",
  ));
  assert.equal(permanentSession.status, "invalid");
  assert.ok(permanentSession.errors.some((error) => error.includes("replaced or cleared")));

  const negatedSessionTransition = validatePolicyText(template.replace(
    "Replace if review finds new work; clear when the session moves to unrelated work.",
    "Never replace or clear this signal.",
  ));
  assert.equal(negatedSessionTransition.status, "invalid");
  assert.ok(negatedSessionTransition.errors.some((error) => error.includes("affirmatively")));

  const passiveNegatedSessionTransition = validatePolicyText(template.replace(
    "Replace if review finds new work; clear when the session moves to unrelated work.",
    "This signal is not cleared when the work is resolved.",
  ));
  assert.equal(passiveNegatedSessionTransition.status, "invalid");
  assert.ok(passiveNegatedSessionTransition.errors.some((error) => error.includes("affirmatively")));

  const clearableTask = validatePolicyText(template.replace(
    "Replace only if a later outcome for the same execution task supersedes it; task signals are not cleared.",
    "Clear the task signal when the task finishes.",
  ));
  assert.equal(clearableTask.status, "invalid");
  assert.ok(clearableTask.errors.some((error) => error.includes("durable and cannot be cleared")));

  const conditionalTaskDurability = validatePolicyText(template.replace(
    "Replace only if a later outcome for the same execution task supersedes it; task signals are not cleared.",
    "Replace after a later outcome; task signals are not cleared unless the task finishes.",
  ));
  assert.equal(conditionalTaskDurability.status, "invalid");
  assert.ok(conditionalTaskDurability.errors.some((error) => error.includes("unconditional")));

  const duplicateHeading = validatePolicyText(`${template}\n## Session naming\n\n- Contradictory duplicate.`);
  assert.equal(duplicateHeading.status, "invalid");
  assert.ok(duplicateHeading.errors.includes('Policy must contain exactly one "Session naming" section.'));
});

test("rejects a non-regular policy path before reading or injecting it", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(path.join(repository, ".pomegr", "signals.md"), { recursive: true });

    const policy = readPolicy(repository);
    assert.equal(policy.status, "invalid");
    assert.deepEqual(policy.errors, ["Policy must be a regular file and cannot be a symbolic link."]);

    const hook = runPolicyHook(repository);
    assert.equal(hook.status, 0);
    assert.match(JSON.parse(hook.stdout).systemMessage, /\/pomegr:doctor/);
  });
});

test("finds a policy upward only as far as the repository root", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    const nested = path.join(repository, "packages", "client", "src");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });

    const missing = findPolicy(nested);
    assert.equal(missing.status, "missing");
    assert.equal(missing.path, path.join(repository, ".pomegr", "signals.md"));

    const template = await readFile(policyTemplatePath, "utf8");
    await writePolicy(repository, template);
    const found = findPolicy(nested);
    assert.equal(found.repositoryRoot, repository);
    assert.equal(found.path, path.join(repository, ".pomegr", "signals.md"));
    assert.equal(readPolicy(nested).status, "valid");
  });
});

test("ignores a legacy-only reporting policy and leaves the hook silent", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    const legacyDirectory = path.join(repository, ".threadlight");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(path.join(legacyDirectory, "signals.md"), await readFile(policyTemplatePath, "utf8"), "utf8");

    const policy = findPolicy(repository);
    assert.equal(policy.status, "missing");
    assert.equal(policy.path, path.join(repository, ".pomegr", "signals.md"));

    const hook = runPolicyHook(repository);
    assert.equal(hook.status, 0);
    assert.equal(hook.stdout, "");
  });
});

test("SessionStart hook injects valid policy context, stays silent when missing, and warns safely when invalid", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    const nested = path.join(repository, "src");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });

    const missing = runPolicyHook(nested);
    assert.equal(missing.status, 0);
    assert.equal(missing.stdout, "");

    const template = await readFile(policyTemplatePath, "utf8");
    await writePolicy(repository, template);
    const valid = runPolicyHook(nested);
    assert.equal(valid.status, 0);
    const validOutput = JSON.parse(valid.stdout);
    assert.equal(validOutput.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(validOutput.hookSpecificOutput.additionalContext, /\[Pomegr reporting policy loaded\]/);
    assert.match(validOutput.hookSpecificOutput.additionalContext, /allow Claude Code to assign/i);
    assert.match(validOutput.hookSpecificOutput.additionalContext, /# Pomegr reporting policy/);

    await writePolicy(repository, template.replace("Policy version: 1", "Policy version: invalid"));
    const invalid = runPolicyHook(nested);
    assert.equal(invalid.status, 0);
    const invalidOutput = JSON.parse(invalid.stdout);
    assert.match(invalidOutput.systemMessage, /\/pomegr:doctor/);
    assert.doesNotMatch(invalid.stdout, /Ready for review/);
    assert.equal(invalidOutput.hookSpecificOutput, undefined);
  });
});

test("plugin manifests register every SessionStart transition and the self-contained MCP server", async () => {
  const marketplace = JSON.parse(await readFile(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const hooks = JSON.parse(await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const packageManifest = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));

  assert.equal(marketplace.plugins[0].source, "./plugins/claude-code");
  assert.equal(manifest.name, "pomegr");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume|fork|clear|compact");
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /\$\{CLAUDE_PROJECT_DIR\}/);
  assert.match(mcp.mcpServers.pomegr.args[0], /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.deepEqual(Object.keys(packageManifest.dependencies).sort(), ["@modelcontextprotocol/server", "zod"]);

  const doctor = await readFile(path.join(pluginRoot, "skills", "doctor", "SKILL.md"), "utf8");
  assert.match(doctor, /\[Pomegr reporting policy loaded\]/);
  assert.match(doctor, /\/hooks/);
  assert.match(doctor, /\/mcp/);
});

test("plugin namespace rejects every legacy Threadlight identifier", async () => {
  const ownedFiles = [
    path.join(repositoryRoot, "mcp", "server.mjs"),
    path.join(repositoryRoot, ".claude-plugin", "marketplace.json"),
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    path.join(pluginRoot, ".mcp.json"),
    path.join(pluginRoot, "package.json"),
    path.join(pluginRoot, "hooks", "hooks.json"),
    path.join(pluginRoot, "mcp", "server.mjs"),
    path.join(pluginRoot, "scripts", "policy.mjs"),
    path.join(pluginRoot, "skills", "doctor", "SKILL.md"),
    path.join(pluginRoot, "skills", "doctor", "agents", "openai.yaml"),
    path.join(pluginRoot, "skills", "init", "SKILL.md"),
    path.join(pluginRoot, "skills", "init", "agents", "openai.yaml"),
    policyTemplatePath,
    path.join(restartSkillRoot, "SKILL.md"),
    path.join(restartSkillRoot, "agents", "openai.yaml"),
    path.join(restartSkillRoot, "scripts", "restart-pomegr.ps1"),
  ];
  const legacy = /threadlight|@threadlight|\/threadlight:|\.threadlight|Lecarvalho\/threadlight/i;
  for (const file of ownedFiles) {
    assert.doesNotMatch(await readFile(file, "utf8"), legacy, file);
  }

  await assert.rejects(access(path.join(repositoryRoot, ".codex", "skills", "restart-threadlight")), { code: "ENOENT" });
  await assert.rejects(access(path.join(restartSkillRoot, "scripts", "restart-threadlight.ps1")), { code: "ENOENT" });
});

test("plugin MCP inventory contains only reporting and scoped clearing tools", () => {
  const server = buildPomegrMcpServer();
  const tools = Object.keys(server._registeredTools).sort();

  assert.deepEqual(tools, [
    "clear_agent_signal",
    "clear_session_signal",
    "report_agent_signal",
    "report_session_signal",
    "report_task_signal",
  ]);
  assert.equal(tools.includes("report_session_title"), false);
  assert.equal(tools.includes("ask_pomegr"), false);
  assert.ok(tools.every((name) => server._registeredTools[name]._meta["anthropic/alwaysLoad"] === true));
});
