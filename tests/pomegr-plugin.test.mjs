import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPomegrMcpServer } from "../plugins/claude-code/mcp/server.mjs";
import * as claudePolicy from "../plugins/claude-code/scripts/policy.mjs";
import * as codexPolicy from "../plugins/pomegr/scripts/policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "claude-code");
const codexPluginRoot = path.join(repositoryRoot, "plugins", "pomegr");
const policyScript = path.join(pluginRoot, "scripts", "policy.mjs");
const policyTemplatePath = path.join(pluginRoot, "skills", "init", "references", "policy-template.md");

const { DELEGATION_MARKER, readPolicy } = claudePolicy;

const claudeReport = (toolName) => ({
  type: "assistant",
  timestamp: "2026-08-14T10:00:00.000Z",
  message: { content: [{ type: "tool_use", name: toolName, input: { label: "Verified", tone: "positive" } }] },
});
const codexReport = (toolName) => ({ type: "response_item", payload: { type: "function_call", name: toolName } });

// The policy script ships as two generated copies (Claude Code and Codex). Their
// validator is shared; only the hook commands, transcript shapes, and copy differ.
const providers = [
  {
    name: "Claude Code",
    policy: claudePolicy,
    script: policyScript,
    template: policyTemplatePath,
    sessionStartCommand: "hook",
    doctor: /\/pomegr:doctor/,
    quiet: "",
    transcriptField: "transcript_path",
    silentTranscript: [
      { type: "user", message: { content: "Verify the release." } },
      { type: "assistant", timestamp: "2026-08-14T10:00:00.000Z", message: { content: [{ type: "text", text: "Checks are green." }] } },
    ],
    reportRecord: claudeReport,
    stopHookActiveIsQuiet: true,
    toolingError: "Delegated agent tooling must declare signal-owning subagent types and attach the Pomegr MCP tools to them.",
    sessionStartNotes: [/call the Pomegr `rename_session` tool once/i, /Delegation is mechanized/i],
  },
  {
    name: "Codex",
    policy: codexPolicy,
    script: path.join(codexPluginRoot, "scripts", "policy.mjs"),
    template: path.join(codexPluginRoot, "skills", "init", "references", "policy-template.md"),
    sessionStartCommand: "session-start",
    doctor: /\$pomegr:doctor/,
    quiet: "{}",
    transcriptField: "agent_transcript_path",
    silentTranscript: [{ type: "event_msg", payload: { message: "Checks are green." } }],
    reportRecord: codexReport,
    stopHookActiveIsQuiet: false,
    toolingError: "Delegated agent tooling must declare signal-owning subagent types and preserve Pomegr MCP access.",
    sessionStartNotes: [/SubagentStart hook/],
  },
];

function policyTest(name, run) {
  for (const provider of providers) test(`${provider.name}: ${name}`, () => run(provider));
}

const readTemplate = (provider) => readFile(provider.template, "utf8");

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

