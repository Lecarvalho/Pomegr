import crypto from "node:crypto";
import fs from "node:fs";
import { mutationScopes, repetitionSignature } from "../tool-efficiency.mjs";
import { codexTimestamp } from "./codex-session-metadata.mjs";
import { toolWorkKind } from "../work-kind.mjs";

const MAX_IDENTIFIER_LENGTH = 80;
const MAX_DETAIL_LENGTH = 96;
const MAX_CALL_ID_LENGTH = 160;

function boundedText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function safeIdentifier(value) {
  return boundedText(value, MAX_IDENTIFIER_LENGTH).replace(/[^A-Za-z0-9_.:/ -]/g, "").trim();
}

function safeBasename(value) {
  if (typeof value !== "string") return "";
  return boundedText(value.split(/[\\/]/).filter(Boolean).at(-1), MAX_DETAIL_LENGTH);
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
  return boundedText(value, MAX_CALL_ID_LENGTH);
}

export function stableCodexCallId(actorId, providerCallId, fallbackIdentity = "") {
  const identity = rawCallId(providerCallId) || boundedText(fallbackIdentity, 512);
  return `codex-${digest(`${actorId}|${identity}`)}`;
}

function normalizedStatus(value, fallback = "running") {
  const status = String(value ?? "").toLowerCase().replace(/[_ -]/g, "");
  if (["completed", "complete", "success", "succeeded"].includes(status)) return "completed";
  if (["failed", "failure", "declined", "incomplete", "interrupted", "cancelled", "canceled"].includes(status)) return "failed";
  if (["inprogress", "running", "pending", "started"].includes(status)) return "running";
  return fallback;
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
  return null;
}

function mcpDetail(server, tool) {
  const safeServer = safeIdentifier(server);
  const safeTool = safeIdentifier(tool);
  return boundedText([safeServer, safeTool].filter(Boolean).join(" / "), MAX_DETAIL_LENGTH);
}

function functionDescriptor(name, input, namespace = "") {
  const normalized = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
    return { tool: "File change", detail, repetitionInput: { patch }, mutationInput: { tool: "apply_patch", input: { patch } }, mutationPaths: paths };
  }
  if (normalized === "requestuserinput") {
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
  if (String(name || "").startsWith("mcp__")) {
    const parts = String(name).split("__");
    return { tool: "MCP", detail: mcpDetail(parts[1], parts.slice(2).join("__")), repetitionInput: input, mutationInput: null };
  }
  if (normalized === "toolsearch" || normalized === "toolsearchcall") {
    return { tool: "Tool search", detail: "Discover tools", repetitionInput: input, mutationInput: null };
  }
  const detail = mcpDetail(namespace, name) || "Tool call";
  return { tool: "Dynamic tool", detail, repetitionInput: input, mutationInput: null };
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
    return { tool: "File change", detail, repetitionInput: { changes }, mutationInput: { tool: "fileChange", input: { changes } }, mutationPaths: paths };
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

function makeCall({ actor, providerCallId, fallbackIdentity, timestamp, descriptor, status }) {
  if (!descriptor || !timestamp) return null;
  return {
    id: stableCodexCallId(actor.id, providerCallId, fallbackIdentity),
    timestamp,
    actor: { id: actor.id, label: actor.label },
    tool: descriptor.tool,
    workKind: toolWorkKind(descriptor.tool, { detail: descriptor.detail, input: descriptor.repetitionInput }),
    detail: boundedText(descriptor.detail, MAX_DETAIL_LENGTH),
    status,
    repetitionSignature: repetitionSignature(descriptor.tool, descriptor.repetitionInput),
    mutation: mutationEvidence(descriptor),
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
    });
  }
  return [...calls.values()].sort((left, right) => (
    Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id)
  ));
}

export function parseCodexCanonicalTurns(turns, options = {}) {
  const actor = options.actor || { id: "primary", label: "Primary agent" };
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
      }));
    }
  }
  return mergeCodexToolCalls([calls]);
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
  const sourceKey = boundedText(options.sourceKey, 160) || actor.id;
  const calls = [];
  const updates = new Map();
  for (const [order, record] of (Array.isArray(records) ? records : []).entries()) {
    const timestamp = codexTimestamp(record?.timestamp ?? record?.payload?.timestamp) || options.fallbackTimestamp;
    const payload = record?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    if (record.type === "response_item") {
      if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payload.type)) {
        const id = responseCallId(payload);
        if (id) updates.set(stableCodexCallId(actor.id, id), outputStatus(payload));
        continue;
      }
      const descriptor = responseDescriptor(payload);
      if (!descriptor) continue;
      const providerCallId = responseCallId(payload);
      calls.push(makeCall({
        actor,
        providerCallId,
        fallbackIdentity: `${sourceKey}:${order}:${payload.type}`,
        timestamp,
        descriptor,
        status: normalizedStatus(payload.status, ["local_shell_call", "web_search_call", "image_generation_call"].includes(payload.type) ? "completed" : "running"),
      }));
      continue;
    }
    if (record.type !== "event_msg") continue;
    const eventType = String(payload.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["execcommandend", "patchapplyend", "mcptoolcallend", "websearchend", "imagegenerationend"].includes(eventType)) {
      const id = eventCallId(payload);
      if (id) updates.set(stableCodexCallId(actor.id, id), outputStatus(payload));
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
    }));
  }
  return mergeCodexToolCalls([calls]).map((call) => (
    updates.has(call.id) ? { ...call, status: updates.get(call.id) } : call
  ));
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
