import crypto from "node:crypto";
import { normalizedRequestWork } from "../../normalize/request-work.mjs";
import { toolWorkKind } from "../../normalize/work-kind.mjs";
import { safeDetail } from "./tool-detail.mjs";
import { mergeClaudeRequestFragments } from "./activity-correlation.mjs";
import { claudeReplyActivityId, userInputContentType } from "./activity-events.mjs";
import { inferredToolChangeCauses } from "./tool-change-attribution.mjs";
import {
  CACHE_MISS_REASONS, assistantIdentity, assistantRecord, boundedIdentity, normalizedCacheMissReason, plainObject, structuredContent, structuredToolResultIds,
} from "./record-shapes.mjs";

const MAX_USAGE_SNAPSHOTS = 1_000;
const MAX_INPUT_CHAIN_RECORDS = 4_096;
const MAX_INPUT_CHAIN_DEPTH = 256;
const MAX_SHAPE_STRING_LENGTH = 160;
// A usage-evidence copy carries a tool use's work kind instead of its input. JSON cannot set a symbol key.
const USAGE_EVIDENCE_WORK_KIND = Symbol("claudeUsageEvidenceWorkKind");
const USAGE_EVIDENCE_RECORD_FIELDS = ["type", "subtype", "timestamp", "uuid", "parentUuid", "requestId", "isMeta", "isCompactSummary", "isSidechain", "promptSource"];
const USAGE_EVIDENCE_MESSAGE_FIELDS = ["id", "model", "usage", "diagnostics", "timestamp"];

function shapeString(value) {
  return typeof value === "string" ? value.slice(0, MAX_SHAPE_STRING_LENGTH) : undefined;
}

// Only the block structure the request parser reads: type, identities, tool name, media type,
// and whether text is present. Text, tool input, and tool-result content are never kept.
function usageEvidenceBlock(block) {
  if (!plainObject(block)) return null;
  const shape = { type: shapeString(block.type) };
  for (const key of ["id", "tool_use_id", "name", "media_type", "mime_type"]) {
    const value = shapeString(block[key]);
    if (value !== undefined) shape[key] = value;
  }
  const sourceMediaType = shapeString(block.source?.media_type);
  if (sourceMediaType !== undefined) shape.source = { media_type: sourceMediaType };
  if (block.type === "text") shape.text = typeof block.text === "string" && block.text.trim() ? "text" : "";
  if (block.type === "tool_use") {
    const tool = block.name || "Tool";
    const input = plainObject(block.input) ? block.input : {};
    shape[USAGE_EVIDENCE_WORK_KIND] = toolWorkKind(tool, { detail: safeDetail(tool, input), input });
  }
  return shape;
}

/**
 * A content-free copy of a Claude record that parses to the same request snapshots, so a
 * whole-transcript pass can retain every request without retaining prompts, responses, or tool content.
 */
export function claudeUsageEvidenceRecord(record) {
  if (!plainObject(record)) return null;
  const copy = {};
  for (const key of USAGE_EVIDENCE_RECORD_FIELDS) if (Object.hasOwn(record, key)) copy[key] = record[key];
  if (plainObject(record.origin)) copy.origin = { kind: shapeString(record.origin.kind) };
  if (Array.isArray(record.attachments)) copy.attachments = record.attachments.map(usageEvidenceBlock);
  if (plainObject(record.message)) {
    const message = {};
    for (const key of USAGE_EVIDENCE_MESSAGE_FIELDS) if (Object.hasOwn(record.message, key)) message[key] = record.message[key];
    const content = record.message.content;
    if (typeof content === "string") message.content = content.trim() ? "text" : "";
    else if (Array.isArray(content)) message.content = content.map(usageEvidenceBlock);
    if (Array.isArray(record.message.attachments)) message.attachments = record.message.attachments.map(usageEvidenceBlock);
    copy.message = message;
  }
  return copy;
}

function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function boundedModel(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
}

