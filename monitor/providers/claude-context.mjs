import crypto from "node:crypto";

const MAX_USAGE_SNAPSHOTS = 1_000;

function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function boundedIdentity(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
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

function assistantRecord(record) {
  return record?.type === "assistant";
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
  if (!usageRecord(record) || record.message.model === "<synthetic>" || record.message.usage.synthetic === true) return null;
  const usage = record.message.usage;
  const input = nonNegativeInteger(usage.input_tokens);
  const output = nonNegativeInteger(usage.output_tokens);
  const readPresent = Object.hasOwn(usage, "cache_read_input_tokens");
  const writePresent = Object.hasOwn(usage, "cache_creation_input_tokens");
  const cacheRead = readPresent ? nonNegativeInteger(usage.cache_read_input_tokens) : 0;
  const cacheWrite = writePresent ? nonNegativeInteger(usage.cache_creation_input_tokens) : 0;
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
  const total = input + output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  return { input, output, cacheRead, cacheWrite, cacheComparable: readPresent };
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

const CACHE_MISS_REASONS = new Set(["model_changed", "system_changed", "tools_changed", "messages_changed"]);
const REMOTE_CONTROL_ACTIVE_PREFIX = "/remote-control is active";
const MAX_BRIDGE_STATUS_DISTANCE = 12;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizedCacheMissReason(record) {
  const value = record?.message?.diagnostics?.cache_miss_reason?.type;
  return typeof value === "string" && CACHE_MISS_REASONS.has(value) ? value : null;
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

function assistantIdentity(record) {
  return assistantRecord(record)
    ? boundedIdentity(record.message?.id ?? record.requestId ?? record.uuid)
    : "";
}

function assistantRequestIdentity(record) {
  return assistantRecord(record)
    ? boundedIdentity(record.requestId ?? record.message?.id ?? record.uuid)
    : "";
}

function structuredContent(record) {
  return Array.isArray(record?.message?.content) ? record.message.content : [];
}

function structuredToolUseIds(record) {
  return structuredContent(record)
    .filter((block) => plainObject(block) && block.type === "tool_use")
    .map((block) => boundedIdentity(block.id))
    .filter(Boolean);
}

function structuredToolResultIds(record) {
  if (record?.type !== "user") return [];
  const content = structuredContent(record);
  if (content.length === 0 || content.some((block) => !plainObject(block) || block.type !== "tool_result")) return [];
  return content.map((block) => boundedIdentity(block.tool_use_id)).filter(Boolean);
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

/**
 * Recognize a bounded transcript sequence around a provider-owned task
 * notification. This records observed structure, not the notification as the
 * authoritative cause of the provider's cache divergence.
 */
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

    // Any other user message interrupts the structural chain.
    candidate = null;
    toolUseIds.clear();
    matchedToolResult = false;
  }
  return sequences;
}

function normalizedBridgeSession(record, expectedSessionId) {
  const sessionId = boundedIdentity(record?.sessionId);
  const bridgeSessionId = boundedIdentity(record?.bridgeSessionId);
  return record?.type === "bridge-session"
    && sessionId.length > 0
    && sessionId === expectedSessionId
    && bridgeSessionId.length > 0
    && sessionId !== bridgeSessionId
    && Number.isSafeInteger(record.lastSequenceNum)
    && record.lastSequenceNum >= 0
    ? { sessionId, bridgeSessionId, sequence: record.lastSequenceNum }
    : null;
}

function remoteControlActiveRecord(record) {
  return record?.type === "system"
    && record.subtype === "bridge_status"
    && typeof record.content === "string"
    && record.content.startsWith(REMOTE_CONTROL_ACTIVE_PREFIX);
}

function inferredToolChangeCauses(records, completeHistory, expectedSessionId) {
  const causes = new Map();
  if (!completeHistory || !Array.isArray(records) || !expectedSessionId) return causes;
  let lastAssistantId = "";
  let distinctAssistantRequests = 0;
  let sawBridgeSession = false;
  let candidate = null;

  for (const [index, record] of records.entries()) {
    const identity = assistantIdentity(record);
    if (identity && identity !== lastAssistantId) {
      lastAssistantId = identity;
      distinctAssistantRequests = Math.min(1_000, distinctAssistantRequests + 1);
      if (candidate?.active && identity !== candidate.activationRequestId) {
        if (!candidate.targetRequestId) candidate.targetRequestId = identity;
        else if (candidate.targetRequestId !== identity) candidate = null;
      }
    }

    const bridgeSession = normalizedBridgeSession(record, expectedSessionId);
    if (bridgeSession) {
      if (!sawBridgeSession) {
        sawBridgeSession = true;
        if (distinctAssistantRequests > 0) candidate = {
          active: false,
          activationRequestId: "",
          bridgeCount: 1,
          bridgeSessionId: bridgeSession.bridgeSessionId,
          lastBridgeSequence: bridgeSession.sequence,
          firstBridgeIndex: index,
          targetRequestId: "",
          turnBoundaryObserved: false,
        };
      } else if (candidate && candidate.bridgeSessionId === bridgeSession.bridgeSessionId) {
        if (candidate.active
          && candidate.turnBoundaryObserved
          && bridgeSession.sequence >= candidate.lastBridgeSequence) {
          candidate.bridgeCount += 1;
          candidate.lastBridgeSequence = bridgeSession.sequence;
          candidate.turnBoundaryObserved = false;
        } else if (bridgeSession.sequence < candidate.lastBridgeSequence) {
          candidate = null;
        }
      } else {
        candidate = null;
      }
      continue;
    }

    if (candidate?.active
      && record?.type === "last-prompt"
      && boundedIdentity(record.sessionId) === expectedSessionId) {
      candidate.turnBoundaryObserved = true;
      continue;
    }

    if (record?.type === "system" && record.subtype === "bridge_status") {
      if (remoteControlActiveRecord(record)
        && candidate
        && index - candidate.firstBridgeIndex <= MAX_BRIDGE_STATUS_DISTANCE
        && lastAssistantId) {
        candidate.active = true;
        candidate.activationRequestId = lastAssistantId;
      } else {
        candidate = null;
      }
      continue;
    }

    if (identity
      && candidate?.active
      && candidate.bridgeCount >= 2
      && identity === candidate.targetRequestId
      && normalizedCacheMissReason(record) === "tools_changed") {
      causes.set(identity, "remote_control_connected");
    }
  }
  return causes;
}

function laterEvidence(previous, next) {
  if (!previous) return next;
  const previousTime = Date.parse(previous.timestamp || "");
  const nextTime = Date.parse(next.timestamp || "");
  return Number.isFinite(nextTime) && (!Number.isFinite(previousTime) || nextTime >= previousTime) ? next : previous;
}

export function parseClaudeContextRecords(records, options = {}) {
  const actorId = boundedIdentity(options.actorId) || "primary";
  const sourceKey = boundedIdentity(options.sourceKey) || actorId;
  const expectedSessionId = boundedIdentity(options.expectedSessionId);
  const fallbackTimestamp = validTimestamp(options.fallbackTimestamp);
  const snapshots = new Map();
  const toolChangeCauses = inferredToolChangeCauses(records, options.completeHistory === true, expectedSessionId);
  const messageChangeSequences = inferredMessageChangeSequences(records, options.completeHistory === true);
  let comparisonGroup = 0;

  for (const record of Array.isArray(records) ? records : []) {
    if (!assistantRecord(record)) continue;
    const usage = normalizedUsage(record);
    const observedTimestamp = validTimestamp(record.timestamp ?? record.message?.timestamp);
    const timestamp = observedTimestamp || fallbackTimestamp;
    if (!usage || !timestamp) {
      comparisonGroup += 1;
      continue;
    }
    if (!usage.cacheComparable || !observedTimestamp) comparisonGroup += 1;
    const providerIdentity = boundedIdentity(record.message.id ?? record.requestId ?? record.uuid);
    const dedupeId = providerIdentity
      ? `${sourceKey}:message:${providerIdentity}`
      : `${sourceKey}:fallback-${fallbackIdentity(observedTimestamp || "unobserved", boundedModel(record.message.model), usage)}`;
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
      cacheToolChangeCause: toolChangeCauses.get(providerIdentity) || null,
      cacheMessageChangeSequence: messageChangeSequences.get(providerIdentity) || null,
    };
    snapshots.set(dedupeId, laterEvidence(snapshots.get(dedupeId), snapshot));
    if (!snapshot.cacheComparable) comparisonGroup += 1;
  }

  return [...snapshots.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId))
    .slice(-MAX_USAGE_SNAPSHOTS);
}
