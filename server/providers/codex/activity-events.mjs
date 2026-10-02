import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mutationScopes, repetitionSignature } from "../../normalize/tool-efficiency.mjs";
import { codexTimestamp } from "./session-metadata.mjs";
import { toolWorkKind } from "../../normalize/work-kind.mjs";
import { boundedActivityDuration, boundedFileChanges } from "../../normalize/activity-events.mjs";
import { collapsedText } from "../../normalize/primitives.mjs";
import { isCodeModeWrapper, normalizedStatus, rolloutExecutionItemKind, rolloutExecutionStatus, rolloutExecutionTiming } from "./execution-items.mjs";

export { bindCodexFileChanges } from "./file-change-binding.mjs";

const MAX_IDENTIFIER_LENGTH = 80;
const MAX_DETAIL_LENGTH = 96;
const MAX_CALL_ID_LENGTH = 160;
const MAX_ASSISTANT_REPLIES = 256;
const ASSISTANT_REPLY_TOOL = "Assistant replied";
const ASSISTANT_REPLY_WORK_KIND = "reply";

function safeIdentifier(value) {
  return collapsedText(value, MAX_IDENTIFIER_LENGTH).replace(/[^A-Za-z0-9_.:/ -]/g, "").trim();
}

function safeBasename(value) {
  if (typeof value !== "string") return "";
  return collapsedText(value.split(/[\\/]/).filter(Boolean).at(-1), MAX_DETAIL_LENGTH);
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function digest(value, length = 20) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function rawCallId(value) {
  return collapsedText(value, MAX_CALL_ID_LENGTH);
}

export function stableCodexCallId(actorId, providerCallId, fallbackIdentity = "") {
  const identity = rawCallId(providerCallId) || collapsedText(fallbackIdentity, 512);
  return `codex-${digest(`${actorId}|${identity}`)}`;
}

export function stableCodexActivityId(actorId, identity) {
  return `codex-activity-${digest(`${actorId}|${collapsedText(identity, 1024)}`)}`;
}

function replyText(value) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .filter((item) => item && typeof item === "object"
      && ["output_text", "text"].includes(String(item.type || "").toLowerCase()))
    .map((item) => typeof item.text === "string" ? item.text : "")
    .join("")
    .trim();
}

function assistantReplyPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const channel = String(value.channel ?? value.message_channel ?? value.messageChannel ?? "").toLowerCase();
  const synthetic = value.synthetic === true || value.is_synthetic === true || value.isSynthetic === true
    || value.metadata?.synthetic === true || value.metadata?.isSynthetic === true;
  if (synthetic || ["analysis", "reasoning", "thinking"].includes(channel)) return null;
  const type = String(value.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (type === "agentmessage") {
    const text = replyText(value.text ?? value.message ?? value.content);
    return text ? { text, id: value.id ?? value.item_id ?? value.itemId, phase: value.phase } : null;
  }
  if (type !== "message" || value.role !== "assistant") return null;
  const text = replyText(value.content ?? value.text);
  return text ? { text, id: value.id ?? value.item_id ?? value.itemId, phase: value.phase } : null;
}

function replyNativeId(value) {
  const id = value?.id ?? value?.item_id ?? value?.itemId ?? value?.message_id ?? value?.messageId;
  return rawCallId(id);
}

function replyTextDigest(text) {
  // The source record is acquisition-bounded; retain only its private digest.
  return digest(text);
}

function makeAssistantReply({ actor, identity, timestamp }) {
  if (!timestamp || !identity) return null;
  return {
    id: stableCodexActivityId(actor.id, identity),
    timestamp,
    actor: actor.label,
    tool: ASSISTANT_REPLY_TOOL,
    workKind: ASSISTANT_REPLY_WORK_KIND,
    detail: "",
    status: null,
  };
}

function replyOccurrenceKey(info, sourceKey = "") {
  return `${sourceKey}|${String(info.phase || "")}|${replyTextDigest(info.text)}`;
}

function boundedReplyEvents(events, maximum = MAX_ASSISTANT_REPLIES) {
  return [...events]
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id))
    .slice(maximum === Infinity ? 0 : -maximum);
}

