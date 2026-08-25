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

function laterEvidence(previous, next) {
  if (!previous) return next;
  const previousTime = Date.parse(previous.timestamp || "");
  const nextTime = Date.parse(next.timestamp || "");
  return Number.isFinite(nextTime) && (!Number.isFinite(previousTime) || nextTime >= previousTime) ? next : previous;
}

export function parseClaudeContextRecords(records, options = {}) {
  const actorId = boundedIdentity(options.actorId) || "primary";
  const sourceKey = boundedIdentity(options.sourceKey) || actorId;
  const fallbackTimestamp = validTimestamp(options.fallbackTimestamp);
  const snapshots = new Map();
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
    };
    snapshots.set(dedupeId, laterEvidence(snapshots.get(dedupeId), snapshot));
    if (!snapshot.cacheComparable) comparisonGroup += 1;
  }

  return [...snapshots.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId))
    .slice(-MAX_USAGE_SNAPSHOTS);
}