function runHook(provider, command, payload) {
  return spawnSync(process.execPath, [provider.script, command], {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
}

function runSessionStart(provider, cwd) {
  return runHook(provider, provider.sessionStartCommand, { hook_event_name: "SessionStart", cwd });
}

function assertQuiet(provider, result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), provider.quiet);
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

test("Codex and Claude Code ship one provider-neutral policy template", async () => {
  const [claude, codex] = await Promise.all(providers.map(readTemplate));
  assert.equal(codex.replace(/\r\n?/g, "\n"), claude.replace(/\r\n?/g, "\n"));
});

policyTest("validates the repository policy template and extracts bounded signal rows", async (provider) => {
  const lfTemplate = (await readTemplate(provider)).replace(/\r\n?/g, "\n");
  assert.match(lfTemplate, /## Delegated agent tooling/);
  assert.match(lfTemplate, /## Delegated agents/);
  assert.match(lfTemplate, /provider-specific prefixes are not part of this policy/);
  for (const candidate of [lfTemplate, lfTemplate.replaceAll("\n", "\r\n")]) {
    const result = provider.policy.validatePolicyText(candidate);
    assert.equal(result.status, "valid");
    assert.deepEqual(result.errors, []);
    assert.equal(result.signals["Session signals"][0].label, "Ready for review");
    assert.equal(result.signals["Agent signals"].length, 0);
    assert.equal(result.signals["Task signals"][0].label, "Checks passed");
    assert.deepEqual(result.delegatedAgents, []);
  }

  const previous = lfTemplate.replace("Policy version: 8", "Policy version: 7").replace(
    "Never ask the user to name the session. A new title replaces the current one.",
    "Never ask the user to name the session and never overwrite a title explicitly set by the user.",
  );
  assert.equal(provider.policy.validatePolicyText(previous).status, "valid");
  assert.equal(provider.policy.validatePolicyText(previous.replace("Policy version: 7", "Policy version: 8")).status, "invalid");
  assert.equal(provider.policy.validatePolicyText(lfTemplate.replace("Policy version: 8", "Policy version: 7")).status, "invalid");

  const legacy = provider.policy.validatePolicyText(previous.replace("Policy version: 7", "Policy version: 6").replace(/\n## Session progress\n\n- Enabled: no\n/, "\n"));
  assert.equal(legacy.status, "valid");
  assert.equal(legacy.progressEnabled, false);
});

policyTest("validates the delegated-agents table and rejects incoherent delegation", async (provider) => {
  const { validatePolicyText } = provider.policy;
  const template = await readTemplate(provider);

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

policyTest("rejects malformed and oversized policies without interpreting their content", async (provider) => {
  const template = await readTemplate(provider);
  const malformed = provider.policy.validatePolicyText(template.replace("Policy version: 8", "Policy version: 1"));
  assert.equal(malformed.status, "invalid");
  assert.ok(malformed.errors.some((error) => error.includes("Policy version must be 8")));

  const oversized = provider.policy.validatePolicyText(`${template}\n${"x".repeat(provider.policy.POLICY_MAX_BYTES)}`);
  assert.equal(oversized.status, "invalid");
  assert.ok(oversized.errors.some((error) => error.includes("byte limit")));
});

policyTest("rejects policies that contradict naming, privacy, and signal-lifetime invariants", async (provider) => {
  const { validatePolicyText } = provider.policy;
  const template = await readTemplate(provider);
  const badNaming = validatePolicyText(template.replace(
    "- Never ask the user to name the session. A new title replaces the current one. Only the main session names itself; subagents never rename the session.",
    "- Always ask the user to run /rename and report the title.",
  ));
  assert.equal(badNaming.status, "invalid");
  assert.ok(badNaming.errors.includes("Session naming must match the canonical agent-title policy."));

  const badPrivacy = validatePolicyText(template.replace(
    "- Never include prompts, responses, secrets, commands, stdout, stderr, tool results, credential values, or sensitive repository content.",
    "- Include prompts, secrets, raw commands, and tool output.",
  ));
  assert.equal(badPrivacy.status, "invalid");
  assert.ok(badPrivacy.errors.includes("Privacy and semantics must match the canonical Pomegr safety policy."));

  const missingDelegatedTools = validatePolicyText(template.replace(
    "- Every signal-owning subagent must retain access to the Pomegr MCP server and the applicable reporting tools. A custom agent definition that replaces or disables inherited MCP configuration must explicitly restore that access.",
    "- Restricted agent definitions may own signals without the Pomegr reporting tools.",
  ));
  assert.equal(missingDelegatedTools.status, "invalid");
  assert.ok(missingDelegatedTools.errors.includes(provider.toolingError));

  const optionalInjection = validatePolicyText(template.replace(
    "- Never rely on the delegating session remembering to paste the rows. Injection is the mechanism; a pasted copy is only a fallback, and the hook does not append a second copy when the prompt already carries one.",
    "- When delegating such work, include the applicable signal rows and transition rules in the Agent prompt.",
  ));
  assert.equal(optionalInjection.status, "invalid");
  assert.ok(optionalInjection.errors.includes(provider.toolingError));

  const sessionTransition = "Replace if review finds new work; clear when the session moves to unrelated work.";
  for (const [replacement, expected] of [
    ["Keep this signal forever.", "replaced or cleared"],
    ["Never replace or clear this signal.", "affirmatively"],
    ["This signal is not cleared when the work is resolved.", "affirmatively"],
  ]) {
    const invalid = validatePolicyText(template.replace(sessionTransition, replacement));
    assert.equal(invalid.status, "invalid");
    assert.ok(invalid.errors.some((error) => error.includes(expected)), replacement);
  }

  const taskDurability = "Replace only if a later outcome for the same execution task supersedes it; task signals are not cleared.";
  for (const [replacement, expected] of [
    ["Clear the task signal when the task finishes.", "durable and cannot be cleared"],
    ["Replace after a later outcome; task signals are not cleared unless the task finishes.", "unconditional"],
  ]) {
    const invalid = validatePolicyText(template.replace(taskDurability, replacement));
    assert.equal(invalid.status, "invalid");
    assert.ok(invalid.errors.some((error) => error.includes(expected)), replacement);
  }

  const duplicateHeading = validatePolicyText(`${template}\n## Session naming\n\n- Contradictory duplicate.`);
  assert.equal(duplicateHeading.status, "invalid");
  assert.ok(duplicateHeading.errors.includes('Policy must contain exactly one "Session naming" section.'));
});

policyTest("rejects a non-regular policy path before reading or injecting it", async (provider) => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(path.join(repository, ".pomegr", "signals.md"), { recursive: true });

    const policy = provider.policy.readPolicy(repository);
    assert.equal(policy.status, "invalid");
    assert.deepEqual(policy.errors, ["Policy must be a regular file and cannot be a symbolic link."]);

    const hook = runSessionStart(provider, repository);
    assert.equal(hook.status, 0);
    assert.match(JSON.parse(hook.stdout).systemMessage, provider.doctor);
  });
});

policyTest("finds a policy upward only as far as the repository root", async (provider) => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    const nested = path.join(repository, "packages", "client", "src");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });

    const missing = provider.policy.findPolicy(nested);
    assert.equal(missing.status, "missing");
    assert.equal(missing.path, path.join(repository, ".pomegr", "signals.md"));

    await writePolicy(repository, await readTemplate(provider));
    const found = provider.policy.findPolicy(nested);
    assert.equal(found.repositoryRoot, repository);
    assert.equal(found.path, path.join(repository, ".pomegr", "signals.md"));
    const valid = provider.policy.readPolicy(nested);
    assert.equal(valid.status, "valid");
    assert.equal(valid.repositoryRoot, repository);
  });
});