/** Normalize canonical app-server agent-message thread items without retaining text. */
export function parseCodexCanonicalActivityEvents(turns, options = {}) {
  const actor = options.actor || { id: "primary", label: "Primary agent" };
  const events = new Map();
  for (const turn of (Array.isArray(turns) ? turns : [])) {
    for (const item of (Array.isArray(turn?.items) ? turn.items : [])) {
      const info = assistantReplyPayload(item);
      const nativeId = replyNativeId(item);
      if (!info || !nativeId) continue;
      const timestamp = codexTimestamp(item.timestamp ?? item.completedAt ?? item.createdAt)
        || (info.phase === "final_answer" ? codexTimestamp(turn.completedAt) : null);
      const event = makeAssistantReply({ actor, identity: `message:${nativeId}`, timestamp });
      if (!event) continue;
      const previous = events.get(event.id);
      if (!previous || Date.parse(event.timestamp) > Date.parse(previous.timestamp)) events.set(event.id, event);
    }
  }
  return boundedReplyEvents(events.values(), options.unlimited === true ? Infinity : MAX_ASSISTANT_REPLIES);
}

function webActionDetail(action) {
  const type = String(action?.type || "").toLowerCase().replace(/[_ -]/g, "");
  if (type === "openpage") return "Open page";
  if (type === "findinpage") return "Find in page";
  if (type === "search") return "Search";
  return "Web activity";
}

function collaborationTool(value) {
  const name = String(value || "").split(/[:./]/).at(-1).toLowerCase().replace(/[^a-z]/g, "");
  if (name === "spawnagent") return "Spawn agent";
  if (["sendinput", "sendmessage", "followuptask"].includes(name)) return "Send to agent";
  if (name === "resumeagent") return "Resume agent";
  if (["closeagent", "interruptagent"].includes(name)) return "Stop agent";
  if (["wait", "waitagent"].includes(name)) return "Wait for agent";
  if (name === "listagents") return "List agents";
  return null;
}

function mcpDetail(server, tool) {
  const safeServer = safeIdentifier(server);
  const safeTool = safeIdentifier(tool);
  return collapsedText([safeServer, safeTool].filter(Boolean).join(" / "), MAX_DETAIL_LENGTH);
}

const PATCH_FILE_HEADER = /^\*\*\* (Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;

/** Structured candidates from an apply_patch body: headers only, never the diff body. */
function patchFileChangeCandidates(patch) {
  if (typeof patch !== "string") return [];
  const candidates = [];
  let current = null;
  for (const match of patch.matchAll(PATCH_FILE_HEADER)) {
    const action = match[1];
    const target = match[2];
    if (!target) { current = null; continue; }
    if (action === "Move to") {
      if (current && current.kind === "edited") {
        current.previousTarget = current.target;
        current.target = target;
        current.kind = "moved";
      }
      continue;
    }
    current = {
      target, kind: action === "Add File" ? "created" : action === "Delete File" ? "deleted" : "edited",
      previousTarget: /** @type {string | undefined} */ (undefined),
    };
    candidates.push(current);
  }
  return candidates;
}

function canonicalFileChangeKind(kind) {
  const type = typeof kind === "string" ? kind : kind?.type;
  const normalized = String(type || "").toLowerCase();
  if (normalized === "add") return "created";
  if (normalized === "update") return "edited";
  if (normalized === "delete") return "deleted";
  return null;
}

/** Structured candidates from canonical fileChange items: add/update/delete, plus update moves. */
function canonicalFileChangeCandidates(changes) {
  return (Array.isArray(changes) ? changes : []).flatMap((change) => {
    const target = typeof change?.path === "string" ? change.path : null;
    const kind = canonicalFileChangeKind(change?.kind);
    if (!target || !kind) return [];
    const movePath = change.kind?.move_path ?? change.kind?.movePath;
    if (kind === "edited" && typeof movePath === "string" && movePath) {
      return [{ target: movePath, kind: "moved", previousTarget: target }];
    }
    return [{ target, kind }];
  });
}

/** Rollout FileChange items key changes by path; reshape them into canonical change entries. */
function rolloutFileChangeList(changes) {
  if (Array.isArray(changes)) return changes;
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes).map(([changePath, change]) => ({ path: changePath, kind: change }));
}

