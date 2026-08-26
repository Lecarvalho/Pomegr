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
export const POLICY_LOADED_MARKER = "[Pomegr reporting policy loaded]";
export const DELEGATION_MARKER = "[Pomegr delegated reporting policy]";
export const PLUGIN_METADATA_MARKER = "[Pomegr plugin metadata]";

const PLUGIN_MANIFEST_URL = new URL("../.codex-plugin/plugin.json", import.meta.url);
const PLUGIN_VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,64})?$/;

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
const DELEGATED_REPORT_TOOL_PATTERN = /^mcp__(?:plugin_pomegr_pomegr|pomegr)__(?:report_agent_signal|report_task_signal|clear_agent_signal)$/i;
const HOOK_INPUT_MAX_BYTES = 1024 * 1024;
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
      if (!signals[section]?.length) errors.push(`Delegated agents row ${index + 1} owns "${section}", but that section configures no rows to delegate.`);
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
      if (!hasTransition || negatesTransition) errors.push(`${name} row ${index + 1} must affirmatively say when the signal is replaced or cleared.`);
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
  if (typeof text !== "string") return policyResult("invalid", { errors: ["Policy content is not text."], signals: {}, delegatedAgents: [] });
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > POLICY_MAX_BYTES) errors.push(`Policy exceeds the ${POLICY_MAX_BYTES}-byte limit.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) errors.push("Policy contains control characters.");
  if (!/^# Pomegr reporting policy\s*$/m.test(text)) errors.push("Missing the Pomegr reporting policy title.");
  const versionMatch = text.match(/^Policy version:\s*(\d+)\s*$/m);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  if (![POLICY_VERSION, LEGACY_POLICY_VERSION].includes(version)) errors.push(`Policy version must be ${POLICY_VERSION} (legacy version ${LEGACY_POLICY_VERSION} is accepted).`);
  const requiredSections = version === POLICY_VERSION ? [...REQUIRED_SECTIONS, PROGRESS_SECTION] : REQUIRED_SECTIONS;

  for (const name of requiredSections) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = text.match(new RegExp(`^## ${escaped}\\s*$`, "gm")) || [];
    if (matches.length > 1) errors.push(`Policy must contain exactly one "${name}" section.`);
  }

  const sections = new Map();
  for (const name of requiredSections) {
    const body = sectionBody(text, name);
    if (body === null || !body) errors.push(`Missing or empty "${name}" section.`);
    sections.set(name, body || "");
  }
  if (sections.get("Session naming") !== CANONICAL_SESSION_NAMING) errors.push("Session naming must match the canonical agent-title policy.");
  if (sections.get("Privacy and semantics") !== CANONICAL_PRIVACY) errors.push("Privacy and semantics must match the canonical Pomegr safety policy.");
  if (sections.get("Delegated agent tooling") !== CANONICAL_DELEGATED_AGENT_TOOLING) {
    errors.push("Delegated agent tooling must declare signal-owning subagent types and preserve Pomegr MCP access.");
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
      return policyResult("invalid", { path: found.path, repositoryRoot: found.repositoryRoot, errors: ["Policy must be a regular file and cannot be a symbolic link."] });
    }
    if (relativePolicyPath.startsWith(`..${path.sep}`) || relativePolicyPath === ".." || path.isAbsolute(relativePolicyPath)) {
      return policyResult("invalid", { path: found.path, repositoryRoot: found.repositoryRoot, errors: ["Policy must resolve inside the repository."] });
    }
    text = fs.readFileSync(found.path, "utf8");
  } catch {
    return policyResult("invalid", { path: found.path, repositoryRoot: found.repositoryRoot, errors: ["Policy could not be read."] });
  }
  return { ...validatePolicyText(text), path: found.path, repositoryRoot: found.repositoryRoot, text, warnings: [] };
}

export function installedPluginVersion() {
  try {
    const stat = fs.lstatSync(PLUGIN_MANIFEST_URL);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));
    return typeof value?.version === "string" && PLUGIN_VERSION_PATTERN.test(value.version) ? value.version : null;
  } catch {
    return null;
  }
}

export function pluginMetadataLine(policy) {
  return `${PLUGIN_METADATA_MARKER} ${JSON.stringify({
    pluginVersion: installedPluginVersion(),
    policyStatus: policy.status,
    policyVersion: Number.isInteger(policy.version) ? policy.version : null,
  })}`;
}

function sessionStartOutput(policy) {
  const metadata = pluginMetadataLine(policy);
  if (policy.status === "missing") {
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: metadata } };
  }
  if (policy.status === "invalid") {
    return {
      systemMessage: "Pomegr reporting policy is invalid. Use $pomegr:doctor; reporting remains non-blocking.",
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: metadata },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        metadata,
        POLICY_LOADED_MARKER,
        "Follow this repository-owned policy when reporting session, agent, or execution-task signals through the Pomegr MCP tools.",
        "Treat signals as project-specific, agent-reported state rather than heartbeats or authoritative judgments. Clear resolved session or agent state when no replacement applies.",
        "Codex injects declared delegated rows through the Pomegr SubagentStart hook. Do not paste them into subagent prompts yourself.",
        "Use provider-native automatic session naming unless an explicit safe title capability is available; never ask the user to name the task.",
        "",
        policy.text,
      ].join("\n"),
    },
  };
}

