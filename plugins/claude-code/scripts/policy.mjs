#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

export const POLICY_RELATIVE_PATH = path.join(".pomegr", "signals.md");
export const POLICY_VERSION = 7;
export const LEGACY_POLICY_VERSION = 6;
export const POLICY_MAX_BYTES = 24 * 1024;
export const POLICY_MAX_CONDITION_LENGTH = 240;
export const POLICY_TONES = new Set(["neutral", "info", "positive", "warning", "negative"]);
export const DELEGATION_MARKER = "[Pomegr delegated reporting policy]";
export const DELEGATION_TOOL_NAMES = new Set(["Task", "Agent"]);

const REQUIRED_SECTIONS = [
  "Session naming",
  "Privacy and semantics",
  "Delegated agent tooling",
  "Delegated agents",
  "Session signals",
  "Agent signals",
  "Task signals",
];
const PROGRESS_SECTION = "Session progress";
const SIGNAL_SECTIONS = ["Session signals", "Agent signals", "Task signals"];
const EMPTY_SECTION = "_No project-specific signals configured._";
const EMPTY_DELEGATED_AGENTS = "_No delegated agent types configured._";
const TABLE_HEADER = "| Label | Tone | Report when | Replace or clear when |";
const TABLE_DIVIDER = "| --- | --- | --- | --- |";
const DELEGATED_TABLE_HEADER = "| Agent type | Owns |";
const DELEGATED_TABLE_DIVIDER = "| --- | --- |";
const DELEGATED_OWNERSHIP = new Map([
  ["agent", ["Agent signals"]],
  ["task", ["Task signals"]],
  ["agent and task", ["Agent signals", "Task signals"]],
]);
const DELEGATED_AGENT_TYPE_PATTERN = /^(?:\*|[a-z0-9][a-z0-9._:-]{0,63})$/;
const FORK_AGENT_TYPE = "fork";
const CANONICAL_SESSION_NAMING = [
  "- After the first substantive request makes the work clear, set one concise, meaningful title through an available provider-native capability. If no safe title capability is available, allow the provider's automatic title.",
  "- Never ask the user to name the session and never overwrite a title explicitly set by the user. Only the main session names itself; subagents never rename the session.",
].join("\n");
const CANONICAL_PRIVACY = [
  "- Report only project-specific state that helps an observer understand the work.",
  "- Treat every signal as agent-reported and potentially stale, not as a Pomegr judgment.",
  "- Report transitions, not heartbeats. Replace a signal when a new configured state applies; clear agent or session state when none applies.",
  "- Never include prompts, responses, secrets, commands, stdout, stderr, tool results, credential values, or sensitive repository content.",
  "- Use only labels and conditions approved below. Pomegr's universal MCP validation remains the safety boundary, not this file as an application enum.",
].join("\n");
const CANONICAL_DELEGATED_AGENT_TOOLING = [
  "- A subagent can start without this policy in its context. Declare every signal-owning subagent type under `Delegated agents`; the active provider adapter's delegation hook then supplies the applicable rows to that subagent.",
  "- Never rely on the delegating session remembering to paste the rows. Injection is the mechanism; a pasted copy is only a fallback, and the hook does not append a second copy when the prompt already carries one.",
  "- Every signal-owning subagent must retain access to the Pomegr MCP server and the applicable reporting tools. A custom agent definition that replaces or disables inherited MCP configuration must explicitly restore that access.",
  "- Match the logical tool suffixes `report_agent_signal`, `report_task_signal`, and `clear_agent_signal` in the resolved Pomegr MCP namespace; provider-specific prefixes are not part of this policy.",
  "- Never assign agent- or task-signal reporting to a subagent that cannot call the applicable Pomegr MCP tool. Add the tool, or keep the reporting in the delegating session.",
].join("\n");

