function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => typeof item === "string" ? item : item?.text || "").join(" ");
}

const FINISHED_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);
const USER_INPUT_TOOLS = new Set(["AskUserQuestion"]);

function recordTimestampMs(record) {
  const milliseconds = new Date(record.timestamp || record.message?.timestamp).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function pendingUserInputAt(records) {
  const pending = new Map();

  for (const record of records) {
    if (!Array.isArray(record.message?.content)) continue;
    for (const content of record.message.content) {
      if (record.type === "assistant"
        && content.type === "tool_use"
        && USER_INPUT_TOOLS.has(content.name)
        && typeof content.id === "string") {
        pending.set(content.id, record.timestamp || record.message?.timestamp || null);
      }
      if (record.type === "user" && content.type === "tool_result") {
        pending.delete(content.tool_use_id);
      }
    }
  }

  return [...pending.values()].reduce((latest, timestamp) => {
    if (!timestamp) return latest;
    if (!latest) return timestamp;
    return (new Date(timestamp).getTime() > new Date(latest).getTime()) ? timestamp : latest;
  }, null);
}

export function externallyStoppedAgentTimes(records) {
  const requests = new Map();
  const stopped = new Map();

  for (const record of records) {
    if (!Array.isArray(record.message?.content)) continue;
    for (const content of record.message.content) {
      if (record.type === "assistant" && content.type === "tool_use" && content.name === "TaskStop") {
        const agentId = typeof content.input?.task_id === "string"
          ? content.input.task_id.replace(/^agent-/, "")
          : "";
        if (agentId) requests.set(content.id, { agentId, timestamp: record.timestamp || record.message?.timestamp || null });
      }
      if (record.type !== "user" || content.type !== "tool_result") continue;
      const request = requests.get(content.tool_use_id);
      if (!request || content.is_error || !/\bstopped\b/i.test(toolResultText(content.content))) continue;
      const timestamp = record.timestamp || record.message?.timestamp || request.timestamp;
      const current = stopped.get(request.agentId);
      if (!current || (recordTimestampMs({ timestamp }) ?? 0) > (recordTimestampMs({ timestamp: current }) ?? 0)) {
        stopped.set(request.agentId, timestamp);
      }
    }
  }

  return stopped;
}

export function isExternalStopCurrent(records, stoppedAt) {
  const stoppedAtMs = new Date(stoppedAt).getTime();
  if (!Number.isFinite(stoppedAtMs)) return false;
  return !records.some((record) => {
    const timestamp = recordTimestampMs(record);
    return record.type === "assistant"
      && record.message?.model !== "<synthetic>"
      && timestamp !== null
      && timestamp > stoppedAtMs + 1_000;
  });
}

export function isAgentTranscriptFinished(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const role = record.message?.role;
    if (record.type !== "assistant" && record.type !== "user" && role !== "assistant" && role !== "user") continue;
    if (role === "user" || record.type === "user") return false;
    return FINISHED_STOP_REASONS.has(record.message?.stop_reason);
  }
  return false;
}

export function buildAgentMetadata(records, parentId) {
  const launches = new Map();
  const agents = new Map();
  for (const record of records) {
    if (!Array.isArray(record.message?.content)) continue;
    for (const content of record.message.content) {
      if (record.type === "assistant" && content.type === "tool_use" && content.name === "Agent") {
        launches.set(content.id, {
          description: content.input?.description || "Subagent",
          kind: content.input?.subagent_type || "subagent",
          parentId,
        });
      }
      if (record.type === "user" && content.type === "tool_result") {
        const match = toolResultText(content.content).match(/agentId:\s*([a-z0-9_-]+)/i);
        const launch = launches.get(content.tool_use_id);
        if (match && launch) agents.set(match[1], launch);
      }
    }
  }
  return agents;
}

export function fallbackAgentMetadata(records) {
  const prompt = records.find((record) => record.type === "user" && typeof record.message?.content === "string")?.message.content || "";
  const match = prompt.match(/^You are\s+(?:the\s+)?(.{3,80}?)(?=\s+(?:of|for|on|tasked)\b|[.!:\n])/i);
  const rawDescription = match?.[1]?.replace(/\s+/g, " ").trim();
  const description = rawDescription
    ? rawDescription.charAt(0).toUpperCase() + rawDescription.slice(1).toLowerCase()
    : "Subagent";
  const kind = records.find((record) => typeof record.attributionAgent === "string")?.attributionAgent || "subagent";
  return { description, kind, parentId: null };
}

export function agentTiming(records, fallbackTimestamp) {
  const timestamps = records
    .map((record) => record.timestamp || record.message?.timestamp)
    .map((timestamp) => new Date(timestamp).getTime())
    .filter(Number.isFinite);
  const fallback = new Date(fallbackTimestamp).getTime();
  const startedAtMs = timestamps.length ? Math.min(...timestamps) : fallback;
  const updatedAtMs = timestamps.length ? Math.max(...timestamps) : fallback;
  const safeStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : 0;
  const safeUpdatedAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : safeStartedAtMs;

  return {
    startedAt: new Date(safeStartedAtMs).toISOString(),
    updatedAt: new Date(safeUpdatedAtMs).toISOString(),
    durationMs: Math.max(0, safeUpdatedAtMs - safeStartedAtMs),
  };
}

export function applyWaitingStatus(agents) {
  const liveAgentIds = new Set(
    agents.filter((agent) => agent.status === "active").map((agent) => agent.id),
  );
  let changed = true;

  while (changed) {
    changed = false;
    for (const agent of agents) {
      if (liveAgentIds.has(agent.id) || agent.status === "needs_input") continue;
      const hasLiveChild = agents.some(
        (child) => child.parentId === agent.id && liveAgentIds.has(child.id),
      );
      if (!hasLiveChild) continue;
      agent.status = "waiting";
      liveAgentIds.add(agent.id);
      changed = true;
    }
  }

  return agents;
}

export function isRunningAgent(agent) {
  return agent.status === "active" || agent.status === "waiting";
}
