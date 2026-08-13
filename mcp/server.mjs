#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  AGENT_SIGNAL_TOOL,
  CLEAR_AGENT_SIGNAL_TOOL,
  CLEAR_SESSION_SIGNAL_TOOL,
  normalizeAgentSignal,
  normalizeSessionSignal,
  normalizeTaskSignal,
  SIGNAL_MAX_DESCRIPTION_LENGTH,
  SIGNAL_MAX_LABEL_LENGTH,
  SESSION_SIGNAL_TOOL,
  SESSION_SIGNAL_TONES,
  TASK_SIGNAL_TOOL,
} from "../monitor/session-signals.mjs";

const labelSchema = z.string().trim().min(1).max(SIGNAL_MAX_LABEL_LENGTH)
  .refine((label) => normalizeSessionSignal({ label, tone: "neutral" }) !== null, "Use one line of plain text without control characters.")
  .describe("Short plain-text tag, such as Approved, Rejected, or Research complete.");
const toneSchema = z.enum(SESSION_SIGNAL_TONES).default("neutral")
  .describe("Semantic tone used by Threadlight to decorate the tag.");
const descriptionSchema = z.string().trim().min(1).max(SIGNAL_MAX_DESCRIPTION_LENGTH)
  .refine((description) => normalizeAgentSignal({ label: "Signal", tone: "neutral", description }) !== null, "Use one line of plain text without control characters.")
  .describe("Optional short plain-text explanation shown as the tag tooltip.")
  .optional();
const signalAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function buildThreadlightMcpServer() {
  const server = new McpServer(
    { name: "threadlight", version: "0.1.0" },
    { instructions: "Use report_agent_signal for the calling agent, report_session_signal for the overall session, and report_task_signal for a durable execution-task outcome. A later report replaces the same scope. Use clear_agent_signal or clear_session_signal when the corresponding current state is no longer meaningful and no replacement applies." },
  );

  server.registerTool(
    AGENT_SIGNAL_TOOL,
    {
      title: "Report Threadlight agent signal",
      description: "Report one short status tag for the calling agent, with an optional tooltip description. A later call from that agent replaces its earlier tag. Do not include prompts, responses, secrets, commands, or tool output.",
      inputSchema: z.object({
        label: labelSchema,
        tone: toneSchema,
        description: descriptionSchema,
      }).strict(),
      annotations: signalAnnotations,
      _meta: { "anthropic/alwaysLoad": true },
    },
    async (input) => {
      const signal = normalizeAgentSignal(input);
      if (!signal) {
        return {
          isError: true,
          content: [{ type: "text", text: "Signal rejected. Use a plain-text label of 1-20 characters, an optional one-line description of up to 160 characters, and a supported tone." }],
        };
      }
      return {
        content: [{ type: "text", text: `Agent signal reported: ${signal.label} (${signal.tone}). Threadlight will read this call from the session transcript.` }],
      };
    },
  );

  server.registerTool(
    CLEAR_AGENT_SIGNAL_TOOL,
    {
      title: "Clear Threadlight agent signal",
      description: "Remove the calling agent's current Threadlight status tag when no project-specific state remains meaningful. This does not affect the overall session tag.",
      inputSchema: z.object({}).strict(),
      annotations: signalAnnotations,
      _meta: { "anthropic/alwaysLoad": true },
    },
    async () => ({ content: [{ type: "text", text: "Agent signal cleared. Threadlight will read this call from the session transcript." }] }),
  );

  server.registerTool(
    CLEAR_SESSION_SIGNAL_TOOL,
    {
      title: "Clear Threadlight session signal",
      description: "Remove the overall session's current Threadlight status tag when no project-specific state remains meaningful. This does not clear agent or task tags.",
      inputSchema: z.object({}).strict(),
      annotations: signalAnnotations,
      _meta: { "anthropic/alwaysLoad": true },
    },
    async () => ({ content: [{ type: "text", text: "Session signal cleared. Threadlight will read this call from agent transcripts." }] }),
  );

  server.registerTool(
    SESSION_SIGNAL_TOOL,
    {
      title: "Report Threadlight session signal",
      description: "Report one short status tag for the overall Threadlight session, with an optional tooltip description. Any agent may report it, and the latest call replaces the earlier session tag. Do not include prompts, responses, secrets, commands, or tool output.",
      inputSchema: z.object({
        label: labelSchema,
        tone: toneSchema,
        description: descriptionSchema,
      }).strict(),
      annotations: signalAnnotations,
      _meta: { "anthropic/alwaysLoad": true },
    },
    async (input) => {
      const signal = normalizeSessionSignal(input);
      if (!signal) {
        return {
          isError: true,
          content: [{ type: "text", text: "Signal rejected. Use a plain-text label of 1-20 characters, an optional one-line description of up to 160 characters, and a supported tone." }],
        };
      }
      return {
        content: [{ type: "text", text: `Session signal reported: ${signal.label} (${signal.tone}). Threadlight will read this call from agent transcripts.` }],
      };
    },
  );

  server.registerTool(
    TASK_SIGNAL_TOOL,
    {
      title: "Report Threadlight task signal",
      description: "Report one short status or outcome tag for a specific execution task. Pass the background task ID returned by Claude Code, or the Bash tool-use ID when available. A later call for the same task replaces the earlier tag. Do not include prompts, responses, secrets, commands, or tool output.",
      inputSchema: z.object({
        task_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
          .describe("Stable background task ID returned by Claude Code, or the corresponding Bash tool-use ID."),
        label: labelSchema,
        tone: toneSchema,
      }).strict(),
      annotations: signalAnnotations,
      _meta: { "anthropic/alwaysLoad": true },
    },
    async (input) => {
      const signal = normalizeTaskSignal(input);
      if (!signal) {
        return {
          isError: true,
          content: [{ type: "text", text: "Task signal rejected. Use a safe task ID, a plain-text label of 1-20 characters, and a supported tone." }],
        };
      }
      return {
        content: [{ type: "text", text: `Task signal reported: ${signal.label} (${signal.tone}). Threadlight will associate this call from the session transcript.` }],
      };
    },
  );

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio(() => buildThreadlightMcpServer());
}
