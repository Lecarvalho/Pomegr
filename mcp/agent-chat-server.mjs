import { McpServer } from "@modelcontextprotocol/server";

import { registerAgentQueryTools } from "./agent-query-tools.mjs";
import { createAgentQueryReader, defaultAgentQueryDataRoot } from "../shared/agent-query-transport.mjs";

export const AGENT_CHAT_MCP_INSTRUCTIONS = "These are Pomegr's read-only observation tools for the Pomegr agent chat. Nothing here changes a session, a task, or the board. This chat is not an observed session, so there is no current session: list_sessions finds exact session references, and every session tool needs one in session_ref (the board snapshot gives a task's session reference). Use get_session_report for one bounded Markdown report of a session's retained normalized evidence. Use get_usage_limits and get_provider_health when capacity or provider condition changes the advice. Results are observations that can be stale or unavailable; public provider status does not prove impact or causation.";

/** The MCP server the desktop app gives its agent chat: the seven read tools, and no signal, task, or feature tool. */
export function buildAgentChatMcpServer(options = {}) {
  const server = new McpServer({ name: "pomegr", version: "1.0.0" }, { instructions: AGENT_CHAT_MCP_INSTRUCTIONS });
  const query = options.query ?? createAgentQueryReader({ dataRoot: options.dataRoot ?? defaultAgentQueryDataRoot() });
  // No host session is bound, so a session tool without an explicit reference answers unavailable.
  registerAgentQueryTools(server, { query, currentSessionRef: null });
  return server;
}
