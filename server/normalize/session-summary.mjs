import { isoTimestamp } from "./primitives.mjs";

const MAX_SUMMARY_LENGTH = 360;

function plainText(value) {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...normalized].slice(0, MAX_SUMMARY_LENGTH).join("");
}

export function sessionSummaryFromRecord(record) {
  if (record?.type !== "system" || record.subtype !== "away_summary") return null;
  const text = plainText(record.content);
  if (!text) return null;
  return {
    text,
    observedAt: isoTimestamp(record.timestamp),
    source: "provider",
  };
}

export function latestSessionSummary(records) {
  let latest = null;
  for (const record of records || []) {
    const summary = sessionSummaryFromRecord(record);
    if (summary) latest = summary;
  }
  return latest;
}