/** A recognized extension item reduced to its canonical item; an unrecognized one records nothing. */
function extensionDescriptor(item) {
  const kind = String(item.kind || "").toLowerCase();
  if (kind === "web.search") return canonicalDescriptor({ type: "webSearch", action: item.action, query: item.query });
  if (kind === "clock.sleep") return canonicalDescriptor({ type: "sleep", durationMs: item.durationMs ?? item.duration_ms });
  if (kind === "image_gen.generation") return canonicalDescriptor({ type: "imageGeneration" });
  return null;
}

function rolloutExecutionDescriptor(kind, item) {
  if (kind === "extension") return extensionDescriptor(item);
  if (kind === "imageview") return canonicalDescriptor({ type: "imageView", path: item.path });
  if (kind === "websearch") return canonicalDescriptor({ type: "webSearch", action: item.action, query: item.query });
  if (kind === "collabagenttoolcall") return canonicalDescriptor({ ...item, type: "collabAgentToolCall" });
  if (kind === "dynamictoolcall") return canonicalDescriptor({ type: "dynamicToolCall", namespace: item.namespace, tool: item.tool, arguments: item.arguments });
  if (kind === "filechange") return canonicalDescriptor({ type: "fileChange", changes: rolloutFileChangeList(item.changes) });
  if (kind === "commandexecution") return canonicalDescriptor({
    type: "commandExecution", command: item.command, commandActions: item.parsed_cmd ?? item.commandActions, cwd: item.cwd,
  });
  return canonicalDescriptor({ type: "mcpToolCall", server: item.server, tool: item.tool, arguments: item.arguments });
}

function functionDescriptor(name, input, namespace = "") {
  const normalized = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // Code mode's own `wait` resumes a yielded exec cell; it names a cell, never an agent.
  if (normalized === "wait" && namespace !== "collaboration" && input?.cell_id !== undefined) {
    return { tool: "Wait", detail: "", repetitionInput: input, mutationInput: null };
  }
  if (normalized === "sleep" && namespace === "clock") {
    return canonicalDescriptor({ type: "sleep", durationMs: input?.duration_ms ?? input?.durationMs });
  }
  const collaboration = collaborationTool(name);
  if (collaboration) return { tool: collaboration, detail: "", repetitionInput: input, mutationInput: null };
  if (["shellcommand", "execcommand", "commandexecution"].includes(normalized)) {
    return { tool: "Shell", detail: "Command execution", repetitionInput: input, mutationInput: null };
  }
  if (["applypatch", "filechange"].includes(normalized)) {
    const patch = typeof input === "string" ? input : input?.patch ?? input?.input;
    const paths = typeof patch === "string"
      ? [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm)].map((match) => match[1])
      : [];
    const detail = paths.length === 1 ? safeBasename(paths[0]) : paths.length > 1 ? `${safeBasename(paths[0])} +${paths.length - 1}` : "File change";
    return {
      tool: "File change", detail, repetitionInput: { patch }, mutationInput: { tool: "apply_patch", input: { patch } }, mutationPaths: paths,
      fileChangeCandidates: patchFileChangeCandidates(patch),
    };
  }
  if (normalized === "requestuserinput" || normalized === "requestuserinputasync") {
    return { tool: "Request input", detail: "User input", repetitionInput: input, mutationInput: null };
  }
  if (["viewimage", "imageview"].includes(normalized)) {
    const imagePath = input?.path ?? input?.file_path;
    return { tool: "View image", detail: safeBasename(imagePath), repetitionInput: input, mutationInput: null };
  }
  if (normalized.includes("imagegen") || normalized === "imagegeneration") {
    return { tool: "Image generation", detail: "Generate image", repetitionInput: input, mutationInput: null };
  }
  if (normalized === "webrun" || normalized === "websearch" || normalized === "searchquery") {
    return { tool: "Web search", detail: "Web activity", repetitionInput: input, mutationInput: null };
  }
  if (normalized === "sendusermessageasync") {
    return { tool: "Message to user", detail: "", repetitionInput: input, mutationInput: null };
  }
  if (normalized === "updateplan") {
    return { tool: "Plan update", detail: "", repetitionInput: input, mutationInput: null };
  }
  if (normalized === "writestdin") {
    return { tool: "Shell input", detail: "", repetitionInput: input, mutationInput: null };
  }
  // A namespaced MCP function call is the same call its completed McpToolCall item records.
  if (String(namespace || "").startsWith("mcp__")) {
    return { tool: "MCP", detail: mcpDetail(String(namespace).slice(5), name), repetitionInput: input, mutationInput: null };
  }
  if (String(name || "").startsWith("mcp__")) {
    const parts = String(name).split("__");
    return { tool: "MCP", detail: mcpDetail(parts[1], parts.slice(2).join("__")), repetitionInput: input, mutationInput: null };
  }
  if (normalized === "toolsearch" || normalized === "toolsearchcall") {
    return { tool: "Tool search", detail: "Discover tools", repetitionInput: input, mutationInput: null };
  }
  const detail = mcpDetail(namespace, name) || "Tool call";
  // An exec wrapper's completion cannot prove that a nested literal patch call
  // ran (or succeeded). Only provider-native apply_patch/fileChange records
  // supply structured mutation evidence.
  return { tool: "Dynamic tool", detail, repetitionInput: input, mutationInput: null, fileChangeCandidates: [] };
}

