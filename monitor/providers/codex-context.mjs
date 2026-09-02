import fs from "node:fs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveInteger(value) {
  const number = nonNegativeInteger(value);
  return number !== null && number > 0 ? number : null;
}

function boundedIdentity(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
}

function normalizedType(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MAX_USAGE_SNAPSHOTS = 1_000;

function boundedModel(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
}

function isTokenCountRecord(record) {
  return normalizedType(record?.type) === "tokencount"
    || normalizedType(record?.payload?.type) === "tokencount";
}

function modelFromContextRecord(record) {
  const type = normalizedType(record?.type);
  if (!["turncontext", "threadsettings", "threadsettingsupdated"].includes(type)) return null;
  const payload = record?.payload && typeof record.payload === "object" ? record.payload : {};
  const settings = payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
  return Object.hasOwn(settings, "model") ? boundedModel(settings.model) : null;
}

function cacheLifetimeForModel(model) {
  // Documented model-policy minimum, not a recorded expiry or an API retention
  // setting. Keep the family allowlist explicit; unknown future models fail closed.
  return /^gpt-5\.6(?:-(?:sol|terra|luna|pro|cyber))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
    ? "30m+"
    : null;
}

function recordTimestamp(record, fallbackTimestamp) {
  return codexTimestamp(record?.timestamp ?? record?.payload?.timestamp) || codexTimestamp(fallbackTimestamp);
}

function explicitCompactionTrigger(value) {
  const trigger = normalizedType(value);
  if (trigger === "auto" || trigger === "automatic") return "auto";
  if (trigger === "manual") return "manual";
  return null;
}

function compactionTriggerEvidence(...objects) {
  const observed = [];
  for (const object of objects) {
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    for (const key of ["trigger", "compaction_trigger", "compactionTrigger"]) {
      if (!Object.hasOwn(object, key)) continue;
      const trigger = explicitCompactionTrigger(object[key]);
      if (!trigger) return { present: true, trigger: null };
      observed.push(trigger);
    }
  }
  if (new Set(observed).size > 1) return { present: true, trigger: null };
  return { present: observed.length > 0, trigger: observed[0] || null };
}

function compactionPayload(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload
    : {};
  const outerType = normalizedType(record.type);
  const payloadType = normalizedType(payload.type);
  if (outerType === "eventmsg" && payloadType === "contextcompacted") {
    const hasBoundaryMetadata = [
      "compactMetadata", "compact_metadata", "trigger", "compaction_trigger", "compactionTrigger",
      "pre_tokens", "preTokens", "pre_compaction_tokens", "preCompactionTokens",
    ].some((key) => Object.hasOwn(payload, key));
    if (!hasBoundaryMetadata) return null;
  }
  if (![outerType, payloadType].some((type) => [
    "compactboundary",
    "compacted",
    "compaction",
    "contextcompacted",
    "contextcompaction",
    "threadcompacted",
  ].includes(type))) return null;
  return payload;
}

function payloadType(record) {
  return normalizedType(record?.payload?.type);
}

function isTaskEvent(record, type) {
  return normalizedType(record?.type) === "eventmsg" && payloadType(record) === type;
}

function isContextCompactionCompletion(record) {
  return (isTaskEvent(record, "itemcompleted")
      && normalizedType(record?.payload?.item?.type) === "contextcompaction")
    || isTaskEvent(record, "contextcompacted");
}

function isWindowedCompactionRecord(record) {
  if (normalizedType(record?.type) !== "compacted") return false;
  const payload = record?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const hasWindowNumber = Object.hasOwn(payload, "window_number") || Object.hasOwn(payload, "windowNumber");
  const hasReplacementHistory = Object.hasOwn(payload, "replacement_history") || Object.hasOwn(payload, "replacementHistory");
  return hasWindowNumber && hasReplacementHistory;
}

function inferredWindowedCompaction(records, index) {
  const record = records[index];
  if (!isWindowedCompactionRecord(record)) return { trigger: null, preTokens: null };

  const previous = records[index - 1];
  const following = records.slice(index + 1, index + 9);
  const completionIndex = following.findIndex(isContextCompactionCompletion);
  if (completionIndex < 0) return { trigger: null, preTokens: null };

  const beforeCompletion = following.slice(0, completionIndex);
  const afterCompletion = following.slice(completionIndex + 1);
  if (
    isTaskEvent(previous, "taskstarted")
    && isTaskEvent(afterCompletion[0], "taskcomplete")
  ) return { trigger: "manual", preTokens: null };

  const resetContextIndex = beforeCompletion.findIndex((candidate) => normalizedType(candidate?.type) === "turncontext");
  let activeTask = false;
  for (const candidate of records.slice(0, index)) {
    if (isTaskEvent(candidate, "taskstarted")) activeTask = true;
    if (isTaskEvent(candidate, "taskcomplete")) activeTask = false;
  }
  const priorUsage = [...records.slice(Math.max(0, index - 8), index)]
    .reverse()
    .map(usageFromRecord)
    .find(Boolean) || null;
  if (
    (isTokenCountRecord(previous) || activeTask)
    && priorUsage
    && resetContextIndex > 0
    && normalizedType(beforeCompletion[resetContextIndex - 1]?.type) === "worldstate"
    && !beforeCompletion.some((candidate) => isTaskEvent(candidate, "taskcomplete"))
    && afterCompletion.length > 0
    && !isTaskEvent(afterCompletion[0], "taskcomplete")
  ) {
    return {
      trigger: "auto",
      preTokens: priorUsage.totalTokens,
    };
  }

  return { trigger: null, preTokens: null };
}

function eventIdentity(record, info) {
  return boundedIdentity(
    record?.id
    ?? record?.event_id
    ?? record?.eventId
    ?? record?.message_id
    ?? record?.messageId
    ?? record?.payload?.id
    ?? record?.payload?.event_id
    ?? record?.payload?.eventId
    ?? record?.payload?.message_id
    ?? record?.payload?.messageId
    ?? info?.id
    ?? info?.event_id
    ?? info?.eventId
    ?? info?.message_id
    ?? info?.messageId,
  );
}

function optionalAliasedInteger(object, keys) {
  const values = keys
    .filter((key) => Object.hasOwn(object, key))
    .map((key) => nonNegativeInteger(object[key]));
  if (!values.length) return { present: false, value: 0 };
  if (values.some((value) => value === null) || values.some((value) => value !== values[0])) {
    return { present: true, value: null };
  }
  return { present: true, value: values[0] };
}

function recordedCount(object, keys, absent = null) {
  const values = keys.filter((key) => Object.hasOwn(object, key)).map((key) => object[key]);
  if (!values.length) return absent;
  return values.every((value) => Number.isSafeInteger(value) && value >= 0 && value === values[0])
    ? values[0] : null;
}

function usageFromRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload
    : {};
  if (normalizedType(record.type) !== "tokencount" && normalizedType(payload.type) !== "tokencount") return null;
  const info = payload.info && typeof payload.info === "object" && !Array.isArray(payload.info)
    ? payload.info
    : payload;
  const usage = info.last_token_usage ?? info.lastTokenUsage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage) || usage.synthetic === true || info.synthetic === true) {
    return null;
  }

  const rawInput = nonNegativeInteger(usage.input_tokens ?? usage.inputTokens) ?? 0;
  const cachedInput = optionalAliasedInteger(usage, ["cached_input_tokens", "cachedInputTokens"]);
  if (cachedInput.present && cachedInput.value === null) return null;
  const rawCached = cachedInput.value;
  const cacheRead = Math.min(rawInput, rawCached);
  const rawCacheWrite = nonNegativeInteger(
    usage.cache_creation_input_tokens
    ?? usage.cacheCreationInputTokens
    ?? usage.cache_write_input_tokens
    ?? usage.cacheWriteInputTokens,
  ) ?? 0;
  const cacheWrite = Math.min(rawCacheWrite, Math.max(0, rawInput - cacheRead));
  const output = nonNegativeInteger(usage.output_tokens ?? usage.outputTokens) ?? 0;
  const reasoningOutput = Math.min(
    output,
    nonNegativeInteger(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens) ?? 0,
  );
  const input = Math.max(0, rawInput - cacheRead - cacheWrite);
  const componentTotal = input + output + cacheWrite + cacheRead;
  if (componentTotal === 0) return null;

  // Context normalization remains compatible with older records. Read-drop
  // inference additionally requires explicit, uncoerced and unclamped counts.
  const recordedInput = recordedCount(usage, ["input_tokens", "inputTokens"]);
  const recordedRead = recordedCount(usage, ["cached_input_tokens", "cachedInputTokens"]);
  const recordedWrite = recordedCount(usage, [
    "cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_input_tokens", "cacheWriteInputTokens",
  ]);
  const cacheReadComparable = recordedInput !== null && recordedInput > 0
    && recordedInput === rawInput && recordedRead !== null && recordedRead === cacheRead
    && recordedWrite !== null && recordedWrite === cacheWrite
    && Number.isSafeInteger(componentTotal);

  return {
    info,
    input,
    output,
    cacheWrite,
    cacheRead,
    cacheReadComparable,
    reasoningOutput,
    totalTokens: nonNegativeInteger(usage.total_tokens ?? usage.totalTokens) ?? componentTotal,
    modelContextWindow: positiveInteger(info.model_context_window ?? info.modelContextWindow),
  };
}

