import * as nodeFs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const HARD_MAX_FILES = 10;
const DEFAULT_MAX_QUEUED_BYTES = 1 * 1024 * 1024;
const HARD_MAX_QUEUED_BYTES = 1 * 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const MAX_RECORD_BYTES = 64 * 1024;
const OWNED_FILE_PATTERN = /^pipeline-(\d{8}T\d{9}Z)-([a-f0-9]{12})-(\d{6})\.jsonl$/;

const clampPositiveInteger = (value, fallback, maximum) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
};

const timestampForFilename = (date = new Date()) => date.toISOString()
  .replace(/[-:]/g, "")
  .replace(".", "");

const makeRunToken = () => randomBytes(6).toString("hex");

const asPromises = (value) => value?.promises ?? value ?? nodeFs;

/**
 * Write already-sanitized, fixed-schema pipeline diagnostics to bounded JSONL files.
 * This module deliberately does not inspect or validate record domains.
 */
export function createPipelineLogWriter(options = {}) {
  let directory = options.directory;
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("directory is required");
  }
  directory = resolvePath(directory);

  const fileSystem = asPromises(options.fs);
  const timers = options.timers ?? globalThis;
  const maxFileBytes = clampPositiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES);
  const maxFiles = clampPositiveInteger(options.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES);
  const maxQueuedBytes = clampPositiveInteger(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES, HARD_MAX_QUEUED_BYTES);
  const flushIntervalMs = clampPositiveInteger(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 60_000);
  const runToken = makeRunToken();
  const queue = [];
  const counters = {
    accepted: 0,
    rejectedInvalid: 0,
    rejectedOversized: 0,
    rejectedCapacity: 0,
    dropped: 0,
    written: 0,
    writtenBytes: 0,
    rotations: 0,
    filesCreated: 0,
    writeFailures: 0,
  };

  let queuedBytes = 0;
  let currentFile = null;
  let currentHandle = null;
  let currentFileBytes = 0;
  let segment = 0;
  let stopped = false;
  let closed = false;
  let timer = null;
  let drainPromise = null;
  let closePromise = null;
  let initializationFailure = false;
  let failureKind = "none";

  const pathJoin = (name) => {
    // The parent supplies a fixed directory. Keep filenames generated here and never
    // concatenate record- or provider-derived values into a path.
    return `${directory.replace(/[\\/]$/, "")}/${name}`;
  };

  const setTimer = () => {
    if (timer !== null || stopped || closed || queue.length === 0) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void drain();
    }, flushIntervalMs);
  };

  const clearTimer = () => {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  };

  const createUniqueFile = async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      segment += 1;
      const name = `pipeline-${timestampForFilename()}-${runToken}-${String(segment).padStart(6, "0")}.jsonl`;
      const path = pathJoin(name);
      try {
        const handle = await fileSystem.open(path, "wx");
        if (currentHandle) {
          try {
            await currentHandle.close();
          } catch (error) {
            try { await handle.close(); } catch { /* cleanup is best effort */ }
            throw error;
          }
        }
        currentHandle = handle;
        currentFile = path;
        currentFileBytes = 0;
        counters.filesCreated += 1;
        return;
      } catch (error) {
        // A collision is recoverable. Other errors stop the writer without exposing
        // filesystem details to callers.
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw new Error("pipeline log filename collision");
  };

  const closeCurrentHandle = async () => {
    const handle = currentHandle;
    currentHandle = null;
    if (!handle) return;
    try {
      await handle.close();
    } catch {
      failureKind = "append";
      stopped = true;
      counters.writeFailures += 1;
    }
  };

  const validateDirectory = async () => {
    // Check every component before canonicalizing: realpath also expands legitimate
    // Windows short names, so a spelling difference alone cannot prove redirection.
    let component = directory;
    while (true) {
      try {
        const entry = await fileSystem.lstat(component);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("invalid pipeline log directory");
      } catch (error) {
        // Missing components may be created only after their existing parents pass.
        if (error?.code !== "ENOENT") throw error;
      }
      const parent = dirname(component);
      if (parent === component) break;
      component = parent;
    }
    await fileSystem.mkdir(directory, { recursive: true });
    directory = await fileSystem.realpath(directory);
  };

  const pruneOwnedFiles = async (activePath = null) => {
    const entries = await fileSystem.readdir(directory, { withFileTypes: true });
    const owned = [];
    for (const entry of entries) {
      if (!entry?.isFile?.() || typeof entry.name !== "string") continue;
      if (!OWNED_FILE_PATTERN.test(entry.name)) continue;
      const path = pathJoin(entry.name);
      if (path === activePath) continue;
      try {
        const stat = await fileSystem.lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (stat.size > maxFileBytes) {
          await fileSystem.unlink(path);
          continue;
        }
        owned.push({ name: entry.name, path, mtimeMs: Number(stat.mtimeMs) || 0 });
      } catch (error) {
        // Disappearance is harmless; other failures mean retention cannot be enforced.
        if (error?.code !== "ENOENT") throw error;
      }
    }
    owned.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    const keep = Math.max(0, maxFiles - 1); // reserve one slot for this run's active file
    for (const file of owned.slice(keep)) {
      try { await fileSystem.unlink(file.path); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  };

  const initialize = (async () => {
    try {
      await validateDirectory();
      await pruneOwnedFiles();
      await createUniqueFile();
    } catch {
      initializationFailure = true;
      failureKind = "startup";
      stopped = true;
      counters.dropped += queue.length;
      queue.length = 0;
      queuedBytes = 0;
    }
  })();

  const stopOnWriteFailure = () => {
    counters.writeFailures += 1;
    failureKind = "append";
    stopped = true;
    clearTimer();
    counters.dropped += queue.length;
    queue.length = 0;
    queuedBytes = 0;
  };

  const writeBatch = async (items) => {
    const data = Buffer.from(items.map((item) => item.line).join(""), "utf8");
    let offset = 0;
    while (offset < data.length) {
      const result = await currentHandle.write(data, offset, data.length - offset);
      const bytesWritten = Number(result?.bytesWritten);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error("pipeline log write made no progress");
      offset += bytesWritten;
    }
    const bytes = items.reduce((total, item) => total + item.bytes, 0);
    currentFileBytes += bytes;
    counters.written += items.length;
    counters.writtenBytes += bytes;
  };

  const drain = () => {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      await initialize;
      if (stopped) return;
      while (queue.length > 0 && !stopped) {
        const batch = [];
        try {
          if (currentFileBytes > 0 && currentFileBytes + queue[0].bytes > maxFileBytes) {
            await createUniqueFile();
            await pruneOwnedFiles(currentFile);
            counters.rotations += 1;
          }
          let batchBytes = 0;
          while (queue.length > 0) {
            const item = queue[0];
            if (currentFileBytes + batchBytes + item.bytes > maxFileBytes) break;
            queue.shift();
            queuedBytes -= item.bytes;
            batch.push(item);
            batchBytes += item.bytes;
          }
          if (batch.length === 0) {
            counters.rejectedOversized += 1;
            counters.dropped += 1;
            queue.shift();
            continue;
          }
          await writeBatch(batch);
        } catch {
          counters.dropped += batch.length;
          stopOnWriteFailure();
          await closeCurrentHandle();
        }
      }
    })().finally(() => {
      drainPromise = null;
      if (queue.length > 0 && !stopped) setTimer();
    });
    return drainPromise;
  };

  const write = (record) => {
    if (stopped || closed) return false;
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      counters.rejectedInvalid += 1;
      return false;
    }
    let serialized;
    try {
      serialized = JSON.stringify(record);
    } catch {
      counters.rejectedInvalid += 1;
      return false;
    }
    if (typeof serialized !== "string") {
      counters.rejectedInvalid += 1;
      return false;
    }
    const line = `${serialized}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_RECORD_BYTES || bytes > maxFileBytes) {
      counters.rejectedOversized += 1;
      return false;
    }
    if (bytes > maxQueuedBytes || queuedBytes + bytes > maxQueuedBytes) {
      counters.rejectedCapacity += 1;
      counters.dropped += 1;
      return false;
    }
    queue.push({ line, bytes });
    queuedBytes += bytes;
    counters.accepted += 1;
    setTimer();
    return true;
  };

  const flush = async () => {
    clearTimer();
    do {
      const generation = counters.accepted;
      await drain();
      if (queue.length === 0 && !drainPromise && generation === counters.accepted) return;
    } while (!stopped);
  };

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    clearTimer();
    closePromise = flush().finally(closeCurrentHandle);
    return closePromise;
  };

  const stats = () => ({
    accepted: counters.accepted,
    rejectedInvalid: counters.rejectedInvalid,
    rejectedOversized: counters.rejectedOversized,
    rejectedCapacity: counters.rejectedCapacity,
    rejectedRecords: counters.rejectedInvalid + counters.rejectedOversized + counters.rejectedCapacity,
    dropped: counters.dropped,
    droppedRecords: counters.dropped,
    written: counters.written,
    writtenBytes: counters.writtenBytes,
    rotations: counters.rotations,
    filesCreated: counters.filesCreated,
    writeFailures: counters.writeFailures,
    queuedRecords: queue.length,
    queuedBytes,
    stopped: stopped ? 1 : 0,
    closed: closed ? 1 : 0,
    ready: currentFile ? 1 : 0,
    failed: failureKind !== "none",
    failureKind,
    initialized: initializationFailure ? 0 : (currentFile ? 1 : 0),
  });

  return { write, flush, close, stats };
}

export const PIPELINE_LOG_WRITER_LIMITS = Object.freeze({
  maxFileBytes: HARD_MAX_FILE_BYTES,
  maxFiles: HARD_MAX_FILES,
  maxQueuedBytes: HARD_MAX_QUEUED_BYTES,
  maxRecordBytes: MAX_RECORD_BYTES,
});
