import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import { createNormalizedPollingObserver } from "./normalized-polling-observer.mjs";

function fingerprint(providerId, localSessionId, identity) {
  return crypto.createHash("sha256").update(`${providerId}\0${localSessionId}\0${identity}`).digest("hex");
}

/** @param {string | null | undefined} file @param {boolean} [historical] */
export function incrementalSourceDescriptor(file, historical = false) {
  if (typeof file !== "string" || !file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 0) return null;
    const identity = Number.isFinite(stat.ino) && stat.ino > 0
      ? `${Number.isFinite(stat.dev) ? stat.dev : "device"}:${stat.ino}`
      : `birth:${Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : "unknown"}`;
    const bytes = Math.min(stat.size, 256);
    const descriptor = fs.openSync(file, "r");
    let suffixDigest;
    try {
      const suffix = Buffer.alloc(bytes);
      fs.readSync(descriptor, suffix, 0, bytes, stat.size - bytes);
      suffixDigest = crypto.createHash("sha256").update(suffix).digest("hex");
    } finally { fs.closeSync(descriptor); }
    return { file, identity, size: stat.size, mtimeMs: stat.mtimeMs, suffixDigest, historical, sourceFiles: [file] };
  } catch { return null; }
}

/**
 * Use one readable primary source for the byte cursor while fingerprinting all
 * provider-owned transcript files that can affect the normalized session.
 * Paths are hashed locally and never cross the adapter boundary.
 */
export function incrementalSourceSetDescriptor(files, primaryFile, historical = false) {
  const primary = incrementalSourceDescriptor(primaryFile, historical);
  if (!primary || !Array.isArray(files)) return primary;
  const parts = [...new Set(files.filter((file) => typeof file === "string" && file))]
    .sort()
    .flatMap((file) => {
      const descriptor = incrementalSourceDescriptor(file, historical);
      return descriptor ? [file === primary.file
        ? `${file}\0${descriptor.identity}`
        : `${file}\0${descriptor.identity}\0${descriptor.size}\0${descriptor.suffixDigest}`] : [];
    });
  if (!parts.length) return primary;
  return {
    ...primary,
    identity: crypto.createHash("sha256").update(parts.join("\n")).digest("hex"),
    sourceFiles: [...new Set(files.filter((file) => typeof file === "string" && file))],
  };
}

/**
 * Adapter-private U1/U2 bridge.  It frames every primary JSONL source before
 * invoking the adapter's existing evidence reducer, so unchanged polling and
 * GET compatibility reads do not repeatedly parse a source.  The only source
 * data exported with a candidate is a hashed identity and complete-record
 * offset suitable for monitor-private checkpoint matching.
 */
