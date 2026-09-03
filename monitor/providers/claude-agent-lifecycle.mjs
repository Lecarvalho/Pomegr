import crypto from "node:crypto";
import fs from "node:fs";
import { claudeTerminalTaskNotification } from "./claude-background-lifecycle.mjs";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";

const MAX_FILES = 100;
const MAX_AGENTS = 256;
const MAX_SESSION_ENTRIES = MAX_FILES * MAX_AGENTS;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const safeId = (value) => typeof value === "string" && ID.test(value) ? value : null;
const emptyObservation = () => ({ terminals: new Map(), launches: new Map(), notifications: [], conversationAt: null, complete: false });

function reduceAgentLifecycle(state, record) {
  const timestamp = Date.parse(record?.timestamp || "");
  if (!Number.isFinite(timestamp)) return state;
  if (["user", "assistant"].includes(record.type) && record.message?.model !== "<synthetic>") {
    state.conversationAt = Math.max(state.conversationAt || 0, timestamp);
  }
  const terminal = claudeTerminalTaskNotification(record);
  if (terminal?.callId) {
    const observed = { ...terminal, timestamp: new Date(timestamp).toISOString() };
    if (state.notifications.length >= MAX_AGENTS) state.complete = false;
    else state.notifications.push(observed);
  }
  const launched = terminal && state.agents.get(terminal.taskId);
  if (launched && !launched.terminal && timestamp >= launched.startedAt
    && (terminal.callId ? terminal.callId === launched.callId : !launched.requiresCallId)) {
    launched.terminal = {
      status: terminal.status === "completed" ? "finished" : "stopped",
      timestamp: new Date(timestamp).toISOString(),
    };
  }
  const parts = Array.isArray(record?.message?.content) ? record.message.content : [];
  for (const part of parts) {
    if (record.type === "assistant" && part.type === "tool_use" && part.name === "Agent") {
      const id = safeId(part.id);
      if (!id) continue;
      if (state.calls.size >= MAX_AGENTS || state.calls.has(id)
        || [...state.agents.values()].some((agent) => agent.callId === id)) { state.complete = false; continue; }
      state.calls.set(id, timestamp);
    }
    if (record.type !== "user" || part.type !== "tool_result" || !state.calls.has(part.tool_use_id)) continue;
    const calledAt = state.calls.get(part.tool_use_id);
    state.calls.delete(part.tool_use_id);
    const result = record.toolUseResult;
    const agentId = safeId(result?.agentId);
    if (part.is_error === true || result?.status !== "async_launched" || result.isAsync !== true
      || !agentId || timestamp < calledAt) continue;
    if (!state.agents.has(agentId) && state.agents.size >= MAX_AGENTS) { state.complete = false; continue; }
    // Once an ID is reused, an ID-only notification could belong to the old run.
    state.agents.set(agentId, { callId: part.tool_use_id, startedAt: calledAt,
      requiresCallId: state.agents.has(agentId), terminal: null });
  }
  return state;
}

// A new conversational record is evidence of resumption; trailing metadata is not.
export function currentClaudeAgentTerminal(records, terminal, completeConversationAt = null, completeObservation = false) {
  if (!terminal) return null;
  const completedAt = Date.parse(terminal.timestamp);
  if (terminal.crossFile && (!completeObservation || !Number.isFinite(completeConversationAt) || completeConversationAt >= completedAt)) return null;
  return (Number.isFinite(completeConversationAt) && completeConversationAt > completedAt)
    || records.some((record) => ["user", "assistant"].includes(record.type)
    && record.message?.model !== "<synthetic>"
    && Date.parse(record.timestamp || record.message?.timestamp || "") > completedAt) ? null : terminal;
}

function priorSuffixMatches(file, source) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(source.suffixBytes);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, source.size - buffer.length);
    return bytes === buffer.length && crypto.createHash("sha256").update(buffer).digest("hex") === source.suffixDigest;
  } finally { fs.closeSync(descriptor); }
}

/** Detail-only, complete parent lifecycle replay. No process ownership is inferred.
 * The reader retains bounded, private launch and receipt identities so the
 * session reducer can join a provider-delivered receipt from another lane.
 * The committed normalized agent persists independently of these acquisition
 * cursors.
 */
