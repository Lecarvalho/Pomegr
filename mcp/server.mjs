#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  AGENT_SIGNAL_TOOL,
  CLEAR_AGENT_SIGNAL_TOOL,
  CLEAR_SESSION_SIGNAL_TOOL,
  CLEAR_SESSION_PROGRESS_TOOL,
  normalizeSessionProgress,
  normalizeAgentSignal,
  normalizeSessionSignal,
  normalizeTaskSignal,
  SIGNAL_MAX_DESCRIPTION_LENGTH,
  SIGNAL_MAX_LABEL_LENGTH,
  SESSION_SIGNAL_TOOL,
  SESSION_PROGRESS_TOOL,
  SESSION_PROGRESS_PHASES,
  SESSION_PROGRESS_CONFIDENCES,
  SESSION_SIGNAL_TONES,
  TASK_SIGNAL_TOOL,
} from "../monitor/session-signals.mjs";
import { AGENT_QUERY_INSTRUCTIONS, registerAgentQueryTools } from "./agent-query-tools.mjs";
import { createAgentQueryReader, defaultAgentQueryDataRoot } from "../shared/agent-query-transport.mjs";

const labelSchema = z.string().trim().min(1).max(SIGNAL_MAX_LABEL_LENGTH)
  .refine((label) => normalizeSessionSignal({ label, tone: "neutral" }) !== null, "Use one line of plain text without control characters.")
  .describe("Short plain-text tag, such as Approved, Rejected, or Research complete.");
const toneSchema = z.enum(SESSION_SIGNAL_TONES).default("neutral")
  .describe("Semantic tone used by Pomegr to decorate the tag.");
const descriptionSchema = z.string().trim().min(1).max(SIGNAL_MAX_DESCRIPTION_LENGTH)
  .refine((description) => normalizeAgentSignal({ label: "Signal", tone: "neutral", description }) !== null, "Use one line of plain text without control characters.")
  .describe("Optional short plain-text explanation shown as the tag tooltip.")
  .optional();
const sessionDescriptionSchema = z.string().trim().min(1).max(SIGNAL_MAX_DESCRIPTION_LENGTH)
  .refine((description) => normalizeSessionSignal({ label: "Signal", tone: "neutral", description }) !== null, "Use one line of plain text without control characters.")
  .describe("Optional short plain-text session summary. Pomegr shows it in the session header when the provider has no native summary.")
  .optional();