policyTest("ignores a legacy-only reporting policy while reporting the missing Pomegr policy", async (provider) => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    const legacyDirectory = path.join(repository, ".threadlight");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(path.join(legacyDirectory, "signals.md"), await readTemplate(provider), "utf8");

    const policy = provider.policy.findPolicy(repository);
    assert.equal(policy.status, "missing");
    assert.equal(policy.path, path.join(repository, ".pomegr", "signals.md"));

    const hook = runSessionStart(provider, repository);
    assert.equal(hook.status, 0);
    assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /"policyStatus":"missing".*"policyVersion":null/);
  });
});

policyTest("SessionStart hook reports plugin metadata and injects valid policy context", async (provider) => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    const nested = path.join(repository, "src");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });

    const missing = runSessionStart(provider, nested);
    assert.equal(missing.status, 0);
    assert.match(JSON.parse(missing.stdout).hookSpecificOutput.additionalContext, /\[Pomegr plugin metadata\].*"policyStatus":"missing".*"policyVersion":null/);

    const template = await readTemplate(provider);
    await writePolicy(repository, template);
    const valid = runSessionStart(provider, nested);
    assert.equal(valid.status, 0);
    const validOutput = JSON.parse(valid.stdout);
    assert.equal(validOutput.hookSpecificOutput.hookEventName, "SessionStart");
    const context = validOutput.hookSpecificOutput.additionalContext;
    assert.match(context, /\[Pomegr plugin metadata\].*"pluginVersion":"[^"]+".*"policyStatus":"valid".*"policyVersion":8/);
    assert.match(context, /\[Pomegr reporting policy loaded\]/);
    assert.match(context, /read tools are decision-triggered observations[\s\S]*do not poll routinely or infer causation/i);
    assert.match(context, /# Pomegr reporting policy/);
    for (const note of provider.sessionStartNotes) assert.match(context, note);

    await writePolicy(repository, template.replace("Policy version: 8", "Policy version: invalid"));
    const invalid = runSessionStart(provider, nested);
    assert.equal(invalid.status, 0);
    const invalidOutput = JSON.parse(invalid.stdout);
    assert.match(invalidOutput.systemMessage, provider.doctor);
    assert.doesNotMatch(invalid.stdout, /Ready for review/);
    assert.match(invalidOutput.hookSpecificOutput.additionalContext, /"policyStatus":"invalid".*"policyVersion":null/);
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

    const hook = runSessionStart(providers[0], path.join(repository, ".git"));
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

policyTest("SubagentStart delegation hook supplies declared rows without rewriting tool input", async (provider) => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await writePolicy(repository, withDelegatedAgents(await readTemplate(provider), ["| release-verifier | task |"]));

    const plan = provider.policy.delegationPlan(provider.policy.readPolicy(repository), "release-verifier");
    assert.deepEqual(plan.labels, ["Checks passed"]);

    const spawnPayload = (overrides = {}) => ({
      hook_event_name: "SubagentStart",
      cwd: repository,
      agent_id: "a1b2c3",
      agent_type: "release-verifier",
      ...overrides,
    });

    const injected = runHook(provider, "subagent-start", spawnPayload());
    assert.equal(injected.status, 0);
    const output = JSON.parse(injected.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "SubagentStart");
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
    assert.equal(output.hookSpecificOutput.updatedInput, undefined);
    const context = output.hookSpecificOutput.additionalContext;
    assert.ok(context.includes(DELEGATION_MARKER));
    assert.match(context, /### Task signals/);
    assert.match(context, /\| Checks passed \| positive \|/);
    assert.doesNotMatch(context, /### Session signals/);
    assert.doesNotMatch(context, /Ready for review/);

    for (const skipped of [
      spawnPayload({ agent_type: "fork" }),
      spawnPayload({ agent_type: "general-purpose" }),
      spawnPayload({ agent_type: undefined }),
      spawnPayload({ hook_event_name: "PreToolUse" }),
    ]) assertQuiet(provider, runHook(provider, "subagent-start", skipped));

    const malformed = spawnSync(process.execPath, [provider.script, "subagent-start", "--cwd", repository], {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: "not json",
    });
    assertQuiet(provider, malformed);
  });
});

