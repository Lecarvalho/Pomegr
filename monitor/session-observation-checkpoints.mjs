import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const SESSION_OBSERVATION_CHECKPOINT_VERSION = 1;

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_PRIVACY_SENTINELS = Object.freeze([
  "MUST_NOT_LEAK",
  "PRIVATE_",
  "OAUTH_",
  "ENV_SECRET",
  "AUTH_FILE",
]);
const FORBIDDEN_KEY = /(?:prompt|response|reasoning|command|patch|stdout|stderr|tool.?result|oauth|credential|authorization|transcript|diagnostic|fragment|raw)/i;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertBounded(value, { depth = 0, maxDepth = 20 } = {}) {
  if (typeof value === "string") {
    if (value.length > 20_000) throw new TypeError("checkpoint strings must be bounded");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (depth >= maxDepth || (!Array.isArray(value) && !isPlainObject(value))) throw new TypeError("checkpoint value is invalid");
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  let count = 0;
  for (const [key, child] of entries) {
    count += 1;
    if (count > 2_000 || (typeof key === "string" && (key.length > 160 || FORBIDDEN_KEY.test(key)))) {
      throw new TypeError("checkpoint collection is invalid");
    }
    assertBounded(child, { depth: depth + 1, maxDepth });
  }
}

function assertIdentity(payload) {
  if (typeof payload.providerId !== "string" || payload.providerId.length < 1 || payload.providerId.length > 64) {
    throw new TypeError("checkpoint provider identity is invalid");
  }
  if (typeof payload.localSessionId !== "string" || payload.localSessionId.length < 1 || payload.localSessionId.length > 512) {
    throw new TypeError("checkpoint session identity is invalid");
  }
}

function assertPrivacy(payload, sentinels) {
  const serialized = JSON.stringify(payload);
  for (const sentinel of sentinels) {
    if (serialized.includes(sentinel)) throw new TypeError("checkpoint privacy validation failed");
  }
  assertBounded(payload);
}

function sourceForCheckpoint(source) {
  if (source === null || source === undefined) return null;
  if (!isPlainObject(source)) throw new TypeError("checkpoint source is invalid");
  const fingerprint = source.fingerprint ?? null;
  const completeOffset = source.completeOffset ?? null;
  if (fingerprint !== null && (typeof fingerprint !== "string" || fingerprint.length > 256)) {
    throw new TypeError("checkpoint fingerprint is invalid");
  }
  if (completeOffset !== null && (!Number.isSafeInteger(completeOffset) || completeOffset < 0)) {
    throw new TypeError("checkpoint complete offset is invalid");
  }
  return { fingerprint, completeOffset };
}

function payloadFromSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) {
    throw new TypeError("checkpoint snapshot is invalid");
  }
  const payload = {
    version: SESSION_OBSERVATION_CHECKPOINT_VERSION,
    providerId: snapshot.providerId,
    localSessionId: snapshot.localSessionId,
    source: sourceForCheckpoint(snapshot.source),
    evidence: snapshot.evidence,
    readiness: snapshot.readiness,
    revision: snapshot.revision,
    observedAt: snapshot.observedAt,
  };
  assertCheckpointPayload(payload);
  return payload;
}

export function checkpointFilename(providerId, localSessionId) {
  const identity = `${providerId}\u0000${localSessionId}`;
  return `checkpoint-${crypto.createHash("sha256").update(identity).digest("hex")}.json`;
}

/** Validate the versioned, bounded and privacy-filtered L2 schema. */
export function assertCheckpointPayload(payload, privacySentinels = DEFAULT_PRIVACY_SENTINELS) {
  if (!isPlainObject(payload) || payload.version !== SESSION_OBSERVATION_CHECKPOINT_VERSION) {
    throw new TypeError("checkpoint version is unsupported");
  }
  const keys = Object.keys(payload).sort();
  const expected = ["evidence", "localSessionId", "observedAt", "providerId", "readiness", "revision", "source", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("checkpoint schema is invalid");
  }
  assertIdentity(payload);
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1 || !Number.isFinite(Date.parse(payload.observedAt || ""))) {
    throw new TypeError("checkpoint metadata is invalid");
  }
  sourceForCheckpoint(payload.source);
  if (!isPlainObject(payload.readiness) || payload.evidence === undefined) throw new TypeError("checkpoint evidence is invalid");
  assertPrivacy(payload, privacySentinels);
  return payload;
}

/**
 * L2 persistence for complete L1 observations. It never accepts raw records or
 * public response state, so restart recovery must re-project public state locally.
 */