function canonicalDescriptor(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (item.type === "commandExecution") return {
    tool: "Shell",
    detail: "Command execution",
    repetitionInput: { command: item.command, commandActions: item.commandActions, cwd: item.cwd },
    mutationInput: null,
  };
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map((change) => change?.path).filter((value) => typeof value === "string");
    const detail = paths.length === 1 ? safeBasename(paths[0]) : paths.length > 1 ? `${safeBasename(paths[0])} +${paths.length - 1}` : "File change";
    return {
      tool: "File change", detail, repetitionInput: { changes }, mutationInput: { tool: "fileChange", input: { changes } }, mutationPaths: paths,
      fileChangeCandidates: canonicalFileChangeCandidates(changes),
    };
  }
  if (item.type === "mcpToolCall") return {
    tool: "MCP",
    detail: mcpDetail(item.server, item.tool),
    repetitionInput: { server: item.server, tool: item.tool, arguments: item.arguments },
    mutationInput: null,
  };
  if (item.type === "dynamicToolCall") return {
    tool: "Dynamic tool",
    detail: mcpDetail(item.namespace, item.tool) || "Tool call",
    repetitionInput: { namespace: item.namespace, tool: item.tool, arguments: item.arguments },
    mutationInput: null,
  };
  if (item.type === "collabAgentToolCall") {
    const tool = collaborationTool(item.tool);
    return tool ? {
      tool,
      detail: "",
      repetitionInput: {
        tool: item.tool,
        prompt: item.prompt,
        senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      },
      mutationInput: null,
    } : null;
  }
  if (item.type === "webSearch") return {
    tool: "Web search",
    detail: webActionDetail(item.action),
    repetitionInput: { action: item.action, query: item.query },
    mutationInput: null,
  };
  if (item.type === "imageView") return {
    tool: "View image",
    detail: safeBasename(item.path),
    repetitionInput: { path: item.path },
    mutationInput: null,
  };
  if (item.type === "imageGeneration") return {
    tool: "Image generation",
    detail: "Generate image",
    repetitionInput: { revisedPrompt: item.revisedPrompt },
    mutationInput: null,
  };
  if (item.type === "sleep") return {
    tool: "Wait",
    detail: Number.isFinite(item.durationMs) ? `${Math.max(0, Math.round(item.durationMs))}ms` : "",
    repetitionInput: { durationMs: item.durationMs },
    mutationInput: null,
  };
  return null;
}

function responseDescriptor(payload) {
  if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
    const rawInput = payload.arguments ?? payload.input;
    return functionDescriptor(payload.name, parseObject(rawInput) ?? rawInput, payload.namespace);
  }
  if (payload?.type === "local_shell_call") return {
    tool: "Shell",
    detail: "Command execution",
    repetitionInput: { action: payload.action },
    mutationInput: null,
  };
  if (payload?.type === "tool_search_call") return {
    tool: "Tool search",
    detail: "Discover tools",
    repetitionInput: { arguments: payload.arguments, execution: payload.execution },
    mutationInput: null,
  };
  if (payload?.type === "web_search_call") return {
    tool: "Web search",
    detail: webActionDetail(payload.action),
    repetitionInput: { action: payload.action },
    mutationInput: null,
  };
  if (payload?.type === "image_generation_call") return {
    tool: "Image generation",
    detail: "Generate image",
    repetitionInput: { revisedPrompt: payload.revised_prompt },
    mutationInput: null,
  };
  return null;
}

