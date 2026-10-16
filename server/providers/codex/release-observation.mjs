import { createOfficialReleaseReader } from "../kernel/official-release-reader.mjs";

const VERSION = /^rust-v(\d{1,4}\.\d{1,4}\.\d{1,4})$/u;
const MAX_ASSETS = 512;
export function parseCodexCliRelease(value, observedAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.tag_name !== "string" || !Array.isArray(value.assets) || value.assets.length > MAX_ASSETS) return null;
  const match = VERSION.exec(value.tag_name);
  if (!match) return null;
  return { provider: "codex", product: "codex_cli", version: match[1], channel: "latest",
    publishedAt: observedAt, observedAt, sourceKey: "releases.openai.com/codex" };
}

export function createCodexCliReleaseReader(options = {}) {
  return createOfficialReleaseReader({ ...options,
    url: "https://releases.openai.com/codex/channels/latest",
    parse: parseCodexCliRelease });
}