export class SessionObservationCheckpointStore {
  constructor({
    directory,
    validateCandidate = () => true,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    privacySentinels = DEFAULT_PRIVACY_SENTINELS,
  } = {}) {
    if (typeof directory !== "string" || directory.length === 0 || typeof validateCandidate !== "function") {
      throw new TypeError("checkpoint directory and validation hook are required");
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("checkpoint limits must be positive safe integers");
    }
    this.directory = directory;
    this.validateCandidate = validateCandidate;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.privacySentinels = Object.freeze([...privacySentinels]);
    this.qa = { writes: 0, writtenBytes: 0, loads: 0, restored: 0, skipped: 0, ignored: 0, pruned: 0 };
  }

  async write(snapshot) {
    const payload = payloadFromSnapshot(snapshot);
    assertCheckpointPayload(payload, this.privacySentinels);
    if (this.validateCandidate({
      providerId: payload.providerId,
      localSessionId: payload.localSessionId,
      source: payload.source,
      evidence: payload.evidence,
      readiness: payload.readiness,
      revision: payload.revision,
      observedAt: payload.observedAt,
    }) === false) {
      throw new TypeError("checkpoint candidate was rejected");
    }
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > this.maxBytes) throw new TypeError("checkpoint exceeds byte budget");
    await mkdir(this.directory, { recursive: true });
    const filename = checkpointFilename(payload.providerId, payload.localSessionId);
    const target = path.join(this.directory, filename);
    const temporary = path.join(this.directory, `.${filename}.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
    await this.prune({ preserveFilename: filename });
    const bytes = Buffer.byteLength(serialized);
    this.qa.writes += 1;
    this.qa.writtenBytes += bytes;
    return Object.freeze({ filename, bytes });
  }

  /**
   * Read compatible records on startup. The caller supplies projection because
   * public response state is intentionally not stored in the checkpoint.
   */
  async load({ projectState = ({ evidence }) => evidence, includeRecord = () => true } = {}) {
    if (typeof projectState !== "function" || typeof includeRecord !== "function") {
      throw new TypeError("checkpoint load hooks must be functions");
    }
    const records = [];
    let ignored = 0;
    let skipped = 0;
    for (const filename of await this.#filenames()) {
      const payload = await this.#readPayload(filename);
      if (!payload) {
        ignored += 1;
        continue;
      }
      if (!includeRecord(payload)) {
        skipped += 1;
        continue;
      }
      try {
        const candidate = {
          providerId: payload.providerId,
          localSessionId: payload.localSessionId,
          source: payload.source,
          evidence: payload.evidence,
          readiness: payload.readiness,
          revision: payload.revision,
          observedAt: payload.observedAt,
          publicState: projectState(payload),
        };
        if (this.validateCandidate(candidate) === false) throw new TypeError("candidate rejected");
        records.push(Object.freeze(candidate));
      } catch {
        ignored += 1;
      }
    }
    await this.prune();
    this.qa.loads += 1;
    this.qa.restored += records.length;
    this.qa.skipped += skipped;
    this.qa.ignored += ignored;
    return Object.freeze({ records: Object.freeze(records), skipped, ignored });
  }

  async prune({ preserveFilename = null } = {}) {
    const files = [];
    for (const filename of await this.#filenames()) {
      try {
        const [info, payload] = await Promise.all([stat(path.join(this.directory, filename)), this.#readPayload(filename)]);
        files.push({ filename, size: info.size, modified: info.mtimeMs, invalid: !payload });
      } catch {
        // An interrupted or externally removed Pomegr checkpoint is simply ignored.
      }
    }
    files.sort((left, right) => Number(right.invalid) - Number(left.invalid)
      || left.modified - right.modified || left.filename.localeCompare(right.filename));
    let bytes = files.reduce((total, file) => total + file.size, 0);
    let retained = files.length;
    const removed = [];
    for (const file of files) {
      if (!file.invalid && retained <= this.maxEntries && bytes <= this.maxBytes) break;
      if (file.filename === preserveFilename) continue;
      try {
        await unlink(path.join(this.directory, file.filename));
        retained -= 1;
        bytes -= file.size;
        removed.push(file.filename);
      } catch {
        // A concurrent Pomegr writer may have already replaced this file.
      }
    }
    this.qa.pruned += removed.length;
    return Object.freeze({ entries: retained, bytes, removed: Object.freeze(removed) });
  }

  /** Monitor-private bounded counters; never serialized to browser responses. */
  stats() {
    return Object.freeze({ ...this.qa, maxEntries: this.maxEntries, maxBytes: this.maxBytes });
  }

  async #filenames() {
    try {
      const directory = await readdir(this.directory, { withFileTypes: true });
      return directory
        .filter((entry) => entry.isFile() && /^checkpoint-[a-f0-9]{64}\.json$/u.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async #readPayload(filename) {
    try {
      const payload = JSON.parse(await readFile(path.join(this.directory, filename), "utf8"));
      return assertCheckpointPayload(payload, this.privacySentinels);
    } catch {
      return null;
    }
  }
}