function fallbackIdentity(timestamp, model, usage) {
  const identity = JSON.stringify([
    timestamp,
    model,
    usage.input,
    usage.output,
    usage.cacheWrite,
    usage.cacheRead,
  ]);
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

// Provider-owned records written before a request is sent: tool results, user input, attachments.
function requestInputRecord(record) {
  return record?.type === "user" || record?.type === "attachment";
}

function usageRecord(record) {
  return assistantRecord(record)
    && record.message
    && typeof record.message === "object"
    && !Array.isArray(record.message)
    && record.message.usage
    && typeof record.message.usage === "object"
    && !Array.isArray(record.message.usage);
}

function normalizedUsage(record) {
  // Known non-request records are different from requests with broken evidence.
  // Only the latter interrupt cache comparability; zero usage alone is not synthetic.
  if (plainObject(record?.message) && (record.message.model === "<synthetic>"
    || (plainObject(record.message.usage) && record.message.usage.synthetic === true))) {
    return { kind: "synthetic" };
  }
  if (!usageRecord(record)) return { kind: "invalid" };
  const usage = record.message.usage;
  const input = nonNegativeInteger(usage.input_tokens);
  const output = nonNegativeInteger(usage.output_tokens);
  const readPresent = Object.hasOwn(usage, "cache_read_input_tokens");
  const writePresent = Object.hasOwn(usage, "cache_creation_input_tokens");
  const cacheRead = readPresent ? nonNegativeInteger(usage.cache_read_input_tokens) : 0;
  const cacheWrite = writePresent ? nonNegativeInteger(usage.cache_creation_input_tokens) : 0;
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return { kind: "invalid" };
  const total = input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(total) || total <= 0) return { kind: "invalid" };
  return { kind: "request", input, output, cacheRead, cacheWrite, cacheComparable: readPresent };
}

function normalizedCacheLifetime(record, cacheWrite) {
  const creation = record?.message?.usage?.cache_creation;
  if (!creation || typeof creation !== "object" || Array.isArray(creation)) return null;
  const fiveMinute = nonNegativeInteger(creation.ephemeral_5m_input_tokens);
  const oneHour = nonNegativeInteger(creation.ephemeral_1h_input_tokens);
  if (fiveMinute === null || oneHour === null || fiveMinute + oneHour !== cacheWrite) return null;
  if (fiveMinute > 0 && oneHour > 0) return "mixed";
  if (oneHour > 0) return "1h";
  if (fiveMinute > 0) return "5m";
  return null;
}

function normalizedCacheMissProviderStatus(record) {
  return record?.message?.diagnostics?.cache_miss_reason?.type === "previous_message_not_found"
    ? "previous_cache_entry_unavailable"
    : null;
}

function normalizedCacheMissDiagnosticState(record) {
  const diagnostics = record?.message?.diagnostics;
  if (diagnostics === undefined || diagnostics === null) return "absent";
  if (!plainObject(diagnostics)) return "inconclusive";
  if (!Object.hasOwn(diagnostics, "cache_miss_reason")) return "absent";
  const cacheMissReason = diagnostics.cache_miss_reason;
  if (!plainObject(cacheMissReason) || typeof cacheMissReason.type !== "string") return "inconclusive";
  if (CACHE_MISS_REASONS.has(cacheMissReason.type)) return "recognized_reason";
  if (cacheMissReason.type === "previous_message_not_found") return "previous_cache_entry_unavailable";
  return "inconclusive";
}

function assistantRequestIdentity(record) {
  return assistantRecord(record)
    ? boundedIdentity(record.requestId ?? record.message?.id ?? record.uuid)
    : "";
}

function structuredToolUseIds(record) {
  return structuredContent(record)
    .filter((block) => plainObject(block) && block.type === "tool_use")
    .map((block) => boundedIdentity(block.id))
    .filter(Boolean);
}

function providerTaskNotification(record) {
  return record?.type === "user"
    && record.isMeta === true
    && plainObject(record.origin)
    && record.origin.kind === "task-notification";
}

function directlyParentedTo(record, notificationId) {
  const parentId = boundedIdentity(record?.parentUuid);
  return !notificationId || !parentId || parentId === notificationId;
}

function inferredMessageChangeSequences(records, completeHistory) {
  const sequences = new Map();
  if (!completeHistory || !Array.isArray(records)) return sequences;
  const toolUseIds = new Set();
  let matchedToolResult = false;
  let lastAssistantRequestId = "";
  let candidate = null;

  for (const record of records) {
    if (assistantRecord(record)) {
      const requestId = assistantRequestIdentity(record);
      const isDistinctRequest = Boolean(requestId) && requestId !== lastAssistantRequestId;
      if (isDistinctRequest) lastAssistantRequestId = requestId;

      if (candidate && isDistinctRequest) {
        if (!candidate.targetRequestId) {
          candidate.targetRequestId = requestId;
          candidate.directParent = directlyParentedTo(record, candidate.notificationId);
        } else if (candidate.targetRequestId !== requestId) {
          candidate = null;
        }
      }

      if (candidate
        && candidate.targetRequestId === requestId
        && candidate.directParent
        && normalizedCacheMissReason(record) === "messages_changed") {
        const providerIdentity = boundedIdentity(record.message?.id ?? record.requestId ?? record.uuid);
        if (providerIdentity) sequences.set(providerIdentity, "post_tool_task_notification_resume");
      }

      for (const toolUseId of structuredToolUseIds(record)) toolUseIds.add(toolUseId);
      continue;
    }

    if (record?.type !== "user") continue;
    if (providerTaskNotification(record)) {
      candidate = matchedToolResult ? {
        notificationId: boundedIdentity(record.uuid),
        targetRequestId: "",
        directParent: false,
      } : null;
      toolUseIds.clear();
      matchedToolResult = false;
      continue;
    }

    const toolResultIds = structuredToolResultIds(record);
    if (toolResultIds.length > 0 && toolResultIds.every((id) => toolUseIds.has(id))) {
      matchedToolResult = true;
      continue;
    }

    candidate = null;
    toolUseIds.clear();
    matchedToolResult = false;
  }
  return sequences;
}