const progressSchema = z.object({
  phase: z.enum(SESSION_PROGRESS_PHASES),
  percent: z.number().int().min(0).max(100),
  remaining_minutes_min: z.number().int().min(0).max(10080).optional(),
  remaining_minutes_max: z.number().int().min(0).max(10080).optional(),
  confidence: z.enum(SESSION_PROGRESS_CONFIDENCES),
}).strict().superRefine((value, context) => {
  const hasMin = value.remaining_minutes_min !== undefined;
  const hasMax = value.remaining_minutes_max !== undefined;
  if (hasMin !== hasMax) context.addIssue({ code: z.ZodIssueCode.custom, message: "ETA minimum and maximum must be provided together." });
  if (hasMin && value.remaining_minutes_min > value.remaining_minutes_max) context.addIssue({ code: z.ZodIssueCode.custom, message: "ETA minimum must not exceed maximum." });
  if (["blocked", "complete"].includes(value.phase) && (hasMin || hasMax)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Blocked and complete progress cannot include an ETA." });
  if (value.phase === "complete" && value.percent !== 100) context.addIssue({ code: z.ZodIssueCode.custom, message: "Complete progress must be 100 percent." });
}).refine((value) => normalizeSessionProgress(value) !== null, "Invalid session progress.");
const signalAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function buildPomegrMcpServer(options = {}) {
  const server = new McpServer(
    { name: "pomegr", version: "0.5.0" },
    { instructions: "Use report_agent_signal for the calling agent, report_session_signal for the overall session, report_session_progress for bounded session progress, and report_task_signal for a durable execution-task outcome. A later report replaces the same scope. Use clear_agent_signal, clear_session_signal, or clear_session_progress when the corresponding current state is no longer meaningful. " + AGENT_QUERY_INSTRUCTIONS },
  );

  server.registerTool(
    CLEAR_SESSION_PROGRESS_TOOL,
    {
      title: "Clear Pomegr session progress",
      description: "Clear the current overall session progress report. This does not clear status tags or task tags.",
      inputSchema: z.object({}).strict(),
      annotations: signalAnnotations,
    },
    async () => ({ content: [{ type: "text", text: "Session progress cleared. Pomegr will read this call from the session transcript." }] }),
  );

  server.registerTool(
    SESSION_PROGRESS_TOOL,
    {
      title: "Report Pomegr session progress",
      description: "Report bounded progress for the overall session. A later report replaces the current progress, including when percent moves backward. Do not include prompts, responses, secrets, commands, or tool output.",
      inputSchema: progressSchema,
      annotations: signalAnnotations,
    },
    async (input) => {
      const progress = normalizeSessionProgress(input);
      if (!progress) return { isError: true, content: [{ type: "text", text: "Progress rejected. Use a valid phase, integer percent from 0-100, confidence, and paired ETA bounds when applicable." }] };
      return { content: [{ type: "text", text: `Session progress reported: ${progress.phase} (${progress.percent}%). Pomegr will read this call from the session transcript.` }] };
    },
  );

  server.registerTool(
    AGENT_SIGNAL_TOOL,
    {
      title: "Report Pomegr agent signal",
      description: "Report one short status tag for the calling agent, with an optional tooltip description. A later call from that agent replaces its earlier tag. Do not include prompts, responses, secrets, commands, or tool output.",
      inputSchema: z.object({
        label: labelSchema,
        tone: toneSchema,
        description: descriptionSchema,
      }).strict(),
      annotations: signalAnnotations,
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
        content: [{ type: "text", text: `Agent signal reported: ${signal.label} (${signal.tone}). Pomegr will read this call from the session transcript.` }],
      };
    },
  );

  server.registerTool(
    CLEAR_AGENT_SIGNAL_TOOL,
    {
      title: "Clear Pomegr agent signal",
      description: "Remove the calling agent's current Pomegr status tag when no project-specific state remains meaningful. This does not affect the overall session tag.",
      inputSchema: z.object({}).strict(),
      annotations: signalAnnotations,
    },
    async () => ({ content: [{ type: "text", text: "Agent signal cleared. Pomegr will read this call from the session transcript." }] }),
  );

  server.registerTool(
    CLEAR_SESSION_SIGNAL_TOOL,
    {
      title: "Clear Pomegr session signal",
      description: "Remove the overall session's current Pomegr status tag when no project-specific state remains meaningful. This does not clear agent or task tags.",
      inputSchema: z.object({}).strict(),
      annotations: signalAnnotations,
    },
    async () => ({ content: [{ type: "text", text: "Session signal cleared. Pomegr will read this call from agent transcripts." }] }),
  );

  server.registerTool(
    SESSION_SIGNAL_TOOL,
    {
      title: "Report Pomegr session signal",
      description: "Report one short status tag for the overall Pomegr session, with an optional agent-authored summary. Pomegr shows the summary in the session header when the provider has no native summary. Any agent may report it, and the latest call replaces the earlier session signal. Do not include prompts, responses, secrets, commands, or tool output.",
      inputSchema: z.object({
        label: labelSchema,
        tone: toneSchema,
        description: sessionDescriptionSchema,
      }).strict(),
      annotations: signalAnnotations,
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
        content: [{ type: "text", text: `Session signal reported: ${signal.label} (${signal.tone}). Pomegr will read this call from agent transcripts.` }],
      };
    },
  );

  server.registerTool(
    TASK_SIGNAL_TOOL,
    {
      title: "Report Pomegr task signal",
      description: "Report one short status or outcome tag for a specific execution task. Pass the stable task ID returned by the coding-agent host when available. A later call for the same task replaces the earlier tag. Do not include prompts, responses, secrets, commands, or tool output.",
      inputSchema: z.object({
        task_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
          .describe("Stable execution-task ID returned by the coding-agent host."),
        label: labelSchema,
        tone: toneSchema,
      }).strict(),
      annotations: signalAnnotations,
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
        content: [{ type: "text", text: `Task signal reported: ${signal.label} (${signal.tone}). Pomegr will associate this call from the session transcript.` }],
      };
    },
  );

  const query = options.query ?? options.agentQuery ?? createAgentQueryReader({
    dataRoot: options.dataRoot ?? defaultAgentQueryDataRoot(),
  });
  registerAgentQueryTools(server, { query });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio(() => buildPomegrMcpServer());
}