function eventDescriptor(payload) {
  const type = String(payload?.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (type === "collabagenttoolcall") return canonicalDescriptor({
    ...payload,
    type: "collabAgentToolCall",
    senderThreadId: payload.senderThreadId ?? payload.sender_thread_id,
    receiverThreadIds: payload.receiverThreadIds ?? payload.receiver_thread_ids,
    reasoningEffort: payload.reasoningEffort ?? payload.reasoning_effort,
  });
  if (type === "execcommandbegin") return functionDescriptor("shell_command", {
    command: payload.command,
    cwd: payload.cwd,
    commandActions: payload.command_actions ?? payload.parsed_cmd,
  });
  if (type === "patchapplybegin") {
    if (Array.isArray(payload.changes)) return canonicalDescriptor({ type: "fileChange", changes: payload.changes });
    return functionDescriptor("apply_patch", payload.patch ?? payload.input ?? "");
  }
  if (type === "mcptoolcallbegin") return canonicalDescriptor({
    type: "mcpToolCall",
    server: payload.server ?? payload.invocation?.server,
    tool: payload.tool ?? payload.invocation?.tool,
    arguments: payload.arguments ?? payload.invocation?.arguments,
  });
  if (type === "websearchbegin") return canonicalDescriptor({
    type: "webSearch",
    action: payload.action,
    query: payload.query,
  });
  if (type === "viewimage") return canonicalDescriptor({ type: "imageView", path: payload.path });
  if (type === "imagegenerationbegin") return canonicalDescriptor({ type: "imageGeneration", revisedPrompt: payload.prompt });
  return null;
}

function mutationEvidence(descriptor) {
  if (!descriptor?.mutationInput) return null;
  const scopes = mutationScopes(descriptor.mutationInput.tool, descriptor.mutationInput.input)
    .map((scope) => digest(scope));
  if (!scopes.length) return null;
  const paths = descriptor.mutationPaths || [];
  const display = paths.length === 1
    ? safeBasename(paths[0])
    : paths.length > 1 ? `${safeBasename(paths[0])} +${paths.length - 1}` : "File change";
  return { display, scopes };
}

function makeCall({ actor, providerCallId, fallbackIdentity, timestamp, descriptor, status, fileChangeCwd }) {
  if (!descriptor || !timestamp) return null;
  return {
    id: stableCodexCallId(actor.id, providerCallId, fallbackIdentity),
    timestamp,
    actor: { id: actor.id, label: actor.label },
    tool: descriptor.tool,
    // A file change's detail is a file name, which says nothing about the kind of work.
    workKind: toolWorkKind(descriptor.tool, { detail: descriptor.tool === "File change" ? "" : descriptor.detail, input: descriptor.repetitionInput }),
    detail: collapsedText(descriptor.detail, MAX_DETAIL_LENGTH),
    status,
    durationMs: null,
    requestId: null,
    repetitionSignature: repetitionSignature(descriptor.tool, descriptor.repetitionInput),
    mutation: mutationEvidence(descriptor),
    // Private working field: raw candidates from a structured file-change item
    // awaiting the finalized status that decides fileChanges. Sealed away by
    // sealCodexFileChanges before any call crosses this module's boundary.
    // Shell commands never contribute: their written files cannot be known reliably.
    fileChangeCandidates: descriptor.fileChangeCandidates || null,
    fileChangeCwd: descriptor.fileChangeCandidates?.length ? fileChangeCwd : undefined,
  };
}

function statusRank(status) {
  return status === "failed" ? 3 : status === "completed" ? 2 : status === "running" ? 1 : 0;
}

export function mergeCodexToolCalls(callGroups) {
  const calls = new Map();
  for (const call of callGroups.flat()) {
    if (!call) continue;
    const previous = calls.get(call.id);
    if (!previous) {
      calls.set(call.id, call);
      continue;
    }
    const nextStatus = statusRank(call.status) >= statusRank(previous.status) ? call.status : previous.status;
    const nextTimestamp = Date.parse(call.timestamp) < Date.parse(previous.timestamp) ? call.timestamp : previous.timestamp;
    calls.set(call.id, {
      ...previous,
      tool: call.tool,
      workKind: call.workKind || previous.workKind,
      detail: call.detail || previous.detail,
      repetitionSignature: call.repetitionSignature,
      mutation: call.mutation || previous.mutation,
      status: nextStatus,
      timestamp: nextTimestamp,
      durationMs: call.durationMs ?? previous.durationMs ?? null,
      requestId: null,
      ...(typeof (call.wrapper ?? previous.wrapper) === "boolean" ? { wrapper: call.wrapper ?? previous.wrapper } : {}),
      // Already-sealed sources (a sealed call never carries fileChangeCandidates)
      // may still disagree on fileChanges; prefer whichever observation has it.
      ...(Object.hasOwn(call, "fileChanges") || Object.hasOwn(previous, "fileChanges")
        ? { fileChanges: call.fileChanges || previous.fileChanges || null }
        : {}),
      ...(call.fileChangeCandidates || previous.fileChangeCandidates
        ? { fileChangeCandidates: call.fileChangeCandidates || previous.fileChangeCandidates, fileChangeCwd: call.fileChangeCwd || previous.fileChangeCwd }
        : {}),
    });
  }
  return [...calls.values()].sort((left, right) => (
    Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id)
  ));
}

