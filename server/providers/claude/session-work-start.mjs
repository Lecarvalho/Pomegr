import fs from "node:fs";
import { createClaudeSessionWorkStartState, reduceClaudeSessionWorkStart } from "./activity-events.mjs";
import { priorFileSuffixStillMatches } from "./file-generation.mjs";
import { createIncrementalJsonlIngestor } from "../kernel/incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "../kernel/incremental-provider-observer.mjs";

/** Complete-source timing with bounded private state, independent of the display tail. */
export function createClaudeSessionWorkStartReader(options = {}) {
  const maximumEntries = Number.isInteger(options.maximumEntries)
    ? Math.max(1, Math.min(options.maximumEntries, 256)) : 64;
  const entries = new Map();

  function createEntry(file) {
    return {
      source: null,
      generation: 0,
      identity: null,
      startedAt: null,
      pending: Promise.resolve(),
      ingestor: createIncrementalJsonlIngestor({
        readChunk(offset, bytes) {
          const descriptor = fs.openSync(file, "r");
          try {
            const buffer = Buffer.alloc(bytes);
            const read = fs.readSync(descriptor, buffer, 0, bytes, offset);
            return buffer.subarray(0, read);
          } finally { fs.closeSync(descriptor); }
        },
        parseRecord: (line) => JSON.parse(line.toString("utf8")),
        initialState: createClaudeSessionWorkStartState,
        reduce: reduceClaudeSessionWorkStart,
        yieldControl: options.yieldControl,
      }),
    };
  }

  async function observe(file, entry) {
    const source = incrementalSourceDescriptor(file);
    if (!source) throw new Error("Session timing source is unavailable");
    const previous = entry.source;
    const appendCompatible = previous && previous.identity === source.identity
      && source.size >= previous.size && source.mtimeMs >= previous.mtimeMs
      && (previous.size === 0 || priorFileSuffixStillMatches(file, previous));
    if (!appendCompatible) entry.identity = `${source.identity}:work-start:${++entry.generation}`;
    entry.source = source;
    await entry.ingestor.observe({ identity: entry.identity, size: source.size }, (state) => {
      // The state covers bytes up to `source.size`. A live transcript that only grew during
      // the observation still holds that exact prefix, so the state stays valid and the next
      // read continues from it; only a replaced, truncated, or rewritten prefix is rejected.
      const confirmed = incrementalSourceDescriptor(file);
      const unchanged = confirmed && confirmed.size === source.size && confirmed.mtimeMs === source.mtimeMs
        && confirmed.suffixDigest === source.suffixDigest;
      const appended = confirmed && confirmed.size > source.size
        && (source.size === 0 || priorFileSuffixStillMatches(file, source));
      if (!confirmed || confirmed.identity !== source.identity || !(unchanged || appended)) {
        throw new Error("Session timing source changed during observation");
      }
      entry.startedAt = state.startedAt;
    });
    return entry.startedAt;
  }

  function read(file) {
    const entry = entries.get(file) || createEntry(file);
    entries.delete(file);
    entries.set(file, entry);
    while (entries.size > maximumEntries) entries.delete(entries.keys().next().value);
    const result = entry.pending.then(() => observe(file, entry));
    entry.pending = result.catch(() => {});
    return result;
  }

  return Object.freeze({ read });
}
