#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  normalizeSessionSignal,
  SESSION_SIGNAL_MAX_LABEL_LENGTH,
  SESSION_SIGNAL_TOOL,
  SESSION_SIGNAL_TONES,
} from "../monitor/session-signals.mjs";

export function buildThreadlightMcpServer() {
  const server = new McpServer(
    { name: "threadlight", version: "0.1.0" },
    { instructions: "Use report_session_signal when the current agent has a short, meaningful status to expose in the Threadlight session dashboard." },
  );

  server.registerTool(
    SESSION_SIGNAL_TOOL,
    {
      title: "Report Threadlight session signal",
      description: "Report one short status tag for the calling agent in the current Threadlight session. A later call replaces the earlier tag. Do not include prompts, responses, secrets, commands, or tool output.",
      inputSchema: z.object({
        label: z.string().trim().min(1).max(SESSION_SIGNAL_MAX_LABEL_LENGTH)
          .refine((label) => normalizeSessionSignal({ label, tone: "neutral" }) !== null, "Use one line of plain text without control characters.")
          .describe("Short plain-text tag, such as Approved, Rejected, or Research complete."),
        tone: z.enum(SESSION_SIGNAL_TONES).default("neutral").describe("Semantic tone used by Threadlight to decorate the tag."),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { "anthropic/alwaysLoad": true },
    },
    async (input) => {
      const signal = normalizeSessionSignal(input);
      if (!signal) {
        return {
          isError: true,
          content: [{ type: "text", text: "Signal rejected. Use a plain-text label of 1-40 characters and a supported tone." }],
        };
      }
      return {
        content: [{ type: "text", text: `Session signal reported: ${signal.label} (${signal.tone}). Threadlight will read this call from the session transcript.` }],
      };
    },
  );

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio(() => buildThreadlightMcpServer());
}