policyTest("delegation hook stays silent for an undeclared policy, a missing policy, and an invalid policy", async (provider) => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    const template = await readTemplate(provider);
    const payload = {
      hook_event_name: "SubagentStart",
      cwd: repository,
      agent_type: "release-verifier",
    };

    assertQuiet(provider, runHook(provider, "subagent-start", payload));

    await writePolicy(repository, template);
    assertQuiet(provider, runHook(provider, "subagent-start", payload));

    await writePolicy(repository, withDelegatedAgents(template, ["| release-verifier | task |"]).replace("Policy version: 8", "Policy version: 9"));
    assertQuiet(provider, runHook(provider, "subagent-start", payload));
  });
});

policyTest("SubagentStop detector reports a miss without inferring a signal or exposing the transcript", async (provider) => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const repository = path.join(temporaryRoot, "repository");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await writePolicy(repository, withDelegatedAgents(await readTemplate(provider), ["| release-verifier | task |"]));

    const silent = await writeTranscript(temporaryRoot, "silent.jsonl", provider.silentTranscript);
    const reported = await writeTranscript(temporaryRoot, "reported.jsonl", [
      ...provider.silentTranscript,
      provider.reportRecord("mcp__plugin_pomegr_pomegr__report_task_signal"),
    ]);
    const sessionOnly = await writeTranscript(temporaryRoot, "session-only.jsonl", [
      ...provider.silentTranscript,
      provider.reportRecord("mcp__plugin_pomegr_pomegr__report_session_signal"),
    ]);
    assert.equal(provider.policy.transcriptReportsDelegatedSignal(silent), false);
    assert.equal(provider.policy.transcriptReportsDelegatedSignal(reported), true);

    const payload = (overrides) => ({
      hook_event_name: "SubagentStop",
      cwd: repository,
      agent_id: "a1b2c3",
      agent_type: "release-verifier",
      [provider.transcriptField]: silent,
      ...overrides,
    });

    const miss = runHook(provider, "subagent-stop", payload());
    assert.equal(miss.status, 0);
    const message = JSON.parse(miss.stdout).systemMessage;
    assert.match(message, /release-verifier/);
    assert.match(message, /finished without calling a Pomegr reporting tool/);
    assert.match(message, /Checks passed/);
    assert.match(message, /never infers a signal/);
    assert.equal(JSON.parse(miss.stdout).hookSpecificOutput, undefined);
    assert.equal(JSON.parse(miss.stdout).decision, undefined);
    assert.doesNotMatch(message, /Checks are green|silent\.jsonl/);

    assertQuiet(provider, runHook(provider, "subagent-stop", payload({ [provider.transcriptField]: reported })));
    assert.match(
      JSON.parse(runHook(provider, "subagent-stop", payload({ [provider.transcriptField]: sessionOnly })).stdout).systemMessage,
      /finished without calling a Pomegr reporting tool/,
    );

    const quietPayloads = [
      payload({ agent_type: "general-purpose" }),
      payload({ agent_type: "fork" }),
      payload({ [provider.transcriptField]: path.join(temporaryRoot, "absent.jsonl") }),
      payload({ [provider.transcriptField]: "" }),
    ];
    if (provider.stopHookActiveIsQuiet) quietPayloads.push(payload({ stop_hook_active: true }));
    for (const quiet of quietPayloads) assertQuiet(provider, runHook(provider, "subagent-stop", quiet));
  });
});

