import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { applyWaitingStatus, buildAgentMetadata, fallbackAgentMetadata } from "./agent-metadata.mjs";
import { findLatestSession, statSafe, walkJsonl } from "./session-discovery.mjs";

const PORT = Number(process.env.SESSION_PULSE_PORT || 4317);
const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
const EXPLICIT_SESSION = process.env.CLAUDE_SESSION_FILE;
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const gitCache = new Map();
let usageCache = { timestamp: 0, value: null, pending: null };

function emptyUsageLimits(error = "") {
  return { available: false, fetchedAt: null, limits: [], error };
}

async function usageLimits() {
  if (usageCache.value && Date.now() - usageCache.timestamp < 60_000) return usageCache.value;
  if (usageCache.pending) return usageCache.pending;
  usageCache.pending = (async () => {
    try {
      const credentialPath = path.join(os.homedir(), ".claude", ".credentials.json");
      const credentials = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
      const token = credentials.claudeAiOauth?.accessToken;
      if (!token) throw new Error("Claude OAuth session not found");
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "user-agent": "threadlight/0.1",
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) throw new Error(`Anthropic usage endpoint returned ${response.status}`);
      const body = await response.json();
      const normalized = (Array.isArray(body.limits) ? body.limits : []).flatMap((limit) => {
        if (limit.kind === "session") return [{
          id: "current-session", label: "Current session", window: "5 hours",
          percent: Number(limit.percent || 0), resetsAt: limit.resets_at || null,
          severity: limit.severity || "normal", active: Boolean(limit.is_active),
        }];
        if (limit.kind === "weekly_all") return [{
          id: "all-models", label: "All models", window: "7 days",
          percent: Number(limit.percent || 0), resetsAt: limit.resets_at || null,
          severity: limit.severity || "normal", active: Boolean(limit.is_active),
        }];
        if (limit.kind === "weekly_scoped" && limit.scope?.model?.display_name) return [{
          id: `model-${String(limit.scope.model.display_name).toLowerCase()}`,
          label: String(limit.scope.model.display_name), window: "7 days",
          percent: Number(limit.percent || 0), resetsAt: limit.resets_at || null,
          severity: limit.severity || "normal", active: Boolean(limit.is_active),
        }];
        return [];
      });
      const wanted = ["current-session", "all-models", "model-fable"];
      const limits = wanted.map((id) => normalized.find((limit) => limit.id === id)).filter(Boolean);
      const value = { available: limits.length > 0, fetchedAt: new Date().toISOString(), limits, error: "" };
      usageCache = { timestamp: Date.now(), value, pending: null };
      return value;
    } catch (error) {
      const value = usageCache.value || emptyUsageLimits(error instanceof Error ? error.message : "Usage unavailable");
      usageCache = { timestamp: Date.now(), value, pending: null };
      return value;
    }
  })();
  return usageCache.pending;
}

function readJsonlTail(file) {
  const stat = statSafe(file);
  if (!stat) return [];
  const bytes = Math.min(stat.size, MAX_BYTES_PER_FILE);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes)); }
  finally { fs.closeSync(fd); }
  let text = buffer.toString("utf8");
  if (stat.size > bytes) text = text.slice(text.indexOf("\n") + 1);
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function safeDetail(input = {}) {
  const file = input.file_path || input.path;
  if (typeof file === "string") return path.basename(file);
  if (typeof input.pattern === "string") return input.pattern.slice(0, 54);
  if (typeof input.command === "string") return input.command.replace(/\s+/g, " ").slice(0, 54);
  if (typeof input.description === "string") return input.description.slice(0, 54);
  if (typeof input.taskId === "string") return `task ${input.taskId}`;
  if (typeof input.delaySeconds === "number") return `${input.delaySeconds}s`;
  return "";
}

