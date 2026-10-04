const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,63}$/u;
export const MODEL_NOTIFICATION_KINDS = Object.freeze(["model_announced", "model_deprecated", "model_client_listed"]);

/** Dedicated model identity and display validators. Never accept paths or source copy. */
export function validModelIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) && !value.includes("..");
}
export function validModelLabel(value) {
  return typeof value === "string" && LABEL.test(value) && value === value.trim() && !value.includes("..");
}
export function isModelNotificationKind(kind) { return MODEL_NOTIFICATION_KINDS.includes(kind); }
export function modelNotificationPolicy(kind) {
  return { category: "model_news", severity: "info", priority: kind === "model_deprecated" ? 40 : 25, action: "open_providers" };
}
export function normalizeModelNotificationData(kind, provider, value) {
  if (!isModelNotificationKind(kind) || !["claude", "codex"].includes(provider)
    || (kind === "model_client_listed" && provider !== "codex")
    || !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3 || !["modelId", "label", "evidence"].every((key) => Object.hasOwn(value, key))
    || !validModelIdentifier(value.modelId) || !validModelLabel(value.label)
    || value.evidence !== (kind === "model_client_listed" ? "client_catalog" : "official_announcement")) return null;
  return { modelId: value.modelId, label: value.label, evidence: value.evidence };
}
export function modelNotificationPayload(record) {
  const data = normalizeModelNotificationData(record?.kind, record?.provider, record?.data);
  if (!data) return null;
  if (record.kind === "model_client_listed") return { title: `${data.label} listed in your client`,
    body: "A complete Codex client catalog newly lists this model. A client listing does not confirm account access." };
  if (record.kind === "model_deprecated") return { title: `${data.label} retirement announced`,
    body: "The provider published a model retirement announcement. Catalog absence does not establish retirement or account access." };
  return { title: `${data.label} announced`,
    body: "The provider published an official model announcement. This does not confirm availability in your client or account." };
}
