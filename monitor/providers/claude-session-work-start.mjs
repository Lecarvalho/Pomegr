import fs from "node:fs";
import { createClaudeSessionWorkStartState, reduceClaudeSessionWorkStart } from "./claude-activity-events.mjs";
import { priorFileSuffixStillMatches } from "./claude-file-generation.mjs";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";

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
      const confirmed = incrementalSourceDescriptor(file);
      if (!confirmed || confirmed.identity !== source.identity || confirmed.size !== source.size
        || confirmed.mtimeMs !== source.mtimeMs || confirmed.suffixDigest !== source.suffixDigest) {
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
