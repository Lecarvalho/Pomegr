import { normalizedWorkKind, toolWorkKind } from "./work-kind.mjs";

const INPUT_KIND_LABELS = [
  ["text", "Text"],
  ["document", "Document"],
  ["image", "Image"],
];

function inputKind(part) {
  if (!part || typeof part !== "object") return null;
  const mediaType = part.source?.media_type || part.media_type || part.mime_type || "";
  if (part.type === "image" || String(mediaType).startsWith("image/")) return "image";
  if (part.type === "document" || part.type === "file" || mediaType) return "document";
  if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return "text";
  return null;
}

export function userInputContentType(record, requestedInputIds = new Set()) {
  if (record?.type !== "user" || record.isMeta || record.isCompactSummary) return null;
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

export function shellFailureActivityEvents(executionTasks, actor = "Primary agent") {
  if (!Array.isArray(executionTasks)) return [];
  return executionTasks.flatMap((task) => {
    if (task?.status !== "failed" || !task.id || !task.finishedAt) return [];
    const exitDetail = Number.isInteger(task.exitCode) ? ` · exit ${task.exitCode}` : "";
    return [{
      id: `${task.id}-failed`,
      timestamp: task.finishedAt,
      actor,
      tool: "Shell failed",
      workKind: normalizedWorkKind(task.workKind),
      detail: `${task.label}${exitDetail}`,
      status: "failed",
    }];
  });
}

export function recentActivityEvents(events, maximum = 30) {
  const limit = Number.isInteger(maximum) ? Math.max(0, maximum) : 30;
  return [...events]
    .sort((left, right) => (
      Date.parse(right.timestamp) - Date.parse(left.timestamp)
      || String(left.id).localeCompare(String(right.id))
    ))
    .slice(0, limit)
    .map(({ id, timestamp, actor, tool, workKind, detail, status }) => ({
      id,
      timestamp,
      actor,
      tool,
      workKind: normalizedWorkKind(workKind, toolWorkKind(tool, { detail })),
      detail,
      status: status === "failed" ? "failed" : null,
    }));
}