/**
 * Convert a call's raw fileChangeCandidates into checkpointed fileChanges
 * once its status is truly final, and strip the private working field so it
 * never reaches evidence.toolCalls (the schema is strict).
 */
/** @param {{ cwd?: string, forbiddenRoots?: string[], deferFileChanges?: boolean }} [options] */
function sealCodexFileChanges(call, status, options = {}) {
  const { cwd, forbiddenRoots = [], deferFileChanges = false } = options;
  const { fileChangeCandidates, fileChangeCwd, ...sealed } = call;
  if (deferFileChanges && status === "completed" && fileChangeCandidates?.length) {
    return { ...sealed, status, fileChanges: null, fileChangeCandidates, fileChangeCwd: fileChangeCwd || cwd };
  }
  return {
    ...sealed,
    status,
    fileChanges: status === "completed" && fileChangeCandidates?.length
      ? boundedFileChanges(fileChangeCandidates, fileChangeCwd || cwd, { forbiddenRoots })
      : null,
  };
}

export function parseCodexCanonicalTurns(turns, options = {}) {
  const actor = options.actor || { id: "primary", label: "Primary agent" };
  const { cwd, forbiddenRoots = [], deferFileChanges = false } = options;
  const calls = [];
  for (const [turnIndex, turn] of (Array.isArray(turns) ? turns : []).entries()) {
    const turnStartedAt = codexTimestamp(turn?.startedAt) || options.fallbackTimestamp;
    const turnCompletedAt = codexTimestamp(turn?.completedAt) || turnStartedAt;
    for (const [itemIndex, item] of (Array.isArray(turn?.items) ? turn.items : []).entries()) {
      const descriptor = canonicalDescriptor(item);
      if (!descriptor) continue;
      const status = normalizedStatus(item.status, turn?.status === "completed" ? "completed" : "running");
      const timestamp = status === "running" ? turnStartedAt : turnCompletedAt;
      calls.push(makeCall({
        actor,
        providerCallId: item.id,
        fallbackIdentity: `canonical:${turn?.id || turnIndex}:${itemIndex}:${item.type}`,
        timestamp,
        descriptor,
        status,
        fileChangeCwd: item?.cwd || cwd,
      }));
    }
  }
  return mergeCodexToolCalls([calls]).map((call) => sealCodexFileChanges(call, call.status, { cwd, forbiddenRoots, deferFileChanges }));
}