const AGENT_DEFINITION_DIRECTORY = [".claude", "agents"];
const AGENT_DEFINITION_FILE_LIMIT = 100;
const AGENT_DEFINITION_HEAD_BYTES = 4096;
const AGENT_WARNING_LIMIT = 10;
const POMEGR_TOOL_PATTERN = /mcp__[a-z0-9_]*pomegr[a-z0-9_]*__/i;
const DELEGATED_REPORT_TOOL_PATTERN = /^mcp__[a-z0-9_]*pomegr[a-z0-9_]*__(?:report_agent_signal|report_task_signal|clear_agent_signal)$/i;
const TRANSCRIPT_SCAN_MAX_BYTES = 32 * 1024 * 1024;
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;

function policyResult(status, fields = {}) {
  return { status, ...fields };
}

function sectionBody(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return match?.[1]?.trim().replace(/\r\n?/g, "\n") ?? null;
}

function splitTableRow(line, expectedCells = 4) {
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
  return cells.length === expectedCells ? cells : null;
}

function validateDelegatedAgentsSection(body, signals, errors) {
  if (body === EMPTY_DELEGATED_AGENTS) return [];
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== DELEGATED_TABLE_HEADER || lines[1] !== DELEGATED_TABLE_DIVIDER) {
    errors.push("Delegated agents must use the two-column Pomegr delegation table or the empty-section marker.");
    return [];
  }
  if (lines.length < 3) {
    errors.push("Delegated agents must contain at least one agent row or the empty-section marker.");
    return [];
  }

  const rows = [];
  const declared = new Set();
  for (const [index, line] of lines.slice(2).entries()) {
    const cells = splitTableRow(line, 2);
    if (!cells) {
      errors.push(`Delegated agents row ${index + 1} must contain exactly two cells; pipe characters are not supported in policy cells.`);
      continue;
    }
    const [rawAgentType, rawOwns] = cells;
    const agentType = rawAgentType.toLowerCase();
    if (!DELEGATED_AGENT_TYPE_PATTERN.test(agentType)) {
      errors.push(`Delegated agents row ${index + 1} has an invalid agent type; use a subagent type name of at most 64 characters or "*".`);
      continue;
    }
    if (declared.has(agentType)) errors.push(`Delegated agents contains the duplicate agent type "${rawAgentType}".`);
    declared.add(agentType);
    const owns = DELEGATED_OWNERSHIP.get(rawOwns.toLowerCase());
    if (!owns) {
      errors.push(`Delegated agents row ${index + 1} must own "agent", "task", or "agent and task".`);
      continue;
    }
    for (const section of owns) {
      if (!signals[section]?.length) {
        errors.push(`Delegated agents row ${index + 1} owns "${section}", but that section configures no rows to delegate.`);
      }
    }
    rows.push({ agentType, owns });
  }
  return rows;
}

