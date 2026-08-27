import fs from "node:fs";
import {
  codexSourceKind,
  codexTimestamp,
  isCodexApprovalReviewerSource,
  isSafeCodexSessionId,
} from "./codex-session-metadata.mjs";
import { classifyCodexApprovalAction, normalizeCodexReviewAction } from "./codex-review-actions.mjs";

const MAX_LABEL_LENGTH = 80;
const MAX_MODEL_LENGTH = 96;
const MAX_ROLE_LENGTH = 64;
const MAX_AGENT_PATH_LENGTH = 512;
const MAX_REVIEW_DECISIONS = 100;
const MAX_REVIEW_DURATION_MS = 60 * 60 * 1_000;
const KNOWN_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const COMPLETED_EVENTS = new Set(["task_complete", "task_completed", "turn_complete", "turn_completed"]);
const INTERRUPTED_EVENTS = new Set(["turn_aborted", "turn_interrupted", "task_interrupted"]);

function boundedText(value, maximum, fallback = "") {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
  return text || fallback;
}

function titleFromIdentifier(value) {
  const label = boundedText(value, MAX_LABEL_LENGTH);
  if (!label) return "Unnamed subagent";
  const words = label.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unnamed subagent";
}

function safeThreadId(value) {
  if (isSafeCodexSessionId(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.match(/(?:agent-)?([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
  return match && isSafeCodexSessionId(match[1]) ? match[1] : null;
}

function safeAgentReference(value) {
  return boundedText(value, MAX_AGENT_PATH_LENGTH);
}

function agentReferenceAliases(value) {
  const reference = safeAgentReference(value).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!reference) return [];
  const trimmed = reference.replace(/^\/+|\/+$/g, "");
  const aliases = new Set([reference, trimmed]);
  const leaf = trimmed.split("/").at(-1);
  if (leaf) aliases.add(leaf);
  return [...aliases].filter(Boolean);
}

function recordTimestamp(record) {
  return codexTimestamp(record?.timestamp ?? record?.payload?.timestamp ?? record?.message?.timestamp);
}

function timestampValue(value) {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : Number.NEGATIVE_INFINITY;
}

function laterTimestamp(left, right) {
  return timestampValue(right) >= timestampValue(left) ? right : left;
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

function nestedThreadSpawn(payload) {
  const source = payload?.source;
  const subagent = source?.subAgent ?? source?.subagent;
  return subagent && typeof subagent === "object"
    ? subagent.thread_spawn ?? subagent.threadSpawn ?? null
    : null;
}

function normalizedEffort(value) {
  const effort = boundedText(value, 24).toLowerCase().replace(/[-_\s]+/g, "");
  return KNOWN_EFFORTS.has(effort) ? effort : "unspecified";
}

function normalizedModel(value) {
  return boundedText(value, MAX_MODEL_LENGTH, "unknown");
}

export function codexSandboxLabel(value) {
  const type = typeof value === "string" ? value : value?.type ?? value?.mode;
  const normalized = boundedText(type, 48).toLowerCase().replace(/[_\s]+/g, "-");
  if (["read-only", "readonly"].includes(normalized)) return "Read only";
  if (["workspace-write", "workspacewrite"].includes(normalized)) return "Workspace write";
  if (["danger-full-access", "full-access", "fullaccess"].includes(normalized)) return "Full access";
  if (["external-sandbox", "externalsandbox"].includes(normalized)) return "External sandbox";
  return normalized ? "Custom sandbox" : "Unspecified sandbox";
}

function runtimeRecord(record) {
  if (!record || typeof record !== "object") return null;
  if (!["turn_context", "thread_settings", "thread_settings_updated"].includes(record.type)) return null;
  const payload = record.payload?.settings ?? record.payload;
  if (!payload || typeof payload !== "object") return null;
  return {
    timestamp: recordTimestamp(record),
    model: normalizedModel(payload.model),
    effort: normalizedEffort(payload.effort ?? payload.reasoning_effort ?? payload.reasoningEffort),
    approvalPolicy: boundedText(payload.approval_policy ?? payload.approvalPolicy, 40, "unspecified"),
    sandboxLabel: codexSandboxLabel(payload.sandbox_policy ?? payload.sandboxPolicy ?? payload.sandbox),
  };
}

function collaborationToolName(name) {
  const normalized = boundedText(name, 80).split(/[:./]/).at(-1)?.replace(/[^A-Za-z]/g, "").toLowerCase() || "";
  if (normalized === "spawnagent") return "spawn";
  if (["resumeagent", "followuptask"].includes(normalized)) return "resume";
  if (["closeagent", "interruptagent"].includes(normalized)) return "stop";
  return null;
}

function callId(payload) {
  return boundedText(payload?.call_id ?? payload?.callId ?? payload?.id, 128);
}

function collaborationState(value) {
  const status = boundedText(value?.status ?? value, 32).toLowerCase().replace(/[_-]/g, "");
  if (["running", "pendinginit", "inprogress"].includes(status)) return "active";
  if (["completed", "finished"].includes(status)) return "finished";
  if (["interrupted", "errored", "shutdown", "notfound", "failed", "stopped"].includes(status)) return "stopped";
  return null;
}

function canonicalCollaboration(payload, timestamp, ownerThreadId) {
  const type = String(payload?.type || "").toLowerCase().replace(/_/g, "");
  if (type !== "collabagenttoolcall") return [];
  const tool = collaborationToolName(payload.tool);
  const senderThreadId = safeThreadId(payload.senderThreadId ?? payload.sender_thread_id) || ownerThreadId;
  const receivers = payload.receiverThreadIds ?? payload.receiver_thread_ids;
  if (!tool || !Array.isArray(receivers)) return [];
  const states = payload.agentsStates ?? payload.agents_states ?? {};
  return receivers.flatMap((receiver) => {
    const childThreadId = safeThreadId(receiver);
    if (!childThreadId) return [];
    const requestedModel = normalizedModel(payload.model);
    const requestedEffort = normalizedEffort(payload.reasoningEffort ?? payload.reasoning_effort);
    return [{
      childThreadId,
      agentReference: null,
      referenceKind: "thread",
      parentThreadId: senderThreadId,
      label: "Unnamed subagent",
      kind: "subagent",
      model: requestedModel,
      effort: requestedEffort,
      timestamp,
      status: collaborationState(states?.[receiver])
        ?? (tool === "stop" && payload.status === "completed" ? "stopped" : null)
        ?? (tool === "resume" && payload.status === "completed" ? "active" : null),
      action: tool,
    }];
  });
}

function functionOutputObject(payload) {
  const parsed = parseObject(payload?.output);
  if (parsed) return parsed;
  const text = typeof payload?.output === "string" ? payload.output : "";
  const match = text.match(/(?:agent_id|agentId|thread_id|threadId)["'\s:=]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})/i);
  return match ? { agent_id: match[1] } : null;
}

function functionCallTarget(input) {
  return safeAgentReference(input?.target ?? input?.agent_id ?? input?.agentId ?? input?.thread_id ?? input?.threadId);
}

function terminalEvent(record) {
  const payload = record?.payload;
  if (record?.type === "turn_completed" || record?.type === "turn/completed") {
    const status = boundedText(payload?.turn?.status ?? payload?.status, 32).toLowerCase();
    if (status === "completed") return "finished";
    if (["interrupted", "failed"].includes(status)) return "stopped";
  }
  if (record?.type !== "event_msg") return null;
  const type = boundedText(payload?.type, 48).toLowerCase();
  if (COMPLETED_EVENTS.has(type)) return "finished";
  if (INTERRUPTED_EVENTS.has(type)) return "stopped";
  return null;
}

function isFinalAgentMessage(record) {
  return record?.type === "event_msg" && record?.payload?.type === "agent_message";
}

function approvalReviewDecision(record, action) {
  const payload = record?.payload;
  if (record?.type !== "event_msg" || !["task_complete", "task_completed"].includes(payload?.type)) return null;
  const result = parseObject(payload?.last_agent_message ?? payload?.lastAgentMessage);
  const outcome = result?.outcome === "allow"
    ? "allowed"
    : result?.outcome === "deny"
      ? "denied"
      : null;
  const normalizedRisk = boundedText(result?.risk_level ?? result?.riskLevel, 16).toLowerCase();
  const risk = ["low", "medium", "high"].includes(normalizedRisk) ? normalizedRisk : "unknown";
  const rawDurationMs = payload?.duration_ms ?? payload?.durationMs;
  const durationMs = Number.isFinite(rawDurationMs) && rawDurationMs >= 0 && rawDurationMs <= MAX_REVIEW_DURATION_MS
    ? Math.round(rawDurationMs)
    : null;
  const reviewedAt = codexTimestamp(payload?.completed_at ?? payload?.completedAt) || recordTimestamp(record);
  return outcome && reviewedAt ? { action: normalizeCodexReviewAction(action), outcome, risk, durationMs, reviewedAt } : null;
}

function reviewDecisionFeed(decisions) {
  const unique = new Map();
  for (const decision of decisions) unique.set(`${decision.reviewedAt}:${decision.outcome}`, decision);
  const ordered = [...unique.values()].sort((left, right) => timestampValue(left.reviewedAt) - timestampValue(right.reviewedAt));
  return {
    total: ordered.length,
    allowed: ordered.filter((decision) => decision.outcome === "allowed").length,
    denied: ordered.filter((decision) => decision.outcome === "denied").length,
    items: ordered.slice(-MAX_REVIEW_DECISIONS),
    truncated: ordered.length > MAX_REVIEW_DECISIONS,
  };
}

function summaryFromRecords(records, fallback = {}) {
  const timestamps = [];
  const pendingCalls = new Map();
  const collaborations = [];
  let runtime = {
    model: normalizedModel(fallback.model),
    effort: normalizedEffort(fallback.effort),
    approvalPolicy: boundedText(fallback.approvalPolicy, 40, "unspecified"),
    sandboxLabel: codexSandboxLabel(fallback.sandboxLabel),
  };
  let terminal = null;
  let ownerThreadId = safeThreadId(fallback.localId);
  let sessionId = safeThreadId(fallback.sessionId);
  let parentThreadId = safeThreadId(fallback.parentThreadId);
  let forkedFromId = safeThreadId(fallback.forkedFromId);
  let agentPath = safeAgentReference(fallback.agentPath);
  let approvalReviewer = fallback.approvalReviewer === true;
  let agentNickname = boundedText(fallback.agentNickname, MAX_LABEL_LENGTH);
  let agentRole = boundedText(fallback.agentRole, MAX_ROLE_LENGTH);
  let sourceKind = fallback.sourceKind || "unknown";
  const reviewDecisions = [];
  const reviewActionsByTurn = new Map();
  let currentReviewTurnId = "";

  for (const [order, record] of records.entries()) {
    const timestamp = recordTimestamp(record);
    if (timestamp) timestamps.push(timestamp);
    if (record?.type === "session_meta" && record.payload && typeof record.payload === "object") {
      const payload = record.payload;
      const recordThreadId = safeThreadId(payload.id ?? payload.thread_id);
      if (!ownerThreadId && recordThreadId) ownerThreadId = recordThreadId;
      if (!recordThreadId || recordThreadId === ownerThreadId) {
        const spawned = nestedThreadSpawn(payload);
        sessionId = safeThreadId(payload.sessionId ?? payload.session_id) || sessionId;
        parentThreadId = safeThreadId(payload.parentThreadId ?? payload.parent_thread_id ?? spawned?.parent_thread_id) || parentThreadId;
        forkedFromId = safeThreadId(payload.forkedFromId ?? payload.forked_from_id) || forkedFromId;
        agentPath = safeAgentReference(payload.agentPath ?? payload.agent_path ?? spawned?.agent_path ?? spawned?.agentPath) || agentPath;
        approvalReviewer ||= isCodexApprovalReviewerSource(payload.source);
        agentNickname = boundedText(payload.agentNickname ?? payload.agent_nickname ?? spawned?.agent_nickname, MAX_LABEL_LENGTH) || agentNickname;
        agentRole = boundedText(payload.agentRole ?? payload.agent_role ?? spawned?.agent_role, MAX_ROLE_LENGTH) || agentRole;
        sourceKind = codexSourceKind(payload.source);
      }
    }
    const observedRuntime = runtimeRecord(record);
    if (observedRuntime) runtime = observedRuntime;
    const observedTerminal = terminalEvent(record);
    if (observedTerminal && timestamp) terminal = { status: observedTerminal, timestamp, order };
    if (isFinalAgentMessage(record) && timestamp) terminal = { status: "finished", timestamp, order };
    const payload = record?.payload;
    if (record?.type === "event_msg" && payload?.type === "task_started") {
      currentReviewTurnId = boundedText(payload.turn_id ?? payload.turnId, 160);
    }
    if (record?.type === "event_msg" && payload?.type === "user_message") {
      const action = classifyCodexApprovalAction(payload.message);
      if (currentReviewTurnId) reviewActionsByTurn.set(currentReviewTurnId, action);
    }
    const completedReviewTurnId = boundedText(payload?.turn_id ?? payload?.turnId, 160);
    const reviewDecision = approvalReviewDecision(record, reviewActionsByTurn.get(completedReviewTurnId));
    if (reviewDecision) reviewDecisions.push(reviewDecision);
    if (reviewDecision && completedReviewTurnId) {
      reviewActionsByTurn.delete(completedReviewTurnId);
      if (currentReviewTurnId === completedReviewTurnId) currentReviewTurnId = "";
    }

    collaborations.push(...canonicalCollaboration(payload, timestamp, ownerThreadId));
    if (record?.type !== "response_item" || !payload || typeof payload !== "object") continue;
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const action = collaborationToolName(payload.name);
      const id = callId(payload);
      if (!action || !id) continue;
      const input = parseObject(payload.arguments ?? payload.input) || {};
      pendingCalls.set(id, {
        action,
        parentThreadId: ownerThreadId,
        targetReference: functionCallTarget(input),
        agentReference: safeAgentReference(input.task_name ?? input.taskName ?? input.agent_path ?? input.agentPath),
        label: titleFromIdentifier(input.task_name ?? input.taskName ?? input.nickname),
        kind: boundedText(input.agent_role ?? input.agentRole ?? input.role, MAX_ROLE_LENGTH, "subagent"),
        model: normalizedModel(input.model),
        effort: normalizedEffort(input.reasoning_effort ?? input.reasoningEffort ?? input.effort),
        timestamp,
      });
      continue;
    }
    if (payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output") continue;
    const pending = pendingCalls.get(callId(payload));
    if (!pending) continue;
    const output = functionOutputObject(payload);
    const outputThreadId = safeThreadId(output?.agent_id ?? output?.agentId ?? output?.thread_id ?? output?.threadId);
    const outputReference = safeAgentReference(
      output?.task_name ?? output?.taskName ?? output?.agent_path ?? output?.agentPath ?? output?.target,
    );
    const agentReference = pending.action === "spawn"
      ? outputReference || pending.agentReference
      : pending.targetReference || outputReference;
    const childThreadId = outputThreadId;
    if (!childThreadId && !agentReference) continue;
    collaborations.push({
      childThreadId,
      agentReference,
      referenceKind: childThreadId ? "thread" : "agentPath",
      parentThreadId: pending.parentThreadId,
      label: pending.label,
      kind: pending.kind,
      model: pending.model,
      effort: pending.effort,
      timestamp: timestamp || pending.timestamp,
      status: pending.action === "stop" ? "stopped" : pending.action === "resume" ? "active" : null,
      action: pending.action,
    });
  }

  const startedAt = timestamps.sort((left, right) => timestampValue(left) - timestampValue(right))[0]
    || codexTimestamp(fallback.createdAt)
    || codexTimestamp(fallback.updatedAt)
    || new Date(0).toISOString();
  const updatedAt = timestamps.at(-1)
    || codexTimestamp(fallback.updatedAt)
    || startedAt;
  if (terminal && terminal.order < records.length - 1) {
    const laterMeaningfulRecord = records.slice(terminal.order + 1).some((record) => (
      record?.type === "turn_context"
      || record?.type === "response_item"
      || record?.type === "event_msg"
    ));
    if (laterMeaningfulRecord) terminal = null;
  }

  return {
    localId: ownerThreadId,
    sessionId: sessionId || ownerThreadId,
    parentThreadId,
    forkedFromId,
    agentPath,
    approvalReviewer,
    agentNickname,
    agentRole,
    sourceKind,
    runtime,
    startedAt,
    updatedAt,
    durationMs: Math.max(0, timestampValue(updatedAt) - timestampValue(startedAt)),
    terminal,
    collaborations,
    reviewDecisions: approvalReviewer ? reviewDecisionFeed(reviewDecisions) : reviewDecisionFeed([]),
  };
}

export function parseCodexAgentRecords(records, fallback = {}) {
  return summaryFromRecords(Array.isArray(records) ? records : [], fallback);
}

export function readCodexAgentRollout(file, fallback = {}) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return summaryFromRecords([], fallback); }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    } catch {
      // Malformed and truncated live lines do not invalidate recognized metadata.
    }
  }
  return summaryFromRecords(records, fallback);
}

function sourceKindLabel(sourceKind, forkedFromId) {
  if (forkedFromId) return "fork";
  if (sourceKind === "subAgentReview") return "reviewer";
  if (sourceKind === "subAgentCompact") return "compaction";
  if (sourceKind === "fork") return "fork";
  return "subagent";
}

function runtimeStatus(value) {
  const type = typeof value === "string" ? value : value?.type;
  if (type === "active") return "active";
  if (type === "idle" || type === "notLoaded") return "idle";
  if (type === "systemError") return "stopped";
  return null;
}

function liveStatus(value) {
  return ["active", "waiting", "needs_input", "finished", "stopped", "idle"].includes(value) ? value : null;
}

function mergeCollaboration(previous, next) {
  if (!previous) return { ...next, startedAt: next.timestamp, updatedAt: next.timestamp };
  const nextIsLater = timestampValue(next.timestamp) >= timestampValue(previous.updatedAt);
  return {
    ...previous,
    ...(nextIsLater ? next : {}),
    label: next.label !== "Unnamed subagent" ? next.label : previous.label,
    kind: next.kind !== "subagent" ? next.kind : previous.kind,
    model: next.model !== "unknown" ? next.model : previous.model,
    effort: next.effort !== "unspecified" ? next.effort : previous.effort,
    startedAt: timestampValue(next.timestamp) < timestampValue(previous.startedAt) ? next.timestamp : previous.startedAt,
    updatedAt: laterTimestamp(previous.updatedAt, next.timestamp),
  };
}

function treeDepth(id, parentById, rootThreadId) {
  let depth = 0;
  let current = id;
  const seen = new Set();
  while (current && current !== rootThreadId && !seen.has(current)) {
    seen.add(current);
    current = parentById.get(current);
    depth += 1;
  }
  return current === rootThreadId ? depth : Number.MAX_SAFE_INTEGER;
}

export function buildCodexAgentTree({ rootThreadId, threads = [], summaries = new Map(), historical = true }) {
  if (!isSafeCodexSessionId(rootThreadId)) return [];
  const threadById = new Map();
  for (const thread of threads) {
    if (!isSafeCodexSessionId(thread?.localId)) continue;
    const previous = threadById.get(thread.localId) || {};
    threadById.set(thread.localId, { ...previous, ...thread });
  }
  if (!threadById.has(rootThreadId)) threadById.set(rootThreadId, { localId: rootThreadId });

  const threadIdsByAgentReference = new Map();
  function indexAgentReference(parentThreadId, reference, threadId) {
    if (!isSafeCodexSessionId(parentThreadId) || !isSafeCodexSessionId(threadId)) return;
    for (const alias of agentReferenceAliases(reference)) {
      const key = `${parentThreadId}\u0000${alias}`;
      const ids = threadIdsByAgentReference.get(key) || new Set();
      ids.add(threadId);
      threadIdsByAgentReference.set(key, ids);
    }
  }
  for (const [threadId, thread] of threadById) {
    if (threadId === rootThreadId) continue;
    const summary = summaries.get(threadId);
    const parentThreadId = safeThreadId(summary?.parentThreadId ?? thread?.parentThreadId);
    indexAgentReference(parentThreadId, summary?.agentPath ?? thread?.agentPath, threadId);
  }

  function resolveCollaborationThreadId(collaboration) {
    if (isSafeCodexSessionId(collaboration?.childThreadId)) return collaboration.childThreadId;
    const parentThreadId = safeThreadId(collaboration?.parentThreadId);
    const directReference = safeThreadId(collaboration?.agentReference);
    if (directReference && threadById.has(directReference)) return directReference;
    const candidates = new Set();
    for (const alias of agentReferenceAliases(collaboration?.agentReference)) {
      for (const id of threadIdsByAgentReference.get(`${parentThreadId}\u0000${alias}`) || []) candidates.add(id);
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  }

  const collaborations = new Map();
  for (const summary of summaries.values()) {
    for (const collaboration of summary?.collaborations || []) {
      const childThreadId = resolveCollaborationThreadId(collaboration);
      if (!childThreadId) continue;
      const resolved = { ...collaboration, childThreadId };
      collaborations.set(
        childThreadId,
        mergeCollaboration(collaborations.get(childThreadId), resolved),
      );
    }
  }

  for (const [childThreadId, collaboration] of collaborations) {
    if (!threadById.has(childThreadId)) threadById.set(childThreadId, {
      localId: childThreadId,
      parentThreadId: collaboration.parentThreadId,
      sourceKind: "subAgentThreadSpawn",
    });
  }

  const root = threadById.get(rootThreadId);
  const rootSessionId = safeThreadId(root.sessionId) || rootThreadId;
  const parentById = new Map([[rootThreadId, null]]);
  const remaining = new Set([...threadById.keys()].filter((id) => id !== rootThreadId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...remaining].sort()) {
      const thread = threadById.get(id);
      const summary = summaries.get(id);
      const collaboration = collaborations.get(id);
      const parent = safeThreadId(
        collaboration?.parentThreadId
        ?? summary?.parentThreadId
        ?? thread?.parentThreadId
        ?? summary?.forkedFromId
        ?? thread?.forkedFromId,
      );
      if (parent && parentById.has(parent)) {
        parentById.set(id, parent);
        remaining.delete(id);
        changed = true;
      }
    }
  }
  for (const id of [...remaining].sort()) {
    const thread = threadById.get(id);
    const summary = summaries.get(id);
    const sessionId = safeThreadId(summary?.sessionId ?? thread?.sessionId);
    if (sessionId === rootSessionId) parentById.set(id, rootThreadId);
  }

  const included = [...parentById.keys()].sort((left, right) => {
    if (left === rootThreadId) return -1;
    if (right === rootThreadId) return 1;
    const depth = treeDepth(left, parentById, rootThreadId) - treeDepth(right, parentById, rootThreadId);
    if (depth) return depth;
    const leftThread = threadById.get(left);
    const rightThread = threadById.get(right);
    const leftSummary = summaries.get(left);
    const rightSummary = summaries.get(right);
    const leftStartedAt = codexTimestamp(leftThread?.createdAt)
      || leftSummary?.startedAt
      || collaborations.get(left)?.startedAt;
    const rightStartedAt = codexTimestamp(rightThread?.createdAt)
      || rightSummary?.startedAt
      || collaborations.get(right)?.startedAt;
    const started = timestampValue(rightStartedAt) - timestampValue(leftStartedAt);
    return started || left.localeCompare(right);
  });

  return included.map((threadId) => {
    const primary = threadId === rootThreadId;
    const thread = threadById.get(threadId) || {};
    const summary = summaries.get(threadId);
    const collaboration = collaborations.get(threadId);
    const startedAt = codexTimestamp(thread.createdAt)
      || summary?.startedAt
      || collaboration?.startedAt
      || codexTimestamp(thread.updatedAt)
      || new Date(0).toISOString();
    const updatedAt = summary?.updatedAt
      || codexTimestamp(thread.updatedAt)
      || collaboration?.updatedAt
      || startedAt;
    const collaborationIsLater = collaboration?.status
      && timestampValue(collaboration.updatedAt) > timestampValue(summary?.updatedAt);
    const currentLiveStatus = liveStatus(thread.liveStatus);
    const observedStatus = currentLiveStatus || runtimeStatus(thread.runtimeStatus);
    let status = primary ? (!historical && observedStatus ? observedStatus : "idle") : null;
    if (!primary) {
      if (!historical && currentLiveStatus) status = currentLiveStatus;
      else if (observedStatus === "active") status = historical ? "idle" : "active";
      else if (collaborationIsLater) status = collaboration.status;
      else if (summary?.terminal) status = summary.terminal.status;
      else if (observedStatus) status = observedStatus;
      else if (!historical && collaboration?.status === "active") status = "active";
      else status = collaboration?.status === "finished" || collaboration?.status === "stopped"
        ? collaboration.status
        : "idle";
    }
    const sourceKind = summary?.sourceKind || thread.sourceKind || "unknown";
    const approvalReviewer = summary?.approvalReviewer === true || thread.approvalReviewer === true;
    const role = boundedText(thread.agentRole ?? summary?.agentRole, MAX_ROLE_LENGTH);
    const nickname = boundedText(thread.agentNickname ?? summary?.agentNickname, MAX_LABEL_LENGTH);
    const collaborationAssignment = collaboration?.label && collaboration.label !== "Unnamed subagent"
      ? collaboration.label
      : null;
    const assignment = primary
      ? null
      : boundedText(collaborationAssignment || thread.agentAssignment, MAX_LABEL_LENGTH) || null;
    const label = primary
      ? "Primary agent"
      : nickname
        || (approvalReviewer ? "Approval reviewer" : "")
        || (collaboration?.label !== "Unnamed subagent" ? collaboration?.label : "")
        || "Unnamed subagent";
    const kind = primary
      ? "orchestrator"
      : role || (approvalReviewer ? "approval-reviewer" : "")
        || (collaboration?.kind !== "subagent" ? collaboration?.kind : "")
        || sourceKindLabel(sourceKind, summary?.forkedFromId ?? thread.forkedFromId);
    let lastSeen = collaborationIsLater
      ? collaboration.updatedAt
      : summary?.terminal?.timestamp || updatedAt;
    if (!historical && timestampValue(thread.liveness?.observedAt) > timestampValue(lastSeen)) {
      lastSeen = thread.liveness.observedAt;
    }

    return {
      id: primary ? "primary" : `agent-${threadId}`,
      parentId: primary ? null : (parentById.get(threadId) === rootThreadId ? "primary" : `agent-${parentById.get(threadId)}`),
      assignment,
      label,
      kind,
      model: summary?.runtime?.model && summary.runtime.model !== "unknown"
        ? summary.runtime.model
        : primary ? "unknown" : collaboration?.model || "unknown",
      effort: summary?.runtime?.effort && summary.runtime.effort !== "unspecified"
        ? summary.runtime.effort
        : primary ? "unspecified" : collaboration?.effort || "unspecified",
      status,
      signal: null,
      toolCalls: 0,
      skills: [],
      executionTasks: [],
      reviewDecisions: summary?.reviewDecisions || reviewDecisionFeed([]),
      lastSeen,
      startedAt,
      updatedAt: lastSeen,
      durationMs: Math.max(0, timestampValue(lastSeen) - timestampValue(startedAt)),
      liveness: historical || !thread.liveness ? null : thread.liveness,
    };
  });
}
