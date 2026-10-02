/** Provider-record shape helpers shared by the Claude usage parser and the tool-change attribution reducers. */

export const CACHE_MISS_REASONS = new Set(["model_changed", "system_changed", "tools_changed", "messages_changed"]);

export function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function boundedIdentity(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
}

export function assistantRecord(record) {
  return record?.type === "assistant";
}

export function assistantIdentity(record) {
  return assistantRecord(record)
    ? boundedIdentity(record.message?.id ?? record.requestId ?? record.uuid)
    : "";
}

export function structuredContent(record) {
  return Array.isArray(record?.message?.content) ? record.message.content : [];
}

export function structuredToolResultIds(record) {
  if (record?.type !== "user") return [];
  const content = structuredContent(record);
  if (content.length === 0 || content.some((block) => !plainObject(block) || block.type !== "tool_result")) return [];
  return content.map((block) => boundedIdentity(block.tool_use_id)).filter(Boolean);
}

export function normalizedCacheMissReason(record) {
  const value = record?.message?.diagnostics?.cache_miss_reason?.type;
  return typeof value === "string" && CACHE_MISS_REASONS.has(value) ? value : null;
}
