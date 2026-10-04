import { createHash } from "node:crypto";
import { MODEL_NOTIFICATION_KINDS, validModelIdentifier, validModelLabel } from "../../shared/model-notification.mjs";

const PROVIDERS = ["claude", "codex"];
const HASH = /^[a-f0-9]{64}$/u;
const MAX_AGE = 2 * 60 * 60_000;
const ANNOUNCEMENT_AGE = 24 * 60 * 60_000;
const MAX_KNOWN = 256;
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function known(value) { return Array.isArray(value) && value.length <= MAX_KNOWN && value.every(validModelIdentifier) && new Set(value).size === value.length; }
function empty() { return { catalogs: { claude: null, codex: null }, announcements: { claude: null, codex: null } }; }

/** Private comparison state contains identities and ages, never source HTML, URLs or credentials. */
export function validModelNotificationState(value, now) {
  return exact(value, ["catalogs", "announcements"]) && ["catalogs", "announcements"].every((type) =>
    exact(value[type], PROVIDERS) && PROVIDERS.every((provider) => {
      const row = value[type][provider];
      return row === null || (exact(row, ["sourceScope", "observedAt", "known"])
        && typeof row.sourceScope === "string" && HASH.test(row.sourceScope) && iso(row.observedAt)
        && Date.parse(row.observedAt) <= now + 60_000
        && (type === "catalogs" ? known(row.known) : Array.isArray(row.known) && row.known.length <= MAX_KNOWN
          && row.known.every((id) => typeof id === "string" && HASH.test(id)) && new Set(row.known).size === row.known.length));
    }));
}

/** Missing catalog rows never mean retirement; only explicit official announcements do. */
export function reduceModelNotifications(input, previous = null, now = Date.now()) {
  const state = structuredClone(previous || empty());
  const items = [];
  for (const type of ["catalogs", "announcements"]) {
    const rows = input?.[type];
    if (!Array.isArray(rows) || rows.length > 2 || new Set(rows.map((row) => row?.provider)).size !== rows.length) continue;
    for (const row of rows) {
      if (!object(row) || !PROVIDERS.includes(row.provider)) continue;
      const prior = state[type][row.provider];
      if (typeof row.sourceScope !== "string" || !HASH.test(row.sourceScope)) {
        if (!prior || !iso(row.observedAt) || Date.parse(row.observedAt) > Date.parse(prior.observedAt)) state[type][row.provider] = null;
        continue;
      }
      const sameScope = prior?.sourceScope === row.sourceScope;
      // Old cached callbacks must not rewind or clear a newer accepted baseline.
      if (sameScope && iso(row.observedAt) && Date.parse(row.observedAt) <= Date.parse(prior.observedAt)) continue;
      const maxAge = type === "catalogs" ? MAX_AGE : ANNOUNCEMENT_AGE;
      const fresh = iso(row.observedAt) && Date.parse(row.observedAt) <= now && now - Date.parse(row.observedAt) <= maxAge;
      if (row.status !== "ready" || row.complete !== true || !fresh) { state[type][row.provider] = null; continue; }
      let entries;
      let identities;
      if (type === "catalogs") {
        if (row.provider !== "codex" || !Array.isArray(row.models) || row.models.length > 128 || !known(row.knownIds)
          || row.models.some((model) => !exact(model, ["id", "label"]) || !validModelIdentifier(model.id) || !validModelLabel(model.label)
            || !row.knownIds.includes(model.id)) || new Set(row.models.map((model) => model.id)).size !== row.models.length) {
          state[type][row.provider] = null; continue;
        }
        identities = row.knownIds;
        entries = row.models.map((model) => ({ kind: "model_client_listed", identity: model.id,
          modelId: model.id, label: model.label, at: row.observedAt }));
      } else {
        if (!Array.isArray(row.announcements) || row.announcements.length > 128
          || row.announcements.some((entry) => !exact(entry, ["kind", "modelId", "label", "publishedAt"])
            || !["model_announced", "model_deprecated"].includes(entry.kind) || !validModelIdentifier(entry.modelId)
            || !validModelLabel(entry.label) || !iso(entry.publishedAt) || Date.parse(entry.publishedAt) > Date.parse(row.observedAt))) {
          state[type][row.provider] = null; continue;
        }
        entries = row.announcements.map((entry) => ({ ...entry, at: entry.publishedAt,
          identity: createHash("sha256").update(`${entry.kind}\0${entry.modelId}\0${entry.publishedAt}`).digest("hex") }));
        identities = entries.map((entry) => entry.identity);
        if (new Set(identities).size !== identities.length) { state[type][row.provider] = null; continue; }
      }
      const comparable = sameScope && now - Date.parse(prior.observedAt) <= maxAge;
      const combined = [...new Set([...(comparable ? prior.known : []), ...identities])];
      const bounded = combined.length <= MAX_KNOWN;
      state[type][row.provider] = { sourceScope: row.sourceScope, observedAt: row.observedAt, known: bounded ? combined : identities };
      if (!comparable || !bounded) continue;
      for (const entry of entries) {
        if (prior.known.includes(entry.identity) || (type === "announcements" && Date.parse(entry.at) <= Date.parse(prior.observedAt))) continue;
        items.push({ kind: entry.kind, key: `${row.provider}:${createHash("sha256").update(entry.identity).digest("hex")}`,
          provider: row.provider, active: true, at: entry.at,
          data: { modelId: entry.modelId, label: entry.label, evidence: type === "catalogs" ? "client_catalog" : "official_announcement" } });
      }
    }
  }
  return { state, items };
}

export const MODEL_NOTIFICATION_RULE = Object.freeze({
  kind: "model_announced", source: "models", capability: "bounded_model_observations", scope: "provider_source",
  identity: "normalized_model_evidence", freshness: "complete_fresh_read", transition: "new_evidence_after_baseline",
  resolution: "occurrence", retentionDays: 30, category: "model_news", severity: "info", priority: 25,
  action: "open_providers", delivery: "native_eligible", occurrence: true, kinds: MODEL_NOTIFICATION_KINDS,
  derive: reduceModelNotifications, policies: { model_deprecated: { category: "model_news", severity: "info", priority: 40, action: "open_providers" } },
});