test("installed plugin starts its MCP server without node_modules and lists every tool", async () => {
  await withTemporaryDirectory(async (temporaryRoot) => {
    const isolatedPlugin = path.join(temporaryRoot, "installed-pomegr");
    const clientRepository = path.join(temporaryRoot, "client-repository");
    await cp(pluginRoot, isolatedPlugin, { recursive: true });
    await mkdir(clientRepository, { recursive: true });
    await assert.rejects(access(path.join(isolatedPlugin, "node_modules")), { code: "ENOENT" });
    const reminderPath = path.join(isolatedPlugin, "scripts", "progress-reminder.bundle.mjs");
    const guardPath = path.join(isolatedPlugin, "scripts", "usage-guard.bundle.mjs");
    await access(reminderPath);
    await access(guardPath);
    const reminder = spawnSync(process.execPath, [reminderPath], { cwd: clientRepository, encoding: "utf8", input: "{}" });
    assert.equal(reminder.status, 0);
    assert.equal(reminder.stdout, "");
    const guard = spawnSync(process.execPath, [guardPath, "--provider", "claude"], { cwd: clientRepository, encoding: "utf8", input: "{}" });
    assert.equal(guard.status, 0);
    assert.equal(guard.stdout, "");

    const sessionId = "22222222-2222-4222-8222-222222222222";
    const queryHook = spawnSync(process.execPath, [path.join(isolatedPlugin, "scripts", "query-session.bundle.mjs")], {
      cwd: clientRepository, encoding: "utf8", env: { ...process.env, NODE_PATH: "" },
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__pomegr__get_session_report",
        tool_input: {}, session_id: "11111111-1111-4111-8111-111111111111",
        transcript_path: path.join(clientRepository, `${sessionId}.jsonl`) }),
    });
    assert.equal(queryHook.status, 0);
    assert.equal(queryHook.stderr, "");
    assert.deepEqual(JSON.parse(queryHook.stdout), { hookSpecificOutput: {
      hookEventName: "PreToolUse", updatedInput: { session_ref: `claude:${sessionId}` },
    } });

    const tools = await readMcpToolInventory(path.join(isolatedPlugin, "mcp", "server.bundle.mjs"), clientRepository);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["add_task", "block_task", "clear_agent_signal", "clear_session_progress", "clear_session_signal", "complete_task", "get_agent_context", "get_provider_health", "get_recent_failures", "get_session_report", "get_usage_limits", "list_session_agents", "list_sessions", "rename_session", "report_agent_signal", "report_session_progress", "report_session_signal", "report_task_signal"]);

    const renameHook = spawnSync(process.execPath, [path.join(isolatedPlugin, "scripts", "rename-session.bundle.mjs")], {
      cwd: clientRepository,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: path.join(temporaryRoot, "claude-config"),
        CLAUDE_PROJECT_DIR: clientRepository,
        NODE_PATH: "",
      },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        cwd: clientRepository,
        tool_name: "mcp__plugin_pomegr_pomegr__rename_session",
        tool_input: { title: "Installed plugin title" },
      }),
    });
    assert.equal(renameHook.status, 2);
    assert.match(renameHook.stderr, /^Pomegr could not safely rename the current Claude Code session\./);
    assert.doesNotMatch(renameHook.stderr, /550e8400|client-repository|claude-config/i);
  });
});