/** Normalize delivered assistant text from legacy and streamed rollout records. */
export function parseCodexAssistantReplyRecords(records, options = {}) {
  const actor = options.actor || { id: "primary", label: "Primary agent" };
  const sourceKey = collapsedText(options.sourceKey, 160) || actor.id;
  const events = new Map();
  let precedingEvent = null;
  for (const [recordIndex, record] of (Array.isArray(records) ? records : []).entries()) {
    const payload = record?.payload;
    let candidate = null;
    let candidateSource = payload;
    if (record?.synthetic !== true && payload && typeof payload === "object" && !Array.isArray(payload)) {
      if (record.type === "event_msg" && payload.type === "agent_message") candidate = assistantReplyPayload(payload);
      else if (record.type === "event_msg" && ["item_completed", "item_done"].includes(payload.type)) {
        candidateSource = payload.item;
        candidate = assistantReplyPayload(candidateSource);
      }
      else if (record.type === "response_item") candidate = assistantReplyPayload(payload);
    }
    const timestamp = codexTimestamp(record?.timestamp ?? payload?.timestamp ?? candidateSource?.timestamp);
    if (!candidate || !timestamp) { precedingEvent = null; continue; }
    const nativeId = replyNativeId(candidateSource);
    const signature = replyOccurrenceKey(candidate, sourceKey);
    // Rollouts emit a delivery/completion event followed by its response item.
    // Text/phase equality establishes a mirror only within this adjacent pair.
    const paired = !nativeId && record.type === "response_item" && precedingEvent
      && precedingEvent.signature === signature;
    const identity = nativeId ? `message:${nativeId}` : paired ? precedingEvent.identity : `observed:${timestamp}:${signature}`;
    const event = makeAssistantReply({ actor, identity, timestamp });
    options.onReply?.(recordIndex, event);
    const previous = events.get(event.id);
    if (!previous || Date.parse(timestamp) > Date.parse(previous.timestamp)) events.set(event.id, event);
    precedingEvent = record.type === "event_msg"
      ? { signature, identity } : null;
  }
  return boundedReplyEvents(events.values(), options.unlimited === true ? Infinity : MAX_ASSISTANT_REPLIES);
}

/** Later groups have stronger source timestamps (rollout follows canonical). */
export function mergeCodexActivityEvents(eventGroups, maximum = 4_096) {
  const merged = new Map();
  for (const group of eventGroups || []) {
    for (const event of group || []) if (event?.id) merged.set(event.id, event);
  }
  const limit = maximum === Infinity ? Infinity : Number.isInteger(maximum) ? Math.max(0, Math.min(4_096, maximum)) : 4_096;
  return limit === 0 ? [] : [...merged.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id))
    .slice(limit === Infinity ? 0 : -limit);
}

function responseCallId(payload) {
  return rawCallId(payload?.call_id ?? payload?.callId ?? payload?.id);
}

function eventCallId(payload) {
  return rawCallId(payload?.call_id ?? payload?.callId ?? payload?.id);
}

function outputStatus(payload) {
  if (payload?.is_error === true || payload?.isError === true || payload?.success === false) return "failed";
  return normalizedStatus(payload?.status, "completed");
}

