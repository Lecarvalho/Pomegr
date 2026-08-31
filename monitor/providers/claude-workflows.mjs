import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statSafe } from "../session-discovery.mjs";

const MAX_WORKFLOWS = 24;
const MAX_WORKFLOW_AGENTS = 64;
const MAX_WORKFLOW_PHASES = 32;
const MAX_WORKFLOW_PROGRESS_ITEMS = 256;
const MAX_WORKFLOW_MANIFEST_BYTES = 512 * 1024;
const MAX_WORKFLOW_JOURNAL_BYTES = 256 * 1024;
const MAX_WORKFLOW_JOURNAL_RECORD_BYTES = 16 * 1024;
const MAX_WORKFLOW_METADATA_BYTES = 16 * 1024;
const MAX_WORKFLOW_DURATION_MS = 366 * 24 * 60 * 60 * 1_000;
const SAFE_WORKFLOW_RUN_ID = /^wf_[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_WORKFLOW_AGENT_FILE = /^agent-([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.jsonl$/;
const SAFE_WORKFLOW_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export const terminalClaudeWorkflowAgentStates = new Set(["done", "error"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanWorkflowText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function workflowTimestamp(value) {
  const time = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" ? Date.parse(value) : Number.NaN;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Resume reuses the run ID and leaves the previous completion manifest in place.
// Only a completion at or after this launch can close its execution attempt.
export function claudeWorkflowCompletionMatchesLaunch(manifest, runId, launchedAt = undefined) {
  if (!plainObject(manifest) || manifest.status !== "completed" || manifest.runId !== runId) return false;
  if (launchedAt === undefined) return true; // Discovery without a recorded launch.
  const completed = workflowTimestamp(manifest.timestamp);
  const launched = workflowTimestamp(launchedAt);
  return completed !== null && launched !== null && Date.parse(completed) >= Date.parse(launched);
}

function workflowDuration(value) {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_WORKFLOW_DURATION_MS)
    : null;
}

function workflowLaunches(records) {
  const launches = new Map();
  for (const record of records) {
    const result = record?.toolUseResult;
    if (!plainObject(result)
      || result.status !== "async_launched"
      || result.taskType !== "local_workflow"
      || !SAFE_WORKFLOW_RUN_ID.test(result.runId || "")) continue;
    const runId = result.runId;
    if (!launches.has(runId) && launches.size >= MAX_WORKFLOWS) continue;
    launches.set(runId, {
      runId,
      name: cleanWorkflowText(result.workflowName, 80) || "Workflow",
      summary: cleanWorkflowText(result.summary, 240) || null,
      observedAt: workflowTimestamp(record.timestamp || record.message?.timestamp),
    });
  }
  return launches;
}

function readWorkflowAgentMetadata(file) {
  const stat = statSafe(file);
  if (!stat || stat.size <= 0 || stat.size > MAX_WORKFLOW_METADATA_BYTES) return null;
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!plainObject(metadata)) return null;
  const rawAgentType = cleanWorkflowText(metadata.agentType, 40);
  const rawModel = cleanWorkflowText(metadata.model, 80);
  const agentType = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(rawAgentType) ? rawAgentType : "";
  const model = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(rawModel) ? rawModel : "";
  const spawnDepth = Number.isInteger(metadata.spawnDepth) && metadata.spawnDepth >= 0 && metadata.spawnDepth <= 32
    ? metadata.spawnDepth
    : null;
  return { agentType: agentType || null, model: model || null, spawnDepth };
}

function assignWorkflowFallbackLabels(agents) {
  const labels = new Map();
  const byCandidate = new Map();
  for (const agent of agents) {
    const candidate = agent.rawAgentId.slice(0, 6).toLowerCase();
    if (!byCandidate.has(candidate)) byCandidate.set(candidate, []);
    byCandidate.get(candidate).push(agent);
  }
  for (const [candidate, matches] of byCandidate) {
    for (const agent of matches) {
      const suffix = matches.length === 1
        ? candidate
        : crypto.createHash("sha1").update(agent.rawAgentId).digest("hex").slice(0, 6);
      labels.set(agent.rawAgentId, `Workflow worker · ${suffix}`);
    }
  }
  return labels;
}

function workflowWorkerOrderLabel(order, metadata) {
  const agentType = metadata?.agentType && metadata.agentType !== "workflow-subagent" ? metadata.agentType : "";
  return agentType ? `Worker ${order + 1} · ${agentType}` : `Worker ${order + 1}`;
}

export function discoverClaudeWorkflowAgents(agentDir) {
  const root = path.join(agentDir, "workflows");
  const runs = new Map();
  if (!fs.existsSync(root)) return { runs, files: [] };
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { runs, files: [] }; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (runs.size >= MAX_WORKFLOWS) break;
    if (!entry.isDirectory() || !SAFE_WORKFLOW_RUN_ID.test(entry.name)) continue;
    const run = { runId: entry.name, agents: [] };
    let agentEntries = [];
    try { agentEntries = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true }); } catch { /* ignore one run */ }
    for (const agentEntry of agentEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (run.agents.length >= MAX_WORKFLOW_AGENTS || !agentEntry.isFile()) continue;
      const match = agentEntry.name.match(SAFE_WORKFLOW_AGENT_FILE);
      if (!match) continue;
      const file = path.join(root, entry.name, agentEntry.name);
      run.agents.push({
        file,
        rawAgentId: match[1],
        id: `workflow-${entry.name}-agent-${match[1]}`,
        runId: entry.name,
        metadata: readWorkflowAgentMetadata(file.replace(/\.jsonl$/, ".meta.json")),
      });
    }
    const fallbackLabels = assignWorkflowFallbackLabels(run.agents);
    for (const agent of run.agents) agent.fallbackLabel = fallbackLabels.get(agent.rawAgentId);
    runs.set(entry.name, run);
  }
  return { runs, files: [...runs.values()].flatMap((run) => run.agents) };
}

function readWorkflowJournal(file, discovered) {
  const stat = statSafe(file);
  const empty = { order: [], states: new Map() };
  if (!stat || stat.size <= 0 || stat.size > MAX_WORKFLOW_JOURNAL_BYTES) return empty;
  const matchedIds = new Set(discovered.map((agent) => agent.rawAgentId));
  const order = [];
  const states = new Map();
  let contents;
  try { contents = fs.readFileSync(file, "utf8"); } catch { return empty; }
  for (const line of contents.split(/\r?\n/)) {
    if (!line || Buffer.byteLength(line, "utf8") > MAX_WORKFLOW_JOURNAL_RECORD_BYTES) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!plainObject(record) || (record.type !== "started" && record.type !== "result")) continue;
    const rawAgentId = typeof record.agentId === "string" ? record.agentId.replace(/^agent-/, "") : "";
    if (!SAFE_WORKFLOW_AGENT_ID.test(rawAgentId) || !matchedIds.has(rawAgentId)) continue;
    if (record.type === "started") {
      if (!order.includes(rawAgentId)) order.push(rawAgentId);
      if (!states.has(rawAgentId)) states.set(rawAgentId, "running");
    } else {
      states.set(rawAgentId, "done");
    }
  }
  return { order, states };
}

