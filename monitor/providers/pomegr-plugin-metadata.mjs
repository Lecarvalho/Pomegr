import fs from "node:fs";
import readline from "node:readline";

export const POMEGR_PLUGIN_METADATA_MARKER = "[Pomegr plugin metadata]";

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,64})?$/;
const POLICY_STATUSES = new Set(["valid", "invalid", "missing"]);
const metadataCache = new Map();

function normalizedTimestamp(value) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function textBlocks(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    return typeof item.text === "string" ? [item.text] : [];
  });
}

function claudeHostMetadataText(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  if (record.type === "user" && record.isMeta === true && record.message?.role === "user") {
    return textBlocks(record.message.content);
  }
  return [];
}

function codexHostMetadataText(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  if (record.type === "response_item" && payload.type === "message" && ["developer", "system"].includes(payload.role)) {
    return textBlocks(payload.content);
  }
  if (record.type === "event_msg" && ["developer_message", "system_message"].includes(payload.type)) {
    return textBlocks(payload.message ?? payload.content);
  }
  if (record.type === "turn_context") {
    return textBlocks(payload.additional_context ?? payload.additionalContext);
  }
  return [];
}

export function parsePomegrPluginMetadataText(text, observedAt = null) {
  if (typeof text !== "string" || !text.includes(POMEGR_PLUGIN_METADATA_MARKER)) return null;
  for (const line of text.split(/\r?\n/)) {
    const markerIndex = line.indexOf(POMEGR_PLUGIN_METADATA_MARKER);
    if (markerIndex < 0) continue;
    const encoded = line.slice(markerIndex + POMEGR_PLUGIN_METADATA_MARKER.length).trim();
    if (!encoded || Buffer.byteLength(encoded, "utf8") > 512) continue;
    let value;
    try { value = JSON.parse(encoded); } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const version = value.pluginVersion === null
      ? null
      : typeof value.pluginVersion === "string" && VERSION_PATTERN.test(value.pluginVersion)
        ? value.pluginVersion
        : undefined;
    const policyStatus = POLICY_STATUSES.has(value.policyStatus) ? value.policyStatus : null;
    const policyVersion = value.policyVersion === null
      ? null
      : Number.isInteger(value.policyVersion) && value.policyVersion >= 1 && value.policyVersion <= 99
        ? value.policyVersion
        : undefined;
    if (version === undefined || !policyStatus || policyVersion === undefined) continue;
    return {
      status: "active",
      version,
      policyStatus,
      policyVersion,
      observedAt: normalizedTimestamp(observedAt),
    };
  }
  return null;
}

export function pomegrPluginMetadataFromRecord(record, provider) {
  const texts = provider === "claude"
    ? claudeHostMetadataText(record)
    : provider === "codex" ? codexHostMetadataText(record) : [];
  let result = null;
  for (const text of texts) {
    const parsed = parsePomegrPluginMetadataText(text, record.timestamp ?? record.message?.timestamp ?? record.payload?.timestamp);
    if (parsed) result = parsed;
  }
  return result;
}

export function latestPomegrPluginMetadata(records, provider) {
  let latest = null;
  for (const record of records || []) {
    latest = pomegrPluginMetadataFromRecord(record, provider) || latest;
  }
  return latest;
}

async function scanMetadata(file, provider, start, initial) {
  const stream = fs.createReadStream(file, { encoding: "utf8", start });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let latest = initial;
  try {
    for await (const line of lines) {
      if (!line.includes(POMEGR_PLUGIN_METADATA_MARKER) || Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      latest = pomegrPluginMetadataFromRecord(record, provider) || latest;
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return latest;
}

function cacheIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

export async function readLatestPomegrPluginMetadata(file, provider) {
  let stat;
  try { stat = fs.lstatSync(file); } catch {
    metadataCache.delete(`${provider}:${file}`);
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) return null;
  const key = `${provider}:${file}`;
  const identity = cacheIdentity(stat);
  const cached = metadataCache.get(key);
  if (cached && cached.identity === identity && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.value;
  }
  const appended = cached && cached.identity === identity && stat.size > cached.size;
  const appendStart = appended ? Math.max(0, cached.size - MAX_RECORD_BYTES - 2) : 0;
  const value = await scanMetadata(file, provider, appendStart, appended ? cached.value : null);
  let confirmed;
  try { confirmed = fs.lstatSync(file); } catch { return value; }
  if (confirmed.isFile() && !confirmed.isSymbolicLink() && cacheIdentity(confirmed) === identity && confirmed.size === stat.size && confirmed.mtimeMs === stat.mtimeMs) {
    metadataCache.delete(key);
    metadataCache.set(key, { identity, size: stat.size, mtimeMs: stat.mtimeMs, value });
    while (metadataCache.size > 128) metadataCache.delete(metadataCache.keys().next().value);
  }
  return value;
}