export function createIncrementalProviderObserver(options = {}) {
  const {
    providerId,
    list,
    readEvidence,
    resolveSource,
    prepareSources,
    routeSourceEvent,
    intervalMs,
    concurrency,
    watchTargets,
    watchSource,
    yieldControl,
    now,
    shouldEagerHydrate,
  } = options;
  if (typeof providerId !== "string" || !providerId || typeof list !== "function"
    || typeof readEvidence !== "function" || typeof resolveSource !== "function") {
    throw new TypeError("Incremental provider observer requires provider identity, list, evidence reader, and source resolver");
  }
  const ingestors = new Map();
  const sourceSessions = new Map();
  const sourcesBySession = new Map();

  const sourceKey = (file) => {
    try {
      const resolved = path.resolve(file);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch { return ""; }
  };

  function indexSource(localSessionId, source) {
    const previous = sourcesBySession.get(localSessionId) || [];
    for (const file of previous) {
      const key = sourceKey(file);
      const owners = sourceSessions.get(key);
      owners?.delete(localSessionId);
      if (owners?.size === 0) sourceSessions.delete(key);
    }
    const files = [...new Set((Array.isArray(source?.sourceFiles) ? source.sourceFiles : [source?.file])
      .filter((file) => typeof file === "string" && file))];
    sourcesBySession.set(localSessionId, files);
    for (const file of files) {
      const key = sourceKey(file);
      if (!key) continue;
      const owners = sourceSessions.get(key) || new Set();
      owners.add(localSessionId);
      sourceSessions.set(key, owners);
    }
  }

  async function acquire(localSessionId, publisher, preparedSources) {
    const source = preparedSources instanceof Map
      ? preparedSources.get(localSessionId) || null
      : await resolveSource(localSessionId);
    if (!source || typeof source.file !== "string" || typeof source.identity !== "string"
      || !Number.isSafeInteger(source.size) || source.size < 0) return null;
    indexSource(localSessionId, source);
    const sourceFingerprint = fingerprint(providerId, localSessionId, source.identity);
    let entry = ingestors.get(localSessionId);
    if (!entry) {
      const sourceRef = { file: source.file, size: source.size, suffixDigest: source.suffixDigest || "" };
      const ingestor = createIncrementalJsonlIngestor({
        readChunk(offset, bytes) {
          const descriptor = fs.openSync(sourceRef.file, "r");
          try {
            const buffer = Buffer.alloc(bytes);
            const read = fs.readSync(descriptor, buffer, 0, bytes, offset);
            return buffer.subarray(0, read);
          } finally { fs.closeSync(descriptor); }
        },
        parseRecord(line) { return JSON.parse(line.toString("utf8")); },
        initialState: () => ({ completeRecords: 0 }),
        reduce(state) { return { completeRecords: state.completeRecords + 1 }; },
        yieldControl,
      });
      const checkpoint = typeof publisher?.checkpointFor === "function" ? publisher.checkpointFor(localSessionId) : null;
      if (checkpoint?.fingerprint === sourceFingerprint) {
        ingestor.restore({ identity: sourceFingerprint, completeOffset: checkpoint.completeOffset });
      }
      entry = { ingestor, sourceRef };
      ingestors.set(localSessionId, entry);
    }
    const replacedAtSameSize = entry.sourceRef.size === source.size && entry.sourceRef.suffixDigest
      && source.suffixDigest && entry.sourceRef.suffixDigest !== source.suffixDigest;
    const observedIdentity = replacedAtSameSize
      ? fingerprint(providerId, localSessionId, `${source.identity}\0${source.suffixDigest}`)
      : sourceFingerprint;
    entry.sourceRef.file = source.file;
    entry.sourceRef.size = source.size;
    entry.sourceRef.suffixDigest = source.suffixDigest || "";
    let candidate = null;
    await entry.ingestor.observe({ identity: observedIdentity, size: source.size }, async (_state, metadata) => {
      const evidence = await readEvidence(localSessionId, { historical: Boolean(source.historical) });
      if (!evidence) throw new Error("Normalized evidence is temporarily unavailable");
      candidate = {
        ...evidence,
        observationSource: {
          fingerprint: metadata.identity,
          completeOffset: metadata.completeOffset,
        },
      };
    });
    return candidate;
  }

  async function resolveSourceEvent(change) {
    const filename = typeof change?.filename === "string" && change.filename ? change.filename : null;
    const candidate = filename ? path.resolve(change.target, filename) : null;
    const known = candidate ? sourceSessions.get(sourceKey(candidate)) : null;
    if (typeof routeSourceEvent === "function") {
      const routed = await routeSourceEvent({
        ...change,
        candidate,
        knownSessionIds: known ? [...known] : [],
      });
      if (routed) return routed;
    }
    if (known?.size) {
      return {
        catalog: change.eventType === "rename",
        sessionIds: [...known],
      };
    }
    return { catalog: true, sessionIds: [] };
  }

  return createNormalizedPollingObserver({
    list,
    ingest: acquire,
    prepare: prepareSources,
    intervalMs,
    concurrency,
    watchTargets,
    routeSourceEvent: resolveSourceEvent,
    watchSource,
    yieldControl,
    now,
    shouldEagerHydrate,
  });
}
