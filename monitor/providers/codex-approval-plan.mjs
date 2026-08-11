import fs from "node:fs";
import { normalizeSessionTask } from "../session-tasks.mjs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

const MAX_PLAN_TASKS = 40;
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

function planPayload(record) {
  if (!plainObject(record)) return null;
  if (record.type === "response_item") {
    const payload = plainObject(record.payload);
    const itemType = normalizedType(payload?.type);
    if (!["functioncall", "customtoolcall"].includes(itemType) || normalizedType(payload?.name) !== "updateplan") return null;
    return parseObject(payload.arguments ?? payload.input);
  }
  if (record.method === "turn/plan/updated") return plainObject(record.params);
  if (record.type === "turn/plan/updated") return plainObject(record.payload ?? record.params);
  if (record.type === "event_msg" && ["planupdate", "turnplanupdated"].includes(normalizedType(record.payload?.type))) {
    return plainObject(record.payload);
  }
  return null;
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

export function parseCodexPlanRecords(records) {
  let latest = [];
  let hasStructuredPlan = false;
  for (const record of (Array.isArray(records) ? records : [])) {
    const payload = planPayload(record);
    if (!payload) continue;
    const plan = normalizedPlan(payload);
    if (!plan) continue;
    latest = plan;
    hasStructuredPlan = true;
  }
  return hasStructuredPlan ? latest : [];
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
