#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const POLICY_RELATIVE_PATH = path.join(".pomegr", "signals.md");
export const POLICY_VERSION = 2;
export const POLICY_MAX_BYTES = 24 * 1024;
export const POLICY_MAX_CONDITION_LENGTH = 240;
export const POLICY_TONES = new Set(["neutral", "info", "positive", "warning", "negative"]);

const REQUIRED_SECTIONS = [
  "Session naming",
  "Privacy and semantics",
  "Delegated agent tooling",
  "Session signals",
  "Agent signals",
  "Task signals",
];
const SIGNAL_SECTIONS = ["Session signals", "Agent signals", "Task signals"];
const EMPTY_SECTION = "_No project-specific signals configured._";
const TABLE_HEADER = "| Label | Tone | Report when | Replace or clear when |";
const TABLE_DIVIDER = "| --- | --- | --- | --- |";
const CANONICAL_SESSION_NAMING = [
  "- Allow Claude Code to assign a concise native automatic title after the first substantive request.",
  "- Never ask the user to name the session and never report a title through Pomegr MCP.",
].join("\n");
const CANONICAL_PRIVACY = [
  "- Report only project-specific state that helps an observer understand the work.",
  "- Treat every signal as agent-reported and potentially stale, not as a Pomegr judgment.",
  "- Report transitions, not heartbeats. Replace a signal when a new configured state applies; clear agent or session state when none applies.",
  "- Never include prompts, responses, secrets, commands, stdout, stderr, tool results, credential values, or sensitive repository content.",
  "- Use only labels and conditions approved below. Pomegr's universal MCP validation remains the safety boundary, not this file as an application enum.",
].join("\n");
const CANONICAL_DELEGATED_AGENT_TOOLING = [
  "- When delegating work that can produce a configured agent or execution-task signal, include the applicable signal rows and transition rules in the Agent prompt.",
  "- Ensure that subagent tooling includes the Pomegr MCP tools. If an agent definition has an explicit `tools` allowlist, add the resolved Pomegr MCP namespace, typically `mcp__plugin_pomegr_pomegr__*`, or the exact Pomegr reporting and clearing tool names available in the session.",
  "- Do not assign agent- or task-signal reporting to a subagent that cannot call the applicable Pomegr MCP tool.",
].join("\n");

function policyResult(status, fields = {}) {
  return { status, ...fields };
}

function sectionBody(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return match?.[1]?.trim().replace(/\r\n?/g, "\n") ?? null;
}

function splitTableRow(line) {
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
  return cells.length === 4 ? cells : null;
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
  if (typeof text !== "string") return policyResult("invalid", { errors: ["Policy content is not text."], signals: {} });
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > POLICY_MAX_BYTES) errors.push(`Policy exceeds the ${POLICY_MAX_BYTES}-byte limit.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) errors.push("Policy contains control characters.");
  if (!/^# Pomegr reporting policy\s*$/m.test(text)) errors.push("Missing the Pomegr reporting policy title.");
  if (!new RegExp(`^Policy version: ${POLICY_VERSION}\\s*$`, "m").test(text)) errors.push(`Policy version must be ${POLICY_VERSION}.`);

  for (const name of REQUIRED_SECTIONS) {
    const matches = text.match(new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "gm")) || [];
    if (matches.length > 1) errors.push(`Policy must contain exactly one "${name}" section.`);
  }

  const sections = new Map();
  for (const name of REQUIRED_SECTIONS) {
    const body = sectionBody(text, name);
    if (body === null || !body) errors.push(`Missing or empty "${name}" section.`);
    sections.set(name, body || "");
  }
  if (sections.get("Session naming") !== CANONICAL_SESSION_NAMING) {
    errors.push("Session naming must match the canonical native-title policy.");
  }
  if (sections.get("Privacy and semantics") !== CANONICAL_PRIVACY) {
    errors.push("Privacy and semantics must match the canonical Pomegr safety policy.");
  }
  if (sections.get("Delegated agent tooling") !== CANONICAL_DELEGATED_AGENT_TOOLING) {
    errors.push("Delegated agent tooling must attach the Pomegr MCP tools to signal-owning subagents.");
  }

  const signals = {};
  for (const name of SIGNAL_SECTIONS) signals[name] = validateSignalSection(name, sections.get(name), errors);
  return policyResult(errors.length ? "invalid" : "valid", { errors, bytes, signals });
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
  return { ...validatePolicyText(text), path: found.path, repositoryRoot: found.repositoryRoot, text };
}

function hookOutput(policy) {
  if (policy.status === "missing") return "";
  if (policy.status === "invalid") {
    return JSON.stringify({
      systemMessage: "Pomegr reporting policy is invalid. Run /pomegr:doctor; reporting remains non-blocking.",
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        "[Pomegr reporting policy loaded]",
        "Follow this repository-owned policy when reporting agent, session, or execution-task signals through the Pomegr MCP tools.",
        "Treat these signals as current project-specific state, not heartbeats or authoritative judgments. Clear a resolved agent or session signal when no replacement applies.",
        "When delegating signal-owning work, pass the applicable policy rows in the Agent prompt and ensure the subagent's tooling includes the resolved Pomegr MCP tools.",
        "Do not ask the user to name the session; allow Claude Code to assign its native automatic title after substantive work begins.",
        "",
        policy.text,
      ].join("\n"),
    },
  });
}

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function runPolicyCli(args = process.argv.slice(2)) {
  const command = args[0] || "validate";
  const cwd = argumentValue(args, "--cwd", process.cwd());
  const policy = readPolicy(cwd);
  if (command === "hook") {
    const output = hookOutput(policy);
    if (output) process.stdout.write(`${output}\n`);
    return 0;
  }
  if (command === "validate") {
    const result = { status: policy.status, path: policy.path, errors: policy.errors || [], bytes: policy.bytes ?? 0 };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return policy.status === "valid" ? 0 : policy.status === "missing" ? 2 : 1;
  }
  process.stderr.write("Usage: policy.mjs <validate|hook> [--cwd <directory>]\n");
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPolicyCli();
}
