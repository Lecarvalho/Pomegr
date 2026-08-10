const APPROVAL_MODES = new Map([
  ["auto", { id: "auto", label: "Auto mode" }],
  ["acceptEdits", { id: "accept_edits", label: "Accept edits" }],
  ["default", { id: "default", label: "Default permissions" }],
  ["plan", { id: "plan", label: "Plan mode" }],
  ["dontAsk", { id: "dont_ask", label: "Don't ask" }],
  ["bypassPermissions", { id: "bypass_permissions", label: "Bypass permissions" }],
]);

function safeTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) return null;
  return value;
}

export function sessionApprovalModeFromRecord(record) {
  if (!record || typeof record !== "object" || record.type !== "user") return null;
  const mode = APPROVAL_MODES.get(record.permissionMode);
  if (!mode) return null;
  return {
    ...mode,
    observedAt: safeTimestamp(record.timestamp),
    source: "provider",
  };
}

export function latestSessionApprovalMode(records) {
  let latest = null;
  for (const record of records || []) {
    latest = sessionApprovalModeFromRecord(record) || latest;
  }
  return latest;
}
