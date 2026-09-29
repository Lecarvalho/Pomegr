import fs from "node:fs";
import readline from "node:readline";
import crypto from "node:crypto";

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

function normalizedTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function creationEvent({ actorId = "primary", callId, timestamp, url }) {
  return {
    id: `pr-${crypto.createHash("sha1").update(`claude|${actorId}|${callId}|${url}`).digest("hex").slice(0, 16)}`,
    actorId,
    timestamp: normalizedTimestamp(timestamp),
    url,
  };
}

function collectPullRequestCreations(records, state, options = {}) {
  if (state.events.length >= MAX_PULL_REQUESTS) return state;
  for (const record of records || []) {
    for (const part of Array.isArray(record?.message?.content) ? record.message.content : []) {
      if (record.type === "assistant" && createdPullRequestTool(part)) state.creationToolIds.set(part.id, {
        actorId: options.actorId || "primary",
        timestamp: record.timestamp || record.message?.timestamp || null,
      });
      const creation = state.creationToolIds.get(part?.tool_use_id);
      if (record.type !== "user" || part?.type !== "tool_result" || part.is_error || !creation) continue;
      const text = resultText(part.content);
      GITHUB_PULL_REQUEST_URL.lastIndex = 0;
      for (const match of text.matchAll(GITHUB_PULL_REQUEST_URL)) {
        const reference = pullRequestReference(match[0]);
        if (!reference || state.seen.has(reference.url)) continue;
        state.seen.add(reference.url);
        state.events.push(creationEvent({
          ...creation,
          callId: part.tool_use_id,
          timestamp: record.timestamp || record.message?.timestamp || creation.timestamp,
          url: reference.url,
        }));
        if (state.events.length >= MAX_PULL_REQUESTS) return state;
      }
    }
  }
  return state;
}

function newCreationState(events = [], creationToolIds = []) {
  return { creationToolIds: new Map(creationToolIds), events: [...events], seen: new Set(events.map(({ url }) => url)) };
}

/** Preserve the existing focused parser API while keeping Claude schema logic in the adapter layer. */
export function pullRequestUrls(records) {
  return pullRequestCreationEvents(records).map(({ url }) => url);
}

export function pullRequestCreationEvents(records, options = {}) {
  return collectPullRequestCreations(records, newCreationState(), options).events;
}

async function scanCompleteTranscript(file, options) {
  const state = newCreationState();
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try { collectPullRequestCreations([JSON.parse(line)], state, options); }
    catch { /* Ignore malformed or partially written JSONL records. */ }
  }
  return state;
}

async function readTranscriptPullRequestCreations(file, recentRecords = [], options = {}) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { return []; }
  const cached = transcriptUrlCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.events;
  const state = cached && stat.size > cached.size && stat.size - cached.size <= 2 * 1024 * 1024
    ? collectPullRequestCreations(recentRecords, newCreationState(cached.events, cached.creationToolIds), options)
    : await scanCompleteTranscript(file, options);
  transcriptUrlCache.set(file, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    events: state.events,
    creationToolIds: state.creationToolIds,
  });
  return state.events;
}

export async function readClaudePullRequestCreations(transcripts = []) {
  const groups = await Promise.all(transcripts.map(async ({ file, records, actorId }) => {
    try { return await readTranscriptPullRequestCreations(file, records, { actorId }); }
    catch { return []; }
  }));
  const seen = new Set();
  return groups.flat().filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  }).slice(0, MAX_PULL_REQUESTS);
}

export async function readClaudePullRequestUrls(transcripts = []) {
  return (await readClaudePullRequestCreations(transcripts)).map(({ url }) => url);
}
