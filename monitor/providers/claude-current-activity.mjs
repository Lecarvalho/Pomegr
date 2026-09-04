import crypto from "node:crypto";
import fs from "node:fs";
import { userInputContentType } from "../activity-events.mjs";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";
import { registryTimestamp } from "./claude-session-status.mjs";

const CLAUDE_ACTIVITY_TOOLS = new Set(["Bash"]);
const CLAUDE_TURN_END_REASONS = new Set(["end_turn", "stop_sequence"]);
const CLAUDE_TURN_END_SUBTYPES = new Set(["turn_duration"]);
const SAFE_TOOL_USE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export const CLAUDE_CURRENT_ACTIVITY_MAX_LENGTH = 160;

function timestamp(value) {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function boundedActivityLabel(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return [...normalized].slice(0, CLAUDE_CURRENT_ACTIVITY_MAX_LENGTH).join("");
}

function toolUseId(value) {
  return typeof value === "string" && SAFE_TOOL_USE_ID.test(value) ? value : null;
}

function boundaryId(value, observedAt) {
  return toolUseId(value) || observedAt;
}

function startsUserTurn(record) {
  return Boolean(userInputContentType(record));
}

function turnBoundary(record, observedAt) {
  if (startsUserTurn(record)) return { kind: "start", key: `start:${boundaryId(record.uuid, observedAt)}` };
  if (record?.type === "assistant" && CLAUDE_TURN_END_REASONS.has(record.message?.stop_reason)) {
    return { kind: "end", key: `end:${boundaryId(record.uuid, observedAt)}` };
  }
  if (record?.type === "system" && CLAUDE_TURN_END_SUBTYPES.has(record.subtype)) {
    return { kind: "end", key: `end:${boundaryId(record.uuid, observedAt)}` };
  }
  return null;
}

function latestPendingActivity(pending) {
  return [...pending.values()].sort((left, right) => (
    right.observedAt.localeCompare(left.observedAt)
    || right.order - left.order
    || left.id.localeCompare(right.id)
  ))[0] || null;
}

/**
 * Reduce only Claude's native, user-visible Bash activity descriptions. Raw
 * commands, arbitrary tool arguments, results, thinking, and message text are
 * deliberately outside this parser.
 */
export function parseClaudeCurrentActivityStateRecords(records, options = {}) {
  const previous = options.existingState || {};
  const pending = new Map((Array.isArray(previous.pending) ? previous.pending : []).flatMap((item) => (
    item && toolUseId(item.id) && boundedActivityLabel(item.label) && timestamp(item.observedAt)
      ? [[item.id, { id: item.id, label: boundedActivityLabel(item.label), observedAt: timestamp(item.observedAt), order: Number.isInteger(item.order) ? item.order : 0 }]]
      : []
  )));
  let turnOpen = previous.turnOpen !== false;
  let boundaryAt = timestamp(previous.boundaryAt);
  let boundaryKey = typeof previous.boundaryKey === "string" ? previous.boundaryKey : null;
  let order = Number.isInteger(previous.order) && previous.order >= 0 ? previous.order : 0;

  for (const record of Array.isArray(records) ? records : []) {
    const observedAt = timestamp(record?.timestamp || record?.message?.timestamp);
    if (!observedAt || (boundaryAt && observedAt < boundaryAt)) continue;
    const boundary = turnBoundary(record, observedAt);
    if (boundary) {
      if (observedAt === boundaryAt && boundary.key === boundaryKey) continue;
      pending.clear();
      turnOpen = boundary.kind === "start";
      boundaryAt = observedAt;
      boundaryKey = boundary.key;
      continue;
    }
    if (!turnOpen || !Array.isArray(record.message?.content)) continue;
    for (const content of record.message.content) {
      if (record.type === "assistant" && content?.type === "tool_use"
        && CLAUDE_ACTIVITY_TOOLS.has(content.name)) {
        const id = toolUseId(content.id);
        const label = boundedActivityLabel(content.input?.description);
        if (!id || !label) continue;
        order = Math.min(Number.MAX_SAFE_INTEGER, order + 1);
        pending.delete(id);
        pending.set(id, { id, label, observedAt, order });
        while (pending.size > 64) pending.delete(pending.keys().next().value);
      }
      if (record.type === "user" && content?.type === "tool_result") {
        const id = toolUseId(content.tool_use_id);
        if (id) pending.delete(id);
      }
    }
  }

  if (options.historical || ["finished", "stopped", "idle"].includes(options.agentStatus)) pending.clear();
  const current = latestPendingActivity(pending);
  return {
    currentActivity: current ? { label: current.label, observedAt: current.observedAt } : null,
    pending: [...pending.values()],
    turnOpen,
    boundaryAt,
    boundaryKey,
    order,
  };
}

export function parseClaudeCurrentActivityRecords(records, options = {}) {
  return parseClaudeCurrentActivityStateRecords(records, options).currentActivity;
}

function priorSuffixMatches(file, source) {
  if (!source?.suffixDigest || !Number.isInteger(source.size) || source.size < 1) return false;
  const bytes = Math.min(source.size, source.suffixBytes || 0);
  if (bytes < 1) return false;
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(descriptor, buffer, 0, bytes, source.size - bytes);
    return read === bytes
      && crypto.createHash("sha256").update(buffer).digest("hex") === source.suffixDigest;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Cooperative complete-record reader with bounded provider-private state. */
export function createClaudeCurrentActivityReader(options = {}) {
  const maximumEntries = Number.isInteger(options.maximumEntries)
    ? Math.max(1, Math.min(options.maximumEntries, 256)) : 100;
  const entries = new Map();

  function createEntry(file, source) {
    const sourceRef = { file, source };
    return {
      sourceRef,
      activeIdentity: source.identity,
      committedIdentity: null,
      suppressedOrder: 0,
      ingestor: createIncrementalJsonlIngestor({
        readChunk(offset, bytes) {
          const descriptor = fs.openSync(sourceRef.file, "r");
          try {
            const buffer = Buffer.alloc(bytes);
            const read = fs.readSync(descriptor, buffer, 0, bytes, offset);
            return buffer.subarray(0, read);
          } finally { fs.closeSync(descriptor); }
        },
        parseRecord(line) { return JSON.parse(line.toString("utf8")); },
        initialState: () => parseClaudeCurrentActivityStateRecords([]),
        reduce(state, record) {
          return parseClaudeCurrentActivityStateRecords([record], { existingState: state });
        },
        yieldControl: options.yieldControl,
      }),
    };
  }

  async function read(file, readOptions = {}) {
    if (readOptions.historical) {
      entries.delete(file);
      return null;
    }
    const source = incrementalSourceDescriptor(file);
    if (!source) {
      entries.delete(file);
      return null;
    }
    let entry = entries.get(file);
    if (!entry) {
      entry = createEntry(file, source);
    } else {
      const previous = entry.sourceRef.source;
      const appendCompatible = previous.identity === source.identity
        && source.size >= previous.size
        && priorSuffixMatches(file, previous);
      if (!appendCompatible) {
        entry.activeIdentity = `${source.identity}:${source.size}:${source.suffixDigest}`;
        entry.suppressedOrder = 0;
      }
      entry.sourceRef.source = source;
    }
    entries.delete(file);
    entries.set(file, entry);
    while (entries.size > maximumEntries) entries.delete(entries.keys().next().value);

    await entry.ingestor.observe({ identity: entry.activeIdentity, size: source.size }, (_candidate, metadata) => {
      entry.committedIdentity = metadata.identity;
    });
    if (entry.committedIdentity !== entry.activeIdentity) return null;
    const state = entry.ingestor.snapshot()?.candidate;
    if (["finished", "stopped", "idle"].includes(readOptions.agentStatus)) {
      entry.suppressedOrder = Math.max(entry.suppressedOrder, state?.order || 0);
      return null;
    }
    return (state?.order || 0) > entry.suppressedOrder ? state.currentActivity : null;
  }

  return Object.freeze({ read });
}

function primaryLiveness(entry, historical) {
  const observedAt = registryTimestamp(entry);
  if (historical || !entry?.resourceOwner || !observedAt
    || !["active", "waiting", "idle"].includes(entry.status)) return null;
  return { source: "lifecycle_bridge", observedAt, evidence: "observed", freshness: "current" };
}

export async function applyClaudeCurrentActivities(agents, options) {
  for (const agent of agents) {
    const file = options.fileByAgentId.get(agent.id);
    const liveness = agent.id === "primary" ? primaryLiveness(options.registryEntry, options.historical) : null;
    if (liveness) Object.assign(agent, { liveness });
    const currentActivity = file
      ? await options.reader.read(file, { historical: options.historical, agentStatus: agent.status }) : null;
    if (currentActivity) Object.assign(agent, { currentActivity });
  }
}
