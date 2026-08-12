import fs from "node:fs";
import { normalizeSessionTask } from "../session-tasks.mjs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

const MAX_PLAN_TASKS = 40;
const MAX_EXEC_PLAN_SOURCE_LENGTH = 64 * 1024;
const MAX_LITERAL_DEPTH = 8;
const MAX_LITERAL_ITEMS = 256;
const APPROVAL_MODES = Object.freeze({
  untrusted: { id: "untrusted", label: "Untrusted" },
  "on-request": { id: "on_request", label: "On request" },
  granular: { id: "granular", label: "Granular" },
  never: { id: "never", label: "Never" },
});

function normalizedType(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseObject(value) {
  if (plainObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try { return plainObject(JSON.parse(value)); } catch { return null; }
}

function identifierStart(value) {
  return /[A-Za-z_$]/.test(value || "");
}

function identifierPart(value) {
  return /[A-Za-z0-9_$]/.test(value || "");
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return source.length;
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function parseQuotedString(source, start) {
  const quote = source[start];
  if (quote !== "\"" && quote !== "'") return null;
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) return { value, index: index + 1 };
    if (character === "\n" || character === "\r") return null;
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (!escaped) return null;
    if (escaped === "\n") {
      index += 2;
      continue;
    }
    if (escaped === "\r") {
      index += source[index + 2] === "\n" ? 3 : 2;
      continue;
    }
    const simpleEscapes = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      0: "\0",
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      if (escaped === "0" && /[0-9]/.test(source[index + 2] || "")) return null;
      value += simpleEscapes[escaped];
      index += 2;
      continue;
    }
    if (escaped === "x") {
      const hex = source.slice(index + 2, index + 4);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    if (escaped === "u") {
      const hex = source.slice(index + 2, index + 6);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    value += escaped;
    index += 2;
  }
  return null;
}

function parseIdentifier(source, start) {
  if (!identifierStart(source[start])) return null;
  let index = start + 1;
  while (identifierPart(source[index])) index += 1;
  return { value: source.slice(start, index), index };
}

function parseRestrictedLiteral(source, start, state, depth = 0) {
  if (depth > MAX_LITERAL_DEPTH || state.items >= MAX_LITERAL_ITEMS) return null;
  state.items += 1;
  let index = skipTrivia(source, start);
  const string = parseQuotedString(source, index);
  if (string) return string;
  if (source[index] === "[") {
    const value = [];
    index = skipTrivia(source, index + 1);
    while (source[index] !== "]") {
      const item = parseRestrictedLiteral(source, index, state, depth + 1);
      if (!item) return null;
      value.push(item.value);
      index = skipTrivia(source, item.index);
      if (source[index] === "]") break;
      if (source[index] !== ",") return null;
      index = skipTrivia(source, index + 1);
      if (source[index] === "]") break;
    }
    return source[index] === "]" ? { value, index: index + 1 } : null;
  }
  if (source[index] === "{") {
    const value = Object.create(null);
    index = skipTrivia(source, index + 1);
    while (source[index] !== "}") {
      const key = parseQuotedString(source, index) || parseIdentifier(source, index);
      if (!key) return null;
      index = skipTrivia(source, key.index);
      if (source[index] !== ":") return null;
      const item = parseRestrictedLiteral(source, index + 1, state, depth + 1);
      if (!item) return null;
      value[key.value] = item.value;
      index = skipTrivia(source, item.index);
      if (source[index] === "}") break;
      if (source[index] !== ",") return null;
      index = skipTrivia(source, index + 1);
      if (source[index] === "}") break;
    }
    return source[index] === "}" ? { value, index: index + 1 } : null;
  }
  const identifier = parseIdentifier(source, index);
  if (identifier && ["true", "false", "null"].includes(identifier.value)) {
    return {
      value: identifier.value === "null" ? null : identifier.value === "true",
      index: identifier.index,
    };
  }
  const number = source.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
  if (!number) return null;
  return { value: Number(number[0]), index: index + number[0].length };
}

function skipTemplateLiteral(source, start) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "`") return index + 1;
    index += 1;
  }
  return source.length;
}

function nestedExecPlanPayloads(value) {
  if (typeof value !== "string" || !value || value.length > MAX_EXEC_PLAN_SOURCE_LENGTH) return [];
  const payloads = [];
  let index = 0;
  while (index < value.length) {
    index = skipTrivia(value, index);
    const quoted = parseQuotedString(value, index);
    if (quoted) {
      index = quoted.index;
      continue;
    }
    if (value[index] === "`") {
      index = skipTemplateLiteral(value, index);
      continue;
    }
    const tools = parseIdentifier(value, index);
    if (tools?.value !== "tools") {
      index = tools?.index ?? index + 1;
      continue;
    }
    let cursor = skipTrivia(value, tools.index);
    if (value[cursor] !== ".") {
      index = tools.index;
      continue;
    }
    const method = parseIdentifier(value, skipTrivia(value, cursor + 1));
    if (method?.value !== "update_plan") {
      index = method?.index ?? cursor + 1;
      continue;
    }
    cursor = skipTrivia(value, method.index);
    if (value[cursor] !== "(") {
      index = method.index;
      continue;
    }
    const literal = parseRestrictedLiteral(value, cursor + 1, { items: 0 });
    if (!literal || value[skipTrivia(value, literal.index)] !== ")") {
      index = cursor + 1;
      continue;
    }
    const payload = plainObject(literal.value);
    if (payload) payloads.push(payload);
    index = literal.index;
  }
  return payloads;
}

