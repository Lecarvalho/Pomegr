import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import {
  incrementalSourceDescriptor,
} from "./incremental-provider-observer.mjs";
import { createNormalizedPollingObserver } from "./normalized-polling-observer.mjs";
import { expandCodexSelectedMetadata } from "./codex-session-discovery.mjs";
import { readCodexRolloutHeader } from "./codex-session-metadata.mjs";

const MAX_USAGE_SNAPSHOTS = 4_096;
const MAX_TOOL_CALLS = 4_096;
const MAX_ACTIVITY = 4_096;
const MAX_COMPACTIONS = 1_024;
const MAX_PULL_REQUESTS = 256;

function chronological(left, right) {
  return Date.parse(left?.timestamp || left?.observedAt || "")
    - Date.parse(right?.timestamp || right?.observedAt || "");
}

function mergeByKey(previous, current, keyOf, maximum, prefer = (_old, next) => next) {
  const merged = new Map();
  for (const item of [...(previous || []), ...(current || [])]) {
    const key = keyOf(item);
    if (!key) continue;
    merged.set(key, merged.has(key) ? prefer(merged.get(key), item) : item);
  }
  return [...merged.values()].sort(chronological).slice(-maximum);
}

function compactionStrength(value) {
  return value?.trigger === "unknown" ? 0 : value?.inferred === true ? 1 : 2;
}

function mergeSkills(previous = [], current = []) {
  const merged = new Map();
  for (const skill of [...previous, ...current]) {
    if (!skill?.name) continue;
    const existing = merged.get(skill.name);
    merged.set(skill.name, existing ? {
      name: skill.name,
      calls: Math.max(existing.calls || 0, skill.calls || 0),
      lastUsed: [existing.lastUsed, skill.lastUsed].filter(Boolean).sort().at(-1) || null,
    } : skill);
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 256);
}

function mergeAgents(previous = [], current = [], toolCalls = []) {
  const previousById = new Map(previous.map((agent) => [agent.id, agent]));
  const currentById = new Map(current.map((agent) => [agent.id, agent]));
  const callsByActor = new Map();
  for (const call of toolCalls) callsByActor.set(call.actor.id, (callsByActor.get(call.actor.id) || 0) + 1);
  return [...new Set([...previousById.keys(), ...currentById.keys()])].map((id) => {
    const agent = currentById.get(id) || previousById.get(id);
    const older = previousById.get(agent.id);
    return {
      ...agent,
      assignment: agent.assignment || older?.assignment || null,
      skills: mergeSkills(older?.skills, agent.skills),
      toolCalls: callsByActor.get(agent.id) || 0,
    };
  });
}

/** Merge a bounded live delta into the complete normalized Codex story. */
export function mergeCodexObservationEvidence(previous, current) {
  if (!previous) return current;
  const usageSnapshots = mergeByKey(previous.usageSnapshots, current.usageSnapshots, (item) => item?.dedupeId, MAX_USAGE_SNAPSHOTS);
  const toolCalls = mergeByKey(previous.toolCalls, current.toolCalls, (item) => item?.id, MAX_TOOL_CALLS);
  const activity = mergeByKey(previous.activity, current.activity, (item) => item?.id, MAX_ACTIVITY);
  const compactions = mergeByKey(
    previous.compactions,
    current.compactions,
    (item) => item ? `${item.actorId}\0${item.timestamp}` : "",
    MAX_COMPACTIONS,
    (older, newer) => {
      const olderStrength = compactionStrength(older);
      const newerStrength = compactionStrength(newer);
      if (newerStrength > olderStrength) return newer;
      if (newerStrength === olderStrength && older.preTokens === null && newer.preTokens !== null) return newer;
      return older;
    },
  );
  const pullRequestCreations = mergeByKey(previous.pullRequestCreations, current.pullRequestCreations, (item) => item?.id, MAX_PULL_REQUESTS);
  return {
    ...current,
    session: {
      ...current.session,
      pomegrPlugin: current.session?.pomegrPlugin || previous.session?.pomegrPlugin || null,
    },
    agents: mergeAgents(previous.agents, current.agents, toolCalls),
    usageSnapshots,
    toolCalls,
    activity,
    compactions,
    pullRequestCreations,
    efficiencyRuleEvidence: Object.fromEntries(Object.keys(current.efficiencyRuleEvidence || {}).map((key) => [
      key,
      Boolean(previous.efficiencyRuleEvidence?.[key] || current.efficiencyRuleEvidence?.[key]),
    ])),
  };
}

function sourceFingerprint(parts) {
  const value = [...parts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, entry]) => `${file}\0${entry.ingestor.snapshot()?.identity || entry.descriptor.identity}`)
    .join("\n");
  return crypto.createHash("sha256").update(value).digest("hex");
}