function normalizedAgentType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function delegationPlan(policy, agentType) {
  if (!policy || policy.status !== "valid") return null;
  const type = normalizedAgentType(agentType);
  if (!type || type === "fork") return null;

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
    "This repository's Pomegr policy assigns the rows below to your agent type. Use the logical Pomegr reporting tools for matching transitions.",
    "Signals are current project-specific state, not heartbeats or Pomegr judgments. Replace applicable state, clear resolved agent state, and keep execution-task outcomes durable.",
    "Never put prompts, responses, secrets, commands, stdout, stderr, tool results, credentials, or sensitive repository content in a signal.",
    "If no row applies when you finish, report nothing.",
  ];
  for (const section of sections) {
    lines.push("", `### ${section.name}`, TABLE_HEADER, TABLE_DIVIDER);
    for (const row of section.rows) lines.push(`| ${row.label} | ${row.tone} | ${row.reportWhen} | ${row.replaceWhen} |`);
  }
  return { agentType: type, sections, labels, block: lines.join("\n") };
}

function codexTranscriptRecordReports(line) {
  if (!line || !/pomegr/i.test(line)) return false;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  if (record?.type !== "response_item") return false;
  const payload = record.payload;
  if (!payload || !["function_call", "custom_tool_call"].includes(payload.type)) return false;
  return typeof payload.name === "string" && DELEGATED_REPORT_TOOL_PATTERN.test(payload.name);
}

export function transcriptReportsDelegatedSignal(transcriptPath) {
  let handle;
  try {
    const stat = fs.lstatSync(transcriptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > TRANSCRIPT_SCAN_MAX_BYTES) return null;
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
      for (const line of lines) if (codexTranscriptRecordReports(line)) return true;
    }
    return codexTranscriptRecordReports(remainder + decoder.end());
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

function readHookPayload() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > HOOK_INPUT_MAX_BYTES) return null;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } catch {
    return null;
  }
  if (!total) return null;
  try {
    const payload = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function payloadDirectory(payload, fallback) {
  return typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : fallback;
}

function subagentStartOutput(payload, fallbackDirectory) {
  if (!payload || payload.hook_event_name !== "SubagentStart") return null;
  const plan = delegationPlan(readPolicy(payloadDirectory(payload, fallbackDirectory)), payload.agent_type);
  if (!plan) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: plan.block,
    },
  };
}

function subagentStopOutput(payload, fallbackDirectory) {
  if (!payload || payload.hook_event_name !== "SubagentStop") return null;
  const plan = delegationPlan(readPolicy(payloadDirectory(payload, fallbackDirectory)), payload.agent_type);
  if (!plan || typeof payload.agent_transcript_path !== "string" || !payload.agent_transcript_path) return null;
  if (transcriptReportsDelegatedSignal(payload.agent_transcript_path) !== false) return null;
  const scopes = plan.sections.map((section) => section.name.toLowerCase()).join(" and ");
  return {
    systemMessage: [
      `Pomegr: delegated agent "${plan.agentType}" owns ${scopes} but finished without calling a Pomegr reporting tool.`,
      `Configured rows: ${plan.labels.join(", ")}.`,
      "Pomegr never infers a signal from transcript content. Report one from the main session only when the outcome is independently confirmed; otherwise leave it unreported.",
    ].join(" "),
  };
}

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function runPolicyCli(args = process.argv.slice(2)) {
  const command = args[0] || "validate";
  const cwd = argumentValue(args, "--cwd", process.cwd());

  if (["session-start", "subagent-start", "subagent-stop"].includes(command)) {
    const payload = readHookPayload();
    const policyDirectory = payloadDirectory(payload, cwd);
    let output = null;
    if (command === "session-start") output = sessionStartOutput(readPolicy(policyDirectory));
    if (command === "subagent-start") output = subagentStartOutput(payload, cwd);
    if (command === "subagent-stop") output = subagentStopOutput(payload, cwd);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    else if (command !== "session-start") process.stdout.write("{}\n");
    return 0;
  }

  if (command === "validate") {
    const policy = readPolicy(cwd);
    process.stdout.write(`${JSON.stringify({
      status: policy.status,
      path: policy.path,
      errors: policy.errors || [],
      warnings: policy.warnings || [],
      delegatedAgents: (policy.delegatedAgents || []).map((row) => ({ agentType: row.agentType, owns: row.owns })),
      bytes: policy.bytes ?? 0,
    })}\n`);
    return policy.status === "valid" ? 0 : policy.status === "missing" ? 2 : 1;
  }

  process.stderr.write("Usage: policy.mjs <validate|session-start|subagent-start|subagent-stop> [--cwd <directory>]\n");
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPolicyCli();
}