function discoverWorkflowManifestIds(workflowRoot) {
  if (!fs.existsSync(workflowRoot)) return [];
  try {
    return fs.readdirSync(workflowRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.basename(entry.name, ".json"))
      .filter((runId) => SAFE_WORKFLOW_RUN_ID.test(runId))
      .sort()
      .slice(0, MAX_WORKFLOWS);
  } catch {
    return [];
  }
}

function readCompletedWorkflowManifest(file, expectedRunId, cache, launchedAt) {
  const stat = statSafe(file);
  if (!stat || stat.size <= 0 || stat.size > MAX_WORKFLOW_MANIFEST_BYTES) return null;
  const key = `${stat.size}:${stat.mtimeMs}:${launchedAt}`;
  const cached = cache.get(file);
  if (cached?.key === key) return cached.value;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); } catch { manifest = null; }
  let value = null;
  if (claudeWorkflowCompletionMatchesLaunch(manifest, expectedRunId, launchedAt)) {
    const phaseByIndex = new Map();
    if (Array.isArray(manifest.phases)) {
      for (const [offset, phase] of manifest.phases.slice(0, MAX_WORKFLOW_PHASES).entries()) {
        const label = cleanWorkflowText(phase?.title, 80);
        if (label) phaseByIndex.set(offset + 1, label);
      }
    }
    if (Array.isArray(manifest.workflowProgress)) {
      for (const item of manifest.workflowProgress.slice(0, MAX_WORKFLOW_PROGRESS_ITEMS)) {
        if (item?.type !== "workflow_phase") continue;
        const index = Number(item.index);
        const label = cleanWorkflowText(item.title, 80);
        if (Number.isInteger(index) && index > 0 && index <= MAX_WORKFLOW_PHASES && label && !phaseByIndex.has(index)) {
          phaseByIndex.set(index, label);
        }
      }
    }
    const workers = [];
    const seenWorkers = new Set();
    if (Array.isArray(manifest.workflowProgress)) {
      for (const item of manifest.workflowProgress.slice(0, MAX_WORKFLOW_PROGRESS_ITEMS)) {
        if (workers.length >= MAX_WORKFLOW_AGENTS || item?.type !== "workflow_agent") continue;
        const rawAgentId = String(item.agentId || "").replace(/^agent-/, "");
        if (!SAFE_WORKFLOW_AGENT_ID.test(rawAgentId) || seenWorkers.has(rawAgentId)) continue;
        seenWorkers.add(rawAgentId);
        const phaseIndex = Number(item.phaseIndex);
        workers.push({
          rawAgentId,
          label: cleanWorkflowText(item.label, 80) || null,
          phaseIndex: Number.isInteger(phaseIndex) && phaseByIndex.has(phaseIndex) ? phaseIndex : null,
          state: item.state === "done" || item.state === "error" || item.state === "running"
            ? item.state
            : "unknown",
        });
      }
    }
    const startedAt = workflowTimestamp(manifest.startTime);
    const updatedAt = workflowTimestamp(manifest.timestamp);
    const derivedDuration = startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : 0;
    value = {
      name: cleanWorkflowText(manifest.workflowName, 80) || null,
      summary: cleanWorkflowText(manifest.summary, 240) || null,
      startedAt,
      updatedAt,
      durationMs: workflowDuration(manifest.durationMs) ?? Math.min(derivedDuration, MAX_WORKFLOW_DURATION_MS),
      phases: [...phaseByIndex].sort((left, right) => left[0] - right[0]).map(([index, label]) => ({ index, label })),
      workers,
    };
  }
  cache.set(file, { key, value });
  return value;
}

