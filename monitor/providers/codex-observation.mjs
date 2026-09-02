import crypto from "node:crypto";
import { priorSourceSuffixMatches } from "./source-generation.mjs";
import fs from "node:fs";
import path from "node:path";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import {
  incrementalSourceDescriptor,
} from "./incremental-provider-observer.mjs";
import { createNormalizedPollingObserver } from "./normalized-polling-observer.mjs";
import { expandCodexSelectedMetadata } from "./codex-session-discovery.mjs";
import { readCodexRolloutHeader } from "./codex-session-metadata.mjs";
import { initialCodexRecordedLifecycle, reduceCodexRecordedLifecycle } from "./codex-recorded-lifecycle.mjs";
import { mergeCodexContextSnapshot } from "./codex-context.mjs";

const MAX_USAGE_SNAPSHOTS = 4_096;
const MAX_TOOL_CALLS = 4_096;
const MAX_ACTIVITY = 4_096;
const MAX_COMPACTIONS = 1_024;
const MAX_PULL_REQUESTS = 256;
const MAX_LIFECYCLE_EVENT_SESSIONS = 64;
const MAX_OBSERVATION_KEY_LENGTH = 16_384;
// Codex tool-result records can contain large encoded images. Frame them once
// so later lifecycle markers are not separated by a silently discarded record.
const MAX_CODEX_RECORD_BYTES = 8 * 1024 * 1024;

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
  const usageSnapshots = mergeByKey(previous.usageSnapshots, current.usageSnapshots, (item) => item?.dedupeId, MAX_USAGE_SNAPSHOTS, mergeCodexContextSnapshot);
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

function sourceFingerprint(parts, observationKey = "") {
  const value = [...parts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, entry]) => `${file}\0${entry.ingestor.snapshot()?.identity || entry.descriptor.identity}`)
    .concat(`lifecycle\0${observationKey}`)
    .join("\n");
  return crypto.createHash("sha256").update(value).digest("hex");
}

