import { createOfficialReleaseReader } from "../kernel/official-release-reader.mjs";
import { RELEASE_EXCERPT_LIMIT, isReleaseExcerpt } from "../../../shared/release-notification.mjs";

const VERSION = /^v(\d{1,4}\.\d{1,4}\.\d{1,4})$/u;
const BASE = "https://github.com/anthropics/claude-code/releases/tag/";
const MAX_BODY = 64 * 1024;
const MAX_LINES = 6;
const ELLIPSIS = String.fromCodePoint(0x2026);

function plainCharacter(char) {
  const code = char.codePointAt(0);
  if (code === 0x0a) return char;
  if (code === 0x09) return " ";
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff ? "" : char;
}

// The first lines of a release body as plain text: no markup, link, URL, or control character.
// The raw body never leaves this parser.
export function releaseBodyExcerpt(body) {
  if (typeof body !== "string" || !body) return null;
  const text = [...body.slice(0, MAX_BODY).replace(/\r\n?/gu, "\n")].map(plainCharacter).join("")
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, " ")
    .replace(/```[\s\S]*?(?:```|$)/gu, "\n")
    .replace(/<[^>\n]*>?/gu, " ")
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/gu, " ")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/gu, "$1")
    .replace(/\[([^\]\n]*)\]\[[^\]\n]*\]/gu, "$1")
    .replace(/&(?:amp|#38);/giu, "&").replace(/&(?:quot|#34);/giu, "\"").replace(/&(?:apos|#39);/giu, "'")
    .replace(/&#?[a-z0-9]{1,10};/giu, " ");
  const lines = [];
  for (const raw of text.split("\n")) {
    if (/^\s*\[[^\]]+\]:/u.test(raw) || /^\s{0,3}#{1,6}(?:\s|$)/u.test(raw) || /^\s*(?:[-*_]\s*){3,}$/u.test(raw)) continue;
    const line = raw.replace(/^\s*(?:>\s*)+/u, "").replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/u, "")
      .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/giu, " ")
      .replace(/[<>]/gu, " ")
      .replace(/[*`~]+/gu, "").replace(/(^|\s)_+|_+(?=\s|$)/gu, "$1")
      .replace(/\s+/gu, " ").trim();
    if (line) lines.push(line);
    if (lines.length >= MAX_LINES) break;
  }
  let excerpt = lines.reduce((joined, line) => !joined ? line
    : `${joined}${/[.!?:;]$/u.test(joined) ? "" : "."} ${line}`, "");
  if (excerpt.length > RELEASE_EXCERPT_LIMIT) {
    const cut = excerpt.slice(0, RELEASE_EXCERPT_LIMIT - 1);
    const space = cut.lastIndexOf(" ");
    excerpt = `${(space > RELEASE_EXCERPT_LIMIT / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/u, "")}${ELLIPSIS}`;
  }
  return isReleaseExcerpt(excerpt) ? excerpt : null;
}

// GitHub is the official Claude Code release publication feed, not its delayed stable channel.
export function parseClaudeCodeReleases(rows, observedAt) {
  if (!Array.isArray(rows) || rows.length > 30) return null;
  const valid = rows.flatMap((row) => {
    const match = typeof row?.tag_name === "string" ? VERSION.exec(row.tag_name) : null;
    if (!match || row.draft !== false || row.prerelease !== false || row.html_url !== `${BASE}${row.tag_name}`
      || typeof row.published_at !== "string" || !Number.isFinite(Date.parse(row.published_at))) return [];
    const publishedAt = new Date(row.published_at).toISOString();
    if (publishedAt > observedAt) return [];
    return [{ row, value: { provider: "claude", product: "claude_code", version: match[1], channel: "latest",
      publishedAt, observedAt, sourceKey: "anthropics/claude-code" } }];
  });
  valid.sort((a, b) => b.value.publishedAt.localeCompare(a.value.publishedAt));
  if (!valid[0]) return null;
  const excerpt = releaseBodyExcerpt(valid[0].row.body);
  return { ...valid[0].value, ...(excerpt ? { excerpt } : {}) };
}

export function createClaudeCodeReleaseReader(options = {}) {
  return createOfficialReleaseReader({ ...options,
    url: "https://api.github.com/repos/anthropics/claude-code/releases?per_page=30",
    parse: parseClaudeCodeReleases });
}
