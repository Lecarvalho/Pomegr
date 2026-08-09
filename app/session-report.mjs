import { formatAgentWallTime, formatWallTime } from "./formatting.mjs";

function number(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function localTime(value) {
  if (!value) return "Unavailable";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(date);
}

function cell(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function code(value) {
  return `\`${String(value ?? "").replace(/`/g, "'")}\``;
}

function agentStatus(status) {
  return status === "needs_input" ? "needs input" : status;
}

function toolDistribution(patterns) {
  const groups = new Map();
  for (const pattern of patterns || []) {
    const key = `${pattern.agent}\u0000${pattern.tool}`;
    const current = groups.get(key) || { agent: pattern.agent, tool: pattern.tool, calls: 0 };
    current.calls += Number(pattern.calls || 0);
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.calls - a.calls || a.agent.localeCompare(b.agent) || a.tool.localeCompare(b.tool));
}

function skillDistribution(agents) {
  return (agents || []).flatMap((agent) => (agent.skills || []).map((skill) => ({
    agent: agent.label,
    name: skill.name,
    calls: skill.calls,
    lastUsed: skill.lastUsed,
  })));
}

export function buildSessionReport(state, generatedAt = new Date()) {
  if (!state?.session) throw new Error("A live session is required to generate a report.");

  const session = state.session;
  const repository = session.repository || { available: false, branch: "", files: [] };
  const agents = state.agents || [];
  const labelsById = new Map(agents.map((agent) => [agent.id, agent.label]));
  const tools = toolDistribution(state.toolPatterns);
  const skills = skillDistribution(agents);
  const insights = state.insights || [];
  const limits = state.usageLimits?.limits || [];
  const lines = [
    "# Threadlight Session Report",
    "",
    "> Deterministic, read-only summary generated locally from execution metadata. No AI inference, prompts, or responses are included.",
    "",
    "## Session",
    "",
    `- **Session ID:** ${code(session.id)}`,
    `- **Name:** ${cell(session.title)}`,
    `- **Project:** ${cell(session.project)}`,
    `- **Source:** ${cell(state.source)}`,
    `- **Generated:** ${localTime(generatedAt)}`,
    `- **Recorded start:** ${localTime(session.startedAt)}`,
    `- **Recorded end:** ${localTime(session.updatedAt)}`,
    `- **Elapsed wall time:** ${formatWallTime(session.durationMs)}`,
    `- **Flow score:** ${number(state.score)} / 100`,
    "",
    "## Executive metrics",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Agents running now | ${number(state.metrics.activeAgents)} / ${number(state.metrics.agents)} |`,
    `| Tool calls | ${number(state.metrics.toolCalls)} |`,
    `| All-agent context | ${number(state.metrics.tokens.allAgents)} tokens |`,
    "",
    "## Agent activity",
    "",
    "| Agent | Parent | Role | Model | Effort | Status | Wall time | Context snapshot | Tool calls |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |",
  ];

  if (agents.length) {
    for (const agent of agents) {
      const parent = agent.parentId ? labelsById.get(agent.parentId) || agent.parentId : "—";
      lines.push(`| ${cell(agent.label)} | ${cell(parent)} | ${cell(agent.kind)} | ${cell(agent.model)} | ${cell(agent.effort)} | ${cell(agentStatus(agent.status))} | ${formatAgentWallTime(agent, generatedAt.getTime())} | ${number(agent.tokens?.total)} | ${number(agent.toolCalls)} |`);
    }
  } else {
    lines.push("| No agents observed | — | — | — | — | — | — | — | — |");
  }

  lines.push("", "## Skill usage", "");
  if (skills.length) {
    lines.push("| Agent | Skill | Invocations | Last used |", "| --- | --- | ---: | --- |");
    for (const skill of skills) lines.push(`| ${cell(skill.agent)} | ${code(skill.name)} | ${number(skill.calls)} | ${cell(localTime(skill.lastUsed))} |`);
  } else {
    lines.push("No explicit skill invocations were observed.");
  }

  lines.push("", "## Tool-call distribution", "");
  if (tools.length) {
    lines.push("| Agent | Tool | Calls |", "| --- | --- | ---: |");
    for (const tool of tools) lines.push(`| ${cell(tool.agent)} | ${cell(tool.tool)} | ${number(tool.calls)} |`);
  } else {
    lines.push("No tool calls were observed.");
  }

  lines.push("", "## Deterministic signals", "");
  if (insights.length) {
    for (const insight of insights) lines.push(`- **${cell(insight.title)}** — ${cell(insight.detail)}`);
  } else {
    lines.push("No efficiency signals were produced.");
  }

  lines.push("", "## Repository", "");
  if (repository.available) {
    lines.push(`- **${repository.historical ? "Recorded branch" : "Branch"}:** ${code(repository.branch)}`);
    if (repository.historical) {
      lines.push("- Historical uncommitted-file state was not recorded.");
    } else {
      lines.push(`- **Uncommitted files:** ${number(repository.files?.length)}`);
    }
    if (!repository.historical && repository.files?.length) {
      lines.push("");
      for (const file of repository.files) lines.push(`- ${code(file.status)} ${code(file.path)}`);
    }
  } else {
    lines.push("Repository metadata was unavailable.");
  }

  if (state.view !== "history") {
    lines.push("", "## Plan usage", "");
    if (state.usageLimits?.available && limits.length) {
      lines.push("| Window | Limit | Used | Reset |", "| --- | --- | ---: | --- |");
      for (const limit of limits) lines.push(`| ${cell(limit.window)} | ${cell(limit.label)} | ${Math.round(Number(limit.percent || 0))}% | ${cell(localTime(limit.resetsAt))} |`);
    } else {
      lines.push("Plan usage was unavailable when the report was generated.");
    }
  }

  lines.push(
    "",
    "## Retrospective questions",
    "",
    "1. Which tool calls could have been batched or stopped earlier?",
    "2. Did agent responsibilities overlap, or were boundaries clear?",
    "3. Which agents used the most wall time or had the largest context snapshots relative to their result?",
    "4. What context, tools, or instructions would reduce retries in the next session?",
    "5. Which successful workflow should be preserved?",
    "",
  );

  return lines.join("\n");
}

export function sessionReportFilename(state, generatedAt = new Date()) {
  const title = state?.session?.title || state?.session?.project || "session";
  const slug = title.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "session";
  const date = generatedAt.toISOString().slice(0, 10);
  return `threadlight-${slug}-${date}.md`;
}
