import fs from "node:fs";
import path from "node:path";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";

const MAX_SESSIONS = 50;
const MAX_OPEN_TASKS = 256;
const MAX_PENDING_CALLS = 256;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL = new Set(["completed", "failed", "error", "stopped", "killed", "cancelled", "canceled", "interrupted"]);
const safeId = (value) => typeof value === "string" && ID.test(value) ? value : null;

function terminalNotification(record) {
  const content = record?.type === "queue-operation" && record.operation === "enqueue"
    ? record.content
    : record?.type === "user" && record.origin?.kind === "task-notification" && record.promptSource === "system"
      ? record.message?.content : null;
  if (typeof content !== "string" || !content.includes("<task-notification>")) return null;
  const status = content.match(/<status>([^<]+)<\/status>/)?.[1]?.trim();
  if (!TERMINAL.has(status)) return null;
  return safeId(content.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim());
}

function launchedTaskId(tool, result) {
  if (tool === "Workflow" && result?.status === "async_launched" && result.taskType === "local_workflow") return safeId(result.taskId);
  if (tool === "Bash") return safeId(result?.backgroundTaskId);
  // Native background agents report their task identity as agentId, not taskId.
  // Launch intent or a foreground Agent result does not establish open background work.
  if (tool === "Agent" && result?.status === "async_launched" && result.isAsync === true) return safeId(result.agentId);
  return null;
}

function reduceLifecycle(state, record, ownerStartedAt) {
  const timestamp = Date.parse(record?.timestamp || "");
  if (!Number.isFinite(timestamp) || timestamp < ownerStartedAt) return state;
  const terminal = terminalNotification(record);
  if (terminal) state.running.delete(terminal);
  const parts = Array.isArray(record?.message?.content) ? record.message.content : [];
  for (const part of parts) {
    if (record.type === "assistant" && part.type === "tool_use" && ["Workflow", "Bash", "Agent"].includes(part.name)) {
      const id = safeId(part.id);
      if (!id) continue;
      if (state.calls.size >= MAX_PENDING_CALLS) { state.complete = false; continue; }
      state.calls.set(id, part.name);
    }
    if (record.type !== "user" || part.type !== "tool_result") continue;
    const call = state.calls.get(part.tool_use_id);
    state.calls.delete(part.tool_use_id);
    if (!call || part.is_error === true) continue;
    const result = record.toolUseResult;
    const id = launchedTaskId(call, result);
    if (!id) continue;
    if (state.running.size >= MAX_OPEN_TASKS) { state.complete = false; continue; }
    const runId = call === "Workflow" && /^wf_[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(result?.runId || "") ? result.runId : null;
    state.running.set(id, runId);
  }
  return state;
}

/** Complete, owner-scoped provider lifecycle, independent of transcript recency.
 * A successful background launch remains open until its exact provider notification.
 * Raw records/fragments stay in U1/U2; only a tri-state observation leaves this reader.
 */
export function createClaudeBackgroundLifecycleReader() {
  const sessions = new Map();

  function ownerKey(entry) {
    return entry?.resourceOwner && Number.isFinite(entry.ownerStartedAt)
      ? JSON.stringify([entry.sessionId, entry.resourceOwner.pid, entry.resourceOwner.processStartIdentity, entry.ownerStartedAt]) : null;
  }

  function prune(registry) {
    for (const [id, item] of sessions) if (ownerKey(registry.get(id)) !== item.owner) sessions.delete(id);
  }

  async function observe(file, entry) {
    const owner = ownerKey(entry);
    if (!owner) { if (entry?.sessionId) sessions.delete(entry.sessionId); return null; }
    let item = sessions.get(entry.sessionId);
    if (item?.owner !== owner) { sessions.delete(entry.sessionId); item = null; }
    if (!item) {
      if (sessions.size >= MAX_SESSIONS) {
        const victim = [...sessions].find(([, value]) => !value.pending);
        if (!victim) return null;
        sessions.delete(victim[0]);
      }
      const sourceFile = { file };
      item = { sourceFile, owner, generation: 0, source: null, known: null, knownTasks: null, completed: new Set(), pending: null, ingestor: null };
      item.ingestor = createIncrementalJsonlIngestor({
        readChunk(offset, bytes) {
          const descriptor = fs.openSync(sourceFile.file, "r");
          try {
            const buffer = Buffer.alloc(bytes);
            const read = fs.readSync(descriptor, buffer, 0, bytes, offset);
            return buffer.subarray(0, read);
          } finally { fs.closeSync(descriptor); }
        },
        parseRecord: (line) => JSON.parse(line.toString("utf8")),
        initialState: () => ({ calls: new Map(), running: new Map(), complete: true }),
        reduce: (state, record) => reduceLifecycle(state, record, entry.ownerStartedAt),
      });
      sessions.set(entry.sessionId, item);
    }
    if (item.pending) return item.pending;
    const current = item;
    current.sourceFile.file = file;
    current.pending = Promise.resolve().then(async () => {
      try {
        const source = incrementalSourceDescriptor(file);
        if (!source) return current.known;
        const previous = current.source;
        if (previous && (previous.file !== source.file || previous.identity !== source.identity || source.size < previous.size
          || (source.size === previous.size && source.mtimeMs !== previous.mtimeMs))) current.generation += 1;
        current.source = source;
        await current.ingestor.observe({ identity: owner + ":" + current.generation, size: source.size }, (state, metadata) => {
          if (!state.complete || metadata.malformedRecords || metadata.oversizedFragments) return;
          for (const id of current.completed) if (!state.running.has(id)) current.completed.delete(id);
          current.knownTasks = new Map([...state.running].filter(([id]) => !current.completed.has(id)));
          current.known = state.running.size > 0;
        });
        if (current.knownTasks) {
          for (const [id, runId] of current.knownTasks) {
            if (!runId) continue;
            const manifestFile = path.join(path.dirname(file), entry.sessionId, "workflows", runId + ".json");
            try {
              const stat = fs.statSync(manifestFile);
              if (!stat.isFile() || stat.size > 512 * 1024) continue;
              const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
              if (manifest?.runId === runId && manifest.status === "completed") {
                current.completed.add(id);
                current.knownTasks.delete(id);
              }
            } catch { /* incomplete or absent completion metadata does not close work */ }
            await new Promise((resolve) => setImmediate(resolve));
          }
          current.known = current.knownTasks.size > 0;
        }
        return sessions.get(entry.sessionId) === current ? current.known : null;
      } catch { return current.known; }
    }).finally(() => { current.pending = null; });
    return current.pending;
  }

  return { observe, prune };
}
