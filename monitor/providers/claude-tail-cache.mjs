import fs from "node:fs";
import { statSafe } from "../session-discovery.mjs";
import { fileGeneration, priorFileSuffixStillMatches } from "./claude-file-generation.mjs";

/** Default bounded tail window: matches the readSession per-agent-file read. */
export const DEFAULT_TAIL_CACHE_MAX_BYTES = 2 * 1024 * 1024;
/** Whole-cache retained-window byte budget, evicted LRU when exceeded. */
export const DEFAULT_TAIL_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
/** Secondary safety cap on distinct cached files, independent of their size. */
export const DEFAULT_TAIL_CACHE_MAX_ENTRIES = 512;

/**
 * Byte-exact record of the last `min(size, maxBytes)` bytes of a JSONL transcript, parsed into
 * records. This is the uncached reference implementation `readJsonlTail` used before caching: the
 * window drops everything up to and including the first "\n" it finds once the file exceeds
 * maxBytes -- including a whole record that happens to start exactly on the window boundary -- and
 * a trailing line without a terminating newline is included only if it independently parses.
 */
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

/**
 * Split a freshly read byte range into complete "\n"-terminated lines plus the absolute offset
 * where the next (possibly incomplete) fragment begins. Offsets are computed on the raw buffer, not
 * the decoded string, because a decoded JS string index is a UTF-16 code-unit count and can diverge
 * from the underlying byte position once multi-byte UTF-8 content (e.g. non-ASCII prompt text)
 * appears before a line; the LF byte (0x0A) never occurs as a UTF-8 continuation or lead byte, so
 * scanning the buffer directly is always byte-exact.
 */
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

/** First index whose accessor value is >= threshold in an ascending array (binary search). */
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

/** Read exactly the new bytes since entry.consumedOffset and extend tracked state in place. */
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

/**
 * Trim tracked state to exactly the window a cold read would produce for `currentSize`: when the
 * file exceeds maxBytes, drop everything at or before the first known newline at/after the window
 * start (this drops a whole record even when the window starts exactly on its boundary, mirroring
 * the cold reference). When no known newline reaches the window start -- an oversized, still
 * unterminated record wider than the window -- nothing is dropped, mirroring the cold reference's
 * indexOf(-1) no-op.
 */
function trimToWindow(entry, currentSize, maxBytes) {
  const windowStart = Math.max(0, currentSize - maxBytes);
  if (windowStart === 0) return;
  const cutAt = firstIndexAtLeast(entry.newlineOffsets, windowStart, (offset) => offset);
  if (cutAt >= entry.newlineOffsets.length) return;
  const adjustedStart = entry.newlineOffsets[cutAt] + 1;
  // Keep the found boundary itself: windowStart only grows, but a still-small
  // next windowStart can be <= this same boundary and need it again. Only an
  // offset strictly before it can never be the answer for any future call.
  entry.newlineOffsets = entry.newlineOffsets.slice(cutAt);
  const recordCutAt = firstIndexAtLeast(entry.records, adjustedStart, (record) => record.start);
  entry.records = entry.records.slice(recordCutAt);
}

/** Bring `entry` up to date for `generation.size`, bounded to the last maxBytes bytes throughout. */
function rebuildOrGrow(file, entry, generation, maxBytes) {
  const windowStart = Math.max(0, generation.size - maxBytes);
  if (windowStart > 0 && entry.consumedOffset <= windowStart) {
    // Whatever was tracked before the current window can never be needed again
    // (the window only advances). Jumping the cursor bounds a cold build, or an
    // append after a single oversized jump, to at most maxBytes of new reading.
    // Equality resets too: the last newline then sits just before the window, so
    // no tracked record can survive the cold read's first-line drop.
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

/**
 * The trailing incomplete fragment (no terminating newline yet) is never cached as a record: it is
 * re-read fresh from the last consumed complete-line offset on every call and parsed only if it
 * independently parses, exactly like the cold reference's final unterminated split segment. The
 * `{ value }` wrapper distinguishes "no fragment" from a fragment that legitimately parses to a
 * falsy JSON value (`null`, `false`, `0`).
 */
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

/**
 * Parsed-tail cache for Claude transcript files, keyed by file path at a fixed maxBytes (the 2 MiB
 * readSession window; the 256 KiB catalog-summary tail is already guarded by the higher-level
 * per-session summary cache in claude.mjs and is read cold via `readJsonlTailCold`). Reused parses
 * are validated by generation (file identity, size, and a sampled tail-suffix digest, from
 * claude-file-generation.mjs) exactly like the other per-session Claude caches: append-only growth
 * with a matching prior suffix extends the parse; anything else -- identity change, shrink, or a
 * same-size suffix mismatch -- drops the entry and rebuilds cold. Nothing here is persisted.
 */
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
      // No trustworthy generation snapshot (e.g. an empty file, or a losing race
      // with a concurrent writer). Degrade to the uncached cold reference rather
      // than risk caching an unvalidated parse.
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
        // Hit: nothing to redo.
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

  /** Drop cached entries for specific files (e.g. once their session leaves the working set). */
  function release(files) {
    for (const file of files) entries.delete(file);
  }

  /** Drop every cached entry not present in keepFiles. */
  function retain(keepFiles) {
    const keep = keepFiles instanceof Set ? keepFiles : new Set(keepFiles);
    for (const file of [...entries.keys()]) {
      if (!keep.has(file)) entries.delete(file);
    }
  }

  /** Drop entries for files that no longer exist on disk. */
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