export function createClaudeAgentLifecycleReader() {
  const files = new Map();
  return async function read(file) {
    let item = files.get(file);
    if (!item) {
      if (files.size >= MAX_FILES) {
        const victim = [...files].find(([, value]) => !value.pending);
        if (!victim) return emptyObservation();
        files.delete(victim[0]);
      }
      item = { source: null, generation: 0, known: emptyObservation(), pending: null, ingestor: null };
      item.ingestor = createIncrementalJsonlIngestor({
        readChunk(offset, bytes) {
          const descriptor = fs.openSync(file, "r");
          try {
            const buffer = Buffer.alloc(bytes);
            return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, bytes, offset));
          } finally { fs.closeSync(descriptor); }
        },
        parseRecord: (line) => JSON.parse(line.toString("utf8")),
        initialState: () => ({ calls: new Map(), agents: new Map(), notifications: [], conversationAt: null, complete: true }),
        reduce: reduceAgentLifecycle,
      });
      files.set(file, item);
    }
    if (item.pending) return item.pending;
    files.delete(file);
    files.set(file, item);
    const current = item;
    current.pending = Promise.resolve().then(async () => {
      try {
        const source = incrementalSourceDescriptor(file);
        if (!source) return current.known;
        const previous = current.source;
        if (previous && (previous.identity !== source.identity || source.size < previous.size
          || (source.size === previous.size && (source.mtimeMs !== previous.mtimeMs || source.suffixDigest !== previous.suffixDigest))
          || (source.size > previous.size && !priorSuffixMatches(file, previous)))) current.generation += 1;
        current.source = source;
        await current.ingestor.observe({ identity: source.identity + ":" + current.generation, size: source.size }, (state, metadata) => {
          if (!state.complete || metadata.malformedRecords || metadata.oversizedFragments) return;
          current.known = {
            terminals: new Map([...state.agents].flatMap(([id, agent]) => agent.terminal ? [[id, { ...agent.terminal }]] : [])),
            launches: new Map([...state.agents].map(([id, agent]) => [id, {
              callId: agent.callId,
              startedAt: agent.startedAt,
              requiresCallId: agent.requiresCallId,
            }])),
            notifications: state.notifications.map((notification) => ({ ...notification })),
            conversationAt: state.conversationAt ? new Date(state.conversationAt).toISOString() : null,
            complete: true,
          };
        });
      } catch { /* Retain the last complete, validated observation. */ }
      return current.known;
    }).finally(() => { current.pending = null; });
    return current.pending;
  };
}


export async function applyClaudeAgentTerminals(agents, recordsByFile, fileByAgentId, read) {
  const terminals = new Map();
  const launchesByAgentId = new Map();
  const observationsByFile = new Map();
  const notifications = [];
  let sessionEntries = 0;
  for (const file of recordsByFile.keys()) {
    const observation = await read(file);
    const entries = 1 + observation.launches.size + observation.notifications.length;
    if (sessionEntries + entries > MAX_SESSION_ENTRIES) throw new Error("Claude agent lifecycle evidence exceeds session bound.");
    sessionEntries += entries;
    observationsByFile.set(file, observation);
    for (const [id, terminal] of observation.terminals) {
      // Duplicate native identities across parents are ambiguous.
      terminals.set(id, terminals.has(id) ? null : terminal);
    }
    for (const [id, launch] of observation.launches) {
      if (!launchesByAgentId.has(id)) launchesByAgentId.set(id, []);
      launchesByAgentId.get(id).push({ ...launch, file });
    }
    notifications.push(...observation.notifications.map((notification) => ({ ...notification, file })));
  }
  for (const [id, launches] of launchesByAgentId) {
    // Multiple parents can expose the same native identity. Do not let a
    // same-file match conceal that ambiguity from the session-level result.
    if (launches.length !== 1) terminals.set(id, null);
  }
  for (const notification of notifications) {
    // Cross-lane receipts must carry the originating tool call. A task ID by
    // itself cannot safely survive a relaunch or identify one parent lane.
    if (!notification.callId) continue;
    const launches = launchesByAgentId.get(notification.taskId);
    if (!launches || launches.length !== 1) continue;
    const launch = launches[0];
    if (launch.file === notification.file || launch.callId !== notification.callId
      || Date.parse(notification.timestamp) < launch.startedAt) continue;
    const terminal = { status: notification.status === "completed" ? "finished" : "stopped", timestamp: notification.timestamp, crossFile: true };
    const existing = terminals.get(notification.taskId);
    if (!terminals.has(notification.taskId)) terminals.set(notification.taskId, terminal);
    else if (existing && Date.parse(terminal.timestamp) < Date.parse(existing.timestamp)) terminals.set(notification.taskId, terminal);
  }
  for (const agent of agents) {
    if (agent.id === "primary" || agent.workflowId || agent.status === "stopped") continue;
    const file = fileByAgentId.get(agent.id);
    const records = recordsByFile.get(file) || [];
    const observation = observationsByFile.get(file);
    const completeConversationAt = Date.parse(observation?.conversationAt || "");
    const terminal = currentClaudeAgentTerminal(records, terminals.get(agent.id.replace(/^agent-/, "")), completeConversationAt, observation?.complete === true);
    if (!terminal) continue;
    agent.status = terminal.status;
    agent.lastSeen = terminal.timestamp;
    agent.updatedAt = terminal.timestamp;
    agent.durationMs = Math.max(0, Date.parse(terminal.timestamp) - Date.parse(agent.startedAt));
  }
}