function signature(tool, input = {}) {
  const important = input.file_path || input.path || input.pattern || input.command || input.taskId || input.delaySeconds || input.description || "";
  return `${tool}:${String(important).replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function actorFor(file, mainFile, metadata) {
  if (file === mainFile) return { id: "primary", label: "Primary agent", kind: "orchestrator", parentId: null };
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

function statusFor(mtimeMs) {
  const age = Date.now() - mtimeMs;
  if (age < 45_000) return "active";
  if (age < 5 * 60_000) return "warm";
  return "idle";
}

function projectCwd(records) {
  return records.find((record) => typeof record.cwd === "string")?.cwd || "";
}

function projectName(mainFile, records) {
  const cwd = projectCwd(records);
  if (cwd) return path.basename(cwd);
  return path.basename(path.dirname(mainFile)).replace(/^[A-Z]--/, "").replaceAll("-", " ");
}

function gitState(cwd) {
  const empty = { available: false, branch: "Not a Git repository", files: [] };
  if (!cwd) return empty;
  const cached = gitCache.get(cwd);
  if (cached && Date.now() - cached.timestamp < 2500) return cached.value;
  try {
    const commonArgs = ["-c", `safe.directory=${cwd}`, "-c", "core.quotepath=false", "-C", cwd];
    let branch = execFileSync("git", [...commonArgs, "branch", "--show-current"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500,
    }).trim();
    if (!branch) {
      const hash = execFileSync("git", [...commonArgs, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500,
      }).trim();
      branch = `detached@${hash}`;
    }
    const output = execFileSync("git", [...commonArgs, "status", "--porcelain=v1"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2500,
    });
    const files = output.split(/\r?\n/).filter(Boolean).map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3),
    }));
    const value = { available: true, branch, files };
    gitCache.set(cwd, { timestamp: Date.now(), value });
    return value;
  } catch {
    gitCache.set(cwd, { timestamp: Date.now(), value: empty });
    return empty;
  }
}

function sessionTitle(records) {
  let aiTitle = "";
  let customTitle = "";
  for (const record of records) {
    if (record.type === "ai-title" && typeof record.aiTitle === "string") aiTitle = record.aiTitle;
    if (record.type === "custom-title") customTitle = record.customTitle || record.title || record.name || customTitle;
  }
  return customTitle || aiTitle || "Untitled session";
}

function runtimeMetadata(records) {
  let model = "unknown";
  let effort = "unspecified";
  for (const record of records) {
    if (record.type !== "assistant" || record.message?.model === "<synthetic>") continue;
    if (typeof record.message?.model === "string") model = record.message.model;
    if (typeof record.effort === "string") effort = record.effort;
  }
  return { model, effort };
}

async function analyze() {
  const mainFile = findLatestSession(CLAUDE_PROJECTS, EXPLICIT_SESSION);
  if (!mainFile) return {
    connected: true,
    source: "Claude Code",
    session: null,
    score: 100,
    metrics: {
      agents: 0,
      activeAgents: 0,
      toolCalls: 0,
      repeatedCalls: 0,
      tokens: { total: 0, cumulative: 0, allAgents: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, lastMinute: 0 },
    },
    agents: [], activity: [], insights: [],
    usageLimits: await usageLimits(),
    error: `No Claude Code sessions found under ${CLAUDE_PROJECTS}`,
  };

  const sessionId = path.basename(mainFile, ".jsonl");
  const agentDir = path.join(path.dirname(mainFile), sessionId, "subagents");
  const files = [mainFile, ...walkJsonl(agentDir, 1)];
  const recordsByFile = new Map(files.map((file) => [file, readJsonlTail(file)]));
  const mainRecords = recordsByFile.get(mainFile) || [];
  const agentMetadata = new Map();
  for (const [file, records] of recordsByFile) {
    const parentId = file === mainFile ? "primary" : path.basename(file, ".jsonl");
    for (const [agentId, metadata] of buildAgentMetadata(records, parentId)) agentMetadata.set(agentId, metadata);
  }
  for (const [file, records] of recordsByFile) {
    if (file === mainFile) continue;
    const agentId = path.basename(file, ".jsonl").replace(/^agent-/, "");
    if (!agentMetadata.has(agentId)) agentMetadata.set(agentId, fallbackAgentMetadata(records));
  }
  const allEvents = [];
  const agents = [];
  const signatureMap = new Map();
  const targetActors = new Map();
  const usageByMessage = new Map();
  let startedAt = null;
  let updatedAt = null;

  for (const file of files) {
    const stat = statSafe(file);
    if (!stat) continue;
    const actor = actorFor(file, mainFile, agentMetadata);
    const records = recordsByFile.get(file) || [];
    let calls = 0;
    for (const record of records) {
      const timestamp = record.timestamp || record.message?.timestamp;
      if (timestamp) {
        if (!startedAt || new Date(timestamp) < new Date(startedAt)) startedAt = timestamp;
        if (!updatedAt || new Date(timestamp) > new Date(updatedAt)) updatedAt = timestamp;
      }
      if (record.type === "assistant" && record.message?.usage) {
        const usage = record.message.usage;
        const messageId = record.message.id || record.requestId || record.uuid;
        if (messageId) usageByMessage.set(`${file}|${messageId}`, {
          actorId: actor.id,
          timestamp: timestamp || stat.mtime.toISOString(),
          input: Number(usage.input_tokens || 0),
          output: Number(usage.output_tokens || 0),
          cacheWrite: Number(usage.cache_creation_input_tokens || 0),
          cacheRead: Number(usage.cache_read_input_tokens || 0),
        });
      }
      if (record.type !== "assistant" || !Array.isArray(record.message?.content)) continue;
      for (const content of record.message.content) {
        if (content.type !== "tool_use") continue;
        calls += 1;
        const tool = content.name || "Tool";
        const input = content.input || {};
        const sig = signature(tool, input);
        const key = `${actor.id}|${sig}`;
        signatureMap.set(key, { count: (signatureMap.get(key)?.count || 0) + 1, actor, tool, detail: safeDetail(input) });
        const target = input.file_path || input.path;
        if (typeof target === "string") {
          const normalized = path.normalize(target).toLowerCase();
          if (!targetActors.has(normalized)) targetActors.set(normalized, { display: path.basename(target), actors: new Set(), calls: 0 });
          targetActors.get(normalized).actors.add(actor.id);
          targetActors.get(normalized).calls += 1;
        }
        allEvents.push({
          id: content.id || crypto.createHash("sha1").update(`${file}:${timestamp}:${calls}:${tool}`).digest("hex").slice(0, 12),
          timestamp: timestamp || stat.mtime.toISOString(), actor: actor.label, tool, detail: safeDetail(input), sig,
        });
      }
    }
    const runtime = runtimeMetadata(records);
    agents.push({
      id: actor.id,
      label: actor.label,
      kind: actor.kind,
      parentId: actor.parentId,
      model: runtime.model,
      effort: runtime.effort,
      status: statusFor(stat.mtimeMs),
      toolCalls: calls,
      lastSeen: stat.mtime.toISOString(),
    });
  }
  applyWaitingStatus(agents);

  const loops = [...signatureMap.values()].filter((item) => item.count >= 3);
  const overlaps = [...targetActors.values()].filter((item) => item.actors.size >= 2 && item.calls >= 3);
  const insights = [];
  for (const loop of loops.slice(0, 3)) insights.push({
    id: `loop-${loop.actor.id}-${loop.tool}-${loop.detail}`,
    level: "warning",
    title: `${loop.actor.label} repeated ${loop.tool} ${loop.count} times`,
    detail: loop.detail ? `The same target (${loop.detail}) keeps recurring. Check whether new evidence is being produced.` : "The same action keeps recurring. Check whether it is making progress.",
  });
  for (const overlap of overlaps.slice(0, 2)) insights.push({
    id: `overlap-${overlap.display}`,
    level: "warning",
    title: `Multiple agents touched ${overlap.display}`,
    detail: `${overlap.actors.size} agents inspected the same target across ${overlap.calls} calls. Their work may overlap.`,
  });
  if (!insights.length) insights.push({
    id: "healthy-flow",
    level: "info",
    title: "No obvious loops right now",
    detail: "Tool activity is varied and agent overlap remains low. The coach will stay quiet unless that changes.",
  });

  const repeatedCalls = loops.reduce((total, item) => total + item.count - 1, 0);
  const activeAgents = agents.filter((agent) => agent.status === "active").length;
  const tokensByAgent = new Map(agents.map((agent) => [agent.id, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, lastMinute: 0 }]));
  const latestByAgent = new Map();
  const cumulativeUsage = [...usageByMessage.values()].reduce((total, usage) => {
    const usageTime = new Date(usage.timestamp).getTime();
    const previous = latestByAgent.get(usage.actorId);
    const snapshotTotal = usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
    if (snapshotTotal > 0 && (!previous || usageTime > new Date(previous.timestamp).getTime())) {
      latestByAgent.set(usage.actorId, usage);
    }
    const agentTotal = tokensByAgent.get(usage.actorId);
    if (agentTotal) {
      agentTotal.input += usage.input;
      agentTotal.output += usage.output;
      agentTotal.cacheWrite += usage.cacheWrite;
      agentTotal.cacheRead += usage.cacheRead;
      if (Date.now() - new Date(usage.timestamp).getTime() <= 60_000) {
        agentTotal.lastMinute += usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
      }
    }
    total.cumulative += usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
    if (Date.now() - usageTime <= 60_000) {
      total.lastMinute += usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
    }
    return total;
  }, { cumulative: 0, lastMinute: 0 });
  for (const agent of agents) {
    const cumulative = tokensByAgent.get(agent.id);
    const latest = latestByAgent.get(agent.id) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    agent.tokens = {
      input: latest.input,
      output: latest.output,
      cacheWrite: latest.cacheWrite,
      cacheRead: latest.cacheRead,
      total: latest.input + latest.output + latest.cacheWrite + latest.cacheRead,
      cumulative: cumulative.input + cumulative.output + cumulative.cacheWrite + cumulative.cacheRead,
      lastMinute: cumulative.lastMinute,
    };
  }
  const primaryTokens = agents.find((agent) => agent.id === "primary")?.tokens || {
    total: 0, cumulative: 0, allAgents: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, lastMinute: 0,
  };
  const allAgents = agents.reduce((total, agent) => total + agent.tokens.total, 0);
  const tokenUsage = {
    ...primaryTokens,
    allAgents,
    cumulative: cumulativeUsage.cumulative,
    lastMinute: cumulativeUsage.lastMinute,
  };
  const cwd = projectCwd(mainRecords);
  const repository = gitState(cwd);
  const currentUsageLimits = await usageLimits();
  const score = Math.max(25, 100 - Math.min(45, repeatedCalls * 4) - Math.min(25, overlaps.length * 7));
  allEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  agents.sort((a, b) => (a.id === "primary" ? -1 : b.id === "primary" ? 1 : new Date(b.lastSeen) - new Date(a.lastSeen)));

  return {
    connected: true,
    source: "Claude Code",
    session: {
      id: sessionId,
      title: sessionTitle(mainRecords),
      project: projectName(mainFile, mainRecords),
      cwd,
      repository,
      startedAt,
      updatedAt: updatedAt || statSafe(mainFile)?.mtime.toISOString(),
      durationMs: startedAt && updatedAt ? Math.max(0, new Date(updatedAt).getTime() - new Date(startedAt).getTime()) : 0,
    },
    score,
    metrics: { agents: agents.length, activeAgents, toolCalls: allEvents.length, repeatedCalls, tokens: tokenUsage },
    agents,
    activity: allEvents.slice(0, 30).map(({ id, timestamp, actor, tool, detail }) => ({ id, timestamp, actor, tool, detail })),
    insights,
    usageLimits: currentUsageLimits,
  };
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (request.url === "/api/state") {
    try {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(await analyze()));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ...analyzeEmpty(), error: error instanceof Error ? error.message : "Monitor error" }));
    }
    return;
  }
  if (request.url === "/health") { response.writeHead(204); response.end(); return; }
  response.writeHead(404); response.end("Not found");
});

function analyzeEmpty() {
  return {
    connected: false,
    source: "Claude Code",
    session: null,
    score: 100,
    metrics: {
      agents: 0,
      activeAgents: 0,
      toolCalls: 0,
      repeatedCalls: 0,
      tokens: { total: 0, cumulative: 0, allAgents: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, lastMinute: 0 },
    },
    agents: [], activity: [], insights: [], usageLimits: emptyUsageLimits(),
  };
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Threadlight monitor: http://127.0.0.1:${PORT}`);
  console.log(`Watching: ${CLAUDE_PROJECTS}`);
});
