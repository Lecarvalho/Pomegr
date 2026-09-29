import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { repositoryProjectName } from "../../normalize/session-discovery.mjs";
import { resolveSessionIdentity } from "../../normalize/session-identity.mjs";

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

function fallbackProjectName(mainFile) {
  return path.basename(path.dirname(mainFile)).replace(/^[A-Z]--/, "").replaceAll("-", " ");
}

/**
 * Catalog-header project name. Claude's recorded cwd is its launch directory, and the
 * nearest enclosing repository names it: the launch-directory half of the shared rule in
 * server/normalize/session-identity.mjs, answered from the filesystem so a catalog row never waits
 * on, or caches the timeout of, a Git subprocess.
 * @param {string} mainFile
 * @param {Array<{ cwd?: string }>} records
 */
export function projectName(mainFile, records) {
  const cwd = projectCwd(records);
  return cwd ? repositoryProjectName(cwd) : fallbackProjectName(mainFile);
}

/**
 * Full-evidence session identity through the shared rule (server/normalize/session-identity.mjs).
 * A launch directory proven to be one Git repository records `single` with its
 * repositoryId and the rule's project. Otherwise (not Git, a removed worktree, Git
 * unavailable, or a timeout) Claude's evidence stays bound to its launch directory as it
 * always was: the generic `launch` attribution, and the header's project name. Claude
 * never records `multiple`: it has no structured mutation-root evidence.
 * `root` never leaves server/normalize/session-identity.mjs.
 * @param {string} mainFile
 * @param {Array<{ cwd?: string }>} records
 * @param {{ resolveRepository?: ((cwd: string, options?: { requireGit?: boolean }) => Promise<{ repositoryId: string, root: string } | null> | { repositoryId: string, root: string } | null) | null }} [options]
 * @returns {Promise<{ project: string, repositoryId: string|null, repositoryAttribution: "single"|"launch" }>}
 */
export async function readSessionIdentity(mainFile, records, { resolveRepository } = {}) {
  const cwd = projectCwd(records);
  const launch = { project: projectName(mainFile, records), repositoryId: null, repositoryAttribution: /** @type {const} */ ("launch") };
  if (!cwd) return launch;
  const identity = await resolveSessionIdentity({ launchCwd: cwd, resolveRepository, resolverTimeoutMs: 5_000 });
  return identity.state === "single"
    ? { project: identity.project, repositoryId: identity.repositoryId, repositoryAttribution: /** @type {const} */ ("single") }
    : launch;
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
