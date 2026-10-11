import fs from "node:fs";
import { statSafe } from "../../normalize/session-discovery.mjs";
import { fileGeneration, priorFileSuffixStillMatches } from "./file-generation.mjs";

export const DEFAULT_TAIL_CACHE_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TAIL_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TAIL_CACHE_MAX_ENTRIES = 512;

export function readJsonlTailCold(file, maxBytes = DEFAULT_TAIL_CACHE_MAX_BYTES) {
  const stat = statSafe(file);
  if (!stat) return [];
  const bytes = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes)); }
  finally { fs.closeSync(fd); }
  let text = buffer.toString("utf8");
  if (stat.size > bytes) text = text.slice(text.indexOf("\n") + 1);
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function splitCompleteLines(buffer, chunkStartOffset) {
  const lines = [];
  let lineStart = 0;
  let searchFrom = 0;
  for (;;) {
    const newlineIndex = buffer.indexOf(0x0a, searchFrom);
    if (newlineIndex === -1) break;
    const text = buffer.subarray(lineStart, newlineIndex).toString("utf8");
    lines.push({ start: chunkStartOffset + lineStart, end: chunkStartOffset + newlineIndex, text });
    lineStart = newlineIndex + 1;
    searchFrom = lineStart;
  }
  return { lines, remainderStart: chunkStartOffset + lineStart };
}

function firstIndexAtLeast(items, threshold, accessor) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (accessor(items[mid]) >= threshold) high = mid; else low = mid + 1;
  }
  return low;
}

function freshEntry() {
  return { generation: null, consumedOffset: 0, newlineOffsets: [], records: [], windowBytes: 0 };
}

// Read exactly the new bytes since entry.consumedOffset and extend tracked state in place.
function growEntry(file, entry, toSize) {
  const fromOffset = entry.consumedOffset;
  if (toSize <= fromOffset) return;
  const length = toSize - fromOffset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, length, fromOffset); }
  finally { fs.closeSync(fd); }
  const { lines, remainderStart } = splitCompleteLines(buffer, fromOffset);
  for (const line of lines) {
    entry.newlineOffsets.push(line.end);
    if (!line.text) continue;
    try { entry.records.push({ start: line.start, value: JSON.parse(line.text) }); }
    catch { /* Silently skip malformed lines, matching the cold reference. */ }
  }
  entry.consumedOffset = remainderStart;
}

function trimToWindow(entry, currentSize, maxBytes) {
  const windowStart = Math.max(0, currentSize - maxBytes);
  if (windowStart === 0) return;
  const cutAt = firstIndexAtLeast(entry.newlineOffsets, windowStart, (offset) => offset);
  if (cutAt >= entry.newlineOffsets.length) return;
  const adjustedStart = entry.newlineOffsets[cutAt] + 1;
  entry.newlineOffsets = entry.newlineOffsets.slice(cutAt);
  const recordCutAt = firstIndexAtLeast(entry.records, adjustedStart, (record) => record.start);
  entry.records = entry.records.slice(recordCutAt);
}

// Bring `entry` up to date for `generation.size`, bounded to the last maxBytes bytes throughout.
function rebuildOrGrow(file, entry, generation, maxBytes) {
  const windowStart = Math.max(0, generation.size - maxBytes);
  if (windowStart > 0 && entry.consumedOffset <= windowStart) {
    entry.consumedOffset = windowStart;
    entry.newlineOffsets = [];
    entry.records = [];
  }
  growEntry(file, entry, generation.size);
  trimToWindow(entry, generation.size, maxBytes);
  entry.generation = generation;
  entry.windowBytes = Math.min(generation.size, maxBytes);
  return entry;
}

function readTrailingFragment(file, fromOffset, toSize) {
  if (toSize <= fromOffset) return undefined;
  const length = toSize - fromOffset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, length, fromOffset); }
  finally { fs.closeSync(fd); }
  const text = buffer.toString("utf8");
  if (!text) return undefined;
  try { return { value: JSON.parse(text) }; } catch { return undefined; }
}

export function createClaudeTailCache({
  maxBytes = DEFAULT_TAIL_CACHE_MAX_BYTES,
  budgetBytes = DEFAULT_TAIL_CACHE_BUDGET_BYTES,
  maxEntries = DEFAULT_TAIL_CACHE_MAX_ENTRIES,
} = {}) {
  /** @type {Map<string, ReturnType<typeof freshEntry>>} Insertion order doubles as LRU order. */
  const entries = new Map();

  function touch(file, entry) {
    entries.delete(file);
    entries.set(file, entry);
  }

  function enforceBounds() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    if (!Number.isFinite(budgetBytes)) return;
    let total = 0;
    for (const entry of entries.values()) total += entry.windowBytes;
    while (total > budgetBytes && entries.size > 0) {
      const oldestKey = entries.keys().next().value;
      total -= entries.get(oldestKey).windowBytes;
      entries.delete(oldestKey);
    }
  }

  function combinedRecords(file, entry, stat) {
    const records = entry.records.map((record) => record.value);
    const fragment = readTrailingFragment(file, entry.consumedOffset, stat.size);
    if (fragment !== undefined) records.push(fragment.value);
    return records;
  }

  function read(file, precomputed) {
    const stat = precomputed ? precomputed.stat : statSafe(file);
    if (!stat) {
      entries.delete(file);
      return [];
    }
    const generation = precomputed ? precomputed.generation : fileGeneration(file, stat);
    if (!generation) {
      entries.delete(file);
      return readJsonlTailCold(file, maxBytes);
    }

    let entry = entries.get(file);
    if (entry) {
      const previous = entry.generation;
      const sameIdentity = previous.identity === generation.identity;
      const unchanged = sameIdentity && generation.size === previous.size && generation.suffixDigest === previous.suffixDigest;
      const grew = sameIdentity && generation.size > previous.size;
      if (unchanged) {
      } else if (grew && priorFileSuffixStillMatches(file, previous)) {
        rebuildOrGrow(file, entry, generation, maxBytes);
      } else {
        entries.delete(file);
        entry = null;
      }
    }
    if (!entry) {
      entry = rebuildOrGrow(file, freshEntry(), generation, maxBytes);
    }
    touch(file, entry);
    enforceBounds();
    return combinedRecords(file, entry, stat);
  }

  function release(files) {
    for (const file of files) entries.delete(file);
  }

  // Drop every cached entry not present in keepFiles.
  function retain(keepFiles) {
    const keep = keepFiles instanceof Set ? keepFiles : new Set(keepFiles);
    for (const file of [...entries.keys()]) {
      if (!keep.has(file)) entries.delete(file);
    }
  }

  /** @param {(file: string) => boolean} [exists] shared per-read existence check */
  function pruneMissingFiles(exists = (file) => Boolean(statSafe(file))) {
    for (const file of [...entries.keys()]) {
      if (!exists(file)) entries.delete(file);
    }
  }

  function size() {
    return entries.size;
  }

  return Object.freeze({ read, release, retain, pruneMissingFiles, size });
}