// The user-input records a request answers: every one on the request's recorded parent chain back
// to the previous assistant record. Recorded linkage only; transcript order and timing never link.
function precedingUserInputIds(inputChain, parentUuid) {
  const ids = [];
  let cursor = parentUuid;
  for (let depth = 0; depth < MAX_INPUT_CHAIN_DEPTH && typeof cursor === "string" && inputChain.has(cursor); depth += 1) {
    const link = inputChain.get(cursor);
    if (link.input) ids.push(cursor);
    cursor = link.parent;
  }
  return ids;
}

export function parseClaudeContextRecords(records, options = {}) {
  const actorId = boundedIdentity(options.actorId) || "primary";
  const sourceKey = boundedIdentity(options.sourceKey) || actorId;
  const expectedSessionId = boundedIdentity(options.expectedSessionId);
  const fallbackTimestamp = validTimestamp(options.fallbackTimestamp);
  const snapshots = new Map();
  // Decided from complete history, either this record list or the caller's whole-transcript pass; a bounded
  // window alone never creates an attribution. A subagent's own transcript flags every record as a sidechain.
  const toolChangeCauses = options.toolChangeCauses instanceof Map ? options.toolChangeCauses
    : options.completeHistory === true ? inferredToolChangeCauses(records, { expectedSessionId, inlineSidechains: actorId === "primary" }) : new Map();
  const messageChangeSequences = inferredMessageChangeSequences(records, options.completeHistory === true);
  // The adapter calls this parser separately for each transcript's resolved actor.
  // Raw record agent IDs must not override that ownership.
  const pendingResults = new Map();
  const issuedKinds = new Map();
  const compactionTimes = (Array.isArray(options.compactionTimestamps) ? options.compactionTimestamps : [])
    .map((timestamp) => Date.parse(timestamp)).filter(Number.isFinite).sort((left, right) => left - right);
  let previousAssistantTime = -Infinity;
  let comparisonGroup = 0;
  // Only the main transcript records user input; a subagent's first user record is its task prompt.
  const linksUserInput = actorId === "primary";
  const inputChain = new Map();
  const requestedInputIds = new Set();
  // Normalization must not create a match: only an unaltered recorded identity joins the chain.
  const chainRecord = (record, input) => {
    if (!linksUserInput || typeof record?.uuid !== "string" || boundedIdentity(record.uuid) !== record.uuid) return;
    inputChain.set(record.uuid, { parent: record.parentUuid, input });
    if (inputChain.size > MAX_INPUT_CHAIN_RECORDS) inputChain.delete(inputChain.keys().next().value);
  };

  let inputRecordedAt = null;
  let sawAssistantRecord = false;

  for (const record of Array.isArray(records) ? records : []) {
    if (!assistantRecord(record)) chainRecord(record, Boolean(userInputContentType(record, requestedInputIds)));
    if (requestInputRecord(record)) inputRecordedAt = validTimestamp(record.timestamp ?? record.message?.timestamp);
    else if (inputRecordedAt && !assistantRecord(record)) inputRecordedAt = validTimestamp(record?.timestamp) || inputRecordedAt;
    if (record?.type === "user") {
      for (const block of structuredContent(record)) {
        if (!plainObject(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string" || !block.tool_use_id) continue;
        const kind = issuedKinds.get(block.tool_use_id) || "shell";
        pendingResults.set(kind, Math.min(999, (pendingResults.get(kind) || 0) + 1));
      }
    }
    if (!assistantRecord(record)) continue;
    const recordedInputAt = inputRecordedAt;
    inputRecordedAt = null;
    // A bounded window can open on a later fragment of a request, after the mid-answer record that
    // precedes it; that record is not when the request was sent. A complete read opens at its start.
    const opensWindow = options.completeHistory !== true && !sawAssistantRecord;
    sawAssistantRecord = true;
    const issued = new Map();
    const issuedTools = [];
    for (const block of structuredContent(record)) {
      if (!plainObject(block) || block.type !== "tool_use") continue;
      const tool = block.name || "Tool";
      const input = plainObject(block.input) ? block.input : {};
      const kind = typeof block[USAGE_EVIDENCE_WORK_KIND] === "string" ? block[USAGE_EVIDENCE_WORK_KIND]
        : toolWorkKind(tool, { detail: safeDetail(tool, input), input });
      issued.set(kind, Math.min(999, (issued.get(kind) || 0) + 1));
      if (typeof block.id === "string" && block.id) issuedKinds.set(block.id, kind);
      if (boundedIdentity(block.id)) issuedTools.push({ id: boundedIdentity(block.id), kind });
      if (linksUserInput && tool === "AskUserQuestion" && typeof block.id === "string" && block.id) requestedInputIds.add(block.id);
    }
    const usage = normalizedUsage(record);
    const observedTimestamp = validTimestamp(record.timestamp ?? record.message?.timestamp);
    const timestamp = observedTimestamp || fallbackTimestamp;
    const assistantTime = Date.parse(observedTimestamp || "");
    if (!Number.isFinite(assistantTime) || compactionTimes.some((time) => time > previousAssistantTime && time <= assistantTime)) {
      pendingResults.clear();
    }
    // Advance only with observed time; fallback filesystem times cannot establish adjacency.
    if (Number.isFinite(assistantTime)) previousAssistantTime = assistantTime;
    // An assistant record that yields no request (a provider error, say) does not end the chain,
    // so the request that retries it still answers the same input.
    if (usage.kind === "synthetic") { chainRecord(record, false); continue; }
    if (usage.kind === "invalid" || !timestamp) {
      chainRecord(record, false);
      comparisonGroup += 1;
      continue;
    }
    if (!usage.cacheComparable || !observedTimestamp) comparisonGroup += 1;
    // Recorded send time: the input record just before the first fragment. It is a record time, never a
    // file time, and it cannot follow the answer it precedes. Absent when no such record is recorded.
    const requestSentAt = !opensWindow && recordedInputAt && observedTimestamp && Date.parse(recordedInputAt) <= assistantTime
      ? recordedInputAt : null;
    const providerIdentity = boundedIdentity(record.message.id ?? record.requestId ?? record.uuid);
    const dedupeId = providerIdentity
      ? `${sourceKey}:message:${providerIdentity}`
      : `${sourceKey}:fallback-${fallbackIdentity(observedTimestamp || "unobserved", boundedModel(record.message.model), usage)}`;
    const toolChange = toolChangeCauses.get(providerIdentity);
    const snapshot = {
      dedupeId,
      actorId,
      timestamp,
      input: usage.input,
      output: usage.output,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead,
      model: boundedModel(record.message.model),
      comparisonGroup,
      cacheComparable: usage.cacheComparable && Boolean(observedTimestamp),
      cacheLifetime: normalizedCacheLifetime(record, usage.cacheWrite),
      cacheMissReason: normalizedCacheMissReason(record),
      cacheMissProviderStatus: normalizedCacheMissProviderStatus(record),
      // Monitor-private evidence state. Cache-event serialization never exposes it.
      cacheMissDiagnosticState: normalizedCacheMissDiagnosticState(record),
      cacheToolChangeCause: toolChange?.cause || null,
      ...(toolChange?.added ? { cacheToolChangeAddedDefinitionCount: toolChange.added } : {}),
      cacheMessageChangeSequence: messageChangeSequences.get(providerIdentity) || null,
      // Monitor-private, optional. Only the first fragment of a request records it.
      ...(requestSentAt ? { requestSentAt } : {}),
      precedingWork: Array.isArray(record.message.content)
        ? normalizedRequestWork([...pendingResults].map(([kind, count]) => ({ kind, count }))) : [],
      issuedWork: normalizedRequestWork([...issued].map(([kind, count]) => ({ kind, count }))),
      issuedToolUseIds: issuedTools.map(({ id }) => id),
      issuedToolUseKinds: issuedTools,
      // Only an exact identity can link a reply; normalization must not create a match.
      replyActivityId: providerIdentity && providerIdentity === (record.message.id ?? record.requestId ?? record.uuid)
        ? claudeReplyActivityId(actorId, providerIdentity) : null,
      precedingUserInputIds: linksUserInput ? precedingUserInputIds(inputChain, record.parentUuid) : [],
    };
    pendingResults.clear();
    snapshots.set(dedupeId, mergeClaudeRequestFragments(snapshots.get(dedupeId), snapshot));
    if (!snapshot.cacheComparable) comparisonGroup += 1;
  }

  return [...snapshots.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId))
    .slice(options.unlimited === true ? 0 : -MAX_USAGE_SNAPSHOTS)
    .map((snapshot) => {
      if (options.includeToolUseIds === true) return snapshot;
      const normalized = { ...snapshot };
      delete normalized.issuedToolUseIds;
      delete normalized.issuedToolUseKinds;
      delete normalized.replyActivityId;
      delete normalized.precedingUserInputIds;
      return normalized;
    });
}