function laterEvidence(previous, next) {
  if (!previous) return next;
  const previousTime = Date.parse(previous.timestamp || "");
  const nextTime = Date.parse(next.timestamp || "");
  return Number.isFinite(nextTime) && (!Number.isFinite(previousTime) || nextTime >= previousTime) ? next : previous;
}

/** Keep proven context when the same immutable request is reread in a smaller tail. */
export function mergeCodexContextSnapshot(previous, next) {
  if (!previous || previous.cacheReadComparable !== true || next.cacheReadComparable !== true
    || !sameRecordedUsage(previous, next)
    || (next.model && previous.model !== next.model)) return next;
  if (!next.model || (!next.cacheReadPreviousAt && previous.cacheReadPreviousAt)) {
    return {
      ...next,
      model: previous.model,
      comparisonGroup: previous.comparisonGroup,
      cacheLifetime: previous.cacheLifetime,
      cacheReadPreviousAt: previous.cacheReadPreviousAt ?? null,
    };
  }
  return next;
}

function sameRecordedUsage(previous, next) {
  return ["actorId", "dedupeId", "timestamp", "input", "output", "cacheRead", "cacheWrite"]
    .every((key) => previous[key] === next[key]);
}

function stableFallbackIdentity({ timestamp, input, output, cacheWrite, cacheRead, reasoningOutput }) {
  return `${timestamp}:${input}:${output}:${cacheWrite}:${cacheRead}:${reasoningOutput}`;
}

