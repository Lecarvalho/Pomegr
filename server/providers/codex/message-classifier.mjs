import crypto from "node:crypto";
import { messageText, messageTime } from "../kernel/session-messages.mjs";
import { normalizedStatus, rolloutExecutionItemKind, rolloutExecutionStatus } from "./execution-items.mjs";

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

export function assistantReplyPayload(value) {
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

const normalizedType = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function synthetic(value) {
  return value?.synthetic === true || value?.is_synthetic === true || value?.isSynthetic === true
    || value?.metadata?.synthetic === true || value?.metadata?.isSynthetic === true;
}

function toolOutcome(value, fallback = "completed") {
  const result = value.result?.Ok ?? value.result;
  if (value.is_error === true || value.isError === true || value.success === false || (Number.isInteger(value.exit_code) && value.exit_code !== 0)
    || value.result?.Err || result?.isError === true || result?.is_error === true || value.error) return "failed";
  const status = normalizedStatus(value.status, fallback);
  return status === "running" ? "pending" : status;
}

export function classifyCodexRecord(record) {
  const payload = record?.payload;
  let reply = null;
  let replySource = payload;
  if (record?.synthetic !== true && payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (record.type === "event_msg" && payload.type === "agent_message") reply = assistantReplyPayload(payload);
    else if (record.type === "event_msg" && ["item_completed", "item_done"].includes(payload.type)) {
      replySource = payload.item;
      reply = assistantReplyPayload(replySource);
    } else if (record.type === "response_item") reply = assistantReplyPayload(payload);
  }
  const completed = normalizedType(payload?.type) === "itemcompleted" && normalizedType(payload?.item?.type) === "usermessage";
  const owner = completed ? payload.item : payload?.type === "user_message" ? payload : null;
  const ownerSource = record?.type === "event_msg" && !synthetic(record) && !synthetic(payload) && !synthetic(owner) ? owner : null;
  return { reply, replySource, ownerSource };
}

export function createCodexSessionMessageClassifier() {
  let previousReply = null;
  return function* messages(record) {
    if (synthetic(record) || synthetic(record?.payload) || record?.isMeta || record?.isCompactSummary || record?.isSidechain) { previousReply = null; return; }
    const { reply, replySource, ownerSource } = classifyCodexRecord(record);
    const payload = record?.payload;
    const at = messageTime(record?.timestamp ?? payload?.timestamp ?? replySource?.timestamp);
    const signature = reply ? crypto.createHash("sha256").update(`${reply.phase || ""}:${reply.text}`).digest("hex") : null;
    const mirrored = reply && record.type === "response_item" && previousReply === signature;
    previousReply = reply && record.type === "event_msg" ? signature : null;
    if (ownerSource) {
      const text = typeof ownerSource.message === "string" ? ownerSource.message : (Array.isArray(ownerSource.content) ? ownerSource.content : [])
        .filter((part) => ["text", "inputtext"].includes(normalizedType(part?.type)) && typeof part.text === "string")
        .map((part) => part.text).join("");
      if (text.trim()) yield { kind: "owner", at, text: messageText(text) };
    }
    if (reply && !mirrored) yield { kind: "agent", at, text: messageText(reply.text) };
    if (synthetic(record) || synthetic(payload) || !payload) return;
    if (record.type === "response_item") {
      if (["function_call", "custom_tool_call", "tool_search_call", "local_shell_call", "web_search_call", "image_generation_call"].includes(payload.type)) {
        const name = typeof payload.name === "string" ? payload.name : payload.type.replace(/_call$/, "");
        yield { kind: "tool", at, name: name.slice(0, 64), id: payload.call_id ?? payload.id,
          outcome: toolOutcome(payload, "running") };
      } else if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payload.type)) {
        yield { kind: "tool-result", id: payload.call_id ?? payload.id,
          outcome: toolOutcome(payload) };
      }
    } else if (record.type === "event_msg") {
      const type = normalizedType(payload.type);
      if (type === "mcptoolcallbegin") {
        const name = payload.tool ?? payload.invocation?.tool;
        if (typeof name === "string") yield { kind: "tool", at, name: name.slice(0, 64), outcome: "pending", id: payload.call_id ?? payload.id };
      } else if (["execcommandend", "patchapplyend", "mcptoolcallend", "websearchend", "imagegenerationend"].includes(type)) {
        yield { kind: "tool-result", id: payload.call_id ?? payload.id, outcome: toolOutcome(payload) };
      } else {
        const kind = rolloutExecutionItemKind(payload);
        if (kind) yield { kind: "tool-result", id: payload.item.id, outcome: rolloutExecutionStatus(kind, payload.item) === "failed" ? "failed" : "completed" };
      }
    }
  };
}