function completeOffset(parts) {
  return [...parts.values()].reduce((total, entry) => {
    const offset = entry.ingestor.snapshot()?.completeOffset || 0;
    return Number.isSafeInteger(total + offset) ? total + offset : Number.MAX_SAFE_INTEGER;
  }, 0);
}

function createPart(descriptor, yieldControl) {
  const sourceRef = { file: descriptor.file };
  const part = {
    descriptor,
    ingestor: null,
    sourceRef,
    ready: descriptor.size === 0,
    capture: false,
    tail: [],
    pendingLookbehind: [],
    pendingRecords: [],
  };
  const ingestor = createIncrementalJsonlIngestor({
    readChunk(offset, bytes) {
      const handle = fs.openSync(sourceRef.file, "r");
      try {
        const buffer = Buffer.alloc(bytes);
        const read = fs.readSync(handle, buffer, 0, bytes, offset);
        return buffer.subarray(0, read);
      } finally { fs.closeSync(handle); }
    },
    parseRecord(line) { return JSON.parse(line.toString("utf8")); },
    initialState: () => ({ completeRecords: 0 }),
    reduce(state, record) {
      if (part.capture) {
        if (!part.pendingRecords.length) part.pendingLookbehind = part.tail.slice();
        part.pendingRecords.push(record);
      }
      part.tail.push(record);
      if (part.tail.length > 24) part.tail.splice(0, part.tail.length - 24);
      return { completeRecords: state.completeRecords + 1 };
    },
    yieldControl,
  });
  part.ingestor = ingestor;
  return part;
}

