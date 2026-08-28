/**
 * Adapter-private JSONL acquisition primitive.  It deliberately returns only
 * reducer-owned state: raw records and an unfinished final fragment never leave
 * this module or become checkpoint/public data.  Adapters supply the parser
 * and reducer because their native schemas must remain private.
 */
export function createIncrementalJsonlIngestor(options) {
  const {
    readChunk,
    parseRecord,
    initialState,
    reduce,
    chunkBytes = 64 * 1024,
    maximumFragmentBytes = 256 * 1024,
    yieldControl = () => new Promise((resolve) => setImmediate(resolve)),
  } = options || {};
  if (typeof readChunk !== "function" || typeof parseRecord !== "function"
    || typeof initialState !== "function" || typeof reduce !== "function") {
    throw new TypeError("Incremental JSONL ingestor requires readChunk, parseRecord, initialState, and reduce");
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 4 * 1024 * 1024) {
    throw new TypeError("Incremental JSONL ingestor chunkBytes must be bounded");
  }
  if (!Number.isInteger(maximumFragmentBytes) || maximumFragmentBytes < chunkBytes || maximumFragmentBytes > 8 * 1024 * 1024) {
    throw new TypeError("Incremental JSONL ingestor maximumFragmentBytes must be bounded");
  }
  if (typeof yieldControl !== "function") {
    throw new TypeError("Incremental JSONL ingestor yieldControl must be a function");
  }

  /** @type {{identity: string, completeOffset: number, fragment: Buffer, candidate: unknown, malformedRecords: number, oversizedFragments: number} | null} */
  let committed = null;
  /** @type {{identity: string, completeOffset: number, fragment: Buffer, candidate: unknown, malformedRecords: number, oversizedFragments: number} | null} */
  let staged = null;

  function validSource(source) {
    return source && typeof source.identity === "string" && source.identity.length > 0
      && Number.isInteger(source.size) && source.size >= 0;
  }

  function generation(identity) {
    return {
      identity,
      completeOffset: 0,
      fragment: Buffer.alloc(0),
      candidate: initialState(),
      malformedRecords: 0,
      oversizedFragments: 0,
    };
  }

  function appendCompleteLines(state, bytes) {
    const buffer = state.fragment.length ? Buffer.concat([state.fragment, bytes]) : bytes;
    let lineStart = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      let line = buffer.subarray(lineStart, index);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      state.completeOffset += index - lineStart + 1;
      lineStart = index + 1;
      if (!line.length) continue;
      try {
        state.candidate = reduce(state.candidate, parseRecord(line));
      } catch {
        // A malformed complete record never blocks later complete records or
        // contaminates an otherwise valid committed candidate.
        state.malformedRecords += 1;
      }
    }
    state.fragment = buffer.subarray(lineStart);
    if (state.fragment.length > maximumFragmentBytes) {
      // Do not retain unbounded raw content.  The next complete record can be
      // consumed after this explicitly degraded oversized fragment.
      state.completeOffset += state.fragment.length;
      state.fragment = Buffer.alloc(0);
      state.oversizedFragments += 1;
    }
  }

  async function consume(state, source) {
    let consumed = false;
    while (state.completeOffset + state.fragment.length < source.size) {
      const offset = state.completeOffset + state.fragment.length;
      const requested = Math.min(chunkBytes, source.size - offset);
      const value = await readChunk(offset, requested, source);
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || "");
      if (!bytes.length) break;
      if (bytes.length > requested) throw new TypeError("Incremental JSONL source returned more bytes than requested");
      appendCompleteLines(state, bytes);
      consumed = true;
      // Reading all available chunks is required for correctness, but doing it
      // in one microtask chain can starve the monitor's cache-serving socket.
      await yieldControl();
    }
    return consumed;
  }

  function metadata(state, replacement) {
    return Object.freeze({
      identity: state.identity,
      completeOffset: state.completeOffset,
      malformedRecords: state.malformedRecords,
      oversizedFragments: state.oversizedFragments,
      replacement,
    });
  }

  return Object.freeze({
    restore(checkpoint) {
      if (!checkpoint || typeof checkpoint.identity !== "string" || !checkpoint.identity
        || !Number.isSafeInteger(checkpoint.completeOffset) || checkpoint.completeOffset < 0) return false;
      committed = { ...generation(checkpoint.identity), completeOffset: checkpoint.completeOffset };
      staged = null;
      return true;
    },
    /**
     * Consume every currently available byte, not just one chunk.  A replaced
     * or truncated source is rebuilt into `staged` and becomes visible only
     * after that independent candidate has been fully normalized.
     *
     * @param {{identity: string, size: number}} source
     * @param {(candidate: unknown, metadata: Readonly<Record<string, unknown>>) => Promise<void> | void} publish
     */
    async observe(source, publish) {
      if (!validSource(source)) throw new TypeError("Incremental JSONL source requires a bounded identity and non-negative size");
      if (typeof publish !== "function") throw new TypeError("Incremental JSONL ingestor requires a publish function");
      if (!committed) {
        committed = generation(source.identity);
        const changed = await consume(committed, source);
        // On a cold start, wait for a complete final record.  There is no
        // previous revision to retain, and publishing this first staged view
        // would make a partial write indistinguishable from ready evidence.
        if (changed && committed.fragment.length === 0) {
          await publish(committed.candidate, metadata(committed, false));
        }
        return;
      }
      const appendCompatible = committed.identity === source.identity
        && source.size >= committed.completeOffset + committed.fragment.length;
      const replacementRequired = !appendCompatible;
      if (replacementRequired) {
        if (!staged || staged.identity !== source.identity) staged = generation(source.identity);
        await consume(staged, source);
        // A replacement is an atomic swap.  Keep the last known-good
        // candidate while the new source ends with an incomplete record.
        if (staged.completeOffset + staged.fragment.length >= source.size && staged.fragment.length === 0) {
          committed = staged;
          staged = null;
          await publish(committed.candidate, metadata(committed, true));
        }
        return;
      }
      const changed = await consume(committed, source);
      if (changed) await publish(committed.candidate, metadata(committed, false));
    },
    snapshot() {
      if (!committed) return null;
      return Object.freeze({
        identity: committed.identity,
        completeOffset: committed.completeOffset,
        malformedRecords: committed.malformedRecords,
        oversizedFragments: committed.oversizedFragments,
        candidate: committed.candidate,
      });
    },
  });
}
