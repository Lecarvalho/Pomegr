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
