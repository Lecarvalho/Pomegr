const PRODUCTS = Object.freeze({ claude_code: { provider: "claude", label: "Claude Code", channel: "latest" },
  codex_cli: { provider: "codex", label: "Codex CLI", channel: "latest" },
  pomegr_plugin: { provider: null, label: "Pomegr reporting plugin", channel: "main" } });
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;

export function isReleaseNotificationKind(kind) {
  return kind === "release_published" || kind === "installation_update_available";
}
export function releaseNotificationPolicy(kind) {
  return { category: "provider_news", severity: "info", priority: kind === "release_published" ? 30 : 35,
    action: "open_providers" };
}
export function normalizeReleaseNotificationData(kind, provider, value) {
  if (!isReleaseNotificationKind(kind) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.product !== "string" || !Object.hasOwn(PRODUCTS, value.product)) return null;
  const product = PRODUCTS[value.product];
  if (product.provider !== provider || value.channel !== product.channel
    || typeof value.version !== "string" || !VERSION.test(value.version)) return null;
  const count = value.affectedRepositories;
  const keys = Object.keys(value);
  if (count === undefined) {
    if (keys.length !== 3 || !["product", "version", "channel"].every((key) => Object.hasOwn(value, key))) return null;
  } else if (value.product !== "pomegr_plugin" || kind !== "installation_update_available"
    || keys.length !== 4 || !["product", "version", "channel", "affectedRepositories"].every((key) => Object.hasOwn(value, key))
    || !Number.isSafeInteger(count) || count < 1 || count > 200) return null;
  return { product: value.product, version: value.version, channel: value.channel,
    ...(count === undefined ? {} : { affectedRepositories: count }) };
}
export function releaseNotificationPayload(record) {
  const data = normalizeReleaseNotificationData(record?.kind, record?.provider, record?.data);
  if (!data) return null;
  const label = PRODUCTS[data.product].label;
  if (record.kind === "release_published") return { title: `${label} ${data.version} published`,
    body: data.product === "claude_code" ? "Published on the latest channel. Stable-channel availability is not confirmed."
      : data.product === "codex_cli" ? "This is a Codex CLI release; desktop and IDE updates are separate."
        : "A Pomegr reporting plugin release is published. Check current repository setup." };
  return { title: `${label} ${data.version} update available`,
    body: data.product === "pomegr_plugin"
      ? `Current plugin setup is behind in ${data.affectedRepositories || 1} ${data.affectedRepositories === 1 ? "repository" : "repositories"}. Review repository setup before updating.`
      : "A comparable current installation is behind this release. Review the provider before updating." };
}
