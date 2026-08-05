function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => typeof item === "string" ? item : item?.text || "").join(" ");
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

export function applyWaitingStatus(agents) {
  const liveAgentIds = new Set(
    agents.filter((agent) => agent.status === "active").map((agent) => agent.id),
  );
  let changed = true;

  while (changed) {
    changed = false;
    for (const agent of agents) {
      if (liveAgentIds.has(agent.id)) continue;
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
