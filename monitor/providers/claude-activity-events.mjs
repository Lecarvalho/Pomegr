import crypto from "node:crypto";
import fs from "node:fs";
import { claudeLaunchedTaskId, claudeTerminalTaskNotification } from "./claude-background-lifecycle.mjs";
import { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";

const INPUT_KIND_LABELS = [["text", "Text"], ["document", "Document"], ["image", "Image"]];
const TASK_KINDS = new Map([
  ["Agent", { detail: "Background agent", workKind: "agent" }],
  ["Bash", { detail: "Background command", workKind: "shell" }],
  ["Workflow", { detail: "Background workflow", workKind: "agent" }],
]);
const GENERIC_TASK = { detail: "Background task", workKind: "process" };
const MAX_ENTRIES = 256;

export function isClaudeSystemTaskNotification(record) {
  return record?.type === "user" && record.origin?.kind === "task-notification" && record.promptSource === "system";
}

function inputKind(part) {
  if (!part || typeof part !== "object") return null;
  const mediaType = part.source?.media_type || part.media_type || part.mime_type || "";
  if (part.type === "image" || String(mediaType).startsWith("image/")) return "image";
  if (part.type === "document" || part.type === "file" || mediaType) return "document";
  if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return "text";
  return null;
}

export function userInputContentType(record, requestedInputIds = new Set()) {
  if (record?.type !== "user" || record.isMeta || record.isCompactSummary || isClaudeSystemTaskNotification(record)) return null;
  const content = record.message?.content;
  const kinds = new Set();
  if (typeof content === "string" && content.trim()) kinds.add("text");
  const parts = [
    ...(Array.isArray(content) ? content : []),
    ...(Array.isArray(record.message?.attachments) ? record.message.attachments : []),
    ...(Array.isArray(record.attachments) ? record.attachments : []),
  ];
  for (const part of parts) {
    const kind = inputKind(part);
    if (kind) kinds.add(kind);
    if (part?.type === "tool_result" && requestedInputIds.has(part.tool_use_id)) kinds.add("text");
  }
  const labels = INPUT_KIND_LABELS.flatMap(([kind, label]) => kinds.has(kind) ? [label] : []);
  return labels.length ? labels.join(" + ") : null;
}

function retain(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

/** U2: delivery is activity; queue operations alone are not a delivered notification. */
function emptyActivityState() {
  return { calls: new Map(), launches: new Map(), events: new Map() };
}

export function claudeTaskNotificationActivity(records, state = emptyActivityState()) {
  const { calls, launches, events } = state;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    for (const part of Array.isArray(record.message?.content) ? record.message.content : []) {
      if (record.type === "assistant" && part?.type === "tool_use" && TASK_KINDS.has(part.name) && typeof part.id === "string") {
        retain(calls, part.id, part.name);
      }
      if (record.type === "user" && part?.type === "tool_result") {
        const tool = calls.get(part.tool_use_id);
        calls.delete(part.tool_use_id);
        const taskId = part.is_error === true ? null : claudeLaunchedTaskId(tool, record.toolUseResult);
        if (taskId) retain(launches, taskId, { tool, callId: part.tool_use_id });
      }
    }
    if (!isClaudeSystemTaskNotification(record) || record.isCompactSummary) continue;
    const terminal = claudeTerminalTaskNotification(record);
    const time = Date.parse(record.timestamp || record.message?.timestamp || "");
    if (!terminal || !Number.isFinite(time)) continue;
    const timestamp = new Date(time).toISOString();
    const launch = launches.get(terminal.taskId);
    const kind = launch && (!terminal.callId || terminal.callId === launch.callId) ? TASK_KINDS.get(launch.tool) : GENERIC_TASK;
    const outcome = terminal.status === "completed" ? "completed" : ["failed", "error"].includes(terminal.status) ? "failed" : "stopped";
    const identity = typeof record.uuid === "string" && record.uuid ? record.uuid : `${terminal.taskId}:${timestamp}`;
    const id = `claude-notification-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
    retain(events, id, {
      id, timestamp, actor: "System", tool: `Task ${outcome}`, ...kind,
      status: outcome === "failed" ? "failed" : null,
    });
  }
  return [...events.values()];
}

function priorSuffixMatches(file, source) {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(source.suffixBytes);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, source.size - buffer.length);
    return bytes === buffer.length && crypto.createHash("sha256").update(buffer).digest("hex") === source.suffixDigest;
  } finally { fs.closeSync(descriptor); }
}

/** Complete, yielding replay retains normalized deliveries independently of acquisition tails. */
export function createClaudeTaskNotificationReader() {
  const files = new Map();
  return async function read(file) {
    let item = files.get(file);
    if (!item) {
      if (files.size >= 50) {
        const victim = [...files].find(([, value]) => !value.pending);
        if (!victim) return [];
        files.delete(victim[0]);
      }
      item = { source: null, generation: 0, known: [], pending: null, ingestor: null };
      item.ingestor = createIncrementalJsonlIngestor({
        readChunk(offset, bytes) {
          const descriptor = fs.openSync(file, "r");
          try {
            const buffer = Buffer.alloc(bytes);
            return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, bytes, offset));
          } finally { fs.closeSync(descriptor); }
        },
        parseRecord: (line) => JSON.parse(line.toString("utf8")),
        initialState: emptyActivityState,
        reduce(state, record) { claudeTaskNotificationActivity([record], state); return state; },
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
        await current.ingestor.observe({ identity: `${source.identity}:${current.generation}`, size: source.size }, (state, metadata) => {
          if (metadata.malformedRecords || metadata.oversizedFragments) return;
          current.known = [...state.events.values()];
        });
      } catch { /* Preserve the last complete normalized observation. */ }
      return current.known;
    }).finally(() => { current.pending = null; });
    return current.pending;
  };
}