function validateSignalSection(name, body, errors) {
  if (body === EMPTY_SECTION) return [];
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== TABLE_HEADER || lines[1] !== TABLE_DIVIDER) {
    errors.push(`${name} must use the four-column Pomegr signal table or the empty-section marker.`);
    return [];
  }
  if (lines.length < 3) {
    errors.push(`${name} must contain at least one signal row or the empty-section marker.`);
    return [];
  }

  const rows = [];
  const labels = new Set();
  for (const [index, line] of lines.slice(2).entries()) {
    const cells = splitTableRow(line);
    if (!cells) {
      errors.push(`${name} row ${index + 1} must contain exactly four cells; pipe characters are not supported in policy cells.`);
      continue;
    }
    const [label, tone, reportWhen, replaceWhen] = cells;
    if (!label || label.length > 20 || /[\u0000-\u001f\u007f]/.test(label)) {
      errors.push(`${name} row ${index + 1} has an invalid label; use 1-20 plain-text characters.`);
    }
    if (labels.has(label.toLowerCase())) errors.push(`${name} contains the duplicate label "${label}".`);
    labels.add(label.toLowerCase());
    if (!POLICY_TONES.has(tone)) errors.push(`${name} row ${index + 1} uses unsupported tone "${tone}".`);
    for (const [field, value] of [["Report when", reportWhen], ["Replace or clear when", replaceWhen]]) {
      if (!value || value.length > POLICY_MAX_CONDITION_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
        errors.push(`${name} row ${index + 1} has an invalid ${field} condition.`);
      }
    }
    if (name !== "Task signals") {
      const hasTransition = /\b(?:replace|clear)(?:s|ed|ing)?\b.{0,180}\b(?:when|if|after|once)\b/i.test(replaceWhen)
        || /\b(?:when|if|after|once)\b.{0,180}\b(?:replace|clear)(?:s|ed|ing)?\b/i.test(replaceWhen);
      const negatesTransition = /\b(?:never|do not|don't)\s+(?:replace|clear)\b/i.test(replaceWhen)
        || /\b(?:is|are|be|remain|remains)\s+not\s+(?:replaced|cleared)\b/i.test(replaceWhen);
      if (!hasTransition || negatesTransition) {
        errors.push(`${name} row ${index + 1} must affirmatively say when the signal is replaced or cleared.`);
      }
    }
    if (name === "Task signals") {
      const durability = replaceWhen.match(/(?:task signals? (?:are|is) not cleared|task signals? cannot be cleared|never clear task signals?)\.?$/i);
      const beforeDurability = durability ? replaceWhen.slice(0, durability.index) : replaceWhen;
      if (!durability || /\bclear(?:s|ed|ing)?\b/i.test(beforeDurability) || /\b(?:unless|except)\b/i.test(replaceWhen)) {
        errors.push(`${name} row ${index + 1} must end with an unconditional statement that task signals are durable and cannot be cleared.`);
      }
    }
    rows.push({ label, tone, reportWhen, replaceWhen });
  }
  return rows;
}

