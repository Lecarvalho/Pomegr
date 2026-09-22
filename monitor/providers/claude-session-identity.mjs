import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { repositoryProjectName } from "../session-discovery.mjs";

export const MAX_SESSION_TITLE_RECORD_BYTES = 16 * 1024;

/** Transcript-file identity: the main file is the primary agent, every other file a subagent. */
export function actorFor(file, mainFile, metadata, workflowFiles = new Map()) {
  if (file === mainFile) return { id: "primary", label: "Primary agent", kind: "orchestrator", parentId: null };
  const workflowAgent = workflowFiles.get(file);
  if (workflowAgent) return {
    id: workflowAgent.id,
    label: workflowAgent.fallbackLabel,
    kind: workflowAgent.metadata?.agentType || "workflow-subagent",
    parentId: "primary",
  };
  const id = path.basename(file, ".jsonl");
  const agentId = id.replace(/^agent-/, "");
  const resolved = metadata.get(agentId);
  return {
    id,
    label: resolved?.description || "Unnamed subagent",
    kind: resolved?.kind || "subagent",
    parentId: resolved?.parentId || null,
  };
}
export function statusFor(mtimeMs, now = Date.now()) {
  const age = now - mtimeMs;
  if (age < 45_000) return "active";
  if (age < 5 * 60_000) return "warm";
  return "idle";
}
export function projectCwd(records) {
  return records.find((record) => typeof record.cwd === "string")?.cwd || "";
}
export function projectName(mainFile, records) {
  const cwd = projectCwd(records);
  if (cwd) return repositoryProjectName(cwd);
  return path.basename(path.dirname(mainFile)).replace(/^[A-Z]--/, "").replaceAll("-", " ");
}
export function recordedGitBranch(records) {
  let branch = "";
  for (const record of records) {
    if (typeof record.gitBranch === "string") branch = record.gitBranch;
  }
  return branch;
}
export function sessionTitleState(records, initial = {}) {
  let aiTitle = initial.aiTitle || "";
  let customTitle = initial.customTitle || "";
  let createdAt = initial.createdAt || "";
  for (const record of records) {
    const timestamp = record.timestamp || record.message?.timestamp;
    const timestampMs = Date.parse(timestamp || "");
    if (Number.isFinite(timestampMs) && (!createdAt || timestampMs < Date.parse(createdAt))) {
      createdAt = new Date(timestampMs).toISOString();
    }
    if (record.type === "ai-title" && typeof record.aiTitle === "string") aiTitle = record.aiTitle;
    if (record.type === "custom-title") customTitle = record.customTitle || record.title || record.name || customTitle;
  }
  return { aiTitle, customTitle, createdAt };
}
export function sessionTitle(records) {
  const { aiTitle, customTitle } = sessionTitleState(records);
  return customTitle || aiTitle || "Untitled session";
}
export async function scanSessionTitleState(file, stat, initial = {}, start = 0) {
  if (!stat?.isFile() || stat.size <= 0) return sessionTitleState([], initial);
  let input;
  let lines;
  let firstLine = true;
  const state = sessionTitleState([], initial);
  try {
    input = fs.createReadStream(file, {
      encoding: "utf8",
      start,
      end: stat.size - 1,
    });
    lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (firstLine) {
        firstLine = false;
        if (start > 0) continue;
      }
      if ((state.createdAt && !line.includes("ai-title") && !line.includes("custom-title"))
        || Buffer.byteLength(line, "utf8") > MAX_SESSION_TITLE_RECORD_BYTES) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const next = sessionTitleState([record], state);
      state.aiTitle = next.aiTitle;
      state.customTitle = next.customTitle;
      state.createdAt = next.createdAt;
    }
    return state;
  } finally {
    lines?.close();
    input?.destroy();
  }
}
export function runtimeMetadata(records) {
  let model = "unknown";
  let effort = "unspecified";
  for (const record of records) {
    if (record.type !== "assistant" || record.message?.model === "<synthetic>") continue;
    if (typeof record.message?.model === "string") model = record.message.model;
    if (typeof record.effort === "string") effort = record.effort;
  }
  return { model, effort };
}
