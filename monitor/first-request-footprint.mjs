import fs from "node:fs";
import readline from "node:readline";

function safeTokenCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function footprintFromRecord(record) {
  if (record?.type !== "assistant" || !record.message?.usage) return null;
  const usage = record.message.usage;
  const uncachedInput = safeTokenCount(usage.input_tokens);
  const cacheWrite = safeTokenCount(usage.cache_creation_input_tokens);
  const cacheRead = safeTokenCount(usage.cache_read_input_tokens);
  const output = safeTokenCount(usage.output_tokens);
  const input = uncachedInput + cacheWrite + cacheRead;
  if (input === 0) return null;
  return {
    observedAt: record.timestamp || record.message?.timestamp || null,
    input,
    uncachedInput,
    cacheWrite,
    cacheRead,
    output,
  };
}

export async function readFirstRequestFootprint(file) {
  let input;
  try {
    input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const footprint = footprintFromRecord(record);
      if (!footprint) continue;
      lines.close();
      input.destroy();
      return footprint;
    }
    return null;
  } catch {
    input?.destroy();
    return null;
  }
}