export function createCodexIncrementalObserver(options = {}) {
  const {
    list,
    readEvidence,
    discoveredMetadata,
    transcriptPathsBySessionId,
    intervalMs,
    concurrency,
    watchTargets,
    catalogWatchTargets = [],
    watchSource,
    yieldControl = () => new Promise((resolve) => setImmediate(resolve)),
    now,
    shouldEagerHydrate,
  } = options;
  const sessions = new Map();
  const sourceSessions = new Map();
  const sourcesBySession = new Map();
  const catalogTargets = new Set(catalogWatchTargets.map((target) => path.resolve(target)));

  const sourceKey = (file) => {
    try {
      const resolved = path.resolve(file);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch { return ""; }
  };

  function indexSessionSources(localSessionId, files) {
    for (const file of sourcesBySession.get(localSessionId) || []) {
      const key = sourceKey(file);
      const owners = sourceSessions.get(key);
      owners?.delete(localSessionId);
      if (owners?.size === 0) sourceSessions.delete(key);
    }
    const nextFiles = [...new Set(files)];
    sourcesBySession.set(localSessionId, nextFiles);
    for (const file of nextFiles) {
      const key = sourceKey(file);
      if (!key) continue;
      const owners = sourceSessions.get(key) || new Set();
      owners.add(localSessionId);
      sourceSessions.set(key, owners);
    }
  }

  async function prepareSources(entries = []) {
    const metadata = await discoveredMetadata();
    const metadataById = new Map(metadata.map((item) => [item.localId, item]));
    const sources = new Map();
    for (const entry of entries) {
      const localId = entry?.localId;
      const root = metadataById.get(localId);
      if (!root?.rolloutFile) continue;
      const selectedIds = new Set([localId]);
      expandCodexSelectedMetadata(metadataById, selectedIds);
      const files = new Set([...selectedIds].flatMap((id) => {
        const rolloutFile = metadataById.get(id)?.rolloutFile;
        return rolloutFile ? [rolloutFile] : [];
      }));
      for (const transcriptPath of transcriptPathsBySessionId.get(localId)?.values() || []) files.add(transcriptPath);
      indexSessionSources(localId, files);
      const parts = [...files]
        .map((file) => incrementalSourceDescriptor(file, entry?.isLive === false))
        .filter(Boolean);
      sources.set(localId, {
        parts,
        unavailable: parts.length !== files.size,
        historical: entry?.isLive === false,
      });
    }
    return sources;
  }

  /** @param {{target?: string, filename?: string | null, eventType?: string}} [change] */
  function routeCodexSourceEvent({ target, filename, eventType } = {}) {
    if (catalogTargets.has(path.resolve(target))) return { catalog: true, sessionIds: [] };
    if (typeof filename !== "string" || !filename) return { catalog: true, sessionIds: [] };
    const candidate = path.resolve(target, filename);
    const known = sourceSessions.get(sourceKey(candidate));
    if (known?.size) {
      return {
        catalog: eventType === "rename",
        sessionIds: [...known],
      };
    }
    const header = readCodexRolloutHeader(candidate);
    const rootId = header?.sessionId && header.sessionId !== header.localId
      ? header.sessionId
      : !header?.parentThreadId && !header?.forkedFromId ? header?.localId : null;
    return {
      catalog: true,
      sessionIds: typeof rootId === "string" && rootId ? [rootId] : [],
    };
  }

  async function acquire(localSessionId, _publisher, preparedSources) {
    const sourceSet = preparedSources instanceof Map
      ? preparedSources.get(localSessionId) || null
      : (await prepareSources([{ localId: localSessionId, isLive: false }])).get(localSessionId) || null;
    if (!sourceSet?.parts?.length || sourceSet.unavailable) return null;
    let session = sessions.get(localSessionId);
    if (!session) {
      session = { parts: new Map(), evidence: null, dirty: false, requiresFull: true };
      sessions.set(localSessionId, session);
    }

    const nextFiles = new Set(sourceSet.parts.map((part) => part.file));
    for (const file of session.parts.keys()) {
      if (!nextFiles.has(file)) {
        session.parts.delete(file);
        session.dirty = true;
        session.requiresFull = true;
      }
    }

    for (const descriptor of sourceSet.parts) {
      let part = session.parts.get(descriptor.file);
      if (!part) {
        part = createPart(descriptor, yieldControl);
        session.parts.set(descriptor.file, part);
        session.requiresFull = true;
      }
      const sameSizeGenerationChange = part.descriptor.size === descriptor.size
        && (part.descriptor.mtimeMs !== descriptor.mtimeMs
          || (part.descriptor.suffixDigest && descriptor.suffixDigest
            && part.descriptor.suffixDigest !== descriptor.suffixDigest));
      const snapshot = part.ingestor.snapshot();
      const identity = part.descriptor.identity !== descriptor.identity
        ? descriptor.identity
        : sameSizeGenerationChange
          ? crypto.createHash("sha256").update(`${descriptor.identity}\0${descriptor.mtimeMs}\0${descriptor.suffixDigest}`).digest("hex")
          : snapshot?.identity || descriptor.identity;
      const replacementPending = snapshot
        && (snapshot.identity !== identity || descriptor.size < snapshot.completeOffset);
      if (replacementPending) {
        part.ready = false;
        part.capture = false;
        part.tail = [];
        part.pendingLookbehind = [];
        part.pendingRecords = [];
        session.requiresFull = true;
      }
      part.descriptor = descriptor;
      part.sourceRef.file = descriptor.file;
      await part.ingestor.observe({ identity, size: descriptor.size }, (_state, metadata) => {
        part.ready = true;
        session.dirty = true;
        if (metadata.replacement) session.requiresFull = true;
      });
    }

    if ([...session.parts.values()].some((part) => !part.ready)) return null;
    if (!session.dirty && session.evidence) return null;
    const completeStory = session.requiresFull || !session.evidence;
    const incrementalRecordsByFile = completeStory ? null : new Map(
      [...session.parts.entries()]
        .filter(([, part]) => part.pendingRecords.length)
        .map(([file, part]) => [file, [...part.pendingLookbehind, ...part.pendingRecords]]),
    );
    const incrementalGenerationsByFile = completeStory ? null : new Map(
      [...session.parts.entries()].map(([file, part]) => [file, {
        identity: part.descriptor.identity,
        size: part.descriptor.size,
        mtimeMs: part.descriptor.mtimeMs,
        suffixBytes: Math.min(256, part.descriptor.size),
        suffixDigest: part.descriptor.suffixDigest,
      }]),
    );
    const next = await readEvidence(localSessionId, {
      historical: Boolean(sourceSet.historical),
      completeStory,
      incrementalRecordsByFile,
      incrementalGenerationsByFile,
    });
    if (!next) return null;
    const evidence = completeStory ? next : mergeCodexObservationEvidence(session.evidence, next);
    const candidate = {
      ...evidence,
      observationSource: {
        fingerprint: sourceFingerprint(session.parts),
        completeOffset: completeOffset(session.parts),
      },
    };
    session.evidence = candidate;
    session.dirty = false;
    session.requiresFull = false;
    for (const part of session.parts.values()) {
      part.capture = true;
      part.pendingLookbehind = [];
      part.pendingRecords = [];
    }
    return candidate;
  }

  return createNormalizedPollingObserver({
    list,
    ingest: acquire,
    prepare: prepareSources,
    intervalMs,
    concurrency,
    watchTargets,
    routeSourceEvent: routeCodexSourceEvent,
    watchSource,
    yieldControl,
    now,
    shouldEagerHydrate,
  });
}
