import crypto from "node:crypto";
import fs from "node:fs";
import { claudeTerminalTaskNotification } from "./claude-background-lifecycle.mjs";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";

const MAX_FILES = 100;
const MAX_AGENTS = 256;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const safeId = (value) => typeof value === "string" && ID.test(value) ? value : null;

function reduceAgentLifecycle(state, record) {
  const timestamp = Date.parse(record?.timestamp || "");
  if (!Number.isFinite(timestamp)) return state;
  const terminal = claudeTerminalTaskNotification(record);
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
      if (state.calls.size >= MAX_AGENTS) { state.complete = false; continue; }
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
export function currentClaudeAgentTerminal(records, terminal) {
  if (!terminal) return null;
  const completedAt = Date.parse(terminal.timestamp);
  return records.some((record) => ["user", "assistant"].includes(record.type)
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
 * Only bounded matched terminal states leave this private reader. The committed
 * normalized agent persists independently of these acquisition cursors.
 */
export function createClaudeAgentLifecycleReader() {
  const files = new Map();
  return async function read(file) {
    let item = files.get(file);
    if (!item) {
      if (files.size >= MAX_FILES) {
        const victim = [...files].find(([, value]) => !value.pending);
        if (!victim) return new Map();
        files.delete(victim[0]);
      }
      item = { source: null, generation: 0, known: new Map(), pending: null, ingestor: null };
      item.ingestor = createIncrementalJsonlIngestor({
        readChunk(offset, bytes) {
          const descriptor = fs.openSync(file, "r");
          try {
            const buffer = Buffer.alloc(bytes);
            return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, bytes, offset));
          } finally { fs.closeSync(descriptor); }
        },
        parseRecord: (line) => JSON.parse(line.toString("utf8")),
        initialState: () => ({ calls: new Map(), agents: new Map(), complete: true }),
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
          current.known = new Map([...state.agents].flatMap(([id, agent]) => agent.terminal ? [[id, { ...agent.terminal }]] : []));
        });
      } catch { /* Retain the last complete, validated observation. */ }
      return current.known;
    }).finally(() => { current.pending = null; });
    return current.pending;
  };
}


export async function applyClaudeAgentTerminals(agents, recordsByFile, fileByAgentId, read) {
  const terminals = new Map();
  for (const file of recordsByFile.keys()) {
    for (const [id, terminal] of await read(file)) {
      // Duplicate native identities across parents are ambiguous.
      terminals.set(id, terminals.has(id) ? null : terminal);
    }
  }
  for (const agent of agents) {
    if (agent.id === "primary" || agent.workflowId || agent.status === "stopped") continue;
    const records = recordsByFile.get(fileByAgentId.get(agent.id)) || [];
    const terminal = currentClaudeAgentTerminal(records, terminals.get(agent.id.replace(/^agent-/, "")));
    if (!terminal) continue;
    agent.status = terminal.status;
    agent.lastSeen = terminal.timestamp;
    agent.updatedAt = terminal.timestamp;
    agent.durationMs = Math.max(0, Date.parse(terminal.timestamp) - Date.parse(agent.startedAt));
  }
}
