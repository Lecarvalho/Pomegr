import fs from "node:fs";
import { buildSkillUsageFromInvocations, normalizedSkillName } from "../skill-usage.mjs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

const SKILL_FUNCTION_NAMES = new Set(["skill", "invokeskill"]);
const SKILL_RECORD_TYPES = new Set(["skillinvocation", "skillinvoked"]);
const MAX_HOST_SKILLS_BODY = 256 * 1024;
const MAX_SKILL_SOURCE_PATH = 1024;

function normalizedType(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function explicitSkillName(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  return normalizedSkillName({ skill: input.skill ?? input.skill_name ?? input.name });
}

function explicitSkillInvocation(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const timestamp = codexTimestamp(record.timestamp ?? payload.timestamp);
  if (!timestamp) return null;

  if (record.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
    if (!SKILL_FUNCTION_NAMES.has(normalizedType(payload.name))) return null;
    const input = parseObject(payload.arguments ?? payload.input);
    const name = explicitSkillName(input);
    return name ? { name, timestamp } : null;
  }

  if (record.type === "response_item" && normalizedType(payload.type) === "skillcall") {
    const name = explicitSkillName(payload);
    return name ? { name, timestamp } : null;
  }

  const recordType = normalizedType(record.type);
  const payloadType = normalizedType(payload.type);
  if (!SKILL_RECORD_TYPES.has(recordType) && !(record.type === "event_msg" && SKILL_RECORD_TYPES.has(payloadType))) return null;
  const name = explicitSkillName(payload);
  return name ? { name, timestamp } : null;
}

function normalizedPathEvidence(value) {
  return String(value || "")
    .replace(/\\\\/g, "\\")
    .replace(/\//g, "\\")
    .toLowerCase();
}

function addHostSkillCatalog(record, catalog) {
  if (record?.type !== "world_state") return;
  const body = record?.payload?.state?.host_skills?.body;
  if (typeof body !== "string" || !body || body.length > MAX_HOST_SKILLS_BODY) return;
  const pattern = /^-\s+([A-Za-z0-9_.:-]+):.*?\(file:\s*([^\r\n)]+?SKILL\.md)\)/gm;
  for (const match of body.matchAll(pattern)) {
    const name = normalizedSkillName({ skill: match[1] });
    const source = match[2].trim();
    if (!name || !source || source.length > MAX_SKILL_SOURCE_PATH) continue;
    catalog.set(normalizedPathEvidence(source), name);
  }
}

function skillSourceReads(record, catalog) {
  const payload = record?.payload;
  if (record?.type !== "response_item"
    || payload?.type !== "custom_tool_call"
    || normalizedType(payload.name) !== "exec"
    || typeof payload.input !== "string") return [];
  const timestamp = codexTimestamp(record.timestamp ?? payload.timestamp);
  if (!timestamp) return [];
  const input = normalizedPathEvidence(payload.input);
  const names = new Set();
  for (const [source, name] of catalog) {
    if (source && input.includes(source)) names.add(name);
  }
  return [...names].map((name) => ({ name, timestamp }));
}

export function parseCodexSkillUsageRecords(records) {
  const catalog = new Map();
  const invocations = (Array.isArray(records) ? records : []).flatMap((record) => {
    addHostSkillCatalog(record, catalog);
    const invocation = explicitSkillInvocation(record);
    return [...(invocation ? [invocation] : []), ...skillSourceReads(record, catalog)];
  });
  return buildSkillUsageFromInvocations(invocations);
}

export function parseCodexCanonicalSkillUsage(turns) {
  const invocations = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    const timestamp = codexTimestamp(turn?.startedAt) || codexTimestamp(turn?.completedAt);
    if (!timestamp) continue;
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (!["dynamicToolCall", "mcpToolCall"].includes(item?.type)
        || !SKILL_FUNCTION_NAMES.has(normalizedType(item.tool))) continue;
      const input = parseObject(item.arguments);
      const name = explicitSkillName(input);
      if (name) invocations.push({ name, timestamp });
    }
  }
  return buildSkillUsageFromInvocations(invocations);
}

export function readCodexSkillUsageRollout(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    } catch {
      // Malformed and truncated lines do not invalidate recognized skill calls.
    }
  }
  return parseCodexSkillUsageRecords(records);
}