function hasStrongWorkflowLiveness(agent, historical) {
  return !historical && (
    agent?.status === "active"
    || agent?.status === "warm"
    || agent?.status === "waiting"
    || agent?.status === "needs_input"
  );
}

export function buildClaudeWorkflows({
  mainRecords,
  workflowRoot,
  workflowDiscovery,
  agents,
  historical,
  manifestCache,
}) {
  const launches = workflowLaunches(mainRecords);
  const runIds = [];
  const rememberRun = (runId) => {
    if (!runIds.includes(runId) && runIds.length < MAX_WORKFLOWS) runIds.push(runId);
  };
  for (const runId of launches.keys()) rememberRun(runId);
  for (const runId of workflowDiscovery.runs.keys()) rememberRun(runId);
  for (const runId of discoverWorkflowManifestIds(workflowRoot)) rememberRun(runId);

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return runIds.map((runId) => {
    const launch = launches.get(runId) || null;
    const discovered = workflowDiscovery.runs.get(runId)?.agents || [];
    const manifest = readCompletedWorkflowManifest(path.join(workflowRoot, `${runId}.json`), runId, manifestCache, launch?.observedAt);
    const journal = readWorkflowJournal(path.join(path.dirname(workflowRoot), "subagents", "workflows", runId, "journal.jsonl"), discovered);
    const rawAgentIds = new Map(discovered.map((item) => [item.rawAgentId, item.id]));
    const phaseAgents = new Map();

    const fallbackRawOrder = [
      ...journal.order,
      ...discovered
        .filter((item) => !journal.order.includes(item.rawAgentId))
        .sort((left, right) => {
          const leftAgent = agentsById.get(left.id);
          const rightAgent = agentsById.get(right.id);
          const timeDifference = Date.parse(leftAgent?.startedAt || "") - Date.parse(rightAgent?.startedAt || "");
          return Number.isFinite(timeDifference) && timeDifference !== 0
            ? timeDifference
            : left.rawAgentId.localeCompare(right.rawAgentId);
        })
        .map((item) => item.rawAgentId),
    ];
    const manifestRawOrder = manifest
      ? manifest.workers.map((worker) => worker.rawAgentId).filter((rawId, index, values) => values.indexOf(rawId) === index)
      : [];
    const orderedRawIds = [
      ...manifestRawOrder.filter((rawId) => rawAgentIds.has(rawId)),
      ...fallbackRawOrder.filter((rawId) => !manifestRawOrder.includes(rawId)),
    ];
    const agentIds = orderedRawIds.map((rawId) => rawAgentIds.get(rawId)).filter((id) => agentsById.has(id));

    const manifestLabelled = new Set();
    if (manifest) {
      for (const worker of manifest.workers) {
        const agentId = rawAgentIds.get(worker.rawAgentId);
        const agent = agentId ? agentsById.get(agentId) : null;
        if (!agent) continue;
        agent.workflowId = runId;
        if (worker.label) {
          agent.label = worker.label;
          manifestLabelled.add(agentId);
        }
        agent.workflowState = worker.state;
        if (worker.phaseIndex !== null) {
          const phaseId = `${runId}-phase-${worker.phaseIndex}`;
          agent.workflowPhaseId = phaseId;
          if (!phaseAgents.has(worker.phaseIndex)) phaseAgents.set(worker.phaseIndex, []);
          phaseAgents.get(worker.phaseIndex).push(agentId);
        }
      }
    }

    const linkedAgents = agentIds.map((id) => agentsById.get(id)).filter(Boolean);
    const strongLiveEvidence = linkedAgents.some((agent) => hasStrongWorkflowLiveness(agent, historical));
    const status = manifest ? "completed" : strongLiveEvidence ? "running" : "unknown";
    const agentStartedAt = linkedAgents.map((agent) => agent.startedAt).filter(Boolean).sort()[0] || null;
    const agentUpdatedAt = linkedAgents.map((agent) => agent.updatedAt).filter(Boolean).sort().at(-1) || null;
    const startedAt = manifest?.startedAt || launch?.observedAt || agentStartedAt;
    const updatedAt = manifest?.updatedAt || agentUpdatedAt || launch?.observedAt;
    const elapsed = startedAt && updatedAt ? Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)) : 0;

    for (const [workflowOrder, agent] of linkedAgents.entries()) {
      agent.workflowId = runId;
      agent.workflowOrder = workflowOrder;
      const discoveredAgent = discovered.find((item) => item.id === agent.id);
      if (!manifestLabelled.has(agent.id)) agent.label = workflowWorkerOrderLabel(workflowOrder, discoveredAgent?.metadata);
      if (!manifest) {
        const rawAgentId = discoveredAgent?.rawAgentId;
        const journalState = rawAgentId ? journal.states.get(rawAgentId) : null;
        agent.workflowState = journalState === "done"
          ? "done"
          : journalState === "running" && status === "running" && hasStrongWorkflowLiveness(agent, historical)
            ? "running"
            : "unknown";
      }
    }
    return {
      id: runId,
      name: manifest?.name || launch?.name || "Workflow",
      summary: manifest?.summary || launch?.summary || null,
      status,
      metadataStatus: manifest ? "ready" : status === "running" ? "pending" : "unavailable",
      startedAt,
      updatedAt,
      durationMs: manifest?.durationMs ?? Math.min(elapsed, MAX_WORKFLOW_DURATION_MS),
      agentIds,
      phases: manifest ? manifest.phases.map((phase) => ({
        id: `${runId}-phase-${phase.index}`,
        label: phase.label,
        agentIds: [...new Set(phaseAgents.get(phase.index) || [])],
      })) : [],
    };
  });
}
