const PRODUCTS = Object.freeze({ claude_code: { provider: "claude", label: "Claude Code", channel: "latest" },
  codex_cli: { provider: "codex", label: "Codex CLI", channel: "latest" },
  pomegr_plugin: { provider: null, label: "Pomegr reporting plugin", channel: "main" } });
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;
export const RELEASE_EXCERPT_LIMIT = 280;
const UNSAFE_EXCERPT_TEXT = /[<>]|:[/][/]|(?:^|[^a-z0-9])www[.]/iu;
// Control, zero-width, line-separator, bidirectional, and byte-order code points.
function unsafeCode(code) {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}
const RELEASE_PAGES = Object.freeze({ claude_code: "https://github.com/anthropics/claude-code/releases/tag/v",
  codex_cli: "https://github.com/openai/codex/releases/tag/rust-v" });

/** A bounded single-line plain-text release excerpt with no URL, markup, or control character. */
export function isReleaseExcerpt(value) {
  return typeof value === "string" && value.length > 0 && value.length <= RELEASE_EXCERPT_LIMIT
    && value === value.trim() && !UNSAFE_EXCERPT_TEXT.test(value)
    && ![...value].some((char) => unsafeCode(char.codePointAt(0)));
}
/** The release page is derived from the product and validated version; it is never stored or read from a payload. */
export function releasePageUrl(product, version) {
  return Object.hasOwn(RELEASE_PAGES, product) && typeof version === "string" && VERSION.test(version)
    ? `${RELEASE_PAGES[product]}${version}` : null;
}

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
  const excerpt = value.excerpt;
  const keys = Object.keys(value);
  if (excerpt !== undefined) {
    if (value.product !== "claude_code" || count !== undefined || !isReleaseExcerpt(excerpt)
      || keys.length !== 4 || !["product", "version", "channel", "excerpt"].every((key) => Object.hasOwn(value, key))) return null;
  } else if (count === undefined) {
    if (keys.length !== 3 || !["product", "version", "channel"].every((key) => Object.hasOwn(value, key))) return null;
  } else if (value.product !== "pomegr_plugin" || kind !== "installation_update_available"
    || keys.length !== 4 || !["product", "version", "channel", "affectedRepositories"].every((key) => Object.hasOwn(value, key))
    || !Number.isSafeInteger(count) || count < 1 || count > 200) return null;
  return { product: value.product, version: value.version, channel: value.channel,
    ...(count === undefined ? {} : { affectedRepositories: count }), ...(excerpt === undefined ? {} : { excerpt }) };
}
export function releaseNotificationPayload(record) {
  const data = normalizeReleaseNotificationData(record?.kind, record?.provider, record?.data);
  if (!data) return null;
  const label = PRODUCTS[data.product].label;
  const link = releasePageUrl(data.product, data.version);
  // The bounded excerpt replaces the fixed line only when the source gave one.
  if (record.kind === "release_published") return { title: `${label} ${data.version} published`, link,
    body: data.excerpt ? data.excerpt : data.product === "claude_code" ? "Published on the latest channel. Stable-channel availability is not confirmed."
      : data.product === "codex_cli" ? "This is a Codex CLI release; desktop and IDE updates are separate."
        : "A Pomegr reporting plugin release is published. Check current repository setup." };
  return { title: `${label} ${data.version} update available`, link,
    body: data.excerpt ? data.excerpt : data.product === "pomegr_plugin"
      ? `Current plugin setup is behind in ${data.affectedRepositories || 1} ${data.affectedRepositories === 1 ? "repository" : "repositories"}. Review repository setup before updating.`
      : "A comparable current installation is behind this release. Review the provider before updating." };
}
