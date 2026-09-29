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

function recordTimestamp(record) {
  const milliseconds = Date.parse(record?.timestamp || record?.message?.timestamp || "");
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function commandName(record) {
  const content = record?.message?.content;
  if (typeof content !== "string") return null;
  const match = /<command-name>\s*(\/[^\s<]+)\s*<\/command-name>/i.exec(content);
  return match?.[1] || null;
}

function isModelInvokingCommand(command, companion) {
  if (typeof command?.promptId !== "string" || !command.promptId
    || command.promptId.length > 512 || typeof command?.uuid !== "string" || !command.uuid
    || command.uuid.length > 512) return false;
  return companion?.type === "user" && companion.isMeta === true && companion.turnCompanion === true
    && companion.promptId === command.promptId && companion.parentUuid === command.uuid;
}

function isAssistantWorkEvidence(record) {
  if (record?.type !== "assistant" || record.isMeta || record.isCompactSummary || record.isApiErrorMessage) return false;
  const message = record.message;
  if (!message || typeof message !== "object" || message.model === "<synthetic>" || message.usage?.synthetic === true) return false;
  if (typeof message.model === "string" && message.model) return true;
  return Array.isArray(message.content) && message.content.some((part) => part?.type === "tool_use");
}

function hasLocalCommandWrapper(content) {
  const values = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.map((part) => part?.text).filter((part) => typeof part === "string") : [];
  return values.some((value) => /<local-command-(?:stdout|stderr|caveat)>/i.test(value));
}

function isDirectWorkInput(record) {
  const content = record?.message?.content;
  return !commandName(record)
    && !hasLocalCommandWrapper(content)
    && Boolean(userInputContentType(record));
}

function earlierTimestamp(current, candidate) {
  return !current || candidate < current ? candidate : current;
}

export function createClaudeSessionWorkStartState() {
  return { startedAt: null, pendingCommand: null };
}

/** Adapter-private reducer; it retains only an initiating timestamp and opaque command linkage. */
export function reduceClaudeSessionWorkStart(state, record) {
  const timestamp = recordTimestamp(record);
  let startedAt = state.startedAt;
  let pendingCommand = state.pendingCommand;
  if (state.pendingCommand) {
    if (isModelInvokingCommand(state.pendingCommand, record)) {
      startedAt = earlierTimestamp(startedAt, state.pendingCommand.timestamp);
    }
    pendingCommand = null;
  }
  if (!timestamp) return { startedAt, pendingCommand };
  const name = commandName(record);
  if (name && name !== "/clear" && record.type === "user" && !record.isMeta
    && typeof record.promptId === "string" && record.promptId.length > 0 && record.promptId.length <= 512
    && typeof record.uuid === "string" && record.uuid.length > 0 && record.uuid.length <= 512) {
    pendingCommand = { promptId: record.promptId, uuid: record.uuid, timestamp };
  }
  if (isDirectWorkInput(record) || isAssistantWorkEvidence(record)) {
    startedAt = earlierTimestamp(startedAt, timestamp);
  }
  return { startedAt, pendingCommand };
}

/**
 * Finds the first recorded main-session action that initiated model work.
 * Command text stays private: command records qualify only through Claude's
 * prompt/turn-companion linkage, never by command-name heuristics.
 */
export function claudeSessionWorkStartedAt(records) {
  let state = createClaudeSessionWorkStartState();
  for (const record of records) state = reduceClaudeSessionWorkStart(state, record);
  return state.startedAt;
}

function retain(map, key, value, maximum = MAX_ENTRIES) {
  map.set(key, value);
  if (maximum !== Infinity && map.size > maximum) map.delete(map.keys().next().value);
}

function hasReplyText(content) {
  if (typeof content === "string") return Boolean(content.trim());
  return Array.isArray(content) && content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
}

export function claudeReplyActivityId(actorId, identity) {
  return `claude-reply-${crypto.createHash("sha256").update(`${actorId}:${identity}`).digest("hex").slice(0, 20)}`;
}

/** Presence metadata only: never retain message or summary content. */
export function claudeConversationActivity(records, actor = { id: "primary", label: "Primary agent" }, events = new Map(), maximum = MAX_ENTRIES) {
  for (const record of records) {
    if (!record || record.isMeta || record.isCompactSummary || record.isApiErrorMessage) continue;
    const summary = record.type === "system" && record.subtype === "away_summary"
      && typeof record.content === "string" && Boolean(record.content.trim());
    const reply = record.type === "assistant" && record.message?.model !== "<synthetic>"
      && record.message?.usage?.synthetic !== true && hasReplyText(record.message?.content);
    if (!summary && !reply) continue;
    const rawTime = record.timestamp ?? record.message?.timestamp;
    const time = typeof rawTime === "string" ? Date.parse(rawTime) : NaN;
    if (!Number.isFinite(time)) continue;
    const timestamp = new Date(time).toISOString();
    const identity = summary ? record.uuid || timestamp : record.message?.id || record.requestId || record.uuid;
    if (typeof identity !== "string" || !identity.trim() || identity.length > 512) continue;
    const id = summary
      ? `claude-summary-${crypto.createHash("sha256").update(`${actor.id}:${identity}`).digest("hex").slice(0, 20)}`
      : claudeReplyActivityId(actor.id, identity);
    const previous = events.get(id);
    if (previous && Date.parse(previous.timestamp) >= time) continue;
    retain(events, id, {
      id, timestamp, actor: summary ? "System" : actor.label,
      tool: summary ? "Summary updated" : "Assistant replied", workKind: "report", detail: "", status: null,
    }, maximum);
  }
  return [...events.values()];
}

/** U2: delivery is activity; queue operations alone are not a delivered notification. */
function emptyActivityState() {
  return { calls: new Map(), launches: new Map(), events: new Map() };
}

export function claudeTaskNotificationActivity(records, state = emptyActivityState(), maximum = MAX_ENTRIES) {
  const { calls, launches, events } = state;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    for (const part of Array.isArray(record.message?.content) ? record.message.content : []) {
      if (record.type === "assistant" && part?.type === "tool_use" && TASK_KINDS.has(part.name) && typeof part.id === "string") {
        retain(calls, part.id, part.name, maximum);
      }
      if (record.type === "user" && part?.type === "tool_result") {
        const tool = calls.get(part.tool_use_id);
        calls.delete(part.tool_use_id);
        const taskId = part.is_error === true ? null : claudeLaunchedTaskId(tool, record.toolUseResult);
        if (taskId) retain(launches, taskId, { tool, callId: part.tool_use_id }, maximum);
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
    }, maximum);
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
export function createClaudeActivityReader() {
  const files = new Map();
  return async function read(file, actor = { id: "primary", label: "Primary agent" }, precomputedDescriptor) {
    const key = `${file}\0${actor.id}`;
    const labelEvents = (events) => events.map((event) => event.tool === "Assistant replied" ? { ...event, actor: actor.label } : event);
    let item = files.get(key);
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
        reduce(state, record) {
          if (actor.id === "primary") claudeTaskNotificationActivity([record], state);
          claudeConversationActivity([record], actor, state.events);
          return state;
        },
      });
      files.set(key, item);
    }
    if (item.pending) return item.pending.then(labelEvents);
    files.delete(key);
    files.set(key, item);
    const current = item;
    current.pending = Promise.resolve().then(async () => {
      try {
        const source = precomputedDescriptor !== undefined ? precomputedDescriptor : incrementalSourceDescriptor(file);
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
    return current.pending.then(labelEvents);
  };
}