export function validatePolicyText(text) {
  const errors = [];
  if (typeof text !== "string") {
    return policyResult("invalid", { errors: ["Policy content is not text."], signals: {}, delegatedAgents: [] });
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > POLICY_MAX_BYTES) errors.push(`Policy exceeds the ${POLICY_MAX_BYTES}-byte limit.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) errors.push("Policy contains control characters.");
  if (!/^# Pomegr reporting policy\s*$/m.test(text)) errors.push("Missing the Pomegr reporting policy title.");
  const versionMatch = text.match(/^Policy version:\s*(\d+)\s*$/m);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  if (![POLICY_VERSION, LEGACY_POLICY_VERSION].includes(version)) errors.push(`Policy version must be ${POLICY_VERSION} (legacy version ${LEGACY_POLICY_VERSION} is accepted).`);
  const requiredSections = version === POLICY_VERSION ? [...REQUIRED_SECTIONS, PROGRESS_SECTION] : REQUIRED_SECTIONS;

  for (const name of requiredSections) {
    const matches = text.match(new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "gm")) || [];
    if (matches.length > 1) errors.push(`Policy must contain exactly one "${name}" section.`);
  }

  const sections = new Map();
  for (const name of requiredSections) {
    const body = sectionBody(text, name);
    if (body === null || !body) errors.push(`Missing or empty "${name}" section.`);
    sections.set(name, body || "");
  }
  if (sections.get("Session naming") !== CANONICAL_SESSION_NAMING) {
    errors.push("Session naming must match the canonical agent-title policy.");
  }
  if (sections.get("Privacy and semantics") !== CANONICAL_PRIVACY) {
    errors.push("Privacy and semantics must match the canonical Pomegr safety policy.");
  }
  if (sections.get("Delegated agent tooling") !== CANONICAL_DELEGATED_AGENT_TOOLING) {
    errors.push("Delegated agent tooling must declare signal-owning subagent types and attach the Pomegr MCP tools to them.");
  }

  const signals = {};
  for (const name of SIGNAL_SECTIONS) signals[name] = validateSignalSection(name, sections.get(name), errors);
  const delegatedAgents = validateDelegatedAgentsSection(sections.get("Delegated agents"), signals, errors);
  const progressBody = version === POLICY_VERSION ? sections.get(PROGRESS_SECTION) : null;
  const progressEnabled = progressBody === "- Enabled: yes";
  if (version === POLICY_VERSION && !["- Enabled: yes", "- Enabled: no"].includes(progressBody)) {
    errors.push('Session progress must contain exactly "- Enabled: yes" or "- Enabled: no".');
  }
  return policyResult(errors.length ? "invalid" : "valid", { errors, bytes, signals, delegatedAgents, version, progressEnabled });
}

function agentToolAllowlist(frontMatter) {
  const inline = frontMatter.match(/^tools:[ \t]*(.*)$/m);
  if (!inline) return null;
  if (inline[1].trim()) return inline[1].trim();
  const listing = frontMatter.slice(inline.index + inline[0].length).match(/^\n(?:[ \t]*-[ \t]*\S.*(?:\n|$))+/);
  return listing ? listing[0].trim() : "";
}

function readFileHead(filePath, bytes) {
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(handle, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function agentDefinitionName(frontMatter, fileName) {
  const declared = frontMatter.match(/^name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m);
  return (declared?.[1] || fileName.replace(/\.md$/, "")).trim().toLowerCase();
}

export function scanAgentDefinitions(repositoryRoot, delegatedAgents = []) {
  const directory = path.join(repositoryRoot, ...AGENT_DEFINITION_DIRECTORY);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const declared = new Set(delegatedAgents.map((row) => row.agentType));
  const declaresEveryAgent = declared.has("*");
  const warnings = [];
  const definitions = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .slice(0, AGENT_DEFINITION_FILE_LIMIT);
  for (const definition of definitions) {
    if (warnings.length >= AGENT_WARNING_LIMIT) break;
    let head;
    try {
      head = readFileHead(path.join(directory, definition.name), AGENT_DEFINITION_HEAD_BYTES);
    } catch {
      continue;
    }
    const frontMatter = head.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---/);
    if (!frontMatter) continue;
    const relativePath = [...AGENT_DEFINITION_DIRECTORY, definition.name].join("/");
    const allowlist = agentToolAllowlist(frontMatter[1]);
    const reachesPomegr = !allowlist || allowlist === "*" || POMEGR_TOOL_PATTERN.test(allowlist);
    const isDelegated = declaresEveryAgent || declared.has(agentDefinitionName(frontMatter[1], definition.name));

    if (isDelegated && !reachesPomegr) {
      warnings.push(`Agent definition "${relativePath}" is declared under Delegated agents but sets an explicit tools allowlist without a Pomegr reporting tool, so it receives the policy rows and still cannot report them.`);
      continue;
    }
    if (!isDelegated && allowlist && allowlist !== "*" && POMEGR_TOOL_PATTERN.test(allowlist)) {
      warnings.push(`Agent definition "${relativePath}" carries the Pomegr reporting tools but no Delegated agents row matches it, so the delegation hook never injects the applicable rows into its prompt.`);
    }
  }
  return warnings;
}

export function findPolicy(startDirectory = process.cwd()) {
  let current = path.resolve(startDirectory || process.cwd());
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    return policyResult("missing", { path: path.join(current, POLICY_RELATIVE_PATH) });
  }

  while (true) {
    const candidate = path.join(current, POLICY_RELATIVE_PATH);
    if (fs.existsSync(candidate)) return { path: candidate, repositoryRoot: current };
    if (fs.existsSync(path.join(current, ".git"))) return policyResult("missing", { path: candidate, repositoryRoot: current });
    const parent = path.dirname(current);
    if (parent === current) return policyResult("missing", { path: candidate, repositoryRoot: current });
    current = parent;
  }
}

export function readPolicy(startDirectory = process.cwd()) {
  const found = findPolicy(startDirectory);
  if (found.status === "missing") return found;
  let text;
  try {
    const policyStat = fs.lstatSync(found.path);
    const repositoryPath = fs.realpathSync(found.repositoryRoot);
    const policyPath = fs.realpathSync(found.path);
    const relativePolicyPath = path.relative(repositoryPath, policyPath);
    if (!policyStat.isFile() || policyStat.isSymbolicLink()) {
      return policyResult("invalid", {
        path: found.path,
        repositoryRoot: found.repositoryRoot,
        errors: ["Policy must be a regular file and cannot be a symbolic link."],
      });
    }
    if (relativePolicyPath.startsWith(`..${path.sep}`) || relativePolicyPath === ".." || path.isAbsolute(relativePolicyPath)) {
      return policyResult("invalid", {
        path: found.path,
        repositoryRoot: found.repositoryRoot,
        errors: ["Policy must resolve inside the repository."],
      });
    }
    text = fs.readFileSync(found.path, "utf8");
  } catch {
    return policyResult("invalid", { path: found.path, repositoryRoot: found.repositoryRoot, errors: ["Policy could not be read."] });
  }
  const validated = validatePolicyText(text);
  const reportsDelegatedSignals = Boolean(validated.signals?.["Agent signals"]?.length || validated.signals?.["Task signals"]?.length);
  const warnings = validated.status === "valid" && reportsDelegatedSignals
    ? scanAgentDefinitions(found.repositoryRoot, validated.delegatedAgents)
    : [];
  return { ...validated, warnings, path: found.path, repositoryRoot: found.repositoryRoot, text };
}

function hookOutput(policy) {
  if (policy.status === "missing") return "";
  if (policy.status === "invalid") {
    return JSON.stringify({
      systemMessage: "Pomegr reporting policy is invalid. Run /pomegr:doctor; reporting remains non-blocking.",
    });
  }
  const drift = policy.warnings?.length
    ? ["", "[Pomegr policy drift]", ...policy.warnings, "Repair the declaration or the allowlist when you next touch these definitions, or keep their reporting in the delegating session."]
    : [];
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        "[Pomegr reporting policy loaded]",
        "Follow this repository-owned policy when reporting agent, session, or execution-task signals through the Pomegr MCP tools.",
        "Treat these signals as current project-specific state, not heartbeats or authoritative judgments. Clear a resolved agent or session signal when no replacement applies.",
        "Delegation is mechanized: the Pomegr PreToolUse hook appends the applicable rows to the prompt of any subagent type declared under Delegated agents, so you do not have to remember to paste them. Keep the resolved Pomegr MCP tools in those subagents' allowlists.",
        "After substantive work makes the session's purpose clear, call the Pomegr `rename_session` tool once with a concise, meaningful title. Its trusted hook targets this main session and preserves an explicit user title. Do not ask the user to name the session, and do not delegate naming to a subagent.",
        ...drift,
        "",
        policy.text,
      ].join("\n"),
    },
  });
}

function normalizedAgentType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function delegationPlan(policy, agentType) {
  if (!policy || policy.status !== "valid") return null;
  const type = normalizedAgentType(agentType);
  if (!type || type === FORK_AGENT_TYPE) return null;

  const owned = new Set();
  for (const row of policy.delegatedAgents || []) {
    if (row.agentType !== "*" && row.agentType !== type) continue;
    for (const section of row.owns) owned.add(section);
  }
  const sections = SIGNAL_SECTIONS
    .filter((name) => owned.has(name) && policy.signals?.[name]?.length)
    .map((name) => ({ name, rows: policy.signals[name] }));
  if (!sections.length) return null;

  const labels = sections.flatMap((section) => section.rows.map((row) => row.label));
  const lines = [
    DELEGATION_MARKER,
    "This repository's Pomegr policy configures the rows below for your agent type. Report them through the Pomegr MCP tools, typically the `mcp__plugin_pomegr_pomegr__*` namespace.",
    "A signal is current project-specific state, not a heartbeat or a Pomegr judgment. Replace one when a new configured state applies, clear agent state when none applies, and treat execution-task outcomes as durable.",
    "Never put prompts, responses, secrets, commands, stdout, stderr, tool results, or credential values in a signal.",
    "If no row below applies when you finish, report nothing.",
  ];
  for (const section of sections) {
    lines.push("", `### ${section.name}`, TABLE_HEADER, TABLE_DIVIDER);
    for (const row of section.rows) lines.push(`| ${row.label} | ${row.tone} | ${row.reportWhen} | ${row.replaceWhen} |`);
  }
  return { agentType: type, sections, labels, block: lines.join("\n") };
}