test("plugin MCP inventory contains bounded reporting, clearing, and native title tools", () => {
  const server = buildPomegrMcpServer();
  const tools = Object.keys(server._registeredTools).sort();
  const reads = ["get_agent_context", "get_provider_health", "get_recent_failures", "get_session_report", "get_usage_limits", "list_session_agents", "list_sessions"];

  const writes = ["add_task", "complete_task", "block_task"];
  assert.deepEqual(tools, [...writes, "clear_agent_signal", "clear_session_progress", "clear_session_signal", ...reads, "rename_session", "report_agent_signal", "report_session_progress", "report_session_signal", "report_task_signal"].sort());
  assert.equal(tools.includes("report_session_title"), false);
  assert.equal(tools.includes("ask_pomegr"), false);
  assert.ok(tools.filter((name) => !reads.includes(name) && !writes.includes(name)).every((name) => server._registeredTools[name]._meta["anthropic/alwaysLoad"] === true));
  assert.ok([...reads, ...writes].every((name) => server._registeredTools[name]._meta === undefined));
  for (const name of writes) {
    assert.equal(server._registeredTools[name].annotations.readOnlyHint, false);
    assert.equal(server._registeredTools[name].annotations.idempotentHint, false);
  }
  assert.equal(server._registeredTools.rename_session.annotations.readOnlyHint, false);
  assert.equal(server._registeredTools.rename_session.annotations.destructiveHint, false);
  assert.equal(server._registeredTools.rename_session.annotations.idempotentHint, true);
  for (const name of tools.filter((tool) => tool !== "rename_session" && !writes.includes(tool))) {
    assert.equal(server._registeredTools[name].annotations.readOnlyHint, true);
  }
});