function boundedLifecycleText(value, maximum = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function stableLifecycleObservationKey(localSessionId, metadata, entry) {
  const actors = metadata.map((item) => ({
    id: boundedLifecycleText(item?.localId, 512),
    archived: Boolean(item?.archived),
    runtimeType: boundedLifecycleText(item?.runtimeStatus?.type),
    runtimeFlags: [...new Set((Array.isArray(item?.runtimeStatus?.activeFlags) ? item.runtimeStatus.activeFlags : [])
      .map((flag) => boundedLifecycleText(flag))
      .filter(Boolean))].sort().slice(0, 32),
    liveStatus: boundedLifecycleText(item?.liveStatus),
    livenessSource: boundedLifecycleText(item?.liveness?.source),
  })).sort((left, right) => (left.id || "").localeCompare(right.id || ""));
  const value = JSON.stringify({
    localId: boundedLifecycleText(localSessionId, 512),
    actors,
    catalog: {
      isLive: Boolean(entry?.isLive),
      needsInput: Boolean(entry?.needsInput),
      activityStatus: boundedLifecycleText(entry?.activityStatus),
    },
  });
  return value;
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
    maximumFragmentBytes: MAX_CODEX_RECORD_BYTES,
    initialState: () => ({ completeRecords: 0, lifecycle: initialCodexRecordedLifecycle() }),
    reduce(state, record) {
      if (part.capture) {
        if (!part.pendingRecords.length) part.pendingLookbehind = part.tail.slice();
        part.pendingRecords.push(record);
      }
      part.tail.push(record);
      if (part.tail.length > 24) part.tail.splice(0, part.tail.length - 24);
      return { completeRecords: state.completeRecords + 1, lifecycle: reduceCodexRecordedLifecycle(state.lifecycle, record) };
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
    observationKey,
    observeLifecycleSources,
  } = options;
  const sessions = new Map();
  const sourceSessions = new Map();
  const sourcesBySession = new Map();
  const catalogTargets = new Set(catalogWatchTargets.map((target) => path.resolve(target)));

  if (observationKey !== undefined && typeof observationKey !== "function") {
    throw new TypeError("Codex observation key hook must be a function");
  }
  if (observeLifecycleSources !== undefined && typeof observeLifecycleSources !== "function") {
    throw new TypeError("Codex lifecycle source observer must be a function");
  }

  const sourceKey = (file) => {
    try {
      const resolved = path.resolve(file);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch { return ""; }
  };

  function privateObservationKey(localSessionId, selectedMetadata, entry) {
    let value = null;
    try {
      value = observationKey
        ? observationKey(localSessionId, selectedMetadata, entry)
        : stableLifecycleObservationKey(localSessionId, selectedMetadata, entry);
    } catch { /* a lifecycle hint must not block source observation */ }
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_OBSERVATION_KEY_LENGTH) {
      value = stableLifecycleObservationKey(localSessionId, selectedMetadata, entry);
    }
    return crypto.createHash("sha256").update(value).digest("hex");
  }

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
      if (!root) continue;
      const selectedIds = new Set([localId]);
      expandCodexSelectedMetadata(metadataById, selectedIds);
      const selectedMetadata = [...selectedIds]
        .map((id) => metadataById.get(id))
        .filter(Boolean);
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
        selectedMetadata,
        entry,
        unavailable: files.size > 0 && parts.length !== files.size,
        historical: entry?.isLive === false,
        observationKey: privateObservationKey(localId, selectedMetadata, entry),
      });
    }
    return sources;
  }

  /** @param {{target?: string, filename?: string | null, eventType?: string}} [change] */
  async function routeCodexSourceEvent({ target, filename, eventType } = {}) {
    if (catalogTargets.has(path.resolve(target))) {
      options.onCatalogSourceEvent?.({ target, filename, eventType });
      // The observer owns one coalesced fresh catalog pass. Never prefetch a
      // second catalog here, or a watcher burst serializes redundant discovery.
      return {
        catalog: true,
        afterCatalog: true,
        sessionIds: [...sessions.keys()].slice(-MAX_LIFECYCLE_EVENT_SESSIONS),
      };
    }
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

  async function acquire(localSessionId, publisher, preparedSources) {
    const sourceSet = preparedSources instanceof Map
      ? preparedSources.get(localSessionId) || null
      : (await prepareSources([{ localId: localSessionId, isLive: false }])).get(localSessionId) || null;
    if (!sourceSet || sourceSet.unavailable) return null;
    let session = sessions.get(localSessionId);
    if (!session) {
      session = {
        parts: new Map(),
        evidence: null,
        dirty: false,
        requiresFull: true,
        observationKey: null,
      };
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
      const rewrittenGrowth = descriptor.size > part.descriptor.size
        && part.descriptor.size > 0 && !priorSourceSuffixMatches(descriptor.file, part.descriptor);
      const snapshot = part.ingestor.snapshot();
      const identity = part.descriptor.identity !== descriptor.identity
        ? descriptor.identity
        : sameSizeGenerationChange || rewrittenGrowth
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

    if (observeLifecycleSources) {
      const observations = [...session.parts.entries()].map(([file, part]) => {
        const snapshot = part.ingestor.snapshot();
        const confirmed = incrementalSourceDescriptor(file);
        const stable = confirmed && confirmed.identity === part.descriptor.identity
          && confirmed.size === part.descriptor.size && confirmed.mtimeMs === part.descriptor.mtimeMs
          && confirmed.suffixDigest === part.descriptor.suffixDigest;
        const validRecords = snapshot?.malformedRecords === 0 && snapshot?.oversizedFragments === 0;
        const complete = Boolean(stable && part.ready && snapshot?.completeOffset === part.descriptor.size && validRecords);
        return { file, generation: part.descriptor, state: snapshot?.candidate?.lifecycle, complete,
          // Keep incomplete acquisition separate from invalid acquired evidence.
          // The lifecycle owner additionally verifies continuity with its accepted source.
          pending: !complete && validRecords };
      });
      if (observeLifecycleSources(observations)) {
        // Catalog and detail must consume the same rebuilt lifecycle state,
        // including when startup initially classified a mid-turn source as history.
        const entries = await list();
        publisher.publishCatalog(entries);
        const entry = entries.find((item) => item.localId === localSessionId) || sourceSet.entry;
        sourceSet.historical = entry?.isLive === false;
        sourceSet.observationKey = privateObservationKey(localSessionId, sourceSet.selectedMetadata, entry);
      }
    }
    if ([...session.parts.values()].some((part) => !part.ready)) return null;
    const lifecycleChanged = session.observationKey !== sourceSet.observationKey;
    if (!session.dirty && session.evidence && !lifecycleChanged) return null;
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
      previousReviewDecisionsByThreadId: completeStory ? null : new Map(
        session.evidence.agents.filter((agent) => agent.reviewDecisions).map((agent) => [
          agent.id === "primary" ? localSessionId : agent.id.slice("agent-".length), agent.reviewDecisions,
        ]),
      ),
    });
    if (!next) return null;
    const evidence = completeStory ? next : mergeCodexObservationEvidence(session.evidence, next);
    const candidate = {
      ...evidence,
      observationSource: {
        fingerprint: sourceFingerprint(session.parts, sourceSet.observationKey),
        completeOffset: completeOffset(session.parts),
      },
    };
    session.evidence = candidate;
    session.dirty = false;
    session.requiresFull = false;
    session.observationKey = sourceSet.observationKey;
    for (const part of session.parts.values()) {
      part.capture = true;
      part.pendingLookbehind = [];
      part.pendingRecords = [];
    }
    return candidate;
  }

  const observer = createNormalizedPollingObserver({
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
  let stopped = false;
  let signal = null;
  let unsubscribeLifecycle = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", stop);
    unsubscribeLifecycle?.();
    observer.stop();
    options.onStop?.();
  };
  return Object.freeze({
    ...observer,
    async start(publisher, nextSignal) {
      signal = nextSignal;
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const unsubscribe = options.subscribeLifecycleChanges?.(() => {
          void observer.refresh({ sessionIds: [...sessions.keys()].slice(-MAX_LIFECYCLE_EVENT_SESSIONS) });
        });
        unsubscribeLifecycle = typeof unsubscribe === "function" ? unsubscribe : null;
      } catch { /* periodic reconciliation still projects current presence */ }
      try { await observer.start(publisher, nextSignal); }
      catch (error) { stop(); throw error; }
      if (signal?.aborted) stop();
    },
    stop,
  });
}
