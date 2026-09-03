#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  normalizeDescribedSignal,
  normalizeSessionProgress,
  normalizeTaskSignal,
  SIGNAL_MAX_DESCRIPTION_LENGTH,
  SIGNAL_MAX_LABEL_LENGTH,
  SIGNAL_TONES,
  SESSION_PROGRESS_PHASES,
  SESSION_PROGRESS_CONFIDENCES,
} from "./signal-contract.mjs";
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from "../scripts/session-title.mjs";
import { AGENT_QUERY_INSTRUCTIONS, registerAgentQueryTools } from "../../../mcp/agent-query-tools.mjs";
import { createAgentQueryReader, defaultAgentQueryDataRoot } from "../../../shared/agent-query-transport.mjs";

const reportingAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const titleAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const label = z.string().trim().min(1).max(SIGNAL_MAX_LABEL_LENGTH)
  .refine((value) => normalizeDescribedSignal({ label: value, tone: "neutral" }) !== null, "Use one line of plain text without control characters.")
  .describe("Short project-specific status tag.");
const tone = z.enum(SIGNAL_TONES).default("neutral").describe("Semantic tone used to decorate the tag.");
const description = z.string().trim().min(1).max(SIGNAL_MAX_DESCRIPTION_LENGTH)
  .refine((value) => normalizeDescribedSignal({ label: "Signal", description: value }) !== null, "Use one line of plain text without control characters.")
  .describe("Optional bounded tooltip explanation.").optional();
const sessionTitle = z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH)
  .refine((value) => normalizeSessionTitle(value) !== null, "Use one line of plain text without control or bidirectional formatting characters.")
  .describe("Concise, meaningful title for the current Claude Code session.");
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

function describedSchema() {
  return z.object({ label, tone, description }).strict();
}

function success(text) {
  return { content: [{ type: "text", text }] };
}

function rejected(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

export function buildPomegrMcpServer(options = {}) {
  const server = new McpServer(
    { name: "pomegr", version: "0.4.3" },
    { instructions: "Follow .pomegr/signals.md when present. Assign a concise native session title through rename_session after the work is clear, preserve any existing custom title, report bounded project-specific transitions and session progress, and clear resolved state when no replacement applies. " + AGENT_QUERY_INSTRUCTIONS },
  );

  server.registerTool("report_agent_signal", {
    title: "Report Pomegr agent signal",
    description: "Report one current project-specific status for the calling agent. A later report or clear from this agent replaces it. Never include prompts, responses, secrets, commands, or tool output.",
    inputSchema: describedSchema(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async (input) => {
    const signal = normalizeDescribedSignal(input);
    return signal ? success(`Agent signal reported: ${signal.label} (${signal.tone}).`) : rejected("Signal rejected. Use a plain-text label of 1-20 characters, optional one-line description up to 160 characters, and a supported tone.");
  });

  server.registerTool("report_session_signal", {
    title: "Report Pomegr session signal",
    description: "Report one current project-specific status for the overall session. The latest session report or clear replaces it. Never include prompts, responses, secrets, commands, or tool output.",
    inputSchema: describedSchema(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async (input) => {
    const signal = normalizeDescribedSignal(input);
    return signal ? success(`Session signal reported: ${signal.label} (${signal.tone}).`) : rejected("Signal rejected. Use a plain-text label of 1-20 characters, optional one-line description up to 160 characters, and a supported tone.");
  });

  server.registerTool("report_session_progress", {
    title: "Report Pomegr session progress",
    description: "Report bounded progress for the overall Claude Code session. A later report replaces the current progress, including when percent moves backward. Do not include prompts, responses, secrets, commands, or tool output.",
    inputSchema: progressSchema, annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async (input) => {
    const progress = normalizeSessionProgress(input);
    return progress ? success(`Session progress reported: ${progress.phase} (${progress.percent}%).`) : rejected("Progress rejected. Use a valid phase, integer percent from 0-100, confidence, and paired ETA bounds when applicable.");
  });

  server.registerTool("clear_session_progress", {
    title: "Clear Pomegr session progress",
    description: "Clear the current overall session progress report. Does not affect status tags or task tags.",
    inputSchema: z.object({}).strict(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async () => success("Session progress cleared."));

  server.registerTool("report_task_signal", {
    title: "Report Pomegr task signal",
    description: "Report a durable outcome for a recognized execution task. Use the background task ID or Bash tool-use ID. Later reports for the same task replace it; task signals cannot be cleared.",
    inputSchema: z.object({
      task_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).describe("Stable execution-task identifier returned by Claude Code."),
      label,
      tone,
    }).strict(),
    annotations: reportingAnnotations,
    _meta: { "anthropic/alwaysLoad": true },
  }, async (input) => {
    const signal = normalizeTaskSignal(input);
    return signal ? success(`Task signal reported: ${signal.label} (${signal.tone}).`) : rejected("Task signal rejected. Use a safe task ID, a plain-text label of 1-20 characters, and a supported tone.");
  });

  server.registerTool("clear_agent_signal", {
    title: "Clear Pomegr agent signal",
    description: "Remove the calling agent's current project-specific status when it has resolved and no replacement state applies. Does not affect the session or tasks.",
    inputSchema: z.object({}).strict(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async () => success("Agent signal cleared."));

  server.registerTool("clear_session_signal", {
    title: "Clear Pomegr session signal",
    description: "Remove the overall session's current project-specific status when it has resolved and no replacement state applies. Does not affect agents or tasks.",
    inputSchema: z.object({}).strict(), annotations: reportingAnnotations, _meta: { "anthropic/alwaysLoad": true },
  }, async () => success("Session signal cleared."));

  server.registerTool("rename_session", {
    title: "Rename current Claude session",
    description: "Assign one concise, meaningful title to the calling Claude Code session after its purpose is clear. A trusted Pomegr hook binds the request to the current session and preserves any existing custom title.",
    inputSchema: z.object({ title: sessionTitle }).strict(),
    annotations: titleAnnotations,
    _meta: { "anthropic/alwaysLoad": true },
  }, async () => success("Session title request accepted; Claude Code preserves any existing explicit title."));

  const query = options.query ?? options.agentQuery ?? createAgentQueryReader({
    dataRoot: options.dataRoot ?? defaultAgentQueryDataRoot(),
  });
  registerAgentQueryTools(server, { query });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveStdio(() => buildPomegrMcpServer());
}
