import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPomegrMcpServer } from "../plugins/claude-code/mcp/server.mjs";
import {
  DELEGATION_MARKER,
  findPolicy,
  POLICY_MAX_BYTES,
  readPolicy,
  validatePolicyText,
} from "../plugins/claude-code/scripts/policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "claude-code");
const policyScript = path.join(pluginRoot, "scripts", "policy.mjs");
const policyTemplatePath = path.join(pluginRoot, "skills", "init", "references", "policy-template.md");
const releaseScriptPath = path.join(repositoryRoot, "scripts", "release-claude-plugin.sh");
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

function runPolicyEventHook(command, cwd, payload) {
  return spawnSync(process.execPath, [policyScript, command, "--cwd", cwd], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
}

function withDelegatedAgents(template, rows) {
  return template.replace(
    "_No delegated agent types configured._",
    ["| Agent type | Owns |", "| --- | --- |", ...rows].join("\n"),
  );
}

function withAgentSignals(template, rows) {
  return template.replace(
    /## Agent signals\r?\n\r?\n_No project-specific signals configured\._/,
    ["## Agent signals", "", "| Label | Tone | Report when | Replace or clear when |", "| --- | --- | --- | --- |", ...rows].join("\n"),
  );
}

async function writeTranscript(directory, name, records) {
  const file = path.join(directory, name);
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return file;
}

function reportRecord(toolName) {
  return {
    type: "assistant",
    timestamp: "2026-08-14T10:00:00.000Z",
    message: { content: [{ type: "tool_use", name: toolName, input: { label: "Verified", tone: "positive" } }] },
  };
}

async function readMcpToolInventory(server, cwd) {
  const child = spawn(process.execPath, [server], {
    cwd,
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let stdout = "";
  let stderr = "";

  try {
    const inventory = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP tools/list. stderr: ${stderr}`)), 5_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!messages.some((message) => message.id === 2)) {
          reject(new Error(`MCP server exited with ${code}. stderr: ${stderr}`));
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          messages.push(message);
          if (message.id === 2) {
            clearTimeout(timer);
            resolve(message.result?.tools || []);
          }
        }
      });

      const requests = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pomegr-plugin-test", version: "1.0.0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ];
      child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
    });
    return inventory;
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
  }
}

test("validates the repository policy template and extracts bounded signal rows", async () => {
  const template = await readFile(policyTemplatePath, "utf8");
  const lfTemplate = template.replace(/\r\n?/g, "\n");
  for (const candidate of [lfTemplate, lfTemplate.replaceAll("\n", "\r\n")]) {
    const result = validatePolicyText(candidate);
    assert.equal(result.status, "valid");
    assert.deepEqual(result.errors, []);
    assert.match(lfTemplate, /## Delegated agent tooling/);
    assert.match(lfTemplate, /## Delegated agents/);
    assert.match(lfTemplate, /mcp__plugin_pomegr_pomegr__\*/);
    assert.equal(result.signals["Session signals"][0].label, "Ready for review");
    assert.equal(result.signals["Agent signals"].length, 0);
    assert.equal(result.signals["Task signals"][0].label, "Checks passed");
    assert.deepEqual(result.delegatedAgents, []);
  }
});

test("validates the delegated-agents table and rejects incoherent delegation", async () => {
  const template = await readFile(policyTemplatePath, "utf8");

  const declared = validatePolicyText(withDelegatedAgents(template, ["| release-verifier | task |", "| * | task |"]));
  assert.equal(declared.status, "valid");
  assert.deepEqual(declared.delegatedAgents, [
    { agentType: "release-verifier", owns: ["Task signals"] },
    { agentType: "*", owns: ["Task signals"] },
  ]);

  const bothScopes = validatePolicyText(withAgentSignals(
    withDelegatedAgents(template, ["| Release-Verifier | agent and task |"]),
    ["| Contract intact | positive | The reviewed contract still holds. | Replace when a later review changes it; clear when the agent leaves the contract. |"],
  ));
  assert.equal(bothScopes.status, "valid");
  assert.deepEqual(bothScopes.delegatedAgents, [{ agentType: "release-verifier", owns: ["Agent signals", "Task signals"] }]);

  const emptyScope = validatePolicyText(withDelegatedAgents(template, ["| release-verifier | agent |"]));
  assert.equal(emptyScope.status, "invalid");
  assert.ok(emptyScope.errors.some((error) => error.includes("configures no rows to delegate")));

  const badOwnership = validatePolicyText(withDelegatedAgents(template, ["| release-verifier | everything |"]));
  assert.equal(badOwnership.status, "invalid");
  assert.ok(badOwnership.errors.some((error) => error.includes('must own "agent", "task", or "agent and task"')));

  const badType = validatePolicyText(withDelegatedAgents(template, [`| ${"a".repeat(65)} | task |`]));
  assert.equal(badType.status, "invalid");
  assert.ok(badType.errors.some((error) => error.includes("invalid agent type")));

  const duplicate = validatePolicyText(withDelegatedAgents(template, ["| release-verifier | task |", "| release-verifier | task |"]));
  assert.equal(duplicate.status, "invalid");
  assert.ok(duplicate.errors.some((error) => error.includes("duplicate agent type")));

  const missingSection = validatePolicyText(template.replace(/## Delegated agents\r?\n\r?\n_No delegated agent types configured\._\r?\n\r?\n/, ""));
  assert.equal(missingSection.status, "invalid");
  assert.ok(missingSection.errors.some((error) => error.includes('Missing or empty "Delegated agents" section.')));
});

test("rejects malformed and oversized policies without interpreting their content", async () => {
  const template = await readFile(policyTemplatePath, "utf8");
  const malformed = validatePolicyText(template.replace("Policy version: 4", "Policy version: 1"));
  assert.equal(malformed.status, "invalid");
  assert.ok(malformed.errors.includes("Policy version must be 4."));

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

  const missingDelegatedTools = validatePolicyText(template.replace(
    "- Every agent definition that can own a configured agent or execution-task signal must also carry the Pomegr reporting tools in its `tools` allowlist. Claude Code subagents inherit MCP tools from the parent unless a definition sets an explicit allowlist.",
    "- Restricted agent definitions may own signals without the Pomegr reporting tools.",
  ));
  assert.equal(missingDelegatedTools.status, "invalid");
  assert.ok(missingDelegatedTools.errors.includes("Delegated agent tooling must declare signal-owning subagent types and attach the Pomegr MCP tools to them."));

  const optionalInjection = validatePolicyText(template.replace(
    "- Never rely on the delegating session remembering to paste the rows. Injection is the mechanism; a pasted copy is only a fallback, and the hook does not append a second copy when the prompt already carries one.",
    "- When delegating such work, include the applicable signal rows and transition rules in the Agent prompt.",
  ));
  assert.equal(optionalInjection.status, "invalid");
  assert.ok(optionalInjection.errors.includes("Delegated agent tooling must declare signal-owning subagent types and attach the Pomegr MCP tools to them."));

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
    assert.match(validOutput.hookSpecificOutput.additionalContext, /Delegation is mechanized/i);
    assert.match(validOutput.hookSpecificOutput.additionalContext, /# Pomegr reporting policy/);

    await writePolicy(repository, template.replace("Policy version: 4", "Policy version: invalid"));
    const invalid = runPolicyHook(nested);
    assert.equal(invalid.status, 0);
    const invalidOutput = JSON.parse(invalid.stdout);
    assert.match(invalidOutput.systemMessage, /\/pomegr:doctor/);
    assert.doesNotMatch(invalid.stdout, /Ready for review/);
    assert.equal(invalidOutput.hookSpecificOutput, undefined);
  });
});

test("reports delegation drift in both directions and stays quiet for uninvolved definitions", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    const agents = path.join(repository, ".claude", "agents");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(agents, { recursive: true });
    const template = await readFile(policyTemplatePath, "utf8");

    const definitions = {
      "restricted.md": "---\nname: restricted\ntools: Read, Bash\n---\n\nBody.\n",
      "listed.md": "---\nname: listed\ntools:\n  - Read\n  - Bash\nmodel: opus\n---\n\nBody.\n",
      "inheriting.md": "---\nname: inheriting\nmodel: opus\n---\n\nBody.\n",
      "wildcard.md": "---\nname: wildcard\ntools: *\n---\n\nBody.\n",
      "equipped.md": "---\nname: equipped\ntools: Read, mcp__plugin_pomegr_pomegr__report_task_signal\n---\n\nBody.\n",
      "notes.txt": "tools: Read\n",
    };
    for (const [name, contents] of Object.entries(definitions)) {
      await writeFile(path.join(agents, name), contents, "utf8");
    }

    await writePolicy(repository, template);
    const undeclared = readPolicy(repository);
    assert.equal(undeclared.status, "valid");
    assert.deepEqual(undeclared.warnings.map((warning) => warning.match(/"([^"]+)"/)[1]), [".claude/agents/equipped.md"]);
    assert.match(undeclared.warnings[0], /no Delegated agents row matches it/);
    assert.ok(undeclared.warnings.every((warning) => !/tools:/.test(warning)));

    await writePolicy(repository, withDelegatedAgents(template, ["| restricted | task |", "| equipped | task |"]));
    const declared = readPolicy(repository);
    assert.equal(declared.status, "valid");
    assert.deepEqual(declared.warnings.map((warning) => warning.match(/"([^"]+)"/)[1]), [".claude/agents/restricted.md"]);
    assert.match(declared.warnings[0], /still cannot report/);

    const hook = runPolicyHook(path.join(repository, ".git"));
    const context = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /\[Pomegr policy drift\]/);
    assert.match(context, /restricted\.md/);
    assert.doesNotMatch(context, /equipped\.md/);

    await writePolicy(repository, withDelegatedAgents(template, ["| * | task |"]));
    const everyAgent = readPolicy(repository);
    assert.deepEqual(everyAgent.warnings.map((warning) => warning.match(/"([^"]+)"/)[1]).sort(), [
      ".claude/agents/listed.md",
      ".claude/agents/restricted.md",
    ]);

    await writePolicy(repository, template.replace(
      /## Task signals\r?\n\r?\n[\s\S]*$/,
      "## Task signals\n\n_No project-specific signals configured._\n",
    ));
    const withoutDelegatedSignals = readPolicy(repository);
    assert.equal(withoutDelegatedSignals.status, "valid");
    assert.deepEqual(withoutDelegatedSignals.warnings, []);
  });
});

test("PreToolUse delegation hook injects the declared rows into a subagent prompt exactly once", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    const template = await readFile(policyTemplatePath, "utf8");
    await writePolicy(repository, withDelegatedAgents(template, ["| release-verifier | task |"]));

    const spawnPayload = (overrides = {}) => ({
      hook_event_name: "PreToolUse",
      cwd: repository,
      tool_name: "Task",
      tool_input: { description: "Verify the release", prompt: "Run the release checks.", subagent_type: "release-verifier" },
      ...overrides,
    });

    const injected = runPolicyEventHook("delegate", repository, spawnPayload());
    assert.equal(injected.status, 0);
    const output = JSON.parse(injected.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
    const updatedPrompt = output.hookSpecificOutput.updatedInput.prompt;
    assert.equal(output.hookSpecificOutput.updatedInput.subagent_type, "release-verifier");
    assert.equal(output.hookSpecificOutput.updatedInput.description, "Verify the release");
    assert.match(updatedPrompt, /^Run the release checks\./);
    assert.ok(updatedPrompt.includes(DELEGATION_MARKER));
    assert.match(updatedPrompt, /### Task signals/);
    assert.match(updatedPrompt, /\| Checks passed \| positive \|/);
    assert.doesNotMatch(updatedPrompt, /### Session signals/);
    assert.doesNotMatch(updatedPrompt, /Ready for review/);

    const reinjected = runPolicyEventHook("delegate", repository, spawnPayload({
      tool_input: { prompt: updatedPrompt, subagent_type: "release-verifier" },
    }));
    assert.equal(reinjected.stdout, "");

    const parentPasted = runPolicyEventHook("delegate", repository, spawnPayload({
      tool_input: { prompt: "Follow the Pomegr policy row Checks passed for this run.", subagent_type: "release-verifier" },
    }));
    assert.equal(parentPasted.stdout, "");

    const agentToolName = runPolicyEventHook("delegate", repository, spawnPayload({ tool_name: "Agent" }));
    assert.ok(JSON.parse(agentToolName.stdout).hookSpecificOutput.updatedInput.prompt.includes(DELEGATION_MARKER));

    for (const skipped of [
      spawnPayload({ tool_input: { prompt: "Anything.", subagent_type: "fork" } }),
      spawnPayload({ tool_input: { prompt: "Anything.", subagent_type: "general-purpose" } }),
      spawnPayload({ tool_input: { prompt: "Anything." } }),
      spawnPayload({ tool_input: { subagent_type: "release-verifier" } }),
      spawnPayload({ tool_name: "TaskStop" }),
    ]) {
      const result = runPolicyEventHook("delegate", repository, skipped);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
    }

    const malformed = spawnSync(process.execPath, [policyScript, "delegate", "--cwd", repository], {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: "not json",
    });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, "");
  });
});

test("delegation hook stays silent for an undeclared policy, a missing policy, and an invalid policy", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    const template = await readFile(policyTemplatePath, "utf8");
    const payload = {
      hook_event_name: "PreToolUse",
      cwd: repository,
      tool_name: "Task",
      tool_input: { prompt: "Do the work.", subagent_type: "release-verifier" },
    };

    assert.equal(runPolicyEventHook("delegate", repository, payload).stdout, "");

    await writePolicy(repository, template);
    assert.equal(runPolicyEventHook("delegate", repository, payload).stdout, "");

    await writePolicy(repository, withDelegatedAgents(template, ["| release-verifier | task |"]).replace("Policy version: 4", "Policy version: 9"));
    assert.equal(runPolicyEventHook("delegate", repository, payload).stdout, "");
  });
});

test("SubagentStop detector reports a miss without inferring a signal", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    const template = await readFile(policyTemplatePath, "utf8");
    await writePolicy(repository, withDelegatedAgents(template, ["| release-verifier | task |"]));

    const conversation = [
      { type: "user", message: { content: "Verify the release." } },
      { type: "assistant", timestamp: "2026-08-14T10:00:00.000Z", message: { content: [{ type: "text", text: "Checks are green." }] } },
    ];
    const silent = await writeTranscript(temporaryRoot, "silent.jsonl", conversation);
    const reported = await writeTranscript(temporaryRoot, "reported.jsonl", [
      ...conversation,
      reportRecord("mcp__plugin_pomegr_pomegr__report_task_signal"),
    ]);
    const sessionOnly = await writeTranscript(temporaryRoot, "session-only.jsonl", [
      ...conversation,
      reportRecord("mcp__plugin_pomegr_pomegr__report_session_signal"),
    ]);

    const payload = (overrides) => ({
      hook_event_name: "SubagentStop",
      cwd: repository,
      agent_id: "a1b2c3",
      agent_type: "release-verifier",
      transcript_path: silent,
      ...overrides,
    });

    const miss = runPolicyEventHook("subagent-stop", repository, payload());
    assert.equal(miss.status, 0);
    const message = JSON.parse(miss.stdout).systemMessage;
    assert.match(message, /release-verifier/);
    assert.match(message, /finished without calling a Pomegr reporting tool/);
    assert.match(message, /Checks passed/);
    assert.match(message, /never infers a signal/);
    assert.equal(JSON.parse(miss.stdout).hookSpecificOutput, undefined);
    assert.equal(JSON.parse(miss.stdout).decision, undefined);
    assert.doesNotMatch(message, /Checks are green/);

    assert.equal(runPolicyEventHook("subagent-stop", repository, payload({ transcript_path: reported })).stdout, "");
    assert.match(
      JSON.parse(runPolicyEventHook("subagent-stop", repository, payload({ transcript_path: sessionOnly })).stdout).systemMessage,
      /finished without calling a Pomegr reporting tool/,
    );

    for (const quiet of [
      payload({ agent_type: "general-purpose" }),
      payload({ agent_type: "fork" }),
      payload({ stop_hook_active: true }),
      payload({ transcript_path: path.join(temporaryRoot, "absent.jsonl") }),
      payload({ transcript_path: "" }),
    ]) {
      const result = runPolicyEventHook("subagent-stop", repository, quiet);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
    }
  });
});

test("plugin manifests register every policy hook and the bundled MCP server", async () => {
  const marketplace = JSON.parse(await readFile(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const hooks = JSON.parse(await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const packageManifest = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));

  assert.equal(marketplace.plugins[0].source, "./plugins/claude-code");
  assert.equal(manifest.name, "pomegr");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume|fork|clear|compact");
  assert.equal(hooks.hooks.PreToolUse[0].matcher, "Task|Agent");
  assert.equal(hooks.hooks.SubagentStop[0].matcher, undefined);
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /policy\.mjs" delegate/);
  assert.match(hooks.hooks.SubagentStop[0].hooks[0].command, /policy\.mjs" subagent-stop/);
  for (const event of ["SessionStart", "PreToolUse", "SubagentStop"]) {
    assert.match(hooks.hooks[event][0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.match(hooks.hooks[event][0].hooks[0].command, /\$\{CLAUDE_PROJECT_DIR\}/);
  }
  assert.match(mcp.mcpServers.pomegr.args[0], /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(mcp.mcpServers.pomegr.args[0], /server\.bundle\.mjs$/);
  assert.deepEqual(Object.keys(packageManifest.dependencies).sort(), ["@modelcontextprotocol/server", "zod"]);

  const doctor = await readFile(path.join(pluginRoot, "skills", "doctor", "SKILL.md"), "utf8");
  assert.match(doctor, /\[Pomegr reporting policy loaded\]/);
  assert.match(doctor, /\[Pomegr delegated reporting policy\]/);
  assert.match(doctor, /delegatedAgents/);
  assert.match(doctor, /SubagentStop/);
  assert.match(doctor, /\/hooks/);
  assert.match(doctor, /\/mcp/);

  const init = await readFile(path.join(pluginRoot, "skills", "init", "SKILL.md"), "utf8");
  assert.match(init, /Delegated agents/);
  assert.match(init, /mcp__plugin_pomegr_pomegr__\*/);
  assert.match(init, /\.claude\/agents\/\*\.md/);
  assert.match(init, /the user confirms them at the preview step/);
  assert.match(init, /thin wrapper around a canonical body/);
});

test("installed plugin starts its MCP server without node_modules and lists every tool", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const isolatedPlugin = path.join(temporaryRoot, "installed-pomegr");
    const clientRepository = path.join(temporaryRoot, "client-repository");
    await cp(pluginRoot, isolatedPlugin, { recursive: true });
    await mkdir(clientRepository, { recursive: true });
    await assert.rejects(access(path.join(isolatedPlugin, "node_modules")), { code: "ENOENT" });

    const tools = await readMcpToolInventory(path.join(isolatedPlugin, "mcp", "server.bundle.mjs"), clientRepository);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "clear_agent_signal",
      "clear_session_signal",
      "report_agent_signal",
      "report_session_signal",
      "report_task_signal",
    ]);
  });
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

test("plugin release helper synchronizes versions, rebuilds, rolls back, and prints correct client commands", async () => {
  const script = await readFile(releaseScriptPath, "utf8");

  assert.match(script, /major\|minor\|patch/);
  assert.match(script, /plugins\/claude-code\/\.claude-plugin\/plugin\.json/);
  assert.match(script, /plugins\/claude-code\/package\.json/);
  assert.match(script, /plugins\/claude-code\/mcp\/server\.mjs/);
  assert.match(script, /npm run build:plugin/);
  assert.match(script, /restore_release_files/);
  assert.match(script, /\/plugin marketplace update pomegr/);
  assert.match(script, /claude plugin update pomegr@pomegr --scope project/);
  assert.doesNotMatch(script, /pomegr:pomegr/);
});
