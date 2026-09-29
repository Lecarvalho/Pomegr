import { createHash } from "node:crypto";

export const MAX_CATALOG_SHELL_ROWS = 200;

export { qualifiedSessionId } from "../../normalize/primitives.mjs";

export function openLiveDeadline(entry, nowMs, windowMs) {
  if (!entry.isLive || entry.activityStatus !== "open" || entry.needsInput) return null;
  const activityAt = typeof entry.updatedAt === "string" ? Date.parse(entry.updatedAt) : NaN;
  return Number.isFinite(nowMs) && Number.isFinite(activityAt) && activityAt <= nowMs ? activityAt + windowMs : Number.NEGATIVE_INFINITY;
}

export function catalogSourceScopeKey(registry) {
  const providers = (registry?.providers || []).map((provider) => provider.id).filter(Boolean).sort();
  const folders = registry?.providerFolders?.folders || {};
  const sourceScopes = (registry?.providers || []).map((provider) => [provider.id,
    typeof provider.catalogSourceScope === "string" ? provider.catalogSourceScope : ""])
    .filter(([providerId]) => providerId).sort(([left], [right]) => left.localeCompare(right));
  // Adapter scope values are already opaque hashes. This second private hash
  // binds them to the configured folders without persisting raw source paths.
  return createHash("sha256").update(JSON.stringify({ providers, folders: Object.keys(folders).sort().map((key) => [key, folders[key] || ""]), sourceScopes })).digest("hex");
}

export function compareCatalogEntries(left, right) {
  return Date.parse(right.createdAt || right.updatedAt || "") - Date.parse(left.createdAt || left.updatedAt || "")
    || left.id.localeCompare(right.id);
}

export function publicCatalogEntry(providerId, source, entry) {
  const localId = String(entry?.localId || "");
  if (!localId) return null;
  return Object.freeze({
    id: `${providerId}:${localId}`, provider: providerId, source,
    title: String(entry.title || "Untitled session"), project: String(entry.project || "Unknown project"),
    createdAt: entry.createdAt || entry.updatedAt || null, updatedAt: entry.updatedAt || null,
    isLive: Boolean(entry.isLive), needsInput: Boolean(entry.needsInput), activityStatus: entry.activityStatus || "unknown",
    detailReadiness: entry?.detailReadiness === "unavailable" ? "unavailable" : null,
  });
}

export function catalogStructure(entries = []) {
  return entries.map((entry) => `${entry.id}\0${entry.isLive ? 1 : 0}\0${entry.needsInput ? 1 : 0}\0${entry.activityStatus || "unknown"}\0${entry.detailReadiness || "loading"}`).sort().join("\n");
}

export function downgradeRestoredLifecycle(record) {
  const historical = record.evidence?.historical === true;
  const downgradeAgent = (agent) => {
    if (!agent || typeof agent !== "object" || !agent.liveness) return agent;
    if (historical) return { ...agent, liveness: null };
    return { ...agent, status: "unknown", liveness: { ...agent.liveness, evidence: "unavailable", freshness: "stale", reason: "legacy_snapshot" } };
  };
  const downgradeAgents = (value) => value && Array.isArray(value.agents) ? { ...value, agents: value.agents.map(downgradeAgent) } : value;
  return { ...record, evidence: downgradeAgents(record.evidence), publicState: downgradeAgents(record.publicState) };
}
