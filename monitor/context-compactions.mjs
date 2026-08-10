import fs from "node:fs";
import readline from "node:readline";

function safeNonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function safeTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

export function contextCompactionFromRecord(record) {
  if (record?.type !== "system" || record.subtype !== "compact_boundary") return null;
  const trigger = record.compactMetadata?.trigger;
  if (trigger !== "auto" && trigger !== "manual") return null;

  return {
    trigger,
    preTokens: safeNonNegativeInteger(record.compactMetadata?.preTokens),
    timestamp: safeTimestamp(record.timestamp),
  };
}

export function contextCompactions(records) {
  return (records || []).flatMap((record) => {
    const compaction = contextCompactionFromRecord(record);
    return compaction ? [compaction] : [];
  });
}

export function mergeContextCompactions(...collections) {
  const merged = new Map();
  for (const compaction of collections.flat()) {
    const key = `${compaction.timestamp || "unknown"}|${compaction.trigger}|${compaction.preTokens ?? "unknown"}`;
    merged.set(key, compaction);
  }
  return [...merged.values()];
}

export async function readContextCompactions(file) {
  let input;
  try {
    input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const compactions = [];
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const compaction = contextCompactionFromRecord(record);
      if (compaction) compactions.push(compaction);
    }
    return compactions;
  } catch {
    input?.destroy();
    return [];
  }
}
