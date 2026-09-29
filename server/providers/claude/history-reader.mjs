import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const CHUNK_BYTES = 64 * 1024;
const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

function sameFile(left, right) {
  if (!left?.isFile?.() || !right?.isFile?.() || left.size !== right.size || left.mtimeMs !== right.mtimeMs) return false;
  if (Number.isFinite(left.ino) && left.ino > 0 && Number.isFinite(right.ino) && right.ino > 0) {
    return left.ino === right.ino && left.dev === right.dev;
  }
  return left.birthtimeMs === right.birthtimeMs;
}

/** Read one stable Claude JSONL generation while yielding between bounded chunks. */
export async function readClaudeHistoryRecords(file, yieldControl = defaultYield) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { records: [], complete: false }; }
  if (!stat.isFile()) return { records: [], complete: false };
  const records = [];
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let remainder = "";
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const opened = fs.fstatSync(descriptor);
    if (!sameFile(stat, opened)) return { records: [], complete: false };
    while (offset < stat.size) {
      const bytes = Math.min(CHUNK_BYTES, stat.size - offset);
      const buffer = Buffer.alloc(bytes);
      if (fs.readSync(descriptor, buffer, 0, bytes, offset) !== bytes) return { records: [], complete: false };
      offset += bytes;
      const lines = (remainder + decoder.write(buffer)).split(/\r?\n/);
      remainder = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        try { records.push(JSON.parse(line)); } catch { return { records: [], complete: false }; }
      }
      await yieldControl();
    }
    remainder += decoder.end();
    if (remainder.trim()) {
      try { records.push(JSON.parse(remainder)); } catch { return { records: [], complete: false }; }
    }
    const confirmed = fs.statSync(file);
    const stable = sameFile(stat, opened) && sameFile(stat, confirmed);
    return stable ? { records, complete: true } : { records: [], complete: false };
  } catch { return { records: [], complete: false }; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
