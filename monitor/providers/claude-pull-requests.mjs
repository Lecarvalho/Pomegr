import fs from "node:fs";
import readline from "node:readline";

const MAX_PULL_REQUESTS = 8;
const GITHUB_PULL_REQUEST_URL = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,10})(?![A-Za-z0-9/?#])/g;
const transcriptUrlCache = new Map();

function canonicalPullRequestUrl(owner, repository, number) {
  return `https://github.com/${owner}/${repository}/pull/${number}`;
}

function pullRequestReference(url) {
  GITHUB_PULL_REQUEST_URL.lastIndex = 0;
  const match = GITHUB_PULL_REQUEST_URL.exec(url);
  if (!match || match[0] !== url) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { url: canonicalPullRequestUrl(match[1], match[2], number) };
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join("\n");
}

function createdPullRequestTool(part) {
  if (part?.type !== "tool_use" || typeof part.id !== "string") return false;
  if (part.name === "Bash" && typeof part.input?.command === "string") {
    return /(?:^|\s)gh\s+pr\s+create(?:\s|$)/i.test(part.input.command);
  }
  return typeof part.name === "string" && /(?:^|__)create_pull_request$/i.test(part.name);
}

function collectPullRequestUrls(records, state) {
  if (state.urls.length >= MAX_PULL_REQUESTS) return state;
  for (const record of records || []) {
    for (const part of Array.isArray(record?.message?.content) ? record.message.content : []) {
      if (record.type === "assistant" && createdPullRequestTool(part)) state.creationToolIds.add(part.id);
      if (record.type !== "user" || part?.type !== "tool_result" || part.is_error || !state.creationToolIds.has(part.tool_use_id)) continue;
      const text = resultText(part.content);
      GITHUB_PULL_REQUEST_URL.lastIndex = 0;
      for (const match of text.matchAll(GITHUB_PULL_REQUEST_URL)) {
        const reference = pullRequestReference(match[0]);
        if (!reference || state.seen.has(reference.url)) continue;
        state.seen.add(reference.url);
        state.urls.push(reference.url);
        if (state.urls.length >= MAX_PULL_REQUESTS) return state;
      }
    }
  }
  return state;
}

function newUrlState(urls = []) {
  return { creationToolIds: new Set(), urls: [...urls], seen: new Set(urls) };
}

/** Preserve the existing focused parser API while keeping Claude schema logic in the adapter layer. */
export function pullRequestUrls(records) {
  return collectPullRequestUrls(records, newUrlState()).urls;
}

async function scanCompleteTranscript(file) {
  const state = newUrlState();
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try { collectPullRequestUrls([JSON.parse(line)], state); }
    catch { /* Ignore malformed or partially written JSONL records. */ }
  }
  return state.urls;
}

async function readTranscriptPullRequestUrls(file, recentRecords = []) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { return []; }
  const cached = transcriptUrlCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.urls;
  const urls = cached && stat.size > cached.size && stat.size - cached.size <= 2 * 1024 * 1024
    ? collectPullRequestUrls(recentRecords, newUrlState(cached.urls)).urls
    : await scanCompleteTranscript(file);
  transcriptUrlCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, urls });
  return urls;
}

export async function readClaudePullRequestUrls(transcripts = []) {
  const groups = await Promise.all(transcripts.map(async ({ file, records }) => {
    try { return await readTranscriptPullRequestUrls(file, records); }
    catch { return []; }
  }));
  return [...new Set(groups.flat())].slice(0, MAX_PULL_REQUESTS);
}