export function parseCodexActivityRecords(records, options = {}) {
  const actor = options.actor || { id: "primary", label: "Primary agent" };
  const sourceKey = collapsedText(options.sourceKey, 160) || actor.id;
  const { cwd, forbiddenRoots = [], deferFileChanges = false } = options;
  const calls = [];
  const updates = new Map();
  // Response calls awaiting their output, and the code-mode wrappers among them with whether a
  // nested execution item was recorded while each was the only open call.
  const openCalls = new Set();
  const wrappers = new Map();
  let recordedCwd = cwd;
  for (const [order, record] of (Array.isArray(records) ? records : []).entries()) {
    const observedTimestamp = codexTimestamp(record?.timestamp ?? record?.payload?.timestamp);
    const timestamp = observedTimestamp || options.fallbackTimestamp;
    const payload = record?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const sourceCwd = typeof payload.cwd === "string" ? payload.cwd : typeof record?.cwd === "string" ? record.cwd : null;
    const sourceType = String(record?.type || payload?.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["turncontext", "sessionmeta"].includes(sourceType) && sourceCwd && path.isAbsolute(sourceCwd)) recordedCwd = sourceCwd;
    if (record.type === "response_item") {
      if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payload.type)) {
        const id = responseCallId(payload);
        if (id) {
          updates.set(stableCodexCallId(actor.id, id), { status: outputStatus(payload), timestamp: observedTimestamp });
          openCalls.delete(stableCodexCallId(actor.id, id));
        }
        continue;
      }
      const descriptor = responseDescriptor(payload);
      if (!descriptor) continue;
      const providerCallId = responseCallId(payload);
      if (providerCallId && ["function_call", "custom_tool_call"].includes(payload.type)) {
        const callId = stableCodexCallId(actor.id, providerCallId);
        openCalls.add(callId);
        if (isCodeModeWrapper(payload)) wrappers.set(callId, wrappers.get(callId) === true);
      }
      calls.push(makeCall({
        actor,
        providerCallId,
        fallbackIdentity: `${sourceKey}:${order}:${payload.type}`,
        timestamp,
        descriptor,
        status: normalizedStatus(payload.status, ["local_shell_call", "web_search_call", "image_generation_call"].includes(payload.type) ? "completed" : "running"),
        fileChangeCwd: sourceCwd || recordedCwd,
      }));
      if (providerCallId && observedTimestamp) options.onCall?.(order, calls.at(-1));
      continue;
    }
    if (record.type !== "event_msg") continue;
    const eventType = String(payload.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["execcommandend", "patchapplyend", "mcptoolcallend", "websearchend", "imagegenerationend"].includes(eventType)) {
      const id = eventCallId(payload);
      if (id) updates.set(stableCodexCallId(actor.id, id), { status: outputStatus(payload), timestamp: observedTimestamp });
      continue;
    }
    // Patches, commands and MCP calls run inside a code-mode exec cell are recorded only as
    // completed items; the wrapping exec call carries no evidence of what it ran.
    const executionKind = rolloutExecutionItemKind(payload);
    if (executionKind) {
      const item = payload.item;
      const providerCallId = rawCallId(item.id);
      const timing = rolloutExecutionTiming(payload);
      const call = makeCall({
        actor,
        providerCallId,
        fallbackIdentity: `${sourceKey}:${order}:${payload.type}`,
        timestamp: timing?.startedAt || timestamp,
        descriptor: rolloutExecutionDescriptor(executionKind, item),
        status: rolloutExecutionStatus(executionKind, item),
        fileChangeCwd: sourceCwd || recordedCwd,
      });
      if (!call) continue;
      if (timing) call.durationMs = timing.durationMs;
      calls.push(call);
      // An item recorded while exactly one response call is open ran inside that call. A native
      // call's own completed item shares its id and is the same row, not a nested one.
      const enclosing = openCalls.size === 1 ? openCalls.values().next().value : null;
      if (enclosing && enclosing !== call.id && wrappers.has(enclosing)) {
        wrappers.set(enclosing, true);
        // A nested file change never inherits the wrapper's request: file-change attribution
        // requires recorded proof, and enclosure is only source order.
        if (executionKind !== "filechange") options.onNested?.(call.id, enclosing);
      }
      if (providerCallId && observedTimestamp) options.onCall?.(order, call);
      continue;
    }
    const descriptor = eventDescriptor(payload);
    if (!descriptor) continue;
    calls.push(makeCall({
      actor,
      providerCallId: eventCallId(payload),
      fallbackIdentity: `${sourceKey}:${order}:${payload.type}`,
      timestamp,
      descriptor,
      status: normalizedStatus(payload.status, eventType.endsWith("begin") ? "running" : "completed"),
      fileChangeCwd: sourceCwd || recordedCwd,
    }));
    if (eventCallId(payload) && observedTimestamp) options.onCall?.(order, calls.at(-1));
  }
  return mergeCodexToolCalls([calls]).map((call) => {
    const update = updates.get(call.id);
    const sealed = sealCodexFileChanges(call, update ? update.status : call.status, { cwd, forbiddenRoots, deferFileChanges });
    // A code-mode wrapper is a container, not an action, once a nested item was recorded inside
    // it. One still awaiting its output is undecided and stays uncounted, so a count never
    // includes a wrapper and then drops it. One that completed with no nested item (older Codex
    // recorded none) remains the only evidence of its work and counts as before.
    const wrapper = wrappers.has(call.id) ? { wrapper: wrappers.get(call.id) || !update } : {};
    return update ? { ...sealed, ...wrapper, durationMs: boundedActivityDuration(call.timestamp, update.timestamp) } : { ...sealed, ...wrapper };
  });
}

export function readCodexActivityRollout(file, options = {}) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    } catch {
      // Malformed and truncated lines do not invalidate recognized activity.
    }
  }
  return parseCodexActivityRecords(records, { ...options, sourceKey: options.sourceKey || file });
}