export function promptCarriesPolicy(prompt, plan) {
  if (typeof prompt !== "string" || !plan) return false;
  if (prompt.includes(DELEGATION_MARKER)) return true;
  return /pomegr/i.test(prompt) && plan.labels.every((label) => prompt.includes(label));
}

function transcriptRecordReports(line) {
  if (!line || !/pomegr/i.test(line)) return false;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) return false;
  return record.message.content.some((content) => content?.type === "tool_use"
    && typeof content.name === "string"
    && DELEGATED_REPORT_TOOL_PATTERN.test(content.name));
}

export function transcriptReportsDelegatedSignal(transcriptPath) {
  let handle;
  try {
    handle = fs.openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let scanned = 0;
    let read = 0;
    while ((read = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      scanned += read;
      if (scanned > TRANSCRIPT_SCAN_MAX_BYTES) return null;
      const lines = (remainder + decoder.write(buffer.subarray(0, read))).split("\n");
      remainder = lines.pop() || "";
      for (const line of lines) if (transcriptRecordReports(line)) return true;
    }
    return transcriptRecordReports(remainder + decoder.end());
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

function readHookPayload() {
  if (process.stdin.isTTY) return null;
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  try {
    const payload = JSON.parse(raw);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function payloadDirectory(payload, fallback) {
  return typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : fallback;
}

function delegateOutput(payload, fallbackDirectory) {
  if (!DELEGATION_TOOL_NAMES.has(payload?.tool_name)) return "";
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  if (typeof input.prompt !== "string" || !input.prompt.trim()) return "";

  const plan = delegationPlan(readPolicy(payloadDirectory(payload, fallbackDirectory)), input.subagent_type);
  if (!plan || promptCarriesPolicy(input.prompt, plan)) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input, prompt: `${input.prompt}\n\n${plan.block}\n` },
    },
  });
}

function subagentStopOutput(payload, fallbackDirectory) {
  if (!payload || payload.stop_hook_active === true) return "";
  const plan = delegationPlan(readPolicy(payloadDirectory(payload, fallbackDirectory)), payload.agent_type);
  if (!plan) return "";
  if (typeof payload.transcript_path !== "string" || !payload.transcript_path) return "";
  if (transcriptReportsDelegatedSignal(payload.transcript_path) !== false) return "";

  const scopes = plan.sections.map((section) => section.name.toLowerCase()).join(" and ");
  return JSON.stringify({
    systemMessage: [
      `Pomegr: delegated agent "${plan.agentType}" owns ${scopes} but finished without calling a Pomegr reporting tool.`,
      `Configured rows: ${plan.labels.join(", ")}.`,
      "Pomegr never infers a signal from a transcript. Report one from this session only if you can confirm the outcome; otherwise leave the scope unreported.",
    ].join(" "),
  });
}

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function runPolicyCli(args = process.argv.slice(2)) {
  const command = args[0] || "validate";
  const cwd = argumentValue(args, "--cwd", process.cwd());

  if (command === "delegate" || command === "subagent-stop") {
    const payload = readHookPayload();
    const output = command === "delegate" ? delegateOutput(payload, cwd) : subagentStopOutput(payload, cwd);
    if (output) process.stdout.write(`${output}\n`);
    return 0;
  }

  const policy = readPolicy(cwd);
  if (command === "hook") {
    const output = hookOutput(policy);
    if (output) process.stdout.write(`${output}\n`);
    return 0;
  }
  if (command === "validate") {
    const result = {
      status: policy.status,
      path: policy.path,
      errors: policy.errors || [],
      warnings: policy.warnings || [],
      delegatedAgents: (policy.delegatedAgents || []).map((row) => ({ agentType: row.agentType, owns: row.owns })),
      bytes: policy.bytes ?? 0,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return policy.status === "valid" ? 0 : policy.status === "missing" ? 2 : 1;
  }
  process.stderr.write("Usage: policy.mjs <validate|hook|delegate|subagent-stop> [--cwd <directory>]\n");
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPolicyCli();
}
