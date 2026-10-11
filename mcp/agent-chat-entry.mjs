#!/usr/bin/env node

// Entry of the agent chat's MCP server. The desktop build bundles it as `desktop/workers/agent-chat-mcp.cjs`, and the
// chat's provider run starts it over stdio.
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { buildAgentChatMcpServer } from "./agent-chat-server.mjs";

serveStdio(() => buildAgentChatMcpServer());