function approvalPolicyId(value) {
  if (typeof value === "string" && Object.hasOwn(APPROVAL_MODES, value)) return value;
  if (plainObject(value)?.granular && plainObject(value.granular)) return "granular";
  return null;
}

function approvalRecord(record) {
  if (!plainObject(record)) return null;
  const recordType = normalizedType(record.type);
  let container = null;
  if (["turncontext", "threadsettings", "threadsettingsupdated"].includes(recordType)) {
    const payload = plainObject(record.payload);
    container = plainObject(payload?.threadSettings)
      ?? plainObject(payload?.thread_settings)
      ?? plainObject(payload?.settings)
      ?? payload;
  } else if (record.method === "thread/settings/updated") {
    const params = plainObject(record.params);
    container = plainObject(params?.threadSettings)
      ?? plainObject(params?.thread_settings)
      ?? plainObject(params?.settings)
      ?? params;
  }
  if (!container) return null;
  const policyId = approvalPolicyId(container.approval_policy ?? container.approvalPolicy);
  if (!policyId) return null;
  return {
    ...APPROVAL_MODES[policyId],
    observedAt: codexTimestamp(record.timestamp ?? record.payload?.timestamp ?? record.params?.timestamp),
    source: "provider",
  };
}

function planPayloads(record) {
  if (!plainObject(record)) return [];
  if (record.type === "response_item") {
    const payload = plainObject(record.payload);
    const itemType = normalizedType(payload?.type);
    if (!["functioncall", "customtoolcall"].includes(itemType)) return [];
    const toolName = normalizedType(payload?.name);
    if (toolName === "updateplan") {
      const parsed = parseObject(payload.arguments ?? payload.input);
      return parsed ? [parsed] : [];
    }
    if (toolName === "exec") return nestedExecPlanPayloads(payload.input ?? payload.arguments);
    return [];
  }
  if (record.method === "turn/plan/updated") return plainObject(record.params) ? [record.params] : [];
  if (record.type === "turn/plan/updated") {
    const payload = plainObject(record.payload ?? record.params);
    return payload ? [payload] : [];
  }
  if (record.type === "event_msg" && ["planupdate", "turnplanupdated"].includes(normalizedType(record.payload?.type))) {
    return plainObject(record.payload) ? [record.payload] : [];
  }
  return [];
}

function planStatus(value) {
  const status = normalizedType(value);
  if (status === "pending") return "pending";
  if (status === "inprogress") return "in_progress";
  if (status === "completed") return "completed";
  return null;
}

function normalizedPlan(payload) {
  if (!plainObject(payload) || !Array.isArray(payload.plan) || payload.plan.length > MAX_PLAN_TASKS) return null;
  const tasks = payload.plan.map((step, index) => {
    if (!plainObject(step)) return null;
    const status = planStatus(step.status);
    if (!status) return null;
    return normalizeSessionTask({
      id: `codex-plan-${index + 1}`,
      subject: step.step,
      status,
    });
  });
  return tasks.every(Boolean) ? tasks : null;
}

export function codexApprovalModeFromRecord(record) {
  return approvalRecord(record);
}

export function latestCodexApprovalMode(records) {
  let latest = null;
  for (const record of (Array.isArray(records) ? records : [])) latest = approvalRecord(record) || latest;
  return latest;
}

export function latestCodexPlanSnapshot(records) {
  let latest = null;
  for (const record of (Array.isArray(records) ? records : [])) {
    for (const payload of planPayloads(record)) {
      const plan = normalizedPlan(payload);
      if (plan) latest = plan;
    }
  }
  return latest;
}

export function parseCodexPlanRecords(records) {
  return latestCodexPlanSnapshot(records) ?? [];
}

export function parseCodexApprovalPlanRecords(records) {
  return {
    approvalMode: latestCodexApprovalMode(records),
    planTasks: parseCodexPlanRecords(records),
  };
}

export function readCodexApprovalPlanRollout(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { approvalMode: null, planTasks: [] }; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (plainObject(record)) records.push(record);
    } catch {
      // Malformed and truncated lines do not invalidate earlier recognized settings or plans.
    }
  }
  return parseCodexApprovalPlanRecords(records);
}
