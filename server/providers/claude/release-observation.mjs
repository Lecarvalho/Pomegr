import { createOfficialReleaseReader } from "../kernel/official-release-reader.mjs";

const VERSION = /^v(\d{1,4}\.\d{1,4}\.\d{1,4})$/u;
const BASE = "https://github.com/anthropics/claude-code/releases/tag/";

/** GitHub is the official Claude Code release publication feed, not its delayed stable channel. */
export function parseClaudeCodeReleases(rows, observedAt) {
  if (!Array.isArray(rows) || rows.length > 30) return null;
  const valid = rows.flatMap((row) => {
    const match = typeof row?.tag_name === "string" ? VERSION.exec(row.tag_name) : null;
    if (!match || row.draft !== false || row.prerelease !== false || row.html_url !== `${BASE}${row.tag_name}`
      || typeof row.published_at !== "string" || !Number.isFinite(Date.parse(row.published_at))) return [];
    const publishedAt = new Date(row.published_at).toISOString();
    if (publishedAt > observedAt) return [];
    return [{ provider: "claude", product: "claude_code", version: match[1], channel: "latest",
      publishedAt, observedAt, sourceKey: "anthropics/claude-code" }];
  });
  valid.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return valid[0] || null;
}

export function createClaudeCodeReleaseReader(options = {}) {
  return createOfficialReleaseReader({ ...options,
    url: "https://api.github.com/repos/anthropics/claude-code/releases?per_page=30",
    parse: parseClaudeCodeReleases });
}
