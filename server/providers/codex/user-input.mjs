import crypto from "node:crypto";
import { stableCodexActivityId } from "./activity-events.mjs";
import { codexTimestamp } from "./session-metadata.mjs";

const MAX_INPUTS = 256;
const normalizedType = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function synthetic(value) {
  return value?.synthetic === true || value?.is_synthetic === true || value?.isSynthetic === true
    || value?.metadata?.synthetic === true || value?.metadata?.isSynthetic === true;
}

/** Rollout deliveries distinguish submitted input from role=user context and mirror records. */
export function parseCodexUserInputRecords(records, options = {}) {
  const actor = options.actor || { id: "primary", label: "Primary agent" };
  if (actor.id !== "primary" || options.userInputEnabled === false) return [];
  const events = new Map();
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    const payload = record?.payload;
    if (record?.type !== "event_msg" || synthetic(record) || synthetic(payload)) continue;
    const completed = normalizedType(payload?.type) === "itemcompleted"
      && normalizedType(payload?.item?.type) === "usermessage";
    const source = completed ? payload.item : payload?.type === "user_message" ? payload : null;
    if (!source || synthetic(source)) continue;
    const timestamp = codexTimestamp(record.timestamp ?? payload.timestamp ?? source.timestamp);
    if (!timestamp) continue;
    const content = Array.isArray(source.content) ? source.content : [];
    const text = (typeof source.message === "string" && Boolean(source.message.trim()))
      || content.some((part) => ["text", "inputtext"].includes(normalizedType(part?.type))
        && typeof part.text === "string" && Boolean(part.text.trim()));
    const image = [source.images, source.local_images].some((items) => Array.isArray(items) && items.length > 0)
      || content.some((part) => ["image", "inputimage", "localimage"].includes(normalizedType(part?.type)));
    if (!text && !image) continue;
    // A private digest distinguishes same-time deliveries without retaining content or paths.
    // Replaying a source slice must produce the same ID regardless of its position in the tail.
    const nativeId = typeof source.id === "string" ? source.id.slice(0, 160) : "";
    const identity = nativeId || `${timestamp}:${crypto.createHash("sha256")
      .update(JSON.stringify([source.message ?? "", source.content ?? [], source.images ?? [], source.local_images ?? []])).digest("hex")}`;
    const event = {
      id: stableCodexActivityId(actor.id, `user-input:${options.sourceKey || actor.id}:${identity}`),
      timestamp, actor: "User", tool: "User input", workKind: "input",
      detail: text ? (image ? "Text + Image" : "Text") : "Image", status: null,
    };
    events.set(event.id, event);
    options.onInput?.(index, event);
  }
  return [...events.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id))
    .slice(options.unlimited === true ? 0 : -MAX_INPUTS);
}
