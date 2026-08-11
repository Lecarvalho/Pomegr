import crypto from "node:crypto";
import fs from "node:fs";
import { codexTimestamp } from "./codex-session-metadata.mjs";

const MAX_PULL_REQUESTS = 8;
const GITHUB_PULL_REQUEST_URL = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,10})(?![A-Za-z0-9/?#])/g;

function canonicalUrl(match) {
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return `https://github.com/${match[1]}/${match[2]}/pull/${number}`;
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resultText(value, depth = 0) {
  if (depth > 3) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => resultText(part, depth + 1)).join("\n");
  if (!value || typeof value !== "object") return "";
  return [value.text, value.content, value.output, value.result]
    .map((part) => resultText(part, depth + 1))
    .filter(Boolean)
    .join("\n");
}

function successful(value) {
  if (value?.is_error === true || value?.isError === true || value?.success === false) return false;
  if (Number.isInteger(value?.exit_code) && value.exit_code !== 0) return false;
  if (Number.isInteger(value?.exitCode) && value.exitCode !== 0) return false;
  const status = String(value?.status || "").toLowerCase().replace(/[^a-z]/g, "");
  return !["failed", "failure", "error", "errored", "declined", "interrupted", "cancelled", "canceled"].includes(status);
}

function normalizedName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPullRequestCreationTool(name, input) {
  if (/(?:^|__)create_pull_request$/i.test(String(name || ""))) return true;
  if (!["shellcommand", "execcommand", "commandexecution"].includes(normalizedName(name))) return false;
  const parsed = parseObject(input);
  const command = typeof parsed?.command === "string" ? parsed.command : typeof input === "string" ? input : "";
  return /(?:^|\s)gh\s+pr\s+create(?:\s|$)/i.test(command);
}

function creationEvent(actorId, sourceKey, callId, timestamp, url) {
  return {
    id: `pr-${crypto.createHash("sha1").update(`codex|${actorId}|${sourceKey}|${callId}|${url}`).digest("hex").slice(0, 16)}`,
    actorId,
    timestamp: codexTimestamp(timestamp),
    url,
  };
}

function urlsFromResult(value) {
  const text = resultText(value);
  GITHUB_PULL_REQUEST_URL.lastIndex = 0;
  const seen = new Set();
  return [...text.matchAll(GITHUB_PULL_REQUEST_URL)].flatMap((match) => {
    const url = canonicalUrl(match);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [url];
  });
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    if (!event?.url || seen.has(event.url)) return false;
    seen.add(event.url);
    return true;
  }).slice(0, MAX_PULL_REQUESTS);
}

export function parseCodexPullRequestRecords(records, options = {}) {
  const actorId = options.actorId || "primary";
  const sourceKey = options.sourceKey || actorId;
  const creationCalls = new Map();
  const events = [];
  for (const [order, record] of (Array.isArray(records) ? records : []).entries()) {
    const payload = record?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const timestamp = codexTimestamp(record.timestamp ?? payload.timestamp) || options.fallbackTimestamp;
    if (record.type === "response_item") {
      if (["function_call", "custom_tool_call"].includes(payload.type)) {
        if (isPullRequestCreationTool(payload.name, payload.arguments ?? payload.input)) {
          const callId = String(payload.call_id ?? payload.callId ?? payload.id ?? `${sourceKey}:${order}`);
          creationCalls.set(callId, { callId, timestamp });
        }
        continue;
      }
      if (!["function_call_output", "custom_tool_call_output"].includes(payload.type) || !successful(payload)) continue;
      const callId = String(payload.call_id ?? payload.callId ?? payload.id ?? "");
      const creation = creationCalls.get(callId);
      if (!creation) continue;
      for (const url of urlsFromResult(payload.output ?? payload.content ?? payload.result)) {
        events.push(creationEvent(actorId, sourceKey, callId, timestamp || creation.timestamp, url));
      }
      continue;
    }
    if (record.type !== "event_msg") continue;
    const eventType = normalizedName(payload.type);
    const callId = String(payload.call_id ?? payload.callId ?? payload.id ?? `${sourceKey}:${order}`);
    if (eventType === "execcommandbegin" && isPullRequestCreationTool("shell_command", { command: payload.command })) {
      creationCalls.set(callId, { callId, timestamp });
    } else if (eventType === "execcommandend" && creationCalls.has(callId) && successful(payload)) {
      const creation = creationCalls.get(callId);
      for (const url of urlsFromResult(payload.aggregated_output ?? payload.output ?? payload.result)) {
        events.push(creationEvent(actorId, sourceKey, callId, timestamp || creation.timestamp, url));
      }
    }
  }
  return dedupeEvents(events);
}

export function parseCodexCanonicalPullRequests(turns, options = {}) {
  const actorId = options.actorId || "primary";
  const sourceKey = options.sourceKey || actorId;
  const events = [];
  for (const [turnIndex, turn] of (Array.isArray(turns) ? turns : []).entries()) {
    const timestamp = codexTimestamp(turn?.completedAt) || codexTimestamp(turn?.startedAt) || options.fallbackTimestamp;
    for (const [itemIndex, item] of (Array.isArray(turn?.items) ? turn.items : []).entries()) {
      if (!item || typeof item !== "object" || !successful(item)) continue;
      const isCreation = item.type === "commandExecution"
        ? isPullRequestCreationTool("commandExecution", { command: item.command })
        : item.type === "mcpToolCall"
          ? isPullRequestCreationTool(`${item.server ? `${item.server}__` : ""}${item.tool}`, item.arguments)
          : item.type === "dynamicToolCall"
            ? isPullRequestCreationTool(item.tool, item.arguments)
            : false;
      if (!isCreation) continue;
      const callId = String(item.id ?? `${turn?.id || turnIndex}:${itemIndex}`);
      for (const url of urlsFromResult(item.aggregatedOutput ?? item.output ?? item.result)) {
        events.push(creationEvent(actorId, sourceKey, callId, timestamp, url));
      }
    }
  }
  return dedupeEvents(events);
}

export function readCodexPullRequestRollout(file, options = {}) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
    } catch {
      // Malformed and truncated lines do not invalidate recognized PR evidence.
    }
  }
  return parseCodexPullRequestRecords(records, options);
}

export function mergeCodexPullRequestCreations(groups) {
  return dedupeEvents(groups.flat().sort((left, right) => (
    Date.parse(left.timestamp || "") - Date.parse(right.timestamp || "") || left.id.localeCompare(right.id)
  )));
}