export function parseCodexContextRecords(records, options = {}) {
  const recordList = Array.isArray(records) ? records : [];
  const actorId = boundedIdentity(options.actorId) || "primary";
  const sourceKey = boundedIdentity(options.sourceKey) || actorId;
  // Supplied only for verified continuous sources. Context is recovered at an
  // exact overlapping record, never from a latest-session/model guess.
  const retained = new Map((options.priorUsageSnapshots || [])
    .filter((snapshot) => snapshot.actorId === actorId).map((snapshot) => [snapshot.dedupeId, snapshot]));
  const snapshots = new Map();
  const compactions = new Map();
  const tokenCountsByTurn = new Map();
  let turnId = "turn";
  let model = "";
  let sawModelContext = false;
  let comparisonGroup = 0;
  let sawTurn = false;
  let turnHasUsage = false;
  let cacheReadPreviousAt = null;

  for (const [recordIndex, record] of recordList.entries()) {
    if (normalizedType(record?.type) === "turncontext") {
      if (sawTurn && !turnHasUsage) {
        comparisonGroup += 1;
        cacheReadPreviousAt = null;
      }
      sawTurn = true;
      turnHasUsage = false;
      turnId = boundedIdentity(record?.payload?.turn_id ?? record?.payload?.turnId) || turnId;
    }
    const recordedModel = modelFromContextRecord(record);
    if (recordedModel !== null) {
      model = recordedModel;
      sawModelContext = true;
    }
    const timestamp = recordTimestamp(record, options.fallbackTimestamp);
    const normalizedUsage = usageFromRecord(record);
    if (normalizedUsage && timestamp) {
      turnHasUsage = true;
      const cacheReadComparable = normalizedUsage.cacheReadComparable && recordTimestamp(record, null) !== null;
      const providerIdentity = eventIdentity(record, normalizedUsage.info);
      const nextCount = (tokenCountsByTurn.get(turnId) || 0) + 1;
      tokenCountsByTurn.set(turnId, nextCount);
      const dedupeId = providerIdentity
        ? `${sourceKey}:token-count:${providerIdentity}`
        : options.stableFallbackIdentity
          ? `${sourceKey}:token-count:${stableFallbackIdentity({
            timestamp: recordTimestamp(record, null) || "unobserved",
            input: normalizedUsage.input,
            output: normalizedUsage.output,
            cacheWrite: normalizedUsage.cacheWrite,
            cacheRead: normalizedUsage.cacheRead,
            reasoningOutput: normalizedUsage.reasoningOutput,
          })}`
        : `${sourceKey}:${turnId}:token-count-${nextCount}`;
      const snapshot = {
        dedupeId,
        actorId,
        timestamp,
        input: normalizedUsage.input,
        output: normalizedUsage.output,
        cacheWrite: normalizedUsage.cacheWrite,
        cacheRead: normalizedUsage.cacheRead,
        reasoningOutput: normalizedUsage.reasoningOutput,
        totalTokens: normalizedUsage.totalTokens,
        modelContextWindow: normalizedUsage.modelContextWindow,
        model,
        comparisonGroup,
        cacheComparable: true,
        cacheReadComparable,
        cacheReadPreviousAt: cacheReadComparable ? cacheReadPreviousAt : null,
        cacheLifetime: cacheLifetimeForModel(model),
        cacheMissProviderStatus: null,
      };
      const anchor = retained.get(dedupeId);
      if (anchor?.cacheReadComparable === true && cacheReadComparable && sameRecordedUsage(anchor, snapshot)
        && anchor.model && (!sawModelContext || model === anchor.model)) {
        if (!sawModelContext) model = anchor.model;
        comparisonGroup = anchor.comparisonGroup;
        snapshot.model = model;
        snapshot.comparisonGroup = comparisonGroup;
        snapshot.cacheLifetime = cacheLifetimeForModel(model);
        snapshot.cacheReadPreviousAt = anchor.cacheReadPreviousAt ?? snapshot.cacheReadPreviousAt;
      }
      const duplicate = snapshots.get(dedupeId);
      if (duplicate && duplicate.timestamp === timestamp) snapshot.cacheReadPreviousAt = duplicate.cacheReadPreviousAt;
      snapshots.set(dedupeId, laterEvidence(duplicate, snapshot));
      if (!duplicate) cacheReadPreviousAt = cacheReadComparable ? timestamp : null;
    } else if (isTokenCountRecord(record)) {
      // A recognized but unusable observation means later valid snapshots are
      // not adjacent evidence. Keep the boundary, never the malformed fields.
      comparisonGroup += 1;
      turnHasUsage = true;
      cacheReadPreviousAt = null;
    }

    const compacted = compactionPayload(record);
    if (compacted) cacheReadPreviousAt = null;
    const compactMetadata = compacted?.compactMetadata ?? compacted?.compact_metadata ?? compacted;
    const triggerEvidence = compactionTriggerEvidence(compactMetadata, record);
    if (!compacted || !timestamp || (triggerEvidence.present && !triggerEvidence.trigger)) continue;
    const inferred = triggerEvidence.trigger ? { trigger: null, preTokens: null } : inferredWindowedCompaction(recordList, recordIndex);
    const trigger = triggerEvidence.trigger || inferred.trigger || "unknown";
    const recordedPreTokens = nonNegativeInteger(
      compactMetadata.pre_tokens
      ?? compactMetadata.preTokens
      ?? compactMetadata.pre_compaction_tokens
      ?? compactMetadata.preCompactionTokens,
    );
    const preTokens = recordedPreTokens ?? inferred.preTokens;
    const providerIdentity = eventIdentity(record, compacted);
    const key = providerIdentity
      ? `${sourceKey}:compaction:${providerIdentity}`
      : `${sourceKey}:compaction:${timestamp}:${trigger}:${preTokens ?? "unknown"}`;
    const evidence = { actorId, timestamp, trigger, preTokens };
    if (inferred.trigger) evidence.inferred = true;
    compactions.set(key, evidence);
  }

  const chronological = (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp);
  return {
    usageSnapshots: [...snapshots.values()]
      .sort((left, right) => chronological(left, right) || left.dedupeId.localeCompare(right.dedupeId))
      .slice(-MAX_USAGE_SNAPSHOTS),
    compactions: [...compactions.values()].sort(chronological).slice(-100),
  };
}

export function readCodexContextRollout(file, options = {}) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { usageSnapshots: [], compactions: [] }; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    } catch {
      // Malformed and truncated lines do not invalidate recognized context evidence.
    }
  }
  return parseCodexContextRecords(records, { ...options, sourceKey: options.sourceKey || file });
}
