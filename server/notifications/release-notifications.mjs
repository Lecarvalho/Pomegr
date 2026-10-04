import { comparePluginVersions } from "../../shared/repository-plugin-state.mjs";

export const RELEASE_PRODUCTS = Object.freeze(["claude_code", "codex_cli", "pomegr_plugin"]);
export const RELEASE_KINDS = Object.freeze(["release_published", "installation_update_available"]);
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;
const CHANNELS = { claude_code: ["latest"], codex_cli: ["latest"], pomegr_plugin: ["main"] };
const PROVIDERS = { claude_code: "claude", codex_cli: "codex", pomegr_plugin: null };
const MAX_AGE = 24 * 60 * 60_000;
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

export function validReleaseNotificationState(value, now) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === RELEASE_PRODUCTS.length
    && RELEASE_PRODUCTS.every((product) => {
      const row = value[product];
      return row === null || (row && typeof row === "object" && !Array.isArray(row)
        && Object.keys(row).length === 3 && typeof row.version === "string" && VERSION.test(row.version)
        && CHANNELS[product].includes(row.channel) && iso(row.observedAt)
        && Date.parse(row.observedAt) <= now + 60_000);
    });
}

/** Published versions have one baseline per product. Installation is qualified only by current setup evidence. */
export function reduceReleaseNotifications(input, previous = null, now = Date.now()) {
  const state = structuredClone(previous || { claude_code: null, codex_cli: null, pomegr_plugin: null });
  const items = [];
  const observations = Array.isArray(input?.observations) ? input.observations.slice(0, 3) : [];
  for (const row of observations) {
    const product = row?.product;
    if (!RELEASE_PRODUCTS.includes(product) || typeof row.version !== "string" || !VERSION.test(row.version)
      || !CHANNELS[product].includes(row.channel) || !iso(row.observedAt)
      || Date.parse(row.observedAt) > now || now - Date.parse(row.observedAt) > MAX_AGE
      || (product === "pomegr_plugin" ? row.provider !== null : row.provider !== PROVIDERS[product])) continue;
    const prior = state[product];
    if (prior && Date.parse(row.observedAt) <= Date.parse(prior.observedAt)) continue;
    const comparison = prior ? comparePluginVersions(prior.version, row.version) : null;
    if (comparison === 1) continue; // A delayed older publication cannot lower the baseline.
    const current = { version: row.version, channel: row.channel, observedAt: row.observedAt };
    state[product] = current;
    if (!prior || prior.channel !== row.channel || comparison !== -1) continue;
    const comparable = row.installation?.status === "installed" && row.installation?.channel === row.channel
      && typeof row.installation.version === "string" && VERSION.test(row.installation.version)
      && comparePluginVersions(row.installation.version, row.version) === -1;
    const kind = comparable ? "installation_update_available" : "release_published";
    const affectedRepositories = product === "pomegr_plugin" && comparable
      ? Math.min(200, Math.max(1, Number.isSafeInteger(row.installation.affectedRepositories) ? row.installation.affectedRepositories : 1)) : 0;
    items.push({ kind, key: product, provider: PROVIDERS[product], active: true, at: row.observedAt,
      data: { product, version: row.version, channel: row.channel, ...(affectedRepositories ? { affectedRepositories } : {}) } });
  }
  return { state, items };
}

export const RELEASE_NOTIFICATION_RULE = Object.freeze({
  kind: "release_published", source: "releases", capability: "official_releases", scope: "product",
  identity: "published_semver", freshness: "successful_bounded_read", transition: "newer_version",
  resolution: "occurrence", retentionDays: 30, category: "provider_news", severity: "info", priority: 30,
  action: "open_providers", delivery: "native_eligible", occurrence: true,
  kinds: RELEASE_KINDS, derive: reduceReleaseNotifications,
  policies: { installation_update_available: { category: "provider_news", severity: "info", priority: 35, action: "open_providers" } },
});
